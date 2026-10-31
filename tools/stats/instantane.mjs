#!/usr/bin/env node
/**
 * L'INSTANTANE des statistiques du site, lu par la page admin « Statistiques »
 * (components/admin/stats, /api/v2/admin/site-stats).
 *
 * Pourquoi un instantane et pas des requetes a l'ouverture de la page : des
 * statistiques « sur tout » touchent des tables de 100 000 a 220 000 lignes, et
 * Turso facture chaque ligne lue (500 M par mois pour TOUTES les bases). Ici
 * chaque section est calculee une fois, son cout exact (`rows_read`) est
 * mesure et affiche ; la page ne lit ensuite qu'une quinzaine de lignes.
 *
 *   node tools/stats/instantane.mjs                sections dues (quotidiennes ; hebdo si > 6 j)
 *   node tools/stats/instantane.mjs --tout         toutes, maintenant
 *   node tools/stats/instantane.mjs --sections=a,b --sec   (--sec : n'ecrit rien, affiche)
 *
 * Ecrit dans la base ADMIN : `site_stats` (derniere valeur de chaque section)
 * et `site_stats_jour` (un resume chiffre par jour, pour les courbes).
 * Lit : Turso (4 bases), Cloudflare (GraphQL analytics), Upstash, Turso API,
 * GitHub (executions des automatisations). Jamais aniscroll.com.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of [".env", ".env.local"]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
}
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "1"];
}));

/* ── Turso par HTTP : les lignes ET le cout exact de chaque requete ───────── */
const BASES = {
  cache: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
  fanarts: ["TURSO_FANARTS_DATABASE_URL", "TURSO_FANARTS_AUTH_TOKEN"],
  admin: ["TURSO_ADMIN_URL", "TURSO_ADMIN_TOKEN"],
  users: ["TURSO_USERS_URL", "TURSO_USERS_TOKEN"],
};
let coutSection = 0;
const valeur = (c) => (c.type === "null" ? null : c.type === "integer" || c.type === "float" ? Number(c.value) : c.value);
async function sql(base, requete, params = []) {
  const [u, t] = BASES[base];
  if (!process.env[u] || !process.env[t]) throw new Error(`${u} absent`);
  const url = process.env[u].replace(/^libsql:/, "https:").replace(/\/$/, "");
  const arg = (v) => (v === null ? { type: "null" } : Number.isInteger(v) ? { type: "integer", value: String(v) } : typeof v === "number" ? { type: "float", value: v } : { type: "text", value: String(v) });
  const r = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env[t]}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: requete, args: params.map(arg) } }, { type: "close" }] }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => null);
  const res = j?.results?.[0];
  if (res?.type !== "ok") throw new Error(res?.error?.message ?? `HTTP ${r.status}`);
  const { cols, rows, rows_read } = res.response.result;
  coutSection += rows_read || 0;
  return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, valeur(row[i])])));
}
const un = async (base, requete, params) => (await sql(base, requete, params))[0] || {};
/** Une table qui peut manquer (base fraiche, fonction pas encore deployee). */
const peutManquer = async (p, defaut) => { try { return await p; } catch { return defaut; } };

const maintenant = Date.now();
const S = Math.floor(maintenant / 1000);
const J = 86400;

/* ── Les sections, DANS L'ORDRE de la page ────────────────────────────────── */
const SECTIONS = [];
const section = (id, cadence, fn) => SECTIONS.push({ id, cadence, fn });

/* Audience : Cloudflare voit toutes les requetes (le site est derriere lui
   depuis le 30/10/2026). `user_analytics` n'est plus alimentee depuis juillet. */
