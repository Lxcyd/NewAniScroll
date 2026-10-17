import type { NextApiRequest, NextApiResponse } from "next";
import { fetchByMal, malIdsOf, pickSongs, songSlug } from "@/lib/music/anisongdb";

/**
 * Le nombre de génériques de plusieurs animés d'un coup — la ligne de chaque
 * anime du menu Musique du studio.
 *
 *   GET /api/v2/theme-counts?ids=99423,20954,120377   (AniList, 100 au plus)
 *
 * UN appel AnimeThemes pour toute la liste (filtre `external_id` en liste,
 * vérifié le 16/10/2026 : DARLING 8, Koe no Katachi 2, Cyberpunk 2, One Piece
 * 73). Avant, le compte n'apparaissait qu'après avoir ouvert l'anime.
 *
 * Pas de Turso : une lecture par id coûterait plus que l'appel lui-même. Le
 * CDN garde la réponse un jour, et la liste d'un même compte change peu. Un
 * anime absent de la réponse n'est pas sur AnimeThemes : compté 0.
 * Le compte est celui d'AnimeThemes, brut ; le studio le remplace par le
 * compte exact dès que l'anime est ouvert.
 *
 * PLUS LES MUSIQUES D'ANISONGDB (18/10/2026) : sans elles, une ligne disait
 * « 2 songs » et en montrait vingt une fois ouverte. Un seul appel AnisongDB
 * pour tout le paquet, et la MÊME sélection que la liste (pickSongs) : un
 * OP/ED qu'AnimeThemes a déjà n'est pas compté deux fois. AnisongDB en panne :
 * le compte d'AnimeThemes seul, pas mis en cache.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const ids = [
    ...new Set(
      String(req.query.ids ?? "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 100);
  if (!ids.length) return res.status(400).json({ error: "ids required" });

  const url =
    "https://api.animethemes.moe/anime?filter[has]=resources&filter[site]=AniList" +
    `&filter[external_id]=${ids.join(",")}` +
    "&include=resources,animethemes&fields[anime]=id&fields[animetheme]=id,slug" +
    "&fields[resource]=external_id,site&page[size]=100";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "NewAniScroll/1.0 (+studio-music)", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`animethemes ${r.status}`);
    const d = await r.json();
    const counts: Record<number, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    const slugs = new Map<number, Set<string>>();
    for (const a of d?.anime ?? []) {
      const list = Array.isArray(a?.animethemes) ? a.animethemes : [];
      for (const res of a?.resources ?? []) {
        const id = Number(res?.external_id);
        if (res?.site === "AniList" && id in counts && list.length >= counts[id]) {
          counts[id] = list.length;
          slugs.set(id, new Set(list.map((t: any) => String(t?.slug ?? "").toUpperCase())));
        }
      }
    }
    let complete = true;
    try {
      const mal = await malIdsOf(ids);
      const raw = await fetchByMal([...new Set(mal.values())]);
      for (const id of mal.keys()) {
        const have = slugs.get(id) ?? new Set<string>();
        for (const s of pickSongs(id, raw)) {
          const slug = songSlug(s);
          if (slug === null || (slug && !have.has(slug))) counts[id]++;
        }
      }
    } catch (e: any) {
      console.warn("[theme-counts] anisongdb", e?.message);
      complete = false;
    }
    res.setHeader(
      "Cache-Control",
      complete ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800" : "public, max-age=60, s-maxage=60",
    );
    return res.status(200).json({ counts });
  } catch (e: any) {
    console.warn("[theme-counts]", e?.message);
    /* Rien de mis en cache : la ligne attend simplement l'ouverture. */
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ counts: {} });
  }
}
