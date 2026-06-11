/**
 * The ONLY sanctioned way to rewrite the visible URL without navigating.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Next.js (Pages Router) stores its router state in `history.state`:
 * `{ url, as, options, key, __N: true }`. Its `popstate` handler relies on it:
 *
 *   • `event.state == null`  → Next does NOT navigate — it just re-syncs its
 *     internal URL. The address bar changes but the page doesn't re-render.
 *   • `event.state.__N` missing → Next ignores the event entirely.
 *
 * So every raw `window.history.replaceState(null, "", url)` call DESTROYS the
 * router state of the current history entry. Pressing back/forward INTO such
 * an entry later does nothing visible — the exact "le retour en arrière ne
 * fait rien" bug. We had six of those calls (locale prefix swap on every
 * route change, slug decoration on the info & watch pages, the ?id= sync, the
 * tab hash), which corrupted essentially every history entry of a French
 * session.
 *
 * ── What this helper does ──────────────────────────────────────────────────
 * Re-writes the visible URL while PRESERVING Next's state object, updating
 * only `as` (the displayed URL). On back/forward Next then:
 *   1. finds a valid `__N` state → re-renders the route it knows (`url`), and
 *   2. displays our cosmetic URL (`as`) — no URL flip-flop on restore.
 *
 * `url` (the internal route + query Next renders from) is intentionally left
 * untouched: every caller only rewrites COSMETIC parts (locale prefix, slug
 * suffix, display-only query params, tab hash) that the pages re-derive
 * themselves on mount. If you ever need to change ROUTING state, use
 * `router.replace` — not this.
 *
 * Never call `window.history.replaceState` / `pushState` directly anywhere in
 * the app. Route through this helper (or the Next router) so history entries
 * always stay restorable.
 */
export function replaceUrlPreservingState(nextUrl: string): void {
  if (typeof window === "undefined") return;
  const prev = window.history.state;
  // Preserve Next's full state (url/key/options/__N…); only the visible URL
  // changes. If the entry's state is already null (legacy corruption from
  // before this helper existed), we can't resurrect it — but we don't make it
  // worse either, and fresh navigations create healthy entries.
  const nextState =
    prev && typeof prev === "object" ? { ...prev, as: nextUrl } : prev;
  try {
    window.history.replaceState(nextState, "", nextUrl);
  } catch {
    /* Safari throws on >100 calls/30s — cosmetic rewrite, safe to skip */
  }
}