section("audience", "jour", async () => {
  const tok = process.env.CF_ZONE_API_TOKEN;
  if (!tok) return { indisponible: "CF_ZONE_API_TOKEN absent" };
  const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const z = await (await fetch("https://api.cloudflare.com/client/v4/zones?name=aniscroll.com", { headers: H })).json();
  const zone = z.result?.[0]?.id;
  if (!zone) return { indisponible: "zone Cloudflare introuvable" };
  const gql = async (query) => {
    const r = await (await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: H, body: JSON.stringify({ query }) })).json();
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return r.data.viewer.zones[0];
  };
  const d30 = new Date(maintenant - 30 * J * 1000).toISOString().slice(0, 10);
  const jours = (await gql(`{viewer{zones(filter:{zoneTag:"${zone}"}){ httpRequests1dGroups(limit:40, filter:{date_geq:"${d30}"}, orderBy:[date_ASC]){
    dimensions{date} uniq{uniques}
    sum{requests pageViews cachedRequests threats bytes cachedBytes
      countryMap{clientCountryName requests} browserMap{uaBrowserFamily pageViews}
      responseStatusMap{edgeResponseStatus requests} clientHTTPVersionMap{clientHTTPProtocol requests} } } }}}`)).httpRequests1dGroups;
  const cumul = (champ, cle, val) => {
    const m = {};
    for (const d of jours) for (const x of d.sum[champ] || []) m[x[cle]] = (m[x[cle]] || 0) + x[val];
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([nom, n]) => ({ nom, n }));
  };
  const parJour = jours.map((d) => ({
    jour: d.dimensions.date, visiteurs: d.uniq.uniques, requetes: d.sum.requests, pages: d.sum.pageViews,
    enCache: d.sum.cachedRequests, menaces: d.sum.threats, octets: d.sum.bytes,
  }));
  const depuis = new Date(maintenant - J * 1000).toISOString();
  const z24 = await gql(`{viewer{zones(filter:{zoneTag:"${zone}"}){
    chemins: httpRequestsAdaptiveGroups(limit:200, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}", clientRequestHTTPHost:"aniscroll.com", requestSource:"eyeball", clientRequestPath_notlike:"/_next/%"}){ count dimensions{clientRequestPath} }
    appareils: httpRequestsAdaptiveGroups(limit:10, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}", clientRequestHTTPHost:"aniscroll.com", requestSource:"eyeball"}){ count dimensions{clientDeviceType} }
    os: httpRequestsAdaptiveGroups(limit:12, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}", clientRequestHTTPHost:"aniscroll.com", requestSource:"eyeball"}){ count dimensions{userAgentOS} }
    hotes: httpRequestsAdaptiveGroups(limit:20, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}"}){ count dimensions{clientRequestHTTPHost cacheStatus} }
  }}}`);
  // Les pages par FAMILLE : /en/anime/watch/…, /en/anime/123, /api/v2/source…
  const famille = (p) => {
    const s = p.split("?")[0].split("/").filter(Boolean);
    if (!s.length) return "/";
    if (s[0] === "api") return `/${s.slice(0, 3).join("/")}`;
    if (s[0] === "en" && s[1] === "anime" && s[2] === "watch") return "/en/anime/watch/…";
    if (s[0] === "en" && s[1] === "anime" && /^\d/.test(s[2] || "")) return "/en/anime/[id]";
    if (s[0] === "en" && s[1] === "manga") return "/en/manga/[id]";
    if (s[0] === "en" && s[1] === "profile") return "/en/profile/…";
    return `/${s.slice(0, 2).join("/")}`;
  };
  const fam = {};
  for (const c of z24.chemins) fam[famille(c.dimensions.clientRequestPath)] = (fam[famille(c.dimensions.clientRequestPath)] || 0) + c.count;
  const hotes = {};
  for (const h of z24.hotes) {
    const x = (hotes[h.dimensions.clientRequestHTTPHost] ||= { nom: h.dimensions.clientRequestHTTPHost, n: 0, cache: 0 });
    x.n += h.count;
    if (["hit", "stale", "revalidated", "updating"].includes(h.dimensions.cacheStatus)) x.cache += h.count;
  }
  const tot = (k) => parJour.reduce((s, d) => s + (d[k] || 0), 0);
  const der = parJour.at(-1) || {};
  const sept = parJour.slice(-7);
  return {
    resume: {
      visiteursHier: parJour.at(-2)?.visiteurs ?? null, visiteursAujourdhui: der.visiteurs ?? null,
      visiteurs7j: sept.reduce((s, d) => s + d.visiteurs, 0), pages30j: tot("pages"), requetes30j: tot("requetes"),
      cache30j: tot("requetes") ? Math.round((tot("enCache") / tot("requetes")) * 100) : null,
      menaces30j: tot("menaces"), octets30j: tot("octets"),
    },
    parJour,
    pays: cumul("countryMap", "clientCountryName", "requests").slice(0, 20),
    navigateurs: cumul("browserMap", "uaBrowserFamily", "pageViews").slice(0, 12),
    statuts: cumul("responseStatusMap", "edgeResponseStatus", "requests"),
    http: cumul("clientHTTPVersionMap", "clientHTTPProtocol", "requests"),
    chemins24h: z24.chemins.slice(0, 25).map((c) => ({ nom: c.dimensions.clientRequestPath, n: c.count })),
    familles24h: Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([nom, n]) => ({ nom, n })),
    appareils24h: z24.appareils.map((x) => ({ nom: x.dimensions.clientDeviceType, n: x.count })),
    os24h: z24.os.map((x) => ({ nom: x.dimensions.userAgentOS || "inconnu", n: x.count })),
    hotes24h: Object.values(hotes).sort((a, b) => b.n - a.n),
  };
});

