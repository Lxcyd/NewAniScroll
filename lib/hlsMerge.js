/**
 * Concatenate several HLS playlists into ONE continuous playlist.
 *
 * Used for the split episodes described in lib/multipartEpisodes.js: a host
 * uploaded one broadcast episode as two files, and we want everything
 * downstream — the scrubber, seeking, watch progress, the OP/ED detector — to
 * see a single stream of the full duration instead of learning about the split.
 * Merging at the PLAYLIST level is what makes that possible: no player code has
 * to know, because there is nothing to know. The output is a normal VOD
 * playlist that happens to have an `#EXT-X-DISCONTINUITY` in the middle, which
 * hls.js (and ffmpeg) handle natively — that tag exists precisely to say "the
 * encoder parameters and timestamps restart here".
 *
 * Environment-agnostic on purpose. The browser (blob: URLs, no Referer control)
 * and the offline detector bridge (local files, Referer header required by
 * Vidmoly) both need this, so both I/O ends are injected:
 *   - `fetchText(url)`   → the playlist body as a string
 *   - `publish(text)`    → a URL the consumer can load the merged body from
 *
 * ADAPTIVE BITRATE IS PRESERVED. A naive merge picks one quality and throws the
 * rest away, which would make this one episode the only one in the app that
 * can't adapt to a weak connection. Instead we pair the parts' variants rank by
 * rank (highest bandwidth with highest bandwidth, …), merge each pair, and emit
 * a synthetic master listing them all. When the parts don't expose the same
 * number of variants we fall back to the top one — see mergeHlsPlaylists.
 */

/** Absolute URL for a playlist-relative URI. */
function absolutize(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

/** Rewrite the URI="…" attribute of a tag (EXT-X-KEY, EXT-X-MAP) to absolute. */
function absolutizeTagUri(line, base) {
  return line.replace(
    /URI="([^"]*)"/,
    (_, uri) => `URI="${absolutize(uri, base)}"`,
  );
}

/**
 * Variants of a master playlist, best first. Returns a single pseudo-variant
 * pointing at the playlist itself when `text` is already a media playlist —
 * some hosts hand out a media playlist under a "master.m3u8" name, and the
 * caller shouldn't have to care which shape it got.
 */
function parseMaster(text, url) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    // The URI is the next non-blank, non-comment line.
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith("#"))) j++;
    if (j >= lines.length) break;
    const bw =
      Number(lines[i].match(/[^-]BANDWIDTH=(\d+)/)?.[1]) ||
      Number(lines[i].match(/AVERAGE-BANDWIDTH=(\d+)/)?.[1]) ||
      0;
    variants.push({ attrs: lines[i], bandwidth: bw, url: absolutize(lines[j].trim(), url) });
    i = j;
  }
  if (variants.length === 0) return [{ attrs: null, bandwidth: 0, url, inline: text }];
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

/**
 * The body of a media playlist, stripped of everything that only makes sense
 * for a standalone playlist (header tags, ENDLIST) and with every URI made
 * absolute — segments are about to be referenced from a blob:/file: playlist
 * that shares no base URL with them.
 */
function parseMedia(text, url) {
  const out = [];
  let targetDuration = 0;
  let version = 3;
  let duration = 0;
  let encrypted = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-TARGETDURATION")) {
      targetDuration = Math.max(targetDuration, Number(line.split(":")[1]) || 0);
      continue;
    }
    if (line.startsWith("#EXT-X-VERSION")) {
      version = Math.max(version, Number(line.split(":")[1]) || 3);
      continue;
    }
    // Header / whole-playlist tags: re-emitted once by the merger, dropped here
    // so the second part doesn't restate them mid-playlist.
    if (
      line === "#EXTM3U" ||
      line === "#EXT-X-ENDLIST" ||
      line.startsWith("#EXT-X-MEDIA-SEQUENCE") ||
      line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE") ||
      line.startsWith("#EXT-X-PLAYLIST-TYPE") ||
      line.startsWith("#EXT-X-I-FRAME-STREAM-INF")
    ) {
      continue;
    }
    if (line.startsWith("#EXTINF")) {
      // `#EXTINF:10.0,` — the trailing comma introduces an optional title and
      // is always present, so it has to be dropped before parsing the number.
      duration += Number(line.slice(8).split(",")[0]) || 0;
      out.push(line);
      continue;
    }
    if (line.startsWith("#EXT-X-KEY") || line.startsWith("#EXT-X-MAP")) {
      if (line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/.test(line)) encrypted = true;
      out.push(absolutizeTagUri(line, url));
      continue;
    }
    if (line.startsWith("#")) {
      out.push(line);
      continue;
    }
    out.push(absolutize(line, url));
  }
  return { lines: out, targetDuration, version, duration, encrypted };
}

