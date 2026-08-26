/**
 * Duree EXACTE d'un episode, sans faire travailler nos fonctions.
 *
 * AniList n'annonce qu'une moyenne par serie ("24 min"). La vraie duree, elle,
 * existe deja quelque part de gratuit : chaque soumission AniSkip porte le
 * `episodeLength` du fichier contre lequel elle a ete mesuree. Verifie sur Solo
 * Leveling S2 — AniSkip repond 1420 s, et le lecteur affiche 23:40 : c'est la
 * meme seconde.
 *
 * L'appel part du NAVIGATEUR vers api.aniskip.com (CORS ouvert), pas par une de
 * nos routes : zero invocation Vercel, zero Redis, zero scrape chez l'hote.
 * C'est ce qui a fait abandonner la premiere version, qui resolvait la source
 * de chaque episode pour lire son manifeste HLS — exact, mais au prix d'un
 * scrape par ligne affichee.
 *
 * Deux garde-fous restent utiles malgre la gratuite :
 *
 *   1. le resultat est memorise 30 jours dans le navigateur — la duree d'un
 *      fichier ne change pas ;
 *   2. l'appelant n'interroge que les lignes VISIBLES, deux a la fois, ce qui
 *      garde le rythme loin des 120 requetes/minute qu'AniSkip autorise.
 *
 * La duree mesuree par le lecteur reste prioritaire partout ou elle existe
 * (lib/watch/progress.ts) : c'est le fichier lui-meme, pas un tiers.
 */

const KEY = "aniscroll:runtimes";
/** Une duree ne bouge pas ; on la garde longtemps. */
const OK_TTL_MS = 30 * 24 * 3600 * 1000;
/** Une absence, elle, peut etre comblee par une soumission plus tard. */
const FAIL_TTL_MS = 7 * 24 * 3600 * 1000;

type Cached = { s: number | null; at: number };

function readCache(): Record<string, Cached> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeCache(key: string, value: Cached): void {
  if (typeof window === "undefined") return;
  try {
    const all = readCache();
    all[key] = value;
    // Purge a l'ecriture : ce store n'a pas d'autre occasion de maigrir, et un
    // catalogue entier de series finirait par saturer le quota.
    const now = Date.now();
    for (const [k, v] of Object.entries(all)) {
      const ttl = v.s == null ? FAIL_TTL_MS : OK_TTL_MS;
      if (now - v.at > ttl) delete all[k];
    }
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota / navigation privee — la duree est un confort, jamais une panne */
  }
}

export type RuntimeParams = {
  /** MAL id : la seule cle qu'AniSkip connaisse. Sans lui, pas de mesure. */
  malId?: number | string | null;
  episode: number;
};

function cacheKey(p: RuntimeParams): string {
  return `mal${p.malId}:${p.episode}`;
}

/** Duree deja connue pour cette ligne, sans aucune requete. */
export function peekRuntime(p: RuntimeParams): number | null {
  if (p.malId == null) return null;
  const hit = readCache()[cacheKey(p)];
  if (!hit) return null;
  const ttl = hit.s == null ? FAIL_TTL_MS : OK_TTL_MS;
  if (Date.now() - hit.at > ttl) return null;
  return hit.s;
}

/**
 * Duree exacte en secondes, ou null quand personne n'a encore mesure cet
 * episode.
 */
export async function fetchRuntime(
  p: RuntimeParams,
  signal?: AbortSignal,
): Promise<number | null> {
  if (p.malId == null || !Number.isFinite(p.episode)) return null;
  const known = peekRuntime(p);
  if (known != null) return known;
  const key = cacheKey(p);

  try {
    // `episodeLength=0` = "je ne connais pas encore la duree" ; AniSkip exige
    // le parametre depuis qu'il refuse la requete sans (HTTP 400), mais 0 reste
    // accepte et n'ecarte aucune soumission — c'est justement ce qu'on cherche.
    const url =
      `https://api.aniskip.com/v2/skip-times/${p.malId}/${p.episode}` +
      `?types%5B%5D=op&types%5B%5D=ed&episodeLength=0`;
    const res = await fetch(url, { signal });
    // 404 = aucune soumission pour cet episode. Ce n'est pas une panne, et on
    // le memorise pour ne pas re-demander a chaque defilement.
    if (!res.ok) {
      writeCache(key, { s: null, at: Date.now() });
      return null;
    }
    const body = await res.json();
    const lengths: number[] = (body?.results || [])
      .map((r: any) => Number(r?.episodeLength))
      .filter((n: number) => Number.isFinite(n) && n > 60);
    if (!lengths.length) {
      writeCache(key, { s: null, at: Date.now() });
      return null;
    }
    // Plusieurs soumissions peuvent viser des encodages differents (une VF plus
    // courte, un blu-ray plus long). La mediane evite qu'un intrus decide seul.
    lengths.sort((a, b) => a - b);
    const seconds = lengths[Math.floor(lengths.length / 2)];
    writeCache(key, { s: seconds, at: Date.now() });
    return seconds;
  } catch (e: any) {
    if (e?.name === "AbortError") return null;
    // Panne reseau : on ne memorise RIEN, sinon une coupure passagere
    // condamnerait la ligne a l'estimation pour une semaine.
    return null;
  }
}

/* File d'attente a deux voies : arriver au bas d'une longue liste ne doit pas
   partir en rafale vers AniSkip, qui plafonne a 120 requetes par minute. */