section("comptes", "jour", async () => {
  const ms = Date.now();
  const u = await un("users", `SELECT count(*) total,
      sum(email_verified_at IS NOT NULL) verifies, sum(anilist_id IS NOT NULL) anilist,
      sum(created_at >= ?) nouveaux7j, sum(created_at >= ?) nouveaux30j,
      sum(last_seen_at >= ?) actifs24h, sum(last_seen_at >= ?) actifs7j, sum(last_seen_at >= ?) actifs30j,
      sum(avatar_url IS NOT NULL OR anilist_avatar_url IS NOT NULL) avecAvatar, sum(profile_banner IS NOT NULL) avecBanniere
    FROM users`, [ms - 7 * J * 1000, ms - 30 * J * 1000, ms - J * 1000, ms - 7 * J * 1000, ms - 30 * J * 1000]);
  const roles = await sql("users", "SELECT role || ' / ' || status nom, count(*) n FROM users GROUP BY role, status ORDER BY n DESC");
  const inscriptions = await sql("users", "SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') mois, count(*) n FROM users GROUP BY mois ORDER BY mois");
  const donnees = await sql("users", "SELECT kind nom, count(*) n, sum(length(payload)) octets, max(updated_at) dernier FROM user_data GROUP BY kind ORDER BY n DESC");
  const jetons = await peutManquer(sql("users", "SELECT kind nom, count(*) n, sum(used_at IS NOT NULL) utilises, sum(expires_at > ?) valides FROM auth_tokens GROUP BY kind", [ms]), []);
  const throttle = await peutManquer(un("users", "SELECT count(*) n, sum(reset_at > ?) actifs FROM auth_throttle", [ms]), {});
  return { resume: { comptes: u.total, actifs7j: u.actifs7j, nouveaux30j: u.nouveaux30j }, comptes: u, roles, inscriptions, donnees, jetons, throttle };
});

