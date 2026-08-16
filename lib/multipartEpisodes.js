/**
 * Episodes that a SOURCE splits across several files.
 *
 * Not to be confused with tools/opening-detector/oped/multipart.py, which
 * handles the opposite shape: one long file that holds several broadcast
 * episodes. Here the broadcast episode is ONE episode and it is the host that
 * chopped it in two.
 *
 * The canonical case: Re:Zero S1 episode 1 is a 49-minute premiere. Anime-Sama
 * and voir-anime's VOSTFR carry it as a single file, but voir-anime's VF
 * upload is split into `…-01a-vf/` (25:07) and `…-01b-vf/` (24:07). Without
 * this table the VF episode 1 does not resolve AT ALL — buildVoiranimeEpRegex
 * needs `-<digits>(-vf)?/` at the end of the URL and `01a` never matches — so
 * the chip is simply absent.
 *
 * WHY A TABLE AND NOT A GENERIC RULE. Accepting `…-01a-/…-01b-` everywhere
 * would silently glue together episodes that are legitimately separate on other
 * titles (some sources letter their specials, recaps and split-cours that way).
 * Gluing two unrelated episodes is far worse than missing a split one: it
 * corrupts the timeline, the watch progress and every OP/ED timing derived from
 * it. So each entry is opted in by hand.
 *
 * Adding an entry:
 *   - `aniId`   AniList id of the SEASON (not the franchise).
 *   - `source`  resolver key, matching the `source` field in lib/servers.js.
 *   - `lang`    "vf" | "vostfr" — the split is per-language (Re:Zero's VOSTFR
 *               is NOT split, only the VF is).
 *   - `episode` the broadcast episode number the parts add up to.
 *   - `parts`   the URL suffix letters, IN PLAYBACK ORDER. Order is the whole
 *               contract: the merge concatenates blindly in this sequence.
 *   - `slug`    the source's own slug for the season. Only the offline OP/ED
 *               bridge needs it: it is invoked with a slug and no AniList id,
 *               so it cannot reach an entry by `aniId`.
 */

const MULTIPART_EPISODES = [
  {
    // Re:Zero kara Hajimeru Isekai Seikatsu (S1) — 49:10 premiere.
    aniId: 21355,
    source: "voiranime",
    lang: "vf",
    episode: 1,
    parts: ["a", "b"],
    slug: "rezero-kara-hajimeru-isekai-seikatsu-vf",
    note: "voir-anime VF splits the double-length premiere into 01a + 01b",
  },
];

/**
 * The part suffixes for an episode, in playback order, or null when the
 * episode is an ordinary single-file one (the overwhelming majority).
 */
export function getEpisodeParts(aniId, source, lang, episode) {
  const id = Number(aniId);
  const ep = Number(episode);
  if (!id || !ep) return null;
  const hit = MULTIPART_EPISODES.find(
    (e) =>
      e.aniId === id &&
      e.source === source &&
      e.lang === lang &&
      e.episode === ep,
  );
  return hit ? hit.parts : null;
}

/**
 * Same lookup, reached by the source's own slug instead of an AniList id.
 *
 * For the offline OP/ED bridge (tools/opening-detector/bridge/resolve.mjs),
 * which is handed a voir-anime slug and an episode range and never sees an
 * AniList id. Keeping it in this file means the detector and the player agree
 * on which episodes are split by construction — one table, two ways in.
 */
export function getPartsBySlug(slug, episode) {
  const ep = Number(episode);
  if (!slug || !ep) return null;
  const hit = MULTIPART_EPISODES.find((e) => e.slug === slug && e.episode === ep);
  return hit ? hit.parts : null;
}

export default MULTIPART_EPISODES;
