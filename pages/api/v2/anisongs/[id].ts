import type { NextApiRequest, NextApiResponse } from "next";
import { getTursoClient } from "@/lib/db/turso";
import { seasonCacheGet, seasonCacheSet } from "@/lib/db/seasonCache";
import { deezerTrack } from "@/lib/music/deezer";

/**
 * Les musiques d'un anime selon AnisongDB (anisongdb.com) — openings, endings
 * ET INSERTS, que AnimeThemes n'a pas.
 *
 *   GET /api/v2/anisongs/{anilistId}
 *
 * Choisi le 18/10/2026 par Luc après qu'AniPlaylist (pas d'API, clé Algolia
 * restreinte par referer) a été écarté. AnisongDB est la base du jeu Anime
 * Music Quiz : API publique documentée (/openapi.json), chaque morceau porte les
 * identifiants de son anime (`linked_ids`), et son fichier audio est servi par
 * AMQ avec CORS ouvert.
 *
 * STRICT PAR IDENTIFIANT. On interroge par MAL id (`mal_ids_request`) puis on
 * ne garde que les morceaux dont `linked_ids.anilist` est l'anime demandé :
 * Cyberpunk: Edgerunners ne ramène jamais Cyberpunk: Edgerunners 2. Sans MAL
 * id connu (table `anime`), on ne devine pas par le nom : liste vide.
 *
 * SANS DOUBLONS. Doublages et rediffusions écartés ; un même titre du même
 * artiste n'est gardé qu'une fois (la version la plus longue). Les OP/ED que
 * AnimeThemes a déjà sont écartés côté studio, par slug.
 *
 * ORDRE ET POCHETTES (18/10/2026, choix de Luc) : chaque morceau est cherché
 * sur Deezer (lib/music/deezer.ts), qui donne sa pochette et sa popularité
 * (`rank`). Les OP/ED restent en tête, dans leur ordre ; les autres musiques
 * suivent, de la plus écoutée à la moins écoutée. Celles que Deezer n'a pas
 * viennent après, rangées par le taux de reconnaissance d'AMQ
 * (`songDifficulty`) — un indice faible, faute de mieux.
 *
 * L'audio est la coupe DIFFUSÉE dans l'épisode (OP ~90 s, un insert tel qu'il
 * passe à l'écran), comme le fichier d'AnimeThemes : pas la version complète.
 */

const API = "https://anisongdb.com/api/mal_ids_request";
const AUDIO = "https://naedist.animemusicquiz.com/";
const KEY = (id: number) => `anisongs:v2:al${id}`;
/** Au-delà, on rend ce qu'on a, sans le garder (l'appel suivant recommence). */
const BUDGET_MS = 8000;

export type AnisongRow = {
  slug: string;
  kind: "op" | "ed" | "ins";
  song: string | null;
  artists: string[];
  /** La pochette Deezer, ou null (le studio montre alors l'affiche de l'anime). */
  cover: string | null;
  video: { url: string; audio: string; episodes: null };
  videoNc: null;
};

