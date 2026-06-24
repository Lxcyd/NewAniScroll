// Stable anonymous identity for Watch 2gether guests.
//
// A signed-in AniList user is identified server-side by their session; everyone
// else gets a guest identity generated once and persisted in localStorage so it
// stays stable across reloads/reconnects within the same browser.

const KEY = "w2g:guest";

export interface GuestIdentity {
  guestId: string;
  guestName: string;
}

export function getGuestIdentity(): GuestIdentity {
  if (typeof window === "undefined") return { guestId: "", guestName: "Guest" };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GuestIdentity;
      if (parsed?.guestId) return parsed;
    }
  } catch {
    /* fall through to regenerate */
  }
  // 4-digit suffix keeps the auto name short and friendly ("Guest 4821").
  const n = Math.floor(1000 + Math.random() * 9000);
  const guestId =
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${n}`
    ).replace(/[^a-zA-Z0-9_-]/g, "");
  const identity: GuestIdentity = { guestId, guestName: `Guest ${n}` };
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    /* non-fatal */
  }
  return identity;
}
