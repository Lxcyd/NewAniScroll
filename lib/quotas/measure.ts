/**
 * MESURE DES PLAFONDS — remplit la colonne « consomme » du catalogue.
 *
 * Un collecteur par fournisseur, tous independants : si le token Vercel manque,
 * on doit quand meme voir Upstash et Turso. C'est la lecon de tools/usage-monitor
 * (un collecteur qui tombe ne doit pas emporter le rapport), transposee ici.
 *
 * COUT DE CETTE PAGE. Elle interroge des API tierces, donc elle a elle-meme un
 * cout — il serait absurde qu'un tableau de bord des quotas en consomme. D'ou :
 *   - les API de management (Upstash, Turso, Vercel) ne comptent PAS dans les
 *     quotas qu'elles rapportent (ce sont des plans de controle separes) ;
 *   - la seule exception est le DBSIZE Redis, qu'on n'appelle donc pas : la
 *     taille des donnees vient de la serie de stats du plan de controle ;
 *   - l'appelant (pages/api/v2/admin/quotas.ts) met tout en cache 10 minutes.
 */

export type Measure = {
  used: number;
  /** Horodatage ISO de la mesure. */
  at: string;
  /** D'ou vient le chiffre, affiche tel quel dans l'UI. */
  source: string;
  /** Precision facultative (nom de la base, fenetre de comptage...). */
  detail?: string;
};

export type CollectorResult = {
  measures: Record<string, Measure>;
  /** Message d'erreur par fournisseur, null si tout va bien. */
  errors: Record<string, string>;
};

const TIMEOUT_MS = 8000;

/** fetch avec un plafond de temps : une API tierce lente ne doit pas faire
 *  expirer la fonction Vercel qui l'interroge (et donc bruler du Fluid CPU). */
async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} sur ${new URL(url).pathname}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const nowIso = () => new Date().toISOString();

/** Les points de series Upstash arrivent en {x: iso, y: n} — avec des variantes
 *  de nommage selon l'endpoint. Tolerant par construction. */
function normalizeSeries(series: any): { x: string; y: number }[] {
  if (!Array.isArray(series)) return [];
  return series
    .map((p: any) => {
      if (!p || typeof p !== "object") return null;
      const x = p.x ?? p.date ?? p.timestamp ?? null;
      const y = Number(p.y ?? p.value ?? p.count ?? 0);
      if (x == null || !Number.isFinite(y)) return null;
      return { x: String(x).slice(0, 10), y };
    })
    .filter(Boolean) as { x: string; y: number }[];
}

/** Somme des points tombant dans le mois calendaire en cours. C'est la fenetre
 *  qu'appliquent les fournisseurs pour un quota « par mois ». */
function sumCurrentMonth(series: { x: string; y: number }[]): number {
  const prefix = new Date().toISOString().slice(0, 7); // YYYY-MM
  return series
    .filter((p) => p.x.startsWith(prefix))
    .reduce((s, p) => s + p.y, 0);
}

/* ------------------------------------------------------------------ *
 * UPSTASH — API de management (email + cle de compte).
 * A ne pas confondre avec UPSTASH_REDIS_REST_TOKEN, qui est la cle de la base
 * elle-meme et ne sait rien des quotas.
 * ------------------------------------------------------------------ */
async function collectUpstash(out: CollectorResult): Promise<void> {
  const email = process.env.UPSTASH_EMAIL;
  const apiKey = process.env.UPSTASH_API_KEY;
  if (!email || !apiKey) return;

  const auth =
    "Basic " + Buffer.from(`${email}:${apiKey}`).toString("base64");
  const headers = { Authorization: auth };

  try {
    const dbs = await fetchJson("https://api.upstash.com/v2/redis/databases", {
      headers,
    });
    const list = Array.isArray(dbs) ? dbs : dbs?.databases || [];

    out.measures["upstash.databases"] = {
      used: list.length,
      at: nowIso(),
      source: "API Upstash",
      detail: list.map((d: any) => d.database_name || d.name).join(", "),
    };
    if (!list.length) return;

    const dbId =
      process.env.UPSTASH_DATABASE_ID || list[0].database_id || list[0].id;
    const chosen = list.find(
      (d: any) => (d.database_id || d.id) === dbId,
    );
    const dbName = chosen?.database_name || chosen?.name || String(dbId);

    const stats = await fetchJson(
      `https://api.upstash.com/v2/redis/stats/${dbId}`,
      { headers },
    );

    const daily = normalizeSeries(stats?.dailyrequests);
    if (daily.length) {
      out.measures["upstash.commands-monthly"] = {
        used: sumCurrentMonth(daily),
        at: nowIso(),
        source: "API Upstash",
        detail: `${dbName} — cumul du mois en cours`,
      };
      const last7 = daily.slice(-7);
      if (last7.length) {
        const avg = last7.reduce((s, p) => s + p.y, 0) / last7.length;
        out.measures["upstash.commands-projected"] = {
          used: Math.round(avg * 30),
          at: nowIso(),
          source: "API Upstash",
          detail: `moyenne 7 j (${Math.round(avg).toLocaleString("fr-FR")}/j) x 30`,
        };
      }
    }

    // Taille des donnees : derniere valeur connue, pas une somme.
    const disk = normalizeSeries(stats?.diskusage ?? stats?.dailydiskusage);
    const lastDisk = disk.at(-1);
    if (lastDisk) {
      out.measures["upstash.data-size"] = {
        used: lastDisk.y,
        at: nowIso(),
        source: "API Upstash",
        detail: dbName,
      };
    }

    // Bande passante : un cumul, comme les commandes.
    const bw = normalizeSeries(stats?.dailybandwidth ?? stats?.bandwidth);
    if (bw.length) {
      out.measures["upstash.bandwidth"] = {
        used: sumCurrentMonth(bw),
        at: nowIso(),
        source: "API Upstash",
        detail: `${dbName} — cumul du mois en cours`,
      };
    }
  } catch (e: any) {
    out.errors.Upstash = e?.message || String(e);
  }
}

