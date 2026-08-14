/**
 * Trailers this visitor cannot watch, remembered for the session.
 *
 * WHY THIS EXISTS AGAIN, having been deleted. There used to be a server-side
 * verdict: `/api/v2/preview` asked our Cloudflare Worker whether a video was
 * deleted, private or region-locked, and withheld the trailer id when it was.
 * That was removed because it cost a blocking round trip to the Worker on every
 * cold payload — and because the answer was about a DATACENTRE's region, not the
 * visitor's, which is the wrong question by construction.
 *
 * The right answer was already arriving and being thrown away. A blocked embed
 * posts `onError` with a code, and that code is about the machine the video is
 * actually being watched on. Measured, in France, on a title reported blocked:
 *
 *     Bleach (0c4IoCA5fY0)   -> etat -1, then onError 150
 *     a playable control     -> etat 5, -1, 3, 1 — no error at all
 *     a deleted video        -> onError 150
 *
 * So the signal is real and it is free. What was missing is MEMORY: without it
 * the card mounts the player, learns it is blocked, and hides — then does the
 * whole thing again on the next hover, for ever. One failure per video per
 * session is a fact worth keeping.
 *
 * Deliberately NOT persisted to storage. Availability is a function of where the
 * visitor is, and someone who moves — or turns off a VPN — should not be told
 * for weeks that a trailer they can now watch is unavailable. A session is
 * roughly the lifetime of that assumption.
 */

/**
 * YouTube's error codes, and which of them mean "this video, here, never".
 *
 * 100 — the video does not exist any more, or is private.
 * 101, 150 — the owner does not allow it in embedded players. Region locks
 *   surface here too, which is why 150 is what a blocked title actually returns.
 *
 * 2 (bad parameter) and 5 (HTML5 player error) are deliberately absent: the
 * first is our bug and the second is transient, and neither is a statement about
 * whether the video can be watched. Hiding a trailer on those would quietly
 * delete working previews whenever the player hiccuped.
 */
const FATAL = new Set([100, 101, 150]);

const blocked = new Set<string>();
/** Answered and fine — so nothing asks a second time. */
const ok = new Set<string>();
const listeners = new Set<() => void>();

export function isFatalTrailerError(code: unknown): boolean {
  return typeof code === "number" && FATAL.has(code);
}

export function markTrailerBlocked(id: string) {
  if (blocked.has(id)) return;
  blocked.add(id);
  for (const l of listeners) l();
}

export function isTrailerBlocked(id: string | null | undefined): boolean {
  return !!id && blocked.has(id);
}

export function markTrailerOk(id: string) {
  ok.add(id);
}

/** unknown = nobody has asked yet, which is the only case worth probing. */
export function trailerStatus(id: string): "unknown" | "ok" | "blocked" {
  if (blocked.has(id)) return "blocked";
  if (ok.has(id)) return "ok";
  return "unknown";
}

/**
 * So a card already on screen can drop its player the moment the verdict lands,
 * rather than keeping a dead frame until the pointer leaves.
 */
export function subscribeBlocked(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
