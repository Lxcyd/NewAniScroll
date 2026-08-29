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
 */

import { useEffect, useState } from "react";

export type GuestIdentity = {
  id: string;
  /** Chosen name, or null to fall back to the generated Guest#TAG. */
  name: string | null;
  createdAt: number;
};

const KEY = "aniscroll:guest";
export const GUEST_IDENTITY_EVENT = "aniscroll:guest:change";

function mint(): GuestIdentity {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return { id, name: null, createdAt: Date.now() };
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
      if (parsed && typeof parsed.id === "string") {
        return {
          id: parsed.id,
          name: typeof parsed.name === "string" ? parsed.name : null,
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

export function setGuestName(name: string | null): GuestIdentity | null {
  if (typeof window === "undefined") return null;
  const current = getGuestIdentity();
  if (!current) return null;
  const next = { ...current, name: name?.trim() || null };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(GUEST_IDENTITY_EVENT));
  return next;
}

/** The 6 public hex chars, derived from the local id the same way a server tag looks. */
export function guestTag(identity: GuestIdentity): string {
  return identity.id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

/**
 * Display name. `guestLabel` is the localised word ("Guest" / "Invité") the
 * caller pulls from its i18n dictionary — this module stays language-free so
 * the stored value never depends on the language at the time it was written.
 */
export function guestDisplayName(
  identity: GuestIdentity,
  guestLabel = "Guest"
): string {
  return identity.name ?? `${guestLabel}#${guestTag(identity)}`;
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