/* ------------------------------------------------------------------ *
 * TURSO — API de plateforme (token de compte, PAS le token d'une base).
 * L'usage renvoye est celui de l'ORGANISATION entiere, ce qui est precisement
 * la granularite du quota gratuit : separer anime et fanarts en deux bases
 * n'a jamais double le budget de lignes lues.
 * ------------------------------------------------------------------ */
async function collectTurso(out: CollectorResult): Promise<void> {
  const token = process.env.TURSO_API_TOKEN;
  if (!token) return;
  const headers = { Authorization: `Bearer ${token}` };

  try {
    let org = process.env.TURSO_ORG;
    if (!org) {
      const orgs = await fetchJson("https://api.turso.tech/v1/organizations", {
        headers,
      });
      const list = Array.isArray(orgs) ? orgs : orgs?.organizations || [];
      org = list[0]?.slug || list[0]?.name;
      if (!org) throw new Error("aucune organisation resolue");
    }

    const data = await fetchJson(
      `https://api.turso.tech/v1/organizations/${encodeURIComponent(org)}/usage`,
      { headers },
    );
    const u = data?.organization?.usage ?? data?.usage ?? data;
    const at = nowIso();
    const src = "API Turso";
    const detail = `organisation ${org} — mois en cours`;

    const map: [string, any][] = [
      ["turso.rows-read", u?.rows_read],
      ["turso.rows-written", u?.rows_written],
      ["turso.storage", u?.storage_bytes],
      ["turso.databases", u?.databases],
      ["turso.bytes-synced", u?.bytes_synced],
    ];
    for (const [id, value] of map) {
      if (Number.isFinite(Number(value))) {
        out.measures[id] = { used: Number(value), at, source: src, detail };
      }
    }
  } catch (e: any) {
    out.errors.Turso = e?.message || String(e);
  }
}

/* ------------------------------------------------------------------ *
 * VERCEL — le fournisseur le plus important et le moins instrumente.
 *
 * Il n'existe AUCUNE API publique d'usage sur Hobby : ni Active CPU, ni
 * invocations, ni stockage. Ce qui se compte, ce sont les deploiements — et
 * c'est loin d'etre anodin, puisque c'est leur accumulation qui a creve les
 * deux stockages le 11/09/2026. Le reste passe par une saisie manuelle.
 * ------------------------------------------------------------------ */
async function collectVercel(out: CollectorResult): Promise<void> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return;
  const headers = { Authorization: `Bearer ${token}` };
  const team = process.env.VERCEL_TEAM_ID;
  const teamQs = team ? `&teamId=${encodeURIComponent(team)}` : "";
  const project = process.env.VERCEL_PROJECT_ID || "aniscroll";

  try {
    const data = await fetchJson(
      `https://api.vercel.com/v6/deployments?app=${encodeURIComponent(project)}&limit=100${teamQs}`,
      { headers },
    );
    const deployments = data?.deployments || [];
    const now = Date.now();
    const since = (ms: number) =>
      deployments.filter((d: any) => d.created && now - d.created < ms).length;

    const day = since(86_400_000);
    const hour = since(3_600_000);
    const at = nowIso();

    out.measures["vercel.deployments-per-day"] = {
      used: day,
      at,
      source: "API Vercel",
      detail:
        deployments.length >= 100 && day >= 100
          ? "100 derniers deploiements seulement — valeur potentiellement tronquee"
          : "24 dernieres heures, tous environnements",
    };
    out.measures["vercel.builds-per-hour"] = {
      used: hour,
      at,
      source: "API Vercel",
      detail: "60 dernieres minutes",
    };
  } catch (e: any) {
    out.errors.Vercel = e?.message || String(e);
  }

  try {
    const projects = await fetchJson(
      `https://api.vercel.com/v9/projects?limit=100${teamQs ? "&" + teamQs.slice(1) : ""}`,
      { headers },
    );
    const list = projects?.projects || [];
    out.measures["vercel.projects"] = {
      used: list.length,
      at: nowIso(),
      source: "API Vercel",
    };

    const mine = list.find((p: any) => p.name === project || p.id === project);
    if (mine) {
      const domains = await fetchJson(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(mine.id)}/domains?limit=100${teamQs ? "&" + teamQs.slice(1) : ""}`,
        { headers },
      );
      const dlist = domains?.domains || [];
      out.measures["vercel.domains-per-project"] = {
        used: dlist.length,
        at: nowIso(),
        source: "API Vercel",
        detail: dlist.map((d: any) => d.name).slice(0, 6).join(", "),
      };
    }
  } catch (e: any) {
    // Un echec ici ne doit pas effacer le comptage de deploiements ci-dessus.
    out.errors.Vercel = out.errors.Vercel
      ? `${out.errors.Vercel} ; ${e?.message || e}`
      : e?.message || String(e);
  }
}

/**
 * Lance tous les collecteurs en parallele. Aucun ne peut faire echouer les
 * autres : chacun ecrit ses erreurs dans `errors` et rend la main.
 */
export async function collectAll(): Promise<CollectorResult> {
  const out: CollectorResult = { measures: {}, errors: {} };
  await Promise.all([
    collectUpstash(out),
    collectTurso(out),
    collectVercel(out),
  ]);
  return out;
}
