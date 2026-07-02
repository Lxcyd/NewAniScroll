/**
 * AnimeThemes.moe runtime client — resolve an anime to its OP/ED themes and
 * their clean (NC) playable videos, for the info-page OP/ED dropdown.
 *
 * This is the runtime (Node/API-route) twin of the offline Python client in
 * `tools/opening-detector/oped/animethemes.py`. It intentionally mirrors that
 * module's lookup path and `episodes`-spec parsing so the two stay consistent:
 *
 *   MAL/AniList id  --/resource-->  anime slug  --/anime/{slug}-->  themes.
 *
 * Per theme AnimeThemes gives us the SONG (title + artists), which EPISODES it
 * plays in ("1-13", free-form), and a downloadable NC video. Unlike the skip
 * detector we don't need in-episode timestamps here — the dropdown just plays
 * the clean OP/ED clip, so the video `link` is all we surface.
 */

const API = "https://api.animethemes.moe";
const USER_AGENT = "NewAniScroll/1.0 (+oped-dropdown)";

export type ThemeVideo = {
  /** Playable clip URL (v.animethemes.moe/*.webm). */
  url: string;
  /** No-credit (clean) rip — preferred for a standalone OP/ED player. */
  nc: boolean;
  resolution: number | null;
  source: string | null;
  /** Free-form episode mapping from AnimeThemes (e.g. "1-13", "2-18, 20-25"). */
  episodes: string | null;
};

export type Theme = {
  /** "OP1", "ED2", … */
  slug: string;
  /** "op" | "ed" */
  kind: "op" | "ed";
  sequence: number;
  song: string | null;
  artists: string[];
  /** Best playable video for this theme (NC, then highest resolution). */
  video: ThemeVideo | null;
};

const _SITE = { mal: "MyAnimeList", anilist: "AniList" } as const;

async function get(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const res = await fetch(`${API}${path}?${qs.toString()}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`animethemes ${res.status}`);
  return res.json();
}

/** AniList/MAL id → AnimeThemes anime slug, via the canonical `/resource` map. */
export async function resolveSlug({
  malId,
  anilistId,
}: {
  malId?: number | null;
  anilistId?: number | null;
}): Promise<string | null> {
  let site: string;
  let ext: number;
  if (malId) {
    site = _SITE.mal;
    ext = malId;
  } else if (anilistId) {
    site = _SITE.anilist;
    ext = anilistId;
  } else {
    return null;
  }
  const data = await get("/resource", {
    "filter[site]": site,
    "filter[external_id]": ext,
    include: "anime",
    "fields[anime]": "slug,name",
    "fields[resource]": "site,external_id",
  });
  for (const r of data?.resources || []) {
    for (const a of r?.anime || []) {
      if (a?.slug) return a.slug as string;
    }
  }
  return null;
}

/** Fetch normalized OP/ED themes for an anime slug (best NC video per theme). */
export async function fetchThemes(slug: string): Promise<Theme[]> {
  const data = await get(`/anime/${encodeURIComponent(slug)}`, {
    include: "animethemes.animethemeentries.videos,animethemes.song.artists",
    "fields[anime]": "slug,name",
    "fields[animetheme]": "type,sequence,slug",
    "fields[animethemeentry]": "episodes,version,nsfw,spoiler",
    "fields[video]": "link,nc,resolution,source",
    "fields[song]": "title",
    "fields[artist]": "name",
  });
  const anime = data?.anime || {};
  const out: Theme[] = [];
  for (const t of anime?.animethemes || []) {
    const song = t?.song?.title ?? null;
    const artists: string[] = (t?.song?.artists || [])
      .map((a: any) => a?.name)
      .filter(Boolean);

    // Best playable video across every entry of this theme: prefer NC (clean,
    // no on-screen credits/subs), then highest resolution. Mirrors the Python
    // client's `entry_for_episode` ranking, but here we surface a single clip
    // for the whole theme (the dropdown plays the OP/ED itself, not per-episode).
    let best: ThemeVideo | null = null;
    for (const e of t?.animethemeentries || []) {
      for (const v of e?.videos || []) {
        if (!v?.link) continue;
        const cand: ThemeVideo = {
          url: v.link,
          nc: !!v.nc,
          resolution: v.resolution ?? null,
          source: v.source ?? null,
          episodes: e?.episodes ?? null,
        };
        if (!best || rankVideo(cand) > rankVideo(best)) best = cand;
      }
    }

    out.push({
      slug: t?.slug || `${t?.type}${t?.sequence}`,
      kind: String(t?.type || "").toLowerCase() === "ed" ? "ed" : "op",
      sequence: t?.sequence ?? 0,
      song,
      artists,
      video: best,
    });
  }
  // Stable, human order: OPs first then EDs, each by sequence.
  out.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "op" ? -1 : 1) ||
      a.sequence - b.sequence,
  );
  return out;
}

/** NC first, then higher resolution — same tiebreak the offline client uses. */
function rankVideo(v: ThemeVideo): number {
  return (v.nc ? 1_000_000 : 0) + (v.resolution ?? 0);
}

/** One-shot: id → themes (empty array when the anime isn't on AnimeThemes). */
export async function themesForAnime({
  malId,
  anilistId,
}: {
  malId?: number | null;
  anilistId?: number | null;
}): Promise<Theme[]> {
  const slug = await resolveSlug({ malId, anilistId });
  if (!slug) return [];
  return fetchThemes(slug);
}