section("lecteurs", "jour", async () => {
  const carte = await sql("cache", "SELECT source, lang, status, count(*) n FROM player_map GROUP BY source, lang, status");
  // Les raisons, regroupees : « verify:count 12/13 » -> « verify:count ».
  const notesBrutes = await sql("cache", "SELECT source, status, note, count(*) n FROM player_map WHERE status IN ('broken','absent') GROUP BY source, status, note");
  const notes = {};
  for (const r of notesBrutes) {
    const k = `${r.source} · ${r.status} · ${String(r.note || "(sans note)").replace(/ .*$/, "").replace(/: .*$/, "")}`;
    notes[k] = (notes[k] || 0) + r.n;
  }
  const origines = await sql("cache", `SELECT source, CASE WHEN note LIKE 'verify:alignement%' THEN 'alignement' WHEN note LIKE 'verify:ok%' THEN 'verificateur'
      WHEN note LIKE 'runtime%' THEN 'execution' WHEN note LIKE 'manuel%' THEN 'manuel' ELSE 'autre' END origine, count(*) n
    FROM player_map WHERE status = 'verified' GROUP BY 1, 2`);
  const as = await peutManquer(un("cache", `SELECT count(DISTINCT slug) fiches, count(*) panneaux, sum(nb_ep) episodes,
      sum(nb_vivants) vivants, sum(nb_morts) morts, sum(anilist_fiche IS NOT NULL) avecId, sum(nb_vivants > 0) jouables, max(maj_le) maj
    FROM as_panneau`), {});
  const asLangues = await peutManquer(sql("cache", "SELECT langue nom, count(*) panneaux, sum(nb_vivants) vivants FROM as_panneau GROUP BY langue ORDER BY vivants DESC"), []);
  const asGenres = await peutManquer(sql("cache", `SELECT CASE WHEN dossier LIKE 'saison%' THEN 'saisons' WHEN dossier LIKE 'film%' THEN 'films'
      WHEN dossier LIKE 'oav%' THEN 'OAV' WHEN dossier LIKE 'kai%' THEN 'kai' ELSE 'autres' END nom, count(*) panneaux, sum(nb_vivants) vivants
    FROM as_panneau GROUP BY 1 ORDER BY vivants DESC`), []);
  const va = await peutManquer(un("cache", `SELECT count(*) pages, sum(anilist IS NOT NULL) ancrees, sum(nb_ep) episodes,
      sum(nb_vivants) vivants, sum(nb_morts) morts, sum(nb_vivants > 0) jouables, max(maj_le) maj FROM va_page`), {});
  const vaLangues = await peutManquer(sql("cache", "SELECT langue nom, count(*) pages, sum(nb_vivants) vivants FROM va_page GROUP BY langue"), []);
  const vaTypes = await peutManquer(sql("cache", "SELECT coalesce(type, '?') nom, count(*) n FROM va_page GROUP BY type ORDER BY n DESC"), []);
  const vaAncres = await peutManquer(sql("cache", "SELECT coalesce(ancre, 'pas encore cherchee') nom, count(*) n FROM va_page GROUP BY ancre ORDER BY n DESC"), []);
  const frembed = await peutManquer(un("cache", "SELECT count(*) sondes, sum(hosted) heberges, max(checked_at) dernier FROM frembed_probe"), {});
  const perf = await peutManquer(sql("cache", "SELECT server_id nom, crit, ewma, n, updated_at FROM server_perf ORDER BY n DESC"), []);
  const runtimes = await peutManquer(sql("cache", "SELECT host || ' · ' || lang nom, count(*) n FROM episode_runtimes GROUP BY host, lang ORDER BY n DESC"), []);
  const doublages = await peutManquer(sql("cache", "SELECT lang nom, count(*) n FROM dub_catalog GROUP BY lang ORDER BY n DESC"), []);
  const verifies = carte.filter((r) => r.status === "verified").reduce((s, r) => s + r.n, 0);
  return {
    resume: { lignesVerifiees: verifies, asVivants: as.vivants ?? null, vaVivants: va.vivants ?? null },
    carte, notes: Object.entries(notes).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([nom, n]) => ({ nom, n })),
    origines, animeSama: { ...as, langues: asLangues, genres: asGenres },
    voirAnime: { ...va, langues: vaLangues, types: vaTypes, ancres: vaAncres },
    frembed, perf, runtimes, doublages,
    lecteurs: JSON.parse(fs.readFileSync(path.join(ROOT, "lib/lecteurs.json"), "utf8")).lecteurs,
  };
});

section("oped", "jour", async () => {
  const skips = await peutManquer(sql("cache", "SELECT kind || ' · ' || source || (CASE WHEN serve THEN '' ELSE ' (non servi)' END) nom, count(*) n FROM oped_skips GROUP BY kind, source, serve ORDER BY n DESC"), []);
  const parHote = await peutManquer(sql("cache", "SELECT host || ' · ' || lang nom, count(*) n FROM oped_host_skips GROUP BY host, lang ORDER BY n DESC"), []);
  const yt = await peutManquer(sql("cache", "SELECT coalesce(verdict, '?') nom, count(*) n FROM oped_youtube GROUP BY verdict ORDER BY n DESC"), []);
  const totalSkips = skips.reduce((s, r) => s + r.n, 0);
  return { resume: { skips: totalSkips, skipsParHote: parHote.reduce((s, r) => s + r.n, 0) }, skips, parHote, youtube: yt };
});

