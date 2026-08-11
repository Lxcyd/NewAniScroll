import { trailerSrc } from "./trailerCrop";

/**
 * Is a trailer worth showing to THIS visitor?
 *
 * A trailer can fail for two reasons that look identical from the browser and
 * deserve opposite treatment:
 *
 *   - the video is unavailable in this region (not released here, made private,
 *     deleted, age-gated). Nothing will ever make it play, and both the info
 *     page's trailer block and the preview card's player are pointing at a dead
 *     end — better not to offer them at all;
 *   - YouTube refused OUR proxy (`Sign in to confirm you're not a bot`, which
 *     it hands a datacentre caller about half the time on a cold lookup). The
 *     video is perfectly fine; this says nothing about it.
 *
 * Hiding on the second would be the worse bug: Death Note's trailer plays in
 * France, and a naive "it failed, hide it" would have removed it from the page
 * on the day our egress happened to be refused, then put it back the next day.
 * So only a `gone` verdict ever hides anything.
 *
 * The worker answers the distinction (see worker/src/youtube-trailer.js), from
 * a colo in the visitor's own region — which is what makes "unavailable here"
 * mean their country and not ours.
 */

export type Verdict = "ok" | "gone" | "unknown";

const STORE_KEY = "as-trailer-verdict-v1";
/**
 * How long a verdict is trusted locally.
 *
 * A week for `gone`, not forever: a regional block gets lifted, a private video
 * comes back. Long enough that a visitor never re-asks about the same dead
 * trailer, short enough that a resurrected one returns on its own.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Stored = { v: Verdict; at: number };

function read(id: string): Verdict | null {
  try {
    const raw = window.localStorage.getItem(`${STORE_KEY}:${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed?.v || Date.now() - parsed.at > TTL_MS) return null;
    return parsed.v;
  } catch {
    return null;
  }
}

function write(id: string, v: Verdict) {
  // `unknown` is not a fact about the video, so it is never written down.
  if (v === "unknown") return;
  try {
    window.localStorage.setItem(`${STORE_KEY}:${id}`, JSON.stringify({ v, at: Date.now() }));
  } catch {
    /* private mode — we simply ask again next time */
  }
}

/** What we already know, without asking anyone. Null when we have never looked. */
export function peekVerdict(id: string): Verdict | null {
  if (typeof window === "undefined") return null;
  return read(id);
}

/** Record what a real playback attempt discovered, so nothing asks twice. */
export function noteVerdict(id: string, v: Verdict) {
  if (typeof window === "undefined") return;
  write(id, v);
}

/** In flight, so two components mounting at once share one request. */
const pending = new Map<string, Promise<Verdict>>();

/**
 * Set when the worker turns out not to serve verdicts at all.
 *
 * The site can ship ahead of the worker — it did, and the result was one dead
 * `.json` request per failed trailer, doubling the console noise while teaching
 * nobody anything. One 404 is enough to learn that this deployment has no
 * verdict route; every later trailer skips the question until the page is
 * reloaded. Costs one request per session in the worst case, and none once the
 * worker catches up.
 */
let endpointMissing = false;

/**
 * Ask the worker, at most once per id per session, and remember the answer.
 *
 * Cheap by construction: the worker answers from its own cache for any trailer
 * it has already served or already refused, and only pays a YouTube round trip
 * for a video nobody has looked at yet.
 */
export function fetchVerdict(id: string): Promise<Verdict> {
  if (typeof window === "undefined" || endpointMissing) return Promise.resolve("unknown");
  const known = read(id);
  if (known) return Promise.resolve(known);
  const inFlight = pending.get(id);
  if (inFlight) return inFlight;

  const request = fetch(trailerSrc(id).replace(/\.mp4$/, ".json"))
    .then((r) => {
      // 404 here is the route itself missing, not the video: a worker that
      // knows about verdicts answers 200 with `unknown` when it cannot tell.
      if (r.status === 404) endpointMissing = true;
      return r.ok ? r.json() : null;
    })
    .then((body: any) => {
      const v: Verdict =
        body?.verdict === "ok" || body?.verdict === "gone" ? body.verdict : "unknown";
      write(id, v);
      return v;
    })
    .catch(() => "unknown" as Verdict)
    .finally(() => pending.delete(id));

  pending.set(id, request);
  return request;
}
