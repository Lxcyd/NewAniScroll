/**
 * Marks a DOM node as an anime card that can raise the hover preview.
 *
 * The site has ~a dozen hand-rolled card layouts (home carousels, catalog grid,
 * search results, schedule, my-list, recommendations…) and no shared card
 * component, so the preview does NOT wrap anything: HoverPreviewProvider runs a
 * single delegated `pointerover` listener on `document` and looks for the
 * nearest ancestor carrying this attribute. Making an existing card previewable
 * is therefore one spread on its outermost element — no wrapper node, no layout
 * change, no extra listener per card:
 *
 *   <div className="…" {...previewAnchor(anime.id)}>
 *
 * Pass an id only for ANIME (manga has no trailer and no watch page).
 */

export const PREVIEW_ATTR = "data-anime-preview";

export function previewAnchor(id?: number | string | null): Record<string, string> {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return {};
  return { [PREVIEW_ATTR]: String(n) };
}
