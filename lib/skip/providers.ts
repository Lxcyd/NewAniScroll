/**
 * The two CROWDSOURCED skip-time providers, and nothing else.
 *
 * Extracted from pages/api/v2/skip/[malId]/[episode].ts so the offline tooling
 * can query the exact same code the player is served by. They used to be
 * private to that route, which left an offline caller with only one option:
 * re-implement the calls. This project has already been bitten by exactly that
 * — the null/throw contract of the source route was honoured by anime-sama and
 * silently violated by the voir-anime copy, and every upstream hiccup became a
 * 6-hour "this host has no episode" for every visitor. One implementation, one
 * behaviour.
 *
 * What lives here: how to TALK to each provider. What does NOT live here: how
 * to choose between them. The merge policy (AniSkip first, Anime-Skip
 * overwriting on shared types) is a serving decision and stays in the route.
 *
 * Neither provider is ground truth. An empty answer means "nobody submitted
 * this", never "this episode has no opening" — coverage follows popularity, so
 * an old or niche title is silent whether or not it has themes. Do not read a
 * miss here as a verdict.
 */

export type Skip = {
  start: number;
  end: number;
  type: "op" | "ed";
  /** Present only on detector-sourced skips: "audio" | "video" | "mixed". Lets
   *  the player down-rank auto-skip on a coarser (video-only) timing later. */
  confidence?: string;
};

const ANIME_SKIP_ENDPOINT = "https://api.anime-skip.com/graphql";
const ANIME_SKIP_CLIENT_ID =
  process.env.ANIME_SKIP_CLIENT_ID ||
  // Shared rate-limited public client. Set ANIME_SKIP_CLIENT_ID in
  // env for a dedicated quota.
  "ZGfO0sMF3eCwLYf8yMSCJjlynwNGRXWE";

// Anime-Skip stores timestamps as POINTS (each marker is a single
// `at` second, not an interval). We map their free-form timestamp
// type names to our op/ed vocabulary; any point whose type isn't
// here is treated as a section boundary that terminates a preceding
// op/ed interval.
const ANIME_SKIP_TYPE: Record<string, "op" | "ed"> = {
  "New Intro": "op",
  Intro: "op",
  Branding: "op",
  "Mixed Intro": "op",
  "New Credits": "ed",
  "New Ending": "ed",
  Ending: "ed",
  "Mixed Credits": "ed",
  "Mixed Ending": "ed",
};