section("moderation", "jour", async () => {
  const b = await un("admin", `SELECT count(*) total, sum(resolved_at IS NULL) ouverts, sum(pending_at IS NOT NULL AND resolved_at IS NULL) enAttente,
      sum(created_at >= ?) nouveaux7j, sum(created_at >= ?) nouveaux30j FROM bug_reports`, [S - 7 * J, S - 30 * J]);
  const gravites = await sql("admin", "SELECT coalesce(severity, '?') nom, count(*) n, sum(resolved_at IS NULL) ouverts FROM bug_reports GROUP BY severity ORDER BY n DESC");
  const parMois = await sql("admin", "SELECT strftime('%Y-%m', created_at, 'unixepoch') mois, count(*) n FROM bug_reports GROUP BY mois ORDER BY mois");
  const resolution = await un("admin", "SELECT avg(resolved_at - created_at) moyenne FROM bug_reports WHERE resolved_at IS NOT NULL");
  const audit = await sql("admin", "SELECT action nom, count(*) n FROM audit_log GROUP BY action ORDER BY n DESC");
  const derniers = await sql("admin", "SELECT action, actor, target, created_at FROM audit_log ORDER BY created_at DESC LIMIT 10");
  const bans = await un("admin", "SELECT count(*) n FROM banned_ips");
  const annonce = await peutManquer(un("admin", "SELECT title, show_flag, start_at, end_at FROM broadcast ORDER BY updated_at DESC LIMIT 1"), {});
  return { resume: { signalementsOuverts: b.ouverts }, signalements: { ...b, resolutionMoyenneS: resolution.moyenne }, gravites, parMois, audit, derniers, bans: bans.n, annonce };
});

section("infra", "jour", async () => {
  const out = {};
  if (process.env.TURSO_API_TOKEN) {
    const { collectTurso } = await import("../usage-monitor/lib/turso.mjs");
    const t = await peutManquer(collectTurso(), null);
    if (t) out.turso = { lus: t.quota.rowsRead, plafond: t.quota.rowsReadLimit, ecrits: t.quota.rowsWritten ?? null, stockage: t.quota.storageBytes ?? null, finPeriode: t.quota.periodEnd, pct: t.usedPct, projection: t.projectedPct, hier: Object.fromEntries(Object.entries(t.perDb).map(([k, d]) => [k, d.rowsRead ?? null])) };
  }
  if (process.env.UPSTASH_EMAIL && process.env.UPSTASH_API_KEY) {
    const { fetchUpstashStats } = await import("../usage-monitor/lib/upstash.mjs");
    const s = await peutManquer(fetchUpstashStats({ email: process.env.UPSTASH_EMAIL, apiKey: process.env.UPSTASH_API_KEY, dbId: process.env.UPSTASH_DATABASE_ID }), null);
    if (s) out.upstash = { hier: s.yesterday, moyenne7j: s.avgPerDay7d, projection: s.projectedCapPct };
  }
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const r = await peutManquer(fetch(`${process.env.UPSTASH_REDIS_REST_URL}/dbsize`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }).then((x) => x.json()), null);
    if (r?.result != null) (out.upstash ||= {}).cles = r.result;
  }
  // Taille des tables (MAX(rowid) : 1 ligne lue par table, approximatif si des lignes ont ete effacees).
  out.tables = [];
  for (const base of Object.keys(BASES)) {
    const t = await peutManquer(sql(base, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' AND name NOT LIKE '_litestream%'"), []);
    for (const { name } of t) {
      const n = await peutManquer(un(base, `SELECT MAX(rowid) n FROM "${name}"`), {});
      out.tables.push({ base, nom: name, n: n.n ?? 0 });
    }
  }
  out.tables.sort((a, b) => b.n - a.n);
  return { resume: { tursoPct: out.turso?.pct ?? null, upstashProjection: out.upstash?.projection ?? null }, ...out };
});