/** Merge N media-playlist bodies into one VOD playlist. */
function joinMedia(parts) {
  const targetDuration = Math.max(1, ...parts.map((p) => p.targetDuration));
  const version = Math.max(3, ...parts.map((p) => p.version));
  const out = [
    "#EXTM3U",
    `#EXT-X-VERSION:${version}`,
    `#EXT-X-TARGETDURATION:${Math.ceil(targetDuration)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  parts.forEach((part, i) => {
    // Between two independently-encoded files the timestamps, and possibly the
    // codec parameters, restart from scratch. This tag is the contract for
    // that; without it players either stall or mis-report the duration.
    if (i > 0) out.push("#EXT-X-DISCONTINUITY");
    out.push(...part.lines);
  });
  out.push("#EXT-X-ENDLIST");
  return out.join("\n") + "\n";
}

/**
 * Merge the playlists at `urls` (master or media) into one.
 *
 * Returns `{ url, duration, variants }` where `url` is what `publish` handed
 * back for the entry playlist and `duration` is the summed length in seconds —
 * the caller can sanity-check it against the expected episode length.
 *
 * Throws when a part can't be read or yields no segments: half an episode
 * served as a whole one is worse than no episode, because it silently
 * misplaces every timestamp that depends on it.
 */
export async function mergeHlsPlaylists(urls, { fetchText, publish }) {
  if (!Array.isArray(urls) || urls.length < 2) {
    throw new Error("mergeHlsPlaylists needs at least two playlists");
  }

  const parts = [];
  for (const url of urls) {
    const text = await fetchText(url);
    if (!text || !text.includes("#EXTM3U")) {
      throw new Error(`not an HLS playlist: ${url}`);
    }
    parts.push({ url, variants: parseMaster(text, url) });
  }

  // Pair variants rank by rank. If the parts disagree on how many they carry
  // (different encoder presets on two uploads is entirely possible) we keep
  // only the top one: serving a quality ladder whose rungs mean different
  // things in each half would make the ABR switch pick a mismatched pair.
  const counts = parts.map((p) => p.variants.length);
  const sameLadder = counts.every((c) => c === counts[0]);
  const rungs = sameLadder ? counts[0] : 1;

  const loadVariant = async (variant) => {
    const text = variant.inline ?? (await fetchText(variant.url));
    if (!text) throw new Error(`empty playlist: ${variant.url}`);
    const media = parseMedia(text, variant.url);
    if (!media.lines.some((l) => !l.startsWith("#"))) {
      throw new Error(`playlist has no segments: ${variant.url}`);
    }
    return media;
  };

  const merged = [];
  for (let rank = 0; rank < rungs; rank++) {
    const bodies = [];
    for (const part of parts) bodies.push(await loadVariant(part.variants[rank]));
    const text = joinMedia(bodies);
    merged.push({
      attrs: parts[0].variants[rank].attrs,
      duration: bodies.reduce((a, b) => a + b.duration, 0),
      encrypted: bodies.some((b) => b.encrypted),
      url: await publish(text, `media-${rank}`),
    });
  }

  if (merged.length === 1) {
    return {
      url: merged[0].url,
      duration: merged[0].duration,
      variants: 1,
      encrypted: merged[0].encrypted,
    };
  }

  const master = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const v of merged) {
    master.push(v.attrs, v.url);
  }
  return {
    url: await publish(master.join("\n") + "\n", "master"),
    // Every rung covers the same content, so any of them reports the duration.
    duration: merged[0].duration,
    variants: merged.length,
    encrypted: merged.some((v) => v.encrypted),
  };
}

/**
 * The playable duration of each playlist, in seconds.
 *
 * For the offline detector, which does NOT use the merged playlist above:
 * ffmpeg's HLS demuxer does not rebase timestamps across an
 * `#EXT-X-DISCONTINUITY` — measured, every seek past the junction decodes zero
 * bytes — so the bridge feeds the parts to the `concat` demuxer instead, which
 * does. That demuxer only knows the total length if each entry carries a
 * `duration` directive, and without a total `-sseof` (how the ED window is
 * anchored) silently yields nothing. Hence this: the durations are the part of
 * the merge the concat path still needs.
 */
export async function playlistDurations(urls, { fetchText }) {
  const out = [];
  for (const url of urls) {
    const text = await fetchText(url);
    if (!text || !text.includes("#EXTM3U")) {
      throw new Error(`not an HLS playlist: ${url}`);
    }
    // Rank 0 — the variant ffmpeg itself picks when handed a master playlist,
    // so the duration we advertise is the duration of the stream it will read.
    const variant = parseMaster(text, url)[0];
    const body = variant.inline ?? (await fetchText(variant.url));
    const media = parseMedia(body, variant.url);
    if (!media.duration) throw new Error(`playlist reports no duration: ${url}`);
    out.push(media.duration);
  }
  return out;
}

export default mergeHlsPlaylists;
