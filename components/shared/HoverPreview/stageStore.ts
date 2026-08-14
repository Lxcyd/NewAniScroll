/**
 * Where the one and only trailer player is currently pointed.
 *
 * WHY A STORE AND NOT A PROP. The player must outlive the card that shows it —
 * that is the whole point of TrailerStage — so it cannot be a child of
 * PreviewCard, which is unmounted the moment the pointer leaves. But the player
 * also cannot simply be MOVED into the open card when one appears: reparenting
 * an iframe reloads its document in every browser, which would throw away
 * exactly the boot we are trying to keep. So the player never moves in the DOM.
 * It lives in a fixed layer beside the card and is TOLD where to draw itself.
 *
 * The card hands over an element rather than a rectangle, and the stage measures
 * it. That is deliberate: the card already travels with the page as it scrolls
 * (see PreviewCard's subscribeRect), and a rectangle captured once would have to
 * be re-sent on every one of those movements, by a second path that could drift
 * out of step with the first. Measuring the real element cannot drift.
 */

export type StageHandlers = {
  /** Live transport state — the card paints its banner whenever this is false. */
  onPlaying: (playing: boolean) => void;
  /** true = this video is unplayable, drop the frame for good. */
  onHide: (hidden: boolean) => void;
};

export type StageAttachment = {
  /** The slot to draw over. Measured, never captured. */
  el: HTMLElement;
  /** YouTube video id. */
  id: string;
  handlers: StageHandlers;
} | null;

let current: StageAttachment = null;
const listeners = new Set<() => void>();

export function attachStage(next: StageAttachment) {
  current = next;
  for (const l of listeners) l();
}

/**
 * Release the stage, but only if it is still showing what the caller attached.
 *
 * A card closing while another has already opened must not blank the new one —
 * and with a pointer moving between posters, that ordering happens constantly.
 */
export function detachStage(el: HTMLElement) {
  if (current?.el !== el) return;
  attachStage(null);
}

export function getStage(): StageAttachment {
  return current;
}

export function subscribeStage(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
