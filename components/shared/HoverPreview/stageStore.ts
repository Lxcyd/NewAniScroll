/**
 * Where each trailer player is currently pointed.
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
 *
 * WHY THE STORE IS KEYED BY SCENE. There used to be exactly one player, which
 * was right while the only caller was the hover preview: one card is open at a
 * time, so one player served all of them. Profile music broke that assumption —
 * it plays for as long as the visitor stays, while cards keep opening and
 * closing underneath it. Sharing one player would mean hovering any poster
 * silently stops the music, and the profile page is full of posters.
 *
 * So a scene is one independent player. Each keeps its own attachment and its
 * own iframe; nothing is shared between them but this module. Adding a scene
 * costs a live iframe, which is why they are named explicitly rather than
 * created on demand — two is a decision, not an accident.
 */

export type StageScene = "hover" | "music";

export type StageHandlers = {
  /** Live transport state — the card paints its banner whenever this is false. */
  onPlaying: (playing: boolean) => void;
  /** true = this video is unplayable, drop the frame for good. */
  onHide: (hidden: boolean) => void;
  /**
   * How far through the trailer we are, 0 to 1.
   *
   * Only the ambient light wants this, and only because it cannot read the
   * picture: it lights the card from the three still frames YouTube publishes,
   * and this is what tells it which one the video is near.
   */
  onProgress: (p: number) => void;
};

export type StageAttachment = {
  /** The slot to draw over. Measured, never captured. */
  el: HTMLElement;
  /** YouTube video id. */
  id: string;
  handlers: StageHandlers;
} | null;

const current = new Map<StageScene, StageAttachment>();
const listeners = new Map<StageScene, Set<() => void>>();

function listenersFor(scene: StageScene) {
  let set = listeners.get(scene);
  if (!set) {
    set = new Set();
    listeners.set(scene, set);
  }
  return set;
}

export function attachStage(scene: StageScene, next: StageAttachment) {
  current.set(scene, next);
  for (const l of listenersFor(scene)) l();
}

/**
 * Release the stage, but only if it is still showing what the caller attached.
 *
 * A card closing while another has already opened must not blank the new one —
 * and with a pointer moving between posters, that ordering happens constantly.
 */
export function detachStage(scene: StageScene, el: HTMLElement) {
  if (current.get(scene)?.el !== el) return;
  attachStage(scene, null);
}

export function getStage(scene: StageScene): StageAttachment {
  return current.get(scene) ?? null;
}

export function subscribeStage(scene: StageScene, l: () => void) {
  const set = listenersFor(scene);
  set.add(l);
  return () => {
    set.delete(l);
  };
}