const MAX_INFLIGHT = 2;
let inflight = 0;
const queue: Array<() => void> = [];

function pump(): void {
  while (inflight < MAX_INFLIGHT && queue.length) {
    const next = queue.shift()!;
    inflight++;
    next();
  }
}

/** `fetchRuntime`, mais en respectant le plafond de requetes simultanees. */
export function queueRuntime(
  p: RuntimeParams,
  signal?: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve) => {
    queue.push(() => {
      fetchRuntime(p, signal)
        .catch(() => null)
        .then((v) => {
          inflight--;
          resolve(v);
          pump();
        });
    });
    pump();
  });
}

/* ------------------------------------------------------------------------- *
 * Durees PAR LECTEUR, servies par notre base (/api/v2/runtimes).
 *
 * C'est la source qui passe AVANT AniSkip, et pour deux raisons.
 *
 *   1. Elle est propre au LECTEUR ACTIF. AniSkip renvoie le `episodeLength` de
 *      l'encodage qu'un contributeur avait sous la main ; deux mensonges mesures
 *      dans ce fichier meme (cf. le bloc de choix dans episodeLists.tsx) venaient
 *      de la. Un episode chez ansembed et chez vidmoly-va n'a pas la meme duree.
 *   2. Elle coute UNE requete pour toute la saison, cachee au CDN et partagee
 *      entre tous les visiteurs — la ou AniSkip coutait une requete par ligne
 *      affichee, par appareil, sans jamais rien mutualiser.
 *
 * AniSkip reste dessous : la base ne couvre pas encore tout le catalogue, et un
 * episode que personne n'a lu sur cet hote n'y a pas de ligne.
 * ------------------------------------------------------------------------- */

type HostMap = Record<number, number>;

/** Saisons deja chargees, par (malId, serveur). Memoire de session : la valeur
 *  est deja cachee au CDN, on evite juste le re-fetch au changement d'onglet. */
const HOST_RUNTIMES = new Map<string, HostMap>();
const HOST_INFLIGHT = new Map<string, Promise<HostMap>>();

const hostKey = (malId: number | string, server: string) => `${malId}@${server}`;

/**
 * Charge (une fois) toutes les durees connues de cet anime sur CE lecteur.
 * Ne rejette jamais : sans base, sans reseau, ou sur un serveur inconnu du
 * registre, elle rend {} et l'affichage retombe sur ses autres sources.
 */
export function loadHostRuntimes(
  malId?: number | string | null,
  server?: string | null,
): Promise<HostMap> {
  if (malId == null || !server) return Promise.resolve({});
  const key = hostKey(malId, server);
  const done = HOST_RUNTIMES.get(key);
  if (done) return Promise.resolve(done);
  const running = HOST_INFLIGHT.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const res = await fetch(
        `/api/v2/runtimes/${malId}?server=${encodeURIComponent(server)}`,
      );
      if (!res.ok) return {};
      const json = await res.json();
      const map: HostMap = {};
      for (const [ep, s] of Object.entries(json?.runtimes || {})) {
        const n = Number(s);
        if (Number.isFinite(n) && n > 60) map[Number(ep)] = n;
      }
      HOST_RUNTIMES.set(key, map);
      return map;
    } catch {
      return {};
    } finally {
      HOST_INFLIGHT.delete(key);
    }
  })();
  HOST_INFLIGHT.set(key, p);
  return p;
}

/** Duree connue pour cette ligne sur ce lecteur, sans aucune requete. */
export function peekHostRuntime(
  malId: number | string | null | undefined,
  episode: number,
  server?: string | null,
): number | null {
  if (malId == null || !server) return null;
  const map = HOST_RUNTIMES.get(hostKey(malId, server));
  const s = map?.[episode];
  return typeof s === "number" ? s : null;
}

/* Une divergence par (episode, lecteur) ne se signale qu'une fois par session :
   la valeur envoyee est la meme a chaque tick de progression du lecteur. */
const REPORTED = new Set<string>();

/**
 * La duree que le LECTEUR vient de mesurer sur ce fichier. On la remonte quand
 * elle diverge de ce que la base disait — ou qu'elle ne disait rien.
 *
 * L'epsilon d'une demi-seconde n'est pas un seuil de tolerance : `video.duration`
 * est un flottant, et le meme fichier se declare 1420.0 ici et 1419.98 la selon
 * le lecteur. Sans elle, chaque lecture reecrirait la meme valeur en boucle.
 * Au-dela, tout ecart corrige la ligne — c'est ce qui rattrape un hote qui a
 * re-encode, sans jamais re-sonder a l'aveugle.
 */
export function reportHostRuntime(
  malId: number | string | null | undefined,
  episode: number,
  server: string | null | undefined,
  seconds: number,
): void {
  if (malId == null || !server) return;
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 4 * 3600) return;
  const known = peekHostRuntime(malId, episode, server);
  if (known != null && Math.abs(known - seconds) <= 0.5) return;
  const key = `${hostKey(malId, server)}:${episode}`;
  if (REPORTED.has(key)) return;
  REPORTED.add(key);

  const rounded = Math.round(seconds);
  // La memoire locale prend la correction tout de suite : la ligne affichee ne
  // doit pas attendre que le CDN expire pour montrer la bonne duree.
  const map = HOST_RUNTIMES.get(hostKey(malId, server));
  if (map) map[episode] = rounded;

  try {
    void fetch(`/api/v2/runtimes/${malId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episode, seconds: rounded, server }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* une duree est un confort, jamais une panne */
  }
}
