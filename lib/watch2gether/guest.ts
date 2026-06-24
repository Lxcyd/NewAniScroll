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
        // Normalize the id to match the server's transform (sanitize +
        // slice(0,32)). Older clients stored a 36-char UUID that the server
        // truncated to 32 → the two never matched. Re-sliced here so existing
        // guests converge without losing their identity (same first 32 chars).
        const normId = parsed.guestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
        // Migrate the localized prefix if the UI language changed since the
        // identity was first stored (e.g. old "Guest 4821" → "Invité 4821").
        const label = guestLabel();
        const migratedName = parsed.guestName.replace(/^(Guest|Invité)\b/, label);
        if (normId !== parsed.guestId || migratedName !== parsed.guestName) {
          const next: GuestIdentity = { guestId: normId, guestName: migratedName };
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
  // IMPORTANT: keep this normalization IDENTICAL to the server's in
  // lib/watch2gether/auth.ts (sanitize + slice(0,32)). The server derives the
  // member id as `g:${guestId}` after the same transform; if the client stored
  // a longer raw id, the two would differ and we'd never match ourselves (no
  // self ring, duplicate chat, playback-block never applies).
  const guestId =
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${n}`
    )
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 32);
  const identity: GuestIdentity = { guestId, guestName: `${guestLabel()} ${n}` };
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    /* non-fatal */
  }
  return identity;
}
