/**
 * Keeps the hover card alive while something modal is open on top of it.
 *
 * The card is a HOVER surface: HoverPreviewProvider tears it down as soon as
 * the pointer meets anything else, leaves the window, or presses down outside
 * it. That is exactly right for a preview and exactly wrong once the card has
 * opened the list editor — the editor is a full-screen dialog, so reaching for
 * it means leaving the card, which would unmount the card and the editor with
 * it. The dialog would vanish under the pointer travelling toward it.
 *
 * So the card takes a lock while a dialog of its own is open, and the provider
 * declines to close until it is released. Released, the card closes: the
 * pointer is somewhere else entirely by then, and leaving a hover card sitting
 * there after a dialog closes would be a ghost nobody asked for.
 *
 * A counter rather than a boolean — two dialogs at once is not a case today,
 * but a lock that can be released by whoever didn't take it is a bug waiting
 * for the second caller.
 */

let held = 0;
const listeners = new Set<() => void>();

export function lockPreview(): void {
  held += 1;
}

/** Releases one lock. The provider closes the card when the last one goes. */
export function unlockPreview(): void {
  if (held === 0) return;
  held -= 1;
  if (held === 0) listeners.forEach((fn) => fn());
}

export function isPreviewLocked(): boolean {
  return held > 0;
}

/** Called when the last lock is released. Returns an unsubscribe. */
export function onPreviewUnlocked(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
