import type { NextApiRequest, NextApiResponse } from "next";
// Les deux fournisseurs participatifs vivent à part pour que les outils de
// mesure hors ligne appellent EXACTEMENT le même code que le lecteur — cf.
// l'en-tête de lib/skip/providers.ts.
import { fetchFromAniSkip, fetchFromAnimeSkip, type Skip } from "@/lib/skip/providers";

/**
 * Minutages PARTICIPATIFS d'un épisode (Anime-Skip, AniSkip).
 *
 *   GET /api/v2/skip/{malId}/{episode}?aniListId={id}&episodeLength={sec}
 *
 * C'est le REPLI : le client ne l'appelle que pour un épisode que notre
 * détecteur n'a pas servi sur le lecteur actif. Les minutages du détecteur
 * arrivent avec la saison, dans /api/v2/runtimes (lib/skip/prefetchSkips.ts).
 *
 * Aucune lecture de base ici. Jusqu'au 02/10/2026 cette route lisait
 * `oped_host_skips` puis `oped_skips` à chaque épisode ouvert — deux requêtes
 * Turso par épisode, pour deux tables vides — et portait un mode `?server=`
 * et un mode `hosts=1`. Un onglet resté sur l'ancien JS reçoit toujours `skips`,
 * le seul champ qu'il lit quand `hosts` est absent.
 *
 * Réponse : { source, skips: [{ start, end, type: "op" | "ed" }] }
 */
export const config = {
  api: { bodyParser: false },
};

type Source = "merged" | "anime_skip" | "aniskip" | "none";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const malId = Number(req.query.malId);
  const episode = Number(req.query.episode);
  const aniListId = Number(req.query.aniListId) || null;
  const episodeLength = Number(req.query.episodeLength) || 0;
  if (!malId || !episode) {
    return res.status(400).json({ error: "malId + episode required" });
  }

  // Les deux en parallèle : Anime-Skip a des intros très justes (saisie
  // manuelle) mais peu de fins ; AniSkip couvre largement les fins. On FUSIONNE
  // par type, Anime-Skip gagnant quand les deux ont le même.
  const [animeSkip, aniSkip] = await Promise.all([
    aniListId
      ? fetchFromAnimeSkip(aniListId, episode).catch((e: any) => {
          console.warn("[skip] anime-skip failed:", e?.message);
          return [] as Skip[];
        })
      : Promise.resolve([] as Skip[]),
    fetchFromAniSkip(malId, episode, episodeLength).catch((e: any) => {
      console.warn("[skip] aniskip failed:", e?.message);
      return [] as Skip[];
    }),
  ]);

  const byType = new Map<string, Skip>();
  for (const s of aniSkip) if (!byType.has(s.type)) byType.set(s.type, s);
  for (const s of animeSkip) byType.set(s.type, s);
  const skips = Array.from(byType.values()).sort((a, b) => a.start - b.start);

  let source: Source = "none";
  if (animeSkip.length && aniSkip.length) source = "merged";
  else if (animeSkip.length) source = "anime_skip";
  else if (aniSkip.length) source = "aniskip";

  // Un vide ne se cache que 60 s : 24 h sur `source=none` épinglerait la
  // réponse vide dans le navigateur même une fois l'amont réparé — c'est
  // arrivé quand AniSkip a changé son exigence sur episodeLength. Les 60 s
  // évitent seulement de re-solliciter les deux amonts à chaque montage.
  res.setHeader(
    "Cache-Control",
    source === "none"
      ? "public, max-age=60, s-maxage=60"
      : "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
  );
  return res.status(200).json({ source, skips });
}
