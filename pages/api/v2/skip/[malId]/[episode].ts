import type { NextApiRequest, NextApiResponse } from "next";
import { getOpedSkips, type OpedSkipRow } from "@/lib/db/opedSkips";
import { getHostSkip, type OpedHostSkipRow } from "@/lib/db/opedHostSkips";
import { serverToHost } from "@/lib/hostRegistry";
// Les deux fournisseurs participatifs vivent à part pour que les outils de
// mesure hors ligne appellent EXACTEMENT le même code que le lecteur — cf.
// l'en-tête de lib/skip/providers.ts.
import { fetchFromAniSkip, fetchFromAnimeSkip, type Skip } from "@/lib/skip/providers";

/**
 * Skip-times proxy.
 *
 *   GET /api/v2/skip/{malId}/{episode}?aniListId={id}&episodeLength={sec}&lang={lang}
 *
 * Source priority (precision-first):
 *   1. Our OWN offline OP/ED detector (oped_skips in Turso) — audio fingerprint
 *      vs the AnimeThemes clean clip, cross-host reconciled, fade edges extended
 *      by the video signal. Only rows the detector flagged `serve` (≥2 hosts
 *      agree, or 1 + video confirms) are returned — a doubtful timing is never
 *      shipped. An ED is re-projected onto the caller's real duration from its
 *      duration-independent `from_end_*` anchor, so a differently-trimmed encode
 *      stays correct.
 *   2. FALLBACK (temporary, while the detector's catalogue coverage ramps up):
 *      Anime-Skip then AniSkip — the crowdsourced sources. Used ONLY when the
 *      detector has no servable timing for this episode, so no episode loses its
 *      skip button during the transition.
 *
 * Response: { source, skips: [{ start, end, type: "op" | "ed", confidence? }] }
 *
 * The oped read is a single indexed Turso lookup (no Upstash); combined with the
 * 24 h Cache-Control below, the vast majority of hits are served by the CDN/
 * browser and never re-invoke this function.
 */
export const config = {
  api: { bodyParser: false },
};

/**
 * Garde de péremption — au-delà de cet écart entre la durée contre laquelle une
 * ligne a été mesurée et celle que le lecteur rapporte, on refuse de servir.
 *
 * Pourquoi elle existe : on stocke `duration` (par hôte) et `canonical_duration`
 * (réconcilié), et jusqu'ici la route ne les lisait JAMAIS. Or les hôtes
 * changent de fichier — le cache megaplay tourne, des uploads meurent et sont
 * remplacés. Le jour où un hôte réuploade un MONTAGE différent, la ligne stockée
 * devient un timing étranger servi avec pleine confiance, et **avant** le
 * participatif puisque nos lignes sont prioritaires. C'est exactement le défaut
 * qu'on a diagnostiqué chez AniSkip le 07/08 (3,3 % de réponses arithmétiquement
 * impossibles), en pire. Voir DEVLOG.md, « 2026-08-07 — Audit OP/ED », §6.
 *
 * Deux seuils, parce que les deux champs ne veulent pas dire la même chose :
 *
 * - PAR HÔTE, la durée stockée est celle de CET encodage précis. L'écart attendu
 *   se limite au bruit de mesure entre ffprobe et le lecteur. 10 s laisse passer
 *   ce bruit et arrête un remplacement de fichier.
 * - RÉCONCILIÉ, `canonical_duration` est la MÉDIANE de plusieurs encodages, qui
 *   diffèrent légitimement entre eux (mesuré : Erased ep1, 1372 s sur deux hôtes
 *   contre 1381 s sur un troisième). Un seuil serré y rejetterait des lignes
 *   valides ; 60 s n'attrape que le hors-sujet franc — mauvais épisode, film
 *   confondu avec un épisode.
 *
 * En cas de refus on ne renvoie pas vide : on retombe sur le participatif. Une
 * réponse imparfaite d'une source qu'on sait imparfaite vaut mieux qu'une
 * réponse fausse présentée comme la nôtre.
 *
 * NOTE — cette garde est aujourd'hui INERTE : aucun appelant n'envoie
 * `episodeLength` (voir lib/skip/prefetchSkips.ts, dont aucun site d'appel ne
 * remplit le champ), donc la re-projection de l'ED ne se produit pas non plus.
 * Elle est écrite maintenant pour être en place AVANT le premier import. La
 * faire mordre suppose que le client transmette la durée réelle — précisément le
 * changement qui a causé la régression revertée en 88170c1, à refaire avec la
 * porte de non-régression en place.
 */
