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
 * plays in ("1-13", free-form), and downloadable videos. Unlike the skip
 * detector we don't need in-episode timestamps here — the panel just plays the
 * OP/ED clip. We surface BOTH the creditless (NC) and the credited rip so the
 * player can offer a "with credits / without credits" toggle.
 */

const API = "https://api.animethemes.moe";
const USER_AGENT = "NewAniScroll/1.0 (+oped-dropdown)";

export type ThemeVideo = {
  /** Playable clip URL (v.animethemes.moe/*.webm). */
  url: string;
  /** No-credit (clean) rip — preferred for a standalone OP/ED player. */
  nc: boolean;
  /** Overlap with adjacent-episode footage: "None" | "Transition" | "Over". */
  overlap: string | null;
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
  /** Best playable video, NC-preferred (kept for backward compatibility — the
   *  default clip the player opens on). */
  video: ThemeVideo | null;
  /** Best creditless (NC) rip, or null if the theme only has credited rips. */
  videoNc: ThemeVideo | null;
  /** Best CREDITED rip (nc=false, overlap=None preferred), or null when
   *  AnimeThemes has no credited version. Powers the "with credits" toggle. */
  videoCredited: ThemeVideo | null;
  /**
   * The FULL-LENGTH song on YouTube, when it has been resolved.
   *
   * Not from AnimeThemes — it does not know it. Everything above is the anime's
   * own rip of the sequence, which is 90 s (ffprobe: ChainsawMan-OP1 = 90.1 s):
   * the TV size, not the track. This id is attached by /api/v2/themes/{id} from
   * the oped_youtube table, and only for rows the offline resolver marked `ok`.
   *
   * `undefined` = the field was never populated (a direct call to this module);
   * `null` = looked up and nothing servable. Both mean "play the 90 s rip".
   */
  youtubeId?: string | null;
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
    "fields[video]": "link,nc,overlap,resolution,source",
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

    // Two variants across every entry of this theme, so the player can toggle
    // "with credits" / "without credits". Mirrors the Python client's `_pick_video`.
    //   • NC:       cleanest creditless rip (nc=true), then highest resolution.
    //   • CREDITED: nc=false, overlap=None preferred (a Transition/Over rip
    //               splices in adjacent-episode footage), then resolution.
    let bestNc: ThemeVideo | null = null;
    let bestCredited: ThemeVideo | null = null;
    for (const e of t?.animethemeentries || []) {
      for (const v of e?.videos || []) {
        if (!v?.link) continue;
        const cand: ThemeVideo = {
          url: v.link,
          nc: !!v.nc,
          overlap: v.overlap ?? null,
          resolution: v.resolution ?? null,
          source: v.source ?? null,
          episodes: e?.episodes ?? null,
        };
        if (cand.nc) {
          if (!bestNc || rankNc(cand) > rankNc(bestNc)) bestNc = cand;
        } else {
          if (!bestCredited || rankCredited(cand) > rankCredited(bestCredited))
            bestCredited = cand;
        }
      }
    }
    // Default clip the player opens on: NC when available, else credited.
    const best = bestNc ?? bestCredited;

    out.push({
      slug: t?.slug || `${t?.type}${t?.sequence}`,
      kind: String(t?.type || "").toLowerCase() === "ed" ? "ed" : "op",
      sequence: t?.sequence ?? 0,
      song,
      artists,
      video: best,
      videoNc: bestNc,
      videoCredited: bestCredited,
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

/** Among NC rips: higher resolution wins. */
function rankNc(v: ThemeVideo): number {
  return v.resolution ?? 0;
}

/** Among credited rips: overlap=None (clean) first, then higher resolution.
 *  AnimeThemes returns overlap as the string "None" when absent. */
function rankCredited(v: ThemeVideo): number {
  const clean = v.overlap == null || v.overlap.toLowerCase() === "none";
  return (clean ? 1_000_000 : 0) + (v.resolution ?? 0);
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
