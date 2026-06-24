// Stable anonymous identity for Watch 2gether guests.
//
// A signed-in AniList user is identified server-side by their session; everyone
// else gets a guest identity generated once and persisted in localStorage so it
// stays stable across reloads/reconnects within the same browser.

import i18n from "@/lib/i18n/config";

const KEY = "w2g:guest";

export interface GuestIdentity {
  guestId: string;
  guestName: string;
}

/** Localized guest label ("Guest" / "Invité"); falls back to "Guest". */
function guestLabel(): string {
  try {
    return i18n.t("party.guest") || "Guest";
  } catch {
    return "Guest";
  }
}

export function getGuestIdentity(): GuestIdentity {
  if (typeof window === "undefined") return { guestId: "", guestName: guestLabel() };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GuestIdentity;
      if (parsed?.guestId) {
        // Migrate the localized prefix if the UI language changed since the
        // identity was first stored (e.g. old "Guest 4821" → "Invité 4821").
        const label = guestLabel();
        const migrated = parsed.guestName.replace(/^(Guest|Invité)\b/, label);
        if (migrated !== parsed.guestName) {
          const next = { ...parsed, guestName: migrated };
          try {
            localStorage.setItem(KEY, JSON.stringify(next));
          } catch {
            /* non-fatal */
          }
          return next;
        }
        return parsed;
      }
    }
  } catch {
    /* fall through to regenerate */
  }
  // 4-digit suffix keeps the auto name short and friendly ("Invité 4821").
  const n = Math.floor(1000 + Math.random() * 9000);
  const guestId =
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${n}`
    ).replace(/[^a-zA-Z0-9_-]/g, "");
  const identity: GuestIdentity = { guestId, guestName: `${guestLabel()} ${n}` };
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    /* non-fatal */
  }
  return identity;
}
