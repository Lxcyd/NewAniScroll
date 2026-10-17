/**
 * Un morceau sur Deezer (API publique, sans clé) : sa pochette et sa
 * popularité (`rank`). Partagé par /api/v2/theme-covers (pochettes des OP/ED)
 * et /api/v2/anisongs (pochettes et ordre des autres musiques, 18/10/2026).
 *
 * LA RECHERCHE EST LIBRE (« titre artiste »), pas `artist:"…" track:"…"` : le
 * filtre strict ne trouve rien dès que le titre porte une mention
 * (« KISS OF DEATH (Produced by HYDE) », 16/10/2026). On filtre ensuite sur
 * l'ARTISTE — sans lui, une pochette fausse vaut moins que pas de pochette — et
 * on garde le titre le plus proche (la version remix a sa propre pochette).
 */

const DEEZER = "https://api.deezer.com/search";

type Hit = { title: string; rank?: number; artist: { name: string }; album: { cover_medium?: string } };

export const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export const words = (s: string) => new Set(norm(s).split(" ").filter(Boolean));
export const VERSION = new Set(["remix", "ver", "version", "tv", "size", "instrumental", "acoustic", "live", "cover", "karaoke", "edit", "mix"]);

/** Le titre sans ses mentions entre parenthèses ou crochets. */
export const bare = (s: string) => s.replace(/[([【].*?[)\]】]/g, " ").replace(/\s+/g, " ").trim();

async function search(q: string): Promise<Hit[]> {
  const r = await fetch(`${DEEZER}?q=${encodeURIComponent(q)}&limit=10`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`deezer ${r.status}`);
  const d = await r.json();
  return Array.isArray(d?.data) ? d.data : [];
}

/**
 * Le morceau retrouvé, ou null. Lève si Deezer ne répond pas : une panne
 * n'est pas « introuvable », l'appelant ne doit pas la mettre en cache.
 */
export async function deezerTrack(
  song: string,
  artists: string[],
): Promise<{ cover: string | null; rank: number | null; title: string; artist: string } | null> {
  const names = artists.map(norm).filter(Boolean);
  if (!names.length) return null;
  const sameArtist = (h: Hit) => {
    const a = norm(h.artist?.name ?? "");
    return !!a && names.some((n) => a.includes(n) || n.includes(a));
  };
  const want = words(song);
  /* Mots communs entre le titre voulu et celui de Deezer, moins les mots en
     trop — et un mot de VERSION en trop (remix, ver., tv size…) pèse lourd :
     sans lui, « KISS OF DEATH (Produced by HYDE) » prenait la pochette du remix,
     plus riche en mots communs que l'original « Kiss of Death » (16/10/2026). */
  const score = (h: Hit) => {
    const got = words(h.title);
    let s = 0;
    for (const w of want) if (got.has(w)) s += 2;
    for (const w of got) if (!want.has(w)) s -= VERSION.has(w) ? 10 : 1;
    return s;
  };
  for (const q of [`${song} ${artists[0]}`, `${bare(song)} ${artists[0]}`]) {
    const hits = (await search(q)).filter(sameArtist);
    if (hits.length) {
      hits.sort((a, b) => score(b) - score(a));
      const h = hits[0];
      return {
        /* 120 px : la vignette s'affiche à 40 (80 sur écran dense). Même motif
           d'URL que `cover_medium` (250x250-…), en plus léger. */
        cover: h.album?.cover_medium?.replace("/250x250-", "/120x120-") ?? null,
        rank: typeof h.rank === "number" ? h.rank : null,
        /* L'orthographe de Deezer : sert à rendre leur casse aux titres écrits
           tout en majuscules ailleurs (AnisongDB). */
        title: h.title,
        artist: h.artist?.name ?? "",
      };
    }
    if (bare(song) === song) break;
  }
  return null;
}
