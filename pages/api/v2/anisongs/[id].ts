import type { NextApiRequest, NextApiResponse } from "next";
import { fetchByMal, malIdsOf, pickSongs, type AnisongRaw } from "@/lib/music/anisongdb";
import { seasonCacheGet, seasonCacheSet } from "@/lib/db/seasonCache";
import { deezerTrack, norm as dzNorm } from "@/lib/music/deezer";

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

const AUDIO = "https://naedist.animemusicquiz.com/";
/* v4 : les v3 calculées le 18/10/2026 pendant que pickSongs écartait les
   inserts (filtre `!== null` au lieu de `!== undefined`) étaient sans eux ;
   v5 : casse des titres que Deezer écrit lui-même en capitales. */
const KEY = (id: number) => `anisongs:v5:al${id}`;
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

type Raw = AnisongRaw;

/**
 * UNE CASSE NORMALE (18/10/2026). AnisongDB écrit presque tout en capitales
 * (« I REALLY WANT TO STAY AT YOUR HOUSE », « RAT BOY »). Un texte déjà en
 * casse mixte est gardé tel quel ; sinon chaque mot prend une majuscule
 * initiale, sauf « feat. » et les sigles à points (P.A.F.F.).
 */
function recase(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/[\p{L}\p{N}][\p{L}\p{N}'’.]*/gu, (w) => {
      if (/^feat\.?$|^ft\.?$/.test(w)) return w;
      if (/^(\p{L}\.){2,}$/u.test(w)) return w.toUpperCase();
      return w[0].toUpperCase() + w.slice(1);
    });
}

/** L'orthographe de Deezer quand c'est le même texte (et pas lui-même tout
    en capitales : « EVERYTHING IS CHANGING »), sinon `recase`. */
const spell = (mine: string, theirs: string | undefined) =>
  theirs && theirs !== theirs.toUpperCase() && dzNorm(theirs) === dzNorm(mine) ? theirs : recase(mine);

/** Les noms à chercher : l'artiste sans ses « feat. », barres et parenthèses. */
const who = (a: string) =>
  a
    .split(/\s+(?:feat\.?|ft\.?|&|x)\s+|\s*\/\s*|,\s*/i)
    .map((x) => x.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

/** Les lignes finales, dans l'ordre : OP, ED, puis le reste par popularité. */
type Found = { s: Raw; rank: number | null; cover: string | null; title?: string; artist?: string };
function order(found: Found[]): AnisongRow[] {
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
  return [...typed("Opening"), ...typed("Ending"), ...rest].map(({ s, cover, title, artist }) => {
    const type = s.songType ?? "";
    const kind: AnisongRow["kind"] = type.startsWith("Opening") ? "op" : type.startsWith("Ending") ? "ed" : "ins";
    const slug = kind === "ins" ? `IN${++ins}` : `${kind.toUpperCase()}${num(s)}`;
    const url = AUDIO + s.audio;
    return {
      slug,
      kind,
      song: s.songName ? spell(s.songName, title) : null,
      artists: s.songArtist ? [spell(s.songArtist, artist)] : [],
      cover,
      video: { url, audio: url, episodes: null },
      videoNc: null,
    };
  });
}

/** Pochette et popularité de chaque morceau, quatre à la fois, dans le budget.
    `complete` faux si Deezer a manqué un seul morceau : rien n'est gardé. */
async function withDeezer(list: Raw[]) {
  const out: Found[] = list.map((s) => ({ s, rank: null, cover: null }));
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
        f.title = t?.title;
        f.artist = t?.artist;
      } catch {
        complete = false;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { found: out, complete };
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

  const malId = (await malIdsOf([anilistId])).get(anilistId);
  if (!malId) {
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    return res.status(200).json({ songs: [] });
  }

  let raw: Raw[];
  try {
    raw = await fetchByMal([malId]);
  } catch (e: any) {
    /* Une panne n'est pas « aucune musique » : rien n'est retenu. */
    console.warn(`[anisongs] ${anilistId}:`, e?.message);
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).json({ songs: [] });
  }

  const { found, complete } = await withDeezer(pickSongs(anilistId, raw));
  const songs = order(found);
  if (!complete) {
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).json({ songs, partial: true });
  }
  await seasonCacheSet(KEY(anilistId), songs);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800");
  return res.status(200).json({ songs });
}
