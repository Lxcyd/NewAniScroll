// Stable anonymous identity for Watch 2gether guests.
//
// A signed-in AniList user is identified server-side by their session; everyone
// else is a guest, and a guest now has exactly ONE identity on the whole site:
// lib/prefs/guestIdentity.ts. This module used to mint a second one of its own,
// with a four-digit suffix drawn at random ("Invité 4821") — two visitors in
// the same room had a one-in-ten-thousand chance of being shown the same name,
// and the two identities disagreed with each other everywhere else.
//
// What is kept here is the wire shape the party code and the server expect
// (`guestId` / `guestName`), plus the migration from the old key.

import i18n from "@/lib/i18n/config";
import { getGuestIdentity as getSiteIdentity, guestTag } from "@/lib/prefs/guestIdentity";

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

  const site = getSiteIdentity();
  if (site) {
    // The guestId is the guest's SECRET: it is sent to the server, which
    // HMAC-hashes it into the public id used in broadcasts (see auth.ts). The
    // sanitize/slice keeps it a tidy token — its exact length need not match
    // the server, which hashes whatever it receives, capped at 64 chars.
    const guestId = site.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    const identity: GuestIdentity = {
      guestId,
      guestName: `${guestLabel()}#${guestTag(site)}`,
    };
    try {
      // Kept written so a party opened in a tab that predates this build still
      // finds something under the old key.
      localStorage.setItem(KEY, JSON.stringify(identity));
    } catch {
      /* non-fatal */
    }
    return identity;
  }

  // localStorage refused (private mode with storage blocked). Fall back to
  // whatever was stored before, then to a bare label.
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as GuestIdentity) : null;
    if (parsed?.guestId) return parsed;
  } catch {
    /* nothing usable */
  }
  return { guestId: "", guestName: guestLabel() };
}