type Raw = {
  linked_ids?: { anilist?: number | null } | null;
  songType?: string;
  songName?: string;
  songArtist?: string;
  songLength?: number | null;
  songDifficulty?: number | null;
  isDub?: boolean;
  isRebroadcast?: boolean;
  audio?: string | null;
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Les morceaux de CET anime, sans doublages, rediffusions ni doublons. */
function pick(anilistId: number, raw: Raw[]): Raw[] {
  const kept = new Map<string, Raw>();
  for (const s of raw) {
    if (s.linked_ids?.anilist !== anilistId || s.isDub || s.isRebroadcast) continue;
    /* Le nom du fichier part dans une adresse : forme stricte. */
    if (!s.audio || !/^[\w-]+\.mp3$/.test(s.audio) || !s.songName) continue;
    const type = s.songType ?? "";
    const k = `${type.startsWith("Insert") ? "ins" : type}|${norm(s.songName)}|${norm(s.songArtist ?? "")}`;
    const had = kept.get(k);
    if (!had || (s.songLength ?? 0) > (had.songLength ?? 0)) kept.set(k, s);
  }
  return [...kept.values()].filter(
    (s) => /^(Opening|Ending)\s+\d+/.test(s.songType ?? "") || (s.songType ?? "").startsWith("Insert"),
  );
}

/** Les noms à chercher : l'artiste sans ses « feat. », barres et parenthèses. */
const who = (a: string) =>
  a
    .split(/\s+(?:feat\.?|ft\.?|&|x)\s+|\s*\/\s*|,\s*/i)
    .map((x) => x.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

/** Les lignes finales, dans l'ordre : OP, ED, puis le reste par popularité. */
function order(found: { s: Raw; rank: number | null; cover: string | null }[]): AnisongRow[] {
  const num = (s: Raw) => Number(/\d+/.exec(s.songType ?? "")?.[0] ?? 0);
  const typed = (k: string) => found.filter((f) => (f.s.songType ?? "").startsWith(k)).sort((a, b) => num(a.s) - num(b.s));
  const rest = found
    .filter((f) => (f.s.songType ?? "").startsWith("Insert"))
    .sort((a, b) =>
      a.rank != null && b.rank != null
        ? b.rank - a.rank
        : a.rank != null
          ? -1
          : b.rank != null
            ? 1
            : (b.s.songDifficulty ?? 0) - (a.s.songDifficulty ?? 0),
    );
  let ins = 0;
  return [...typed("Opening"), ...typed("Ending"), ...rest].map(({ s, cover }) => {
    const type = s.songType ?? "";
    const kind: AnisongRow["kind"] = type.startsWith("Opening") ? "op" : type.startsWith("Ending") ? "ed" : "ins";
    const slug = kind === "ins" ? `IN${++ins}` : `${kind.toUpperCase()}${num(s)}`;
    const url = AUDIO + s.audio;
    return {
      slug,
      kind,
      song: s.songName ?? null,
      artists: s.songArtist ? [s.songArtist] : [],
      cover,
      video: { url, audio: url, episodes: null },
      videoNc: null,
    };
  });
}

/** Pochette et popularité de chaque morceau, quatre à la fois, dans le budget.
    `complete` faux si Deezer a manqué un seul morceau : rien n'est gardé. */
async function withDeezer(list: Raw[]) {
  const out = list.map((s) => ({ s, rank: null as number | null, cover: null as string | null }));
  const end = Date.now() + BUDGET_MS;
  let complete = true;
  let next = 0;
  const worker = async () => {
    while (next < out.length) {
      const f = out[next++];
      if (Date.now() > end) {
        complete = false;
        return;
      }
      try {
        const t = await deezerTrack(f.s.songName ?? "", who(f.s.songArtist ?? ""));
        f.rank = t?.rank ?? null;
        f.cover = t?.cover ?? null;
      } catch {
        complete = false;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { found: out, complete };
}

async function malIdOf(anilistId: number): Promise<number | null> {
  const db = getTursoClient();
  if (!db) return null;
  try {
    const r = await db.execute({ sql: "SELECT id_mal FROM anime WHERE id = ? LIMIT 1", args: [anilistId] });
    const v = Number((r.rows[0] as any)?.id_mal);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const anilistId = Number(req.query.id);
  if (!Number.isInteger(anilistId) || anilistId <= 0) return res.status(400).json({ error: "id" });

  const cached = await seasonCacheGet<AnisongRow[]>(KEY(anilistId));
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800");
    return res.status(200).json({ songs: cached });
  }

  const malId = await malIdOf(anilistId);
  if (!malId) {
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    return res.status(200).json({ songs: [] });
  }

  let raw: Raw[];
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ mal_ids: [malId] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    raw = Array.isArray(json) ? json : [];
  } catch (e: any) {
    /* Une panne n'est pas « aucune musique » : rien n'est retenu. */
    console.warn(`[anisongs] ${anilistId}:`, e?.message);
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).json({ songs: [] });
  }

  const { found, complete } = await withDeezer(pick(anilistId, raw));
  const songs = order(found);
  if (!complete) {
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).json({ songs, partial: true });
  }
  await seasonCacheSet(KEY(anilistId), songs);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800");
  return res.status(200).json({ songs });
}