section("automatisations", "jour", async () => {
  const repo = process.env.GITHUB_REPOSITORY || "Lxcyd/NewAniScroll";
  const H = { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const w = await (await fetch(`https://api.github.com/repos/${repo}/actions/workflows?per_page=100`, { headers: H })).json();
  const liste = [];
  for (const wf of (w.workflows || []).filter((x) => x.state === "active")) {
    const r = await (await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf.id}/runs?per_page=10&exclude_pull_requests=true`, { headers: H })).json();
    const runs = r.workflow_runs || [];
    const fini = runs.filter((x) => x.status === "completed");
    liste.push({
      nom: wf.name, fichier: wf.path.split("/").pop(),
      dernier: runs[0] ? { quand: runs[0].created_at, etat: runs[0].status === "completed" ? runs[0].conclusion : runs[0].status, url: runs[0].html_url, duree: runs[0].updated_at && runs[0].run_started_at ? Math.round((Date.parse(runs[0].updated_at) - Date.parse(runs[0].run_started_at)) / 1000) : null } : null,
      reussis10: fini.filter((x) => x.conclusion === "success").length, finis10: fini.length,
    });
  }
  liste.sort((a, b) => String(b.dernier?.quand || "").localeCompare(String(a.dernier?.quand || "")));
  const echecs = liste.filter((x) => x.dernier?.etat === "failure").length;
  return { resume: { automatisationsEnEchec: echecs }, workflows: liste };
});

/* ── Hebdomadaires : les grosses tables (~1,7 M de lignes lues au total) ──── */
section("catalogue", "semaine", async () => {
  const g = await sql("cache", `SELECT coalesce(format, '?') format, coalesce(status, '?') status, is_adult adulte,
      season_year annee, count(*) n, sum(expires_at < ?) perimes FROM anime GROUP BY 1, 2, 3, 4`, [S]);
  const somme = (cle) => {
    const m = {};
    for (const r of g) m[r[cle]] = (m[r[cle]] || 0) + r.n;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([nom, n]) => ({ nom, n }));
  };
  const decennies = {};
  for (const r of g) { const d = r.annee ? `${Math.floor(r.annee / 10) * 10}s` : "sans annee"; decennies[d] = (decennies[d] || 0) + r.n; }
  const annees = {};
  for (const r of g) if (r.annee && r.annee >= 2000) annees[r.annee] = (annees[r.annee] || 0) + r.n;
  const total = g.reduce((s, r) => s + r.n, 0);
  const perimes = g.reduce((s, r) => s + r.perimes, 0);
  const adultes = g.filter((r) => r.adulte).reduce((s, r) => s + r.n, 0);
  const persos = await un("cache", "SELECT count(*) n, sum(with_image) avecImage, sum(complete) complets FROM anime_characters");
  const musiques = await un("cache", "SELECT count(*) n, sum(n > 0) avecMusiques, sum(n) titres FROM aniplaylist_songs");
  const ids = await un("cache", `SELECT count(*) n, sum(mal_id IS NOT NULL) mal, sum(tmdb_tv_id IS NOT NULL OR tmdb_movie_id IS NOT NULL) tmdb,
      sum(tvdb_id IS NOT NULL) tvdb, sum(simkl_id IS NOT NULL) simkl FROM fribb_map`);
  const frembed = await sql("cache", "SELECT coalesce(kind, '?') nom, count(*) n FROM frembed_catalog GROUP BY kind ORDER BY n DESC");
  return {
    resume: { animes: total },
    total, perimes, adultes, formats: somme("format"), statuts: somme("status"),
    decennies: Object.entries(decennies).sort().map(([nom, n]) => ({ nom, n })),
    annees: Object.entries(annees).sort().map(([nom, n]) => ({ nom, n })),
    personnages: persos, musiques, identifiants: ids, frembed,
  };
});

section("images", "semaine", async () => {
  const f = await sql("fanarts", "SELECT type, coalesce(nsfw_label, 'non classe') label, count(*) n FROM anime_fanarts GROUP BY 1, 2");
  const fAnimes = await un("fanarts", "SELECT count(DISTINCT anime_id) n FROM anime_fanarts");
  const somme = (cle) => {
    const m = {};
    for (const r of f) m[r[cle]] = (m[r[cle]] || 0) + r.n;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([nom, n]) => ({ nom, n }));
  };
  const wh = await un("fanarts", `SELECT count(*) n, count(DISTINCT anime_id) animes, sum(has_character) personnages, sum(is_scenery) decors,
      sum(serie_ok = 1) serieOk, sum(serie_ok = 0) serieRefusee, sum(tagged_at IS NOT NULL) etiquetees FROM wallhaven_image`);
  const whTitres = await un("fanarts", "SELECT count(*) n, sum(images_prises > 0) avecImages, sum(total_dispo) dispo FROM wallhaven_titre");
  const whTypes = await sql("fanarts", "SELECT coalesce(facet_type, '?') nom, count(*) n FROM wallhaven_image GROUP BY facet_type ORDER BY n DESC");
  const tmdb = await un("fanarts", "SELECT (SELECT MAX(rowid) FROM tmdb_images_cache) images, (SELECT MAX(rowid) FROM tmdb_stills_cache) stills");
  const total = f.reduce((s, r) => s + r.n, 0);
  return { resume: { fanarts: total, wallhaven: wh.n }, fanarts: { total, animes: fAnimes.n, types: somme("type"), labels: somme("label") }, wallhaven: { ...wh, titres: whTitres, types: whTypes }, tmdb };
});

/* ── Programme ────────────────────────────────────────────────────────────── */
const SEC = !!args.sec;
const voulues = args.sections ? new Set(args.sections.split(",")) : null;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS site_stats (section TEXT PRIMARY KEY, data TEXT NOT NULL, calcule_le INTEGER NOT NULL, cout INTEGER, duree_ms INTEGER, erreur TEXT)`,
  `CREATE TABLE IF NOT EXISTS site_stats_jour (jour TEXT PRIMARY KEY, resume TEXT NOT NULL)`,
];
if (!SEC) for (const s of SCHEMA) await sql("admin", s);
const deja = SEC ? [] : await sql("admin", "SELECT section, calcule_le, data FROM site_stats");
const quand = new Map(deja.map((r) => [r.section, r.calcule_le]));
const resumes = {};
for (const r of deja) { try { resumes[r.section] = JSON.parse(r.data).resume || {}; } catch {} }

let coutTotal = 0;
for (const s of SECTIONS) {
  if (voulues && !voulues.has(s.id)) continue;
  const age = maintenant - (quand.get(s.id) || 0);
  if (!args.tout && !voulues && s.cadence === "semaine" && age < 6.5 * J * 1000) { console.log(`${s.id} : a jour (hebdomadaire)`); continue; }
  coutSection = 0;
  const t0 = Date.now();
  let data = null, erreur = null;
  try { data = await s.fn(); } catch (e) { erreur = e.message; }
  const duree = Date.now() - t0;
  coutTotal += coutSection;
  console.log(`${s.id} : ${erreur ? `ERREUR ${erreur}` : "ok"} — ${coutSection.toLocaleString("fr-FR")} lignes lues, ${duree} ms`);
  if (SEC) { console.log(JSON.stringify(data, null, 1).slice(0, 3000)); continue; }
  if (erreur) {
    // On garde la derniere valeur bonne ; seule l'erreur est notee.
    await sql("admin", `INSERT INTO site_stats (section, data, calcule_le, cout, duree_ms, erreur) VALUES (?, '{}', 0, ?, ?, ?)
      ON CONFLICT(section) DO UPDATE SET erreur = excluded.erreur`, [s.id, coutSection, duree, erreur]);
    continue;
  }
  resumes[s.id] = data.resume || {};
  await sql("admin", `INSERT INTO site_stats (section, data, calcule_le, cout, duree_ms, erreur) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, calcule_le = excluded.calcule_le, cout = excluded.cout, duree_ms = excluded.duree_ms, erreur = NULL`,
  [s.id, JSON.stringify(data), Date.now(), coutSection, duree]);
}
if (!SEC) {
  const jour = new Date().toISOString().slice(0, 10);
  const plat = Object.fromEntries(Object.entries(resumes).flatMap(([sec, r]) => Object.entries(r).map(([k, v]) => [`${sec}.${k}`, v])));
  await sql("admin", "INSERT INTO site_stats_jour (jour, resume) VALUES (?, ?) ON CONFLICT(jour) DO UPDATE SET resume = excluded.resume", [jour, JSON.stringify(plat)]);
}
console.log(`total : ${coutTotal.toLocaleString("fr-FR")} lignes lues`);
