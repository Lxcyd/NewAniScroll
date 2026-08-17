/**
 * "Restore default settings" — wipe every local preference this app stores so
 * the next render falls back to the built-in defaults.
 *
 * We clear all `aniscroll:*` keys plus the few legacy/un-prefixed keys the
 * player uses (`preferred_server`, `view`, `artplayer_settings`, volume/muted).
 * This is local-only: it never touches the AniList account. The LOCAL LIST
 * (`aniscroll:localList`) is intentionally KEPT — wiping a user's whole anime
 * list under "restore settings" would be a nasty surprise; the dedicated
 * "Delete list" action owns that.
 */

const KEEP = new Set(["aniscroll:localList"]);
const EXTRA_KEYS = [
  "preferred_server",
  // Classement des langues (cf. lib/prefs/langPref.ts) : le remettre a zero
  // re-affiche la popup au prochain episode, ce qui est bien le sens de
  // « reglages par defaut ».
  "lang_pref_order",
  "view",
  "artplayer_settings",
  "aniscroll:volume",
  "aniscroll:muted",
];

export function restoreDefaultSettings(): void {
  if (typeof window === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("aniscroll:") && !KEEP.has(key)) toRemove.push(key);
    }
    for (const k of [...toRemove, ...EXTRA_KEYS]) {
      try {
        localStorage.removeItem(k);
      } catch {}
    }
  } catch {
    /* best-effort */
  }
}
