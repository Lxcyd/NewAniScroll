import type { NextApiRequest, NextApiResponse } from "next";
import { fetchByMal, malIdsOf, pickSongs, type AnisongRaw } from "@/lib/music/anisongdb";
import { seasonCacheGet, seasonCacheGetEntry, seasonCacheSet } from "@/lib/db/seasonCache";
import { getAplSongs, type AplSong } from "@/lib/db/aniplaylistSongs";
import { THEMES_KEY } from "@/lib/animethemes/themesKey";
import { sameTitle, titleKey } from "@/lib/music/titleKey";
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
  video: { url: string; audio: string; episodes: string | null };
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

/** Pochette et popularité de chaque morceau, DIX à la fois (Deezer tolère
    ~50 requêtes / 5 s par IP : 18 morceaux tiennent en deux vagues, ~0,5 s au
    lieu de ~2 s à quatre, 18/10/2026), dans le budget.
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
  await Promise.all(Array.from({ length: 10 }, worker));
  return { found: out, complete };
}

/* ── ANIPLAYLIST (24/10/2026, Luc) ─────────────────────────────────────────
   Les morceaux relevés chaque jour sur AniPlaylist (lib/db/aniplaylistSongs)
   s'ajoutent à ceux d'AnisongDB AU MOMENT DE RÉPONDRE, jamais dans le cache
   d'une semaine : un relevé du jour se voit le jour même. Un morceau déjà
   donné par AnisongDB, ou par AnimeThemes (sa liste en cache), n'est pas
   repris — même titre, même type. Leurs OP/ED restants prennent les numéros
   suivants (le studio écarte un slug qu'AnimeThemes a déjà). */
const CDN = "https://cdn.aniplaylist.com/";
const KIND_ORDER = { op: 0, ed: 1, ins: 2 } as const;

async function withAniplaylist(anilistId: number, malId: number | undefined, songs: AnisongRow[]) {
  const apl = await getAplSongs(anilistId);
  if (!apl?.length) return { songs, added: 0 };
  /* La liste AnimeThemes telle que le studio la reçoit (clé sans MAL id),
     sinon celle de la page anime (clé MAL). */
  const themes =
    (await seasonCacheGet<{ slug: string; song?: string | null }[]>(THEMES_KEY(anilistId, null))) ??
    (malId ? await seasonCacheGet<{ slug: string; song?: string | null }[]>(THEMES_KEY(anilistId, malId)) : null) ??
    [];
  const known = [...songs.map((x) => titleKey(x.song)), ...themes.map((x) => titleKey(x.song))].filter(Boolean);
  const num = (slug: string, k: string) => (slug.toUpperCase().startsWith(k) ? Number(/\d+/.exec(slug)?.[0] ?? 0) : 0);
  const next = { OP: 0, ED: 0, IN: 0 };
  for (const x of [...songs, ...themes]) for (const k of ["OP", "ED", "IN"] as const) next[k] = Math.max(next[k], num(x.slug, k));
  const fresh = apl
    .filter((x) => {
      const k = titleKey(x.t);
      return !known.some((y) => sameTitle(k, y));
    })
    /* OP, puis ED, puis les inserts ; dans chaque groupe, le plus écouté d'abord. */
    .sort((a, b) => KIND_ORDER[a.k] - KIND_ORDER[b.k] || (b.s ?? 0) - (a.s ?? 0));
  const row = (x: AplSong): AnisongRow => {
    const k = x.k === "op" ? "OP" : x.k === "ed" ? "ED" : "IN";
    return {
      slug: `${k}${++next[k]}`,
      kind: x.k,
      song: x.t,
      artists: x.a,
      cover: x.c ? CDN + x.c : null,
      video: { url: x.p, audio: x.p, episodes: x.e },
      videoNc: null,
    };
  };
  const opEd = fresh.filter((x) => x.k !== "ins").map(row);
  const ins = fresh.filter((x) => x.k === "ins").map(row);
  /* L'ordre du studio : OP/ED d'abord, puis les inserts. */
  const head = songs.filter((x) => x.kind !== "ins");
  const tail = songs.filter((x) => x.kind === "ins");
  return { songs: [...head, ...opEd, ...tail, ...ins], added: opEd.length + ins.length };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const anilistId = Number(req.query.id);
  if (!Number.isInteger(anilistId) || anilistId <= 0) return res.status(400).json({ error: "id" });

  /* Les deux lectures Turso en même temps : à froid, la seconde ne s'ajoute
     plus à la première. */
  const [entry, malIds] = await Promise.all([
    seasonCacheGetEntry<AnisongRow[]>(KEY(anilistId)),
    malIdsOf([anilistId]),
  ]);
  const malId = malIds.get(anilistId);

  /* Toutes les réponses passent par ici : AniPlaylist ajouté, et un cache du
     bord d'un jour au plus quand il a ajouté quelque chose (relevé quotidien). */
  const send = async (base: AnisongRow[], cache: string, extra: Record<string, unknown> = {}) => {
    const { songs, added } = await withAniplaylist(anilistId, malId, base);
    res.setHeader("Cache-Control", added && cache !== BRIEF ? DAILY : cache);
    return res.status(200).json({ songs, ...extra });
  };

  /* UN VIDE SE REDEMANDE AU BOUT DE 6 H (24/10/2026), une liste pleine garde
     sa semaine : un anime qui vient de sortir n'a pas encore ses musiques
     (même piège que /api/v2/themes, Cyberpunk: Edgerunners 2). */
  const cached =
    entry && entry.ageSeconds <= (entry.value?.length ? WEEK : EMPTY_TTL) ? entry.value : null;
  if (cached) return send(cached, cached.length ? LONG : SHORT);

  if (!malId) return send([], SHORT);

  let raw: Raw[];
  try {
    raw = await fetchByMal([malId]);
  } catch (e: any) {
    /* Une panne n'est pas « aucune musique » : rien n'est retenu. */
    console.warn(`[anisongs] ${anilistId}:`, e?.message);
    return send([], BRIEF);
  }

  const { found, complete } = await withDeezer(pickSongs(anilistId, raw));
  const songs = order(found);
  if (!complete) return send(songs, BRIEF, { partial: true });
  await seasonCacheSet(KEY(anilistId), songs);
  return send(songs, songs.length ? LONG : SHORT);
}

const WEEK = 7 * 24 * 3600;
const EMPTY_TTL = 6 * 3600;
const LONG = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800";
const SHORT = "public, max-age=3600, s-maxage=3600";
const BRIEF = "public, max-age=60, s-maxage=60";
const DAILY = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