async function gql<T>(query: string, variables: any): Promise<T> {
  const res = await fetch(ANIME_SKIP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-ID": ANIME_SKIP_CLIENT_ID,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`anime-skip ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

export async function fetchFromAnimeSkip(
  aniListId: number,
  episode: number,
  episodeLength = 0,
): Promise<Skip[]> {
  // 1. AniList id → Anime-Skip showId(s). Anime-Skip can have MULTIPLE
  //    shows under the same external id (different submitters, different
  //    completeness levels). We previously hard-picked [0], which on
  //    Demon Slayer dropped us into a near-empty submission and missed
  //    the fully timestamped one sitting at index 1.
  const showRes = await gql<{
    findShowsByExternalId: Array<{ id: string }>;
  }>(
    `query($s: ExternalService!, $id: String!) {
       findShowsByExternalId(service: $s, serviceId: $id) { id }
     }`,
    { s: "ANILIST", id: String(aniListId) },
  );
  const showIds =
    showRes?.findShowsByExternalId?.map((s) => s.id).filter(Boolean) || [];
  if (showIds.length === 0) return [];

  // 2. Fetch every show's episode list in parallel and merge candidates
  //    for the requested episode number. Pick the candidate with the most
  //    op/ed timestamps after the points→intervals conversion — that's the
  //    "most useful" submission for the player.
  const epLists = await Promise.all(
    showIds.map((id) =>
      gql<{
        findEpisodesByShowId: Array<{
          number: string | null;
          absoluteNumber: string | null;
          timestamps: Array<{ at: number; type: { name: string } }>;
        }>;
      }>(
        // `baseDuration` is the rip the submission was timed against — the
        // Anime-Skip equivalent of AniSkip's per-result `episodeLength`. It was
        // never requested, so the picker below had nothing but "how many
        // markers" to go on and could hand back a submission timed on a
        // different cut.
        `query($id: ID!) {
           findEpisodesByShowId(showId: $id) {
             number absoluteNumber baseDuration
             timestamps { at type { name } }
           }
         }`,
        { id },
      ).catch(() => null),
    ),
  );

  // Points → intervals: pair each op/ed point with the NEXT point of any
  // kind to derive an end time. Returns the resulting Skip[] for one
  // episode submission.
  const toSkips = (
    timestamps: Array<{ at: number; type: { name: string } }>,
  ): Skip[] => {
    const sorted = [...timestamps].sort((a, b) => a.at - b.at);
    const out: Skip[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const mapped = ANIME_SKIP_TYPE[cur.type?.name];
      if (!mapped) continue;
      const next = sorted[i + 1];
      if (!next) continue;
      if (next.at - cur.at < 5) continue;
      out.push({
        start: Math.round(cur.at),
        end: Math.round(next.at),
        type: mapped,
      });
    }
    return out;
  };

  // Pick the submission timed against OUR rip when we know our duration, and
  // only fall back to "the most complete one" when we do not (or when the
  // submission does not declare a duration). Completeness was the old and only
  // criterion, which is the same trap as AniSkip's: the fullest set of markers
  // is worthless if it was timed on a different cut.
  const known = Math.round(episodeLength);
  let best: Skip[] = [];
  let bestGap = Infinity;
  for (const epList of epLists) {
    const episodes = epList?.findEpisodesByShowId || [];
    const ep =
      episodes.find((e) => Number(e.number) === episode) ||
      episodes.find((e) => Number(e.absoluteNumber) === episode);
    if (!ep) continue;
    const candidate = toSkips(ep.timestamps);
    if (!candidate.length) continue;
    const base = Number((ep as any).baseDuration) || 0;
    if (known > 0 && base > 0) {
      const gap = Math.abs(base - known);
      if (gap > CUT_TOLERANCE_S) continue; // different cut — never mix it in
      if (gap < bestGap || (gap === bestGap && candidate.length > best.length)) {
        best = candidate;
        bestGap = gap;
      }
    } else if (bestGap === Infinity && candidate.length > best.length) {
      // No duration to compare on either side: keep the historical behaviour.
      best = candidate;
    }
  }
  return best;
}

/**
 * How far a submission's own cut may sit from ours before we refuse it.
 *
 * AniSkip holds SEVERAL submissions per episode, each timed against a
 * different rip, and every result carries the `episodeLength` it was made
 * against. Measured on Shingeki no Kyojin episode 1:
 *
 *   asked 0     -> op 47.4 @1540.061 | ed 1342.8 @1446.997   (two DIFFERENT cuts)
 *   asked 1447  -> op 128.4 @1441.94 | ed 1342.8 @1446.997   (one coherent cut)
 *   asked 1540  -> op 47.4  @1540.06 | ed 1430.0 @1541.0     (another one)
 *
 * The first line is what this project was shipping: an opening timed on a
 * 1540 s rip served next to an ending timed on a 1447 s rip — 93 seconds
 * apart, so at most one of them can be right for the viewer's stream. An ED
 * is anchored from the end, so a cut mismatch moves it by the whole
 * difference; that is the failure this bound exists to stop.
 *
 * 8 s is deliberately tighter than AniSkip's own acceptance window (measured
 * ~±25-40 s): they optimise for answering, we optimise for not being wrong.
 */
const CUT_TOLERANCE_S = 8;

export async function fetchFromAniSkip(
  malId: number,
  episode: number,
  episodeLength: number,
): Promise<Skip[]> {
  // Send our REAL duration whenever we have it: AniSkip then picks the
  // submission timed against our rip instead of an arbitrary one. Sending 0
  // does not merely "disable their tiebreak" as this code used to claim — it
  // lets results from unrelated cuts come back together (see CUT_TOLERANCE_S).
  const params = new URLSearchParams();
  ["op", "ed"].forEach((t) => params.append("types[]", t));
  params.set("episodeLength", String(Math.max(0, Math.round(episodeLength))));
  const res = await fetch(
    `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?${params}`,
  );
  if (!res.ok) return [];
  const json = await res.json();
  const KEEP = new Set(["op", "ed"]);
  const raw = (json?.results || [])
    .filter((r: any) => KEEP.has(r?.skipType) && r?.interval)
    .map((r: any) => ({
      start: Math.round(r.interval.startTime),
      end: Math.round(r.interval.endTime),
      type: r.skipType as "op" | "ed",
      // The rip this submission was timed against — the field that makes the
      // check below possible. Not exposed on Skip: callers must not have to
      // know, the filtering is done here.
      cut: Number(r.episodeLength) || 0,
    }))
    .filter(
      (s: any) =>
        s.end > s.start && s.end - s.start >= 5 && !(s.type === "ed" && s.start < 3),
    );

  const known = Math.round(episodeLength);
  let kept: any[];
  if (known > 0) {
    // We know our own cut: keep only submissions timed against it.
    kept = raw.filter((s: any) => s.cut > 0 && Math.abs(s.cut - known) <= CUT_TOLERANCE_S);
  } else {
    // We do NOT know our cut (the overlay fires before the player reports a
    // duration, to keep the chapter pills instant). We cannot tell which
    // submission matches, but we CAN refuse to mix two: keep the answer only
    // when every result agrees on one cut. When they disagree we return
    // nothing and the caller re-asks once the real duration lands — a couple
    // of seconds without pills beats a Skip button that jumps to the wrong
    // place.
    const cuts = raw.map((s: any) => s.cut).filter((c: number) => c > 0);
    const coherent =
      cuts.length === raw.length &&
      (cuts.length === 0 || Math.max(...cuts) - Math.min(...cuts) <= CUT_TOLERANCE_S);
    kept = coherent ? raw : [];
  }
  return kept.map(({ start, end, type }: any) => ({ start, end, type }));
}
