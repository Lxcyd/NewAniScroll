/**
 * Identity of a signed-out visitor. Same pattern as the other prefs modules
 * (lib/prefs/syncPrefs.ts): one localStorage key, a CustomEvent for same-tab
 * notification, a hook for the live value.
 *
 * Entirely local. A guest has NO row in the users database, which is what
 * makes the "don't flood the DB with throwaway guest accounts" problem
 * disappear instead of needing a purge policy: there is nothing to purge.
 *
 * The id here is a convenience for showing a stable name across reloads, not
 * an identity the server trusts. On signup it is thrown away — the server
 * mints its own id and tag, and uniqueness comes from PRIMARY KEY / UNIQUE,
 * never from the client. Two browsers colliding on a local UUID would be
 * harmless, and cannot reach the database anyway.
 *
 * **A guest cannot choose a name.** A free-text name is exactly what makes two
 * visitors indistinguishable in a shared room — anyone could call themselves
 * what someone else is called. The name is `Invité#123456` and nothing else:
 * the digits come from the local id, so they are stable for this browser and
 * effectively never repeat between two people in the same watch party. This is
 * also the only identity a guest has anywhere, so watch2gether uses it too
 * rather than minting a second one of its own.
 */

import { useEffect, useState } from "react";

export type GuestIdentity = {
  /** Local UUID. The real identity; the tag below is only its readable face. */
  id: string;
  createdAt: number;
};

const KEY = "aniscroll:guest";
export const GUEST_IDENTITY_EVENT = "aniscroll:guest:change";

function mint(): GuestIdentity {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return { id, createdAt: Date.now() };
}

/**
 * Read the local identity, creating it on first call. Returns null on the
 * server: the guest name must never be part of SSR output, or it would
 * mismatch on hydration (the same class of bug as the episode countdown).
 */
export function getGuestIdentity(): GuestIdentity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // A `name` written by an older build is simply ignored — guests do not
      // carry a chosen name any more.
      if (parsed && typeof parsed.id === "string") {
        return {
          id: parsed.id,
          createdAt: Number(parsed.createdAt) || Date.now(),
        };
      }
    }
    const fresh = mint();
    window.localStorage.setItem(KEY, JSON.stringify(fresh));
    return fresh;
  } catch {
    return mint();
  }
}

/**
 * Six digits, same shape as an account tag — a tag is read aloud and typed by
 * people, and letters invite the b/8 and O/0 confusions.
 *
 * Derived from the id rather than drawn at random so it survives a reload and
 * so there is one identity, not two. FNV-1a over the whole UUID: the id is the
 * thing that is actually unique, the digits are its readable face. Two guests
 * in the same room landing on the same six digits is a one-in-a-million
 * display collision; the server still tells them apart by the id.
 */
export function guestTag(identity: GuestIdentity): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.id.length; i++) {
    hash ^= identity.id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash % 1_000_000).padStart(6, "0");
}

/**
 * Display name, always generated. `guestLabel` is the localised word ("Guest"
 * / "Invité") the caller pulls from its i18n dictionary — this module stays
 * language-free so nothing stored depends on the language at the time it was
 * written.
 */
export function guestDisplayName(
  identity: GuestIdentity,
  guestLabel = "Guest"
): string {
  return `${guestLabel}#${guestTag(identity)}`;
}

export function useGuestIdentity(): GuestIdentity | null {
  const [identity, setIdentity] = useState<GuestIdentity | null>(null);
  useEffect(() => {
    const read = () => setIdentity(getGuestIdentity());
    read();
    window.addEventListener(GUEST_IDENTITY_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(GUEST_IDENTITY_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return identity;
}