const HOST_DURATION_TOLERANCE_S = 10;
const CANONICAL_DURATION_TOLERANCE_S = 60;

/** Vrai quand la ligne a été mesurée sur un média sensiblement différent de
 *  celui que le lecteur a sous les yeux. Une durée inconnue des deux côtés ne
 *  prouve rien : on ne bloque que sur un désaccord constaté. */
function durationMismatch(
  storedDuration: number | null | undefined,
  playerDuration: number,
  toleranceS: number,
): boolean {
  if (!storedDuration || storedDuration <= 0) return false;
  if (!playerDuration || playerDuration <= 0) return false;
  return Math.abs(storedDuration - playerDuration) > toleranceS;
}




export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const malId = Number(req.query.malId);
  const episode = Number(req.query.episode);
  const aniListId = Number(req.query.aniListId) || null;
  const episodeLength = Number(req.query.episodeLength) || 0;
  const lang = typeof req.query.lang === "string" ? req.query.lang : "vostfr";
  // The player's ACTIVE server (lib/servers.js id). When present it pins the
  // exact encode, which matters for the OP: its absolute start is encode-specific
  // (SnK ep1 OP is 2:02 on sibnet but 2:19 on megaplay), so a per-host row is the
  // only correct answer. Absent → fall back to the reconciled oped_skips below.
  const serverId = typeof req.query.server === "string" ? req.query.server : null;
  const mapped = serverId ? serverToHost(serverId) : null;
  // A mapped server also fixes the language (its id encodes vo/vf); use that for
  // every downstream lookup so the fallback reads the matching panel too.
  const effLang = mapped ? mapped.lang : lang;
  if (!malId || !episode) {
    return res.status(400).json({ error: "malId + episode required" });
  }

  // 0. PER-HOST: if we know which server the viewer is on, return that encode's
  //    own OP/ED (correct absolute OP; ED re-projected from its from_end anchor).
  if (mapped) {
    const hostRow = await getHostSkipSafe(malId, episode, mapped.lang, mapped.host);
    const hostStale =
      hostRow !== null &&
      durationMismatch(hostRow.duration, episodeLength, HOST_DURATION_TOLERANCE_S);
    if (hostStale) {
      console.warn(
        `[skip] ligne perimee ignoree: mal${malId} ep${episode} ${mapped.host} ` +
          `mesuree sur ${hostRow!.duration}s, lecteur a ${episodeLength}s`,
      );
    }
    if (hostRow && hostRow.serve && !hostStale) {
      const skips = hostRowToSkips(hostRow, episodeLength);
      if (skips.length) {
        res.setHeader(
          "Cache-Control",
          "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
        );
        return res
          .status(200)
          .json({ source: "oped-host", host: mapped.host, skips });
      }
    }
  }

  // 1. Our own detector first. Only servable rows; ED re-projected onto the
  //    caller's real duration from its from_end anchor.
  const oped = await getOpedSkipsSafe(malId, episode, effLang);
  const opedSkips = oped
    .filter((r) => r.serve)
    .filter((r) => {
      // Même garde que par hôte, seuil plus large : canonical_duration est une
      // médiane sur des encodages qui diffèrent légitimement entre eux.
      const stale = durationMismatch(
        r.canonicalDuration,
        episodeLength,
        CANONICAL_DURATION_TOLERANCE_S,
      );
      if (stale) {
        console.warn(
          `[skip] ligne reconciliee perimee ignoree: mal${malId} ep${episode} ` +
            `${r.kind} mesuree sur ${r.canonicalDuration}s, lecteur a ${episodeLength}s`,
        );
      }
      return !stale;
    })
    .map((r) => opedRowToSkip(r, episodeLength))
    .filter((s): s is Skip => s !== null)
    .sort((a, b) => a.start - b.start);
  if (opedSkips.length) {
    // 24 h cache like the crowdsourced path — this data is quasi-static.
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
    );
    return res.status(200).json({ source: "oped", skips: opedSkips });
  }

  // Fetch both in parallel — Anime-Skip tends to have very accurate
  // intros (manual curation) but spotty outro coverage; AniSkip has
  // broad outro coverage from crowdsourcing. We MERGE per-type with
  // Anime-Skip winning when both have the same type, and AniSkip
  // filling in whatever Anime-Skip is missing (typically the ed).
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
  // AniSkip first so Anime-Skip overwrites for shared types.
  for (const s of aniSkip) if (!byType.has(s.type)) byType.set(s.type, s);
  for (const s of animeSkip) byType.set(s.type, s);
  const skips: Skip[] = Array.from(byType.values()).sort(
    (a, b) => a.start - b.start,
  );

  let source: "oped" | "merged" | "anime_skip" | "aniskip" | "none" = "none";
  if (animeSkip.length && aniSkip.length) source = "merged";
  else if (animeSkip.length) source = "anime_skip";
  else if (aniSkip.length) source = "aniskip";

  // Cache hits only on success. A 24-hour cache on `source=none` would pin
  // the empty response in the browser even after the upstream API is fixed
  // or the data lands — bit us when AniSkip changed its episodeLength
  // requirement and every visitor kept seeing "no skips" for a full day.
  // Failures get a 60 s cushion so the SkipOverlay fetch fan-out (one per
  // mount) doesn't re-hammer both upstreams for the same anime+episode.
  if (source === "none") {
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  } else {
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
    );
  }
  return res.status(200).json({ source, skips });
}

