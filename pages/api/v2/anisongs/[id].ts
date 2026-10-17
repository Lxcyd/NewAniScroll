import type { NextApiRequest, NextApiResponse } from "next";
import { getTursoClient } from "@/lib/db/turso";
import { seasonCacheGet, seasonCacheSet } from "@/lib/db/seasonCache";

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
 * L'audio est la coupe DIFFUSÉE dans l'épisode (OP ~90 s, un insert tel qu'il
 * passe à l'écran), comme le fichier d'AnimeThemes : pas la version complète.
 */

const API = "https://anisongdb.com/api/mal_ids_request";
const AUDIO = "https://naedist.animemusicquiz.com/";
const KEY = (id: number) => `anisongs:v1:al${id}`;

export type AnisongRow = {
  slug: string;
  kind: "op" | "ed" | "ins";
  song: string | null;
  artists: string[];
  video: { url: string; audio: string; episodes: null };
  videoNc: null;
};

type Raw = {
  linked_ids?: { anilist?: number | null } | null;
  songType?: string;
  songName?: string;
  songArtist?: string;
  songLength?: number | null;
  isDub?: boolean;
  isRebroadcast?: boolean;
  audio?: string | null;
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function toRows(anilistId: number, raw: Raw[]): AnisongRow[] {
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
  let ins = 0;
  const out: AnisongRow[] = [];
  for (const s of kept.values()) {
    const type = s.songType ?? "";
    const m = /^(Opening|Ending)\s+(\d+)/.exec(type);
    let slug: string;
    let kind: AnisongRow["kind"];
    if (m) {
      kind = m[1] === "Opening" ? "op" : "ed";
      slug = `${kind.toUpperCase()}${m[2]}`;
    } else if (type.startsWith("Insert")) {
      kind = "ins";
      slug = `IN${++ins}`;
    } else continue;
    const url = AUDIO + s.audio;
    out.push({
      slug,
      kind,
      song: s.songName ?? null,
      artists: s.songArtist ? [s.songArtist] : [],
      video: { url, audio: url, episodes: null },
      videoNc: null,
    });
  }
  return out;
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

  const songs = toRows(anilistId, raw);
  await seasonCacheSet(KEY(anilistId), songs);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800");
  return res.status(200).json({ songs });
}
