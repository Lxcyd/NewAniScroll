/**
 * Duree EXACTE d'un episode, telle que le lecteur la verrait.
 *
 * AniList n'annonce qu'une moyenne par serie ("24 min"), et le seul endroit ou
 * la vraie duree existe, c'est le fichier servi par le lecteur. On va donc la
 * chercher la : on resout la source de l'episode (la meme requete que la
 * lecture, `/api/v2/source`, deja mise en cache a l'edge), puis on lit le
 * manifeste HLS et on additionne ses `#EXTINF`. La somme est la duree du
 * fichier a la seconde pres — celle du serveur choisi, donc deux serveurs
 * peuvent legitimement ne pas annoncer la meme chose.
 *
 * Ce n'est pas gratuit : une resolution de source, c'est un scrape chez l'hote.
 * Trois garde-fous, dans cet ordre :
 *
 *   1. l'episode EN COURS n'est jamais sonde — le lecteur connait deja sa duree
 *      et la publie (lib/watch/progress.ts) ;
 *   2. le resultat est memorise 30 jours dans le navigateur : la duree d'un
 *      fichier ne change pas, donc une ligne n'est sondee qu'une fois par
 *      appareil (et l'edge sert les suivants) ;
 *   3. l'appelant ne sonde que les lignes VISIBLES, deux a la fois (la file
 *      ci-dessous) : ouvrir une serie de 1000 episodes ne declenche pas 1000
 *      scrapes, seulement ce que l'ecran montre.
 *
 * Un echec (iframe sans fichier lisible, mp4, hote muet) est memorise aussi,
 * mais brievement : inutile de re-sonder a chaque scroll un serveur qui ne
 * peut pas repondre, et inutile de s'interdire de reessayer demain.
 */

import { requestSource } from "@/lib/watch/sourceRequest";

const PROXY_BASE =
  (typeof process !== "undefined" &&
    (process as any).env?.NEXT_PUBLIC_PROXY_BASE) ||
  "https://proxy.aniscroll.com";

const KEY = "aniscroll:runtimes";
/** Une duree ne bouge pas ; on la garde longtemps. */
const OK_TTL_MS = 30 * 24 * 3600 * 1000;
/** Un echec, lui, merite d'etre retente — mais pas au prochain scroll. */
const FAIL_TTL_MS = 6 * 3600 * 1000;
/** Manifeste anormalement gros = piste ratee ; on n'avale pas 5 Mo pour ça. */
const MAX_MANIFEST_BYTES = 3_000_000;

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
    // Purge a l'ecriture : ce store n'a pas d'autre occasion de maigrir, et
    // un catalogue entier de series finirait par saturer le quota.
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
  aniId: number | string;
  episode: number;
  server: string;
  sub: "sub" | "dub";
  title?: string | null;
  malId?: number | string | null;
};

function cacheKey(p: RuntimeParams): string {
  return `${p.aniId}:${p.episode}:${p.server}:${p.sub}`;
}

/** Duree deja connue pour cette ligne, sans aucune requete. */
export function peekRuntime(p: RuntimeParams): number | null {
  const hit = readCache()[cacheKey(p)];
  if (!hit) return null;
  const ttl = hit.s == null ? FAIL_TTL_MS : OK_TTL_MS;
  if (Date.now() - hit.at > ttl) return null;
  return hit.s;
}

function proxied(url: string, referer?: string | null): string {
  const ref = referer ? `&referer=${encodeURIComponent(referer)}` : "";
  return `${PROXY_BASE}?url=${encodeURIComponent(url)}${ref}`;
}

/** Somme des `#EXTINF` d'un manifeste de segments. */
function sumExtinf(manifest: string): number {
  let total = 0;
  for (const line of manifest.split("\n")) {
    if (!line.startsWith("#EXTINF:")) continue;
    const v = parseFloat(line.slice(8));
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

/** Premiere variante d'un manifeste maitre, resolue en URL absolue. */
function firstVariant(manifest: string, base: string): string | null {
  const lines = manifest.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const next = lines[i + 1]?.trim();
    if (!next || next.startsWith("#")) continue;
    try {
      return new URL(next, base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

async function readManifest(
  url: string,
  referer: string | null | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(proxied(url, referer), { signal });
  if (!res.ok) return null;
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_MANIFEST_BYTES) return null;
  return res.text();
}

/**
 * Duree exacte en secondes, ou null quand ce serveur ne permet pas de la lire
 * (embed iframe, mp4 brut, extraction cote client, hote injoignable).
 */
export async function fetchRuntime(
  p: RuntimeParams,
  signal?: AbortSignal,
): Promise<number | null> {
  const known = peekRuntime(p);
  if (known != null) return known;
  const key = cacheKey(p);

  const fail = () => {
    writeCache(key, { s: null, at: Date.now() });
    return null;
  };

  try {
    const out = await requestSource(
      {
        server: p.server,
        aniId: p.aniId,
        episode: p.episode,
        sub: p.sub,
        title: p.title ?? null,
        malId: p.malId ?? null,
      },
      // `low` : ces requetes ne doivent jamais passer devant la source que
      // l'utilisateur attend vraiment, celle de l'episode qu'il regarde.
      { signal, priority: "low" },
    );
    if (out.kind !== "ok") return fail();

    const data: any = out.data;
    // Un embed n'expose aucun fichier a mesurer, et une extraction cote client
    // demanderait de rejouer tout le pipeline du lecteur pour un libelle.
    if (data?.clientExtract || (!data?.streams?.length && !data?.sources?.length)) {
      return fail();
    }
    const stream = data.streams?.[0] || data.sources?.[0];
    const url: string = stream?.url;
    if (!url) return fail();
    const isM3U8 =
      stream.isM3U8 === true || (stream.isM3U8 !== false && url.includes(".m3u8"));
    // Un mp4 ne porte sa duree que dans son entete binaire : la lire
    // couterait un telechargement partiel par episode, hors de proportion.
    if (!isM3U8) return fail();

    const referer = stream.referer || data.referer;
    let manifest = await readManifest(url, referer, signal);
    if (!manifest) return fail();

    if (manifest.includes("#EXT-X-STREAM-INF")) {
      const variant = firstVariant(manifest, url);
      if (!variant) return fail();
      manifest = await readManifest(variant, referer, signal);
      if (!manifest) return fail();
    }

    const seconds = sumExtinf(manifest);
    // Sous une minute, c'est une piste de garde ou un manifeste tronque, pas
    // un episode : mieux vaut ne rien afficher qu'un chiffre faux.
    if (!(seconds > 60)) return fail();
    writeCache(key, { s: seconds, at: Date.now() });
    return seconds;
  } catch (e: any) {
    if (e?.name === "AbortError") return null;
    return fail();
  }
}

/* File d'attente a deux voies. Les sondes partent au fil du defilement ; sans
   plafond, arriver au bas d'une longue liste lancerait vingt scrapes d'un coup
   chez le meme hote — le genre de rafale qui reveille les anti-bots et fait
   echouer la lecture elle-meme. */
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