/** Read one host's row without ever throwing into the request path. */
async function getHostSkipSafe(
  malId: number,
  episode: number,
  lang: string,
  host: string,
): Promise<OpedHostSkipRow | null> {
  try {
    return await getHostSkip(malId, episode, lang, host);
  } catch (e: any) {
    console.warn("[skip] host lookup failed:", e?.message);
    return null;
  }
}

/** Build the OP/ED skips for ONE host's encode. The OP start is absolute in this
 *  host's own encode (no re-projection — that's the whole point of per-host). The
 *  ED is re-projected from its host-independent from_end anchor onto the player's
 *  real duration, so a differently-trimmed encode of the SAME host stays right. */
function hostRowToSkips(r: OpedHostSkipRow, episodeLength: number): Skip[] {
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const out: Skip[] = [];

  if (r.opStart != null && r.opEnd != null) {
    let end = r.opEnd;
    if (episodeLength > 0) end = Math.min(end, episodeLength);
    if (end - r.opStart >= 5) {
      out.push({ start: round2(r.opStart), end: round2(end), type: "op", confidence: r.source });
    }
  }

  if (r.edStart != null && r.edEnd != null) {
    let start = r.edStart;
    let end = r.edEnd;
    if (episodeLength > 0 && r.edFromEndStart != null && r.edFromEndEnd != null) {
      start = Math.max(0, episodeLength - r.edFromEndStart);
      end = Math.max(start, episodeLength - r.edFromEndEnd);
    }
    if (episodeLength > 0) end = Math.min(end, episodeLength);
    if (end - start >= 5) {
      out.push({ start: round2(start), end: round2(end), type: "ed", confidence: r.source });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}

/** Read oped_skips without ever throwing into the request path — a DB hiccup
 *  must fall through to the crowdsourced fallback, never 500 the skip button. */
async function getOpedSkipsSafe(
  malId: number,
  episode: number,
  lang: string,
): Promise<OpedSkipRow[]> {
  try {
    return await getOpedSkips(malId, episode, lang);
  } catch (e: any) {
    console.warn("[skip] oped lookup failed:", e?.message);
    return [];
  }
}

/** Convert one stored detector row into a Skip, re-projecting the ED onto the
 *  player's real duration from its host-independent from_end anchor.
 *
 *  Why re-project: the stored ED start/end are absolute in the detector's
 *  CANONICAL (median) duration; the encode the user is actually watching can be
 *  a few seconds shorter/longer. `from_end_*` ("seconds before the end") is
 *  duration-independent, so `realDuration - from_end` puts the ED at the right
 *  spot on THIS encode. The OP (anchored from the start) needs no re-projection.
 */
function opedRowToSkip(r: OpedSkipRow, episodeLength: number): Skip | null {
  let start = r.start;
  let end = r.end;
  if (
    r.kind === "ed" &&
    episodeLength > 0 &&
    r.fromEndStart != null &&
    r.fromEndEnd != null
  ) {
    start = Math.max(0, episodeLength - r.fromEndStart);
    end = Math.max(start, episodeLength - r.fromEndEnd);
  }
  if (episodeLength > 0) end = Math.min(end, episodeLength);
  if (end - start < 5) return null; // sub-frame / degenerate — not worth a button
  // Keep sub-second precision: the detector now pins ED/OP edges to the image
  // transition to ~0.25s (dense credited refine), so rounding to whole seconds
  // here would throw that away and land the "last frame" up to a second off.
  // 2 decimals is well below the ~0.25s target and the DB already stores floats.
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    start: round2(start),
    end: round2(end),
    type: r.kind,
    confidence: r.source,
  };
}



