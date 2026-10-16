import type { NextApiRequest, NextApiResponse } from "next";
import { themesForAnime, type Theme } from "@/lib/animethemes/themes";
import { THEMES_KEY } from "@/lib/animethemes/themesKey";
import { seasonCacheGet, seasonCacheSet } from "@/lib/db/seasonCache";

/**
 * LA POCHETTE DE CHAQUE GÉNÉRIQUE — le menu Musique du studio de profil.
 *
 *   GET /api/v2/theme-covers/{anilistId}  →  { covers: { [slug]: url | null } }
 *
 * Deezer (API publique, sans clé) cherché par titre + artiste. La route prend
 * l'ID DE L'ANIME, jamais du texte libre : les clés de cache restent bornées et
 * elle ne peut pas servir de relais vers Deezer. Les thèmes sont relus dans le
 * cache de /api/v2/themes (même clé).
 *
 * LA RECHERCHE EST LIBRE (« titre artiste »), pas `artist:"…" track:"…"` : le
 * filtre strict ne trouve rien dès que le titre AnimeThemes porte une mention
 * (« KISS OF DEATH (Produced by HYDE) », 16/10/2026). On filtre ensuite sur
 * l'ARTISTE — sans lui, une pochette fausse vaut moins que pas de pochette — et
 * on garde le titre le plus proche (la version remix a sa propre pochette).
 *
 * Caches : Turso une semaine (season_cache), CDN une semaine. Une réponse sans
 * aucune pochette (Deezer en panne, ou rien de trouvé) n'est gardée qu'une heure.
 */
const COVERS_KEY = (anilistId: number) => `themecovers:v1:al${anilistId}`;
const DEEZER = "https://api.deezer.com/search";

type Hit = { title: string; artist: { name: string }; album: { cover_medium?: string } };

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (s: string) => new Set(norm(s).split(" ").filter(Boolean));
const VERSION = new Set(["remix", "ver", "version", "tv", "size", "instrumental", "acoustic", "live", "cover", "karaoke", "edit", "mix"]);

/** Le titre sans ses mentions entre parenthèses ou crochets. */
const bare = (s: string) => s.replace(/[([【].*?[)\]】]/g, " ").replace(/\s+/g, " ").trim();

async function search(q: string): Promise<Hit[]> {
  const r = await fetch(`${DEEZER}?q=${encodeURIComponent(q)}&limit=10`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`deezer ${r.status}`);
  const d = await r.json();
  return Array.isArray(d?.data) ? d.data : [];
}

async function coverFor(song: string, artists: string[]): Promise<string | null> {
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
    const hits = (await search(q)).filter((h) => sameArtist(h) && h.album?.cover_medium);
    if (hits.length) {
      hits.sort((a, b) => score(b) - score(a));
      return hits[0].album.cover_medium ?? null;
    }
    if (bare(song) === song) break;
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const anilistId = Number(req.query.id) || null;
  if (!anilistId) return res.status(400).json({ error: "id (AniList) required" });

  const cached = await seasonCacheGet<Record<string, string | null>>(COVERS_KEY(anilistId));
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800");
    return res.status(200).json({ covers: cached });
  }

  let themes = await seasonCacheGet<Theme[]>(THEMES_KEY(anilistId, null));
  if (!themes) {
    try {
      themes = await themesForAnime({ anilistId, malId: null });
    } catch {
      themes = [];
    }
  }

  /* Un titre par couple (chanson, artiste) : OP1 et sa version crédits ne
     coûtent qu'une recherche. Trois à la fois, loin de la limite Deezer
     (50 requêtes / 5 s). */
  const byKey = new Map<string, { song: string; artists: string[]; slugs: string[] }>();
  for (const th of themes) {
    if (!th.song) continue;
    const k = `${norm(th.song)}|${norm(th.artists[0] ?? "")}`;
    const e = byKey.get(k) ?? { song: th.song, artists: th.artists, slugs: [] };
    e.slugs.push(th.slug);
    byKey.set(k, e);
  }
  const covers: Record<string, string | null> = {};
  for (const th of themes) covers[th.slug] = null;
  const jobs = [...byKey.values()];
  let failed = false;
  for (let i = 0; i < jobs.length; i += 3) {
    await Promise.all(
      jobs.slice(i, i + 3).map(async (j) => {
        try {
          const url = await coverFor(j.song, j.artists);
          for (const s of j.slugs) covers[s] = url;
        } catch {
          failed = true;
        }
      }),
    );
  }

  const found = Object.values(covers).some(Boolean);
  if (found && !failed) await seasonCacheSet(COVERS_KEY(anilistId), covers);
  res.setHeader(
    "Cache-Control",
    found && !failed
      ? "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800"
      : "public, max-age=3600, s-maxage=3600",
  );
  return res.status(200).json({ covers });
}
