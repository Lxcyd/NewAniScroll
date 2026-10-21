/**
 * Les episodes que les LECTEURS ont deja, meme quand AniList les annonce a venir.
 *
 * La liste d'episodes s'arrete a `nextAiringEpisode - 1` : c'est le calendrier
 * de la diffusion japonaise. Or une plateforme peut publier avant — cas signale
 * le 28/09/2026 : Steel Ball Run ep 2 en ligne sur anime-sama (sortie Netflix)
 * alors qu'AniList le disait « dans 3 j ». Le site cachait un episode jouable.
 *
 * Trois preuves :
 *   - une source RESOLUE pour l'episode N prouve que N existe ;
 *   - la route source signale `nextAired` quand le panneau anime-sama qu'elle
 *     vient de lire porte deja l'entree suivante (cf. pages/api/v2/source) ;
 *   - l'instantane de disponibilite d'un episode (/api/v2/availability) qui
 *     porte au moins un lecteur — c'est ce que la FICHE anime lit, elle qui ne
 *     resout aucune source (`checkAiredAhead`, 21/10/2026).
 *
 * Garde dans le navigateur une semaine (21/10/2026) : la fiche anime ouverte
 * apres la page de lecture disait encore « Pas encore sorti » pour l'episode
 * qu'on venait de regarder, la memoire de l'onglet etant perdue au chargement.
 */

const connus = new Map<string, number>(); // aniId → plus grand episode prouve
const abonnes = new Set<() => void>();

const STORE_KEY = "aniscroll:aired-ahead";
const STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let lu = false;

/** Relu une fois, a la premiere question : rien au rendu serveur. */
function charge(): void {
  if (lu || typeof window === "undefined") return;
  lu = true;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") as Record<string, { n: number; at: number }>;
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (v && Number.isFinite(v.n) && now - v.at < STORE_TTL_MS) connus.set(k, Math.max(connus.get(k) || 0, v.n));
    }
  } catch {
    /* stockage illisible : la memoire de l'onglet suffit */
  }
}

function garde(k: string, n: number): void {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") as Record<string, { n: number; at: number }>;
    const now = Date.now();
    for (const [key, v] of Object.entries(raw)) if (!v || now - v.at >= STORE_TTL_MS) delete raw[key];
    raw[k] = { n, at: now };
    localStorage.setItem(STORE_KEY, JSON.stringify(raw));
  } catch {
    /* stockage refuse : l'onglet garde quand meme la preuve */
  }
}

function prouve(aniId: number | string, n: number): void {
  charge();
  const k = String(aniId);
  if ((connus.get(k) || 0) >= n) return;
  connus.set(k, n);
  garde(k, n);
  abonnes.forEach((f) => f());
}

export function noteSourceResolved(aniId: number | string, episode: number | string, data: any): void {
  const n = Number(episode);
  if (!Number.isFinite(n) || n <= 0) return;
  prouve(aniId, data?.nextAired === true ? n + 1 : n);
}

/** Plus grand numero d'episode dont un lecteur a prouve l'existence (0 = aucun). */
export function airedAhead(aniId: number | string | null | undefined): number {
  if (aniId == null) return 0;
  charge();
  return connus.get(String(aniId)) || 0;
}

export function subscribeAiredAhead(f: () => void): () => void {
  abonnes.add(f);
  return () => {
    abonnes.delete(f);
  };
}

const demandes = new Set<string>();

/**
 * La fiche anime demande si l'episode `n` (le prochain au calendrier) est
 * deja en ligne : l'instantane de disponibilite, une lecture Redis cachee au
 * bord (10 min quand il existe, 1 min sinon). Une fois par onglet et par
 * episode ; rien si la preuve est deja la.
 */
export function checkAiredAhead(aniId: number, n: number): void {
  if (!aniId || !Number.isFinite(n) || n <= 0 || airedAhead(aniId) >= n) return;
  const k = `${aniId}:${n}`;
  if (demandes.has(k)) return;
  demandes.add(k);
  void Promise.all(
    (["sub", "dub"] as const).map((sub) =>
      fetch(`/api/v2/availability?aniId=${aniId}&episode=${n}&sub=${sub}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => Array.isArray(d?.servers) && d.servers.length > 0)
        .catch(() => false),
    ),
  ).then((oui) => {
    if (oui.some(Boolean)) prouve(aniId, n);
  });
}
