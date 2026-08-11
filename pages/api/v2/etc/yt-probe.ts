import type { NextApiRequest, NextApiResponse } from "next";

/**
 * GET /api/v2/etc/yt-probe?id=<11-char youtube id>
 *
 * TEMPORARY DIAGNOSTIC — delete once the question below is answered.
 *
 * THE QUESTION. Trailers are resolved by the Cloudflare Worker
 * (worker/src/youtube-trailer.js) and YouTube refuses it: measured over eight
 * real trailers, four came back `LOGIN_REQUIRED: Sign in to confirm you're not
 * a bot`. The same ANDROID client, on the same ids, answers perfectly from a
 * residential connection — so what is refused is the egress IP, not the client
 * and not the video. This route asks whether VERCEL's egress is refused too.
 *
 * It has to test BOTH halves, because they cannot be separated: googlevideo
 * signs the stream URL against the IP that asked for it (`ip=` inside
 * `sparams`), so whoever resolves must also be whoever downloads. A resolve
 * that succeeds here proves nothing until a fetch from here succeeds as well.
 *
 * Returns metadata only — a status, an itag, the first bytes' HTTP code. It
 * never streams video, so it cannot be used as a proxy.
 */

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const ANDROID_VERSION = "20.10.38";
const ANDROID_UA = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 15) gzip`;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");
  if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });

  const started = Date.now();
  let playability = "?";
  let reason: string | null = null;
  let itag: number | null = null;
  let byteStatus: number | null = null;
  let byteLength: number | null = null;

  try {
    const player = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": ANDROID_UA,
          "X-Youtube-Client-Name": "3",
          "X-Youtube-Client-Version": ANDROID_VERSION,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: ANDROID_VERSION,
              androidSdkVersion: 35,
              osName: "Android",
              osVersion: "15",
              hl: "en",
              gl: "US",
            },
          },
          videoId: id,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      },
    );
    if (!player.ok) {
      return res.status(200).json({ id, playability: `http ${player.status}`, ms: Date.now() - started });
    }
    const json: any = await player.json();
    playability = json?.playabilityStatus?.status ?? "?";
    reason = json?.playabilityStatus?.reason ?? null;

    const formats = json?.streamingData?.formats || [];
    const muxed =
      formats.find((f: any) => f.itag === 18 && f.url) ||
      formats.find(
        (f: any) => f.url && (f.mimeType || "").startsWith("video/mp4") && f.audioQuality,
      );
    itag = muxed?.itag ?? null;

    // The half that actually matters: can THIS machine pull the bytes the URL
    // it just minted points at.
    if (muxed?.url) {
      const head = await fetch(muxed.url, {
        headers: { "User-Agent": ANDROID_UA, Accept: "*/*", Range: "bytes=0-2047" },
      });
      byteStatus = head.status;
      const buf = await head.arrayBuffer().catch(() => null);
      byteLength = buf ? buf.byteLength : null;
    }
  } catch (err: any) {
    return res
      .status(200)
      .json({ id, playability: `threw ${err?.name || "?"}`, ms: Date.now() - started });
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    id,
    playability,
    reason,
    itag,
    byteStatus,
    byteLength,
    ms: Date.now() - started,
  });
}
