/**
 * Username rules — "règles classiques", shared by the signup route, the
 * live-availability endpoint and the rename action so a name can never be
 * accepted by one path and refused by another.
 *
 * Uniqueness is case-insensitive and enforced by the UNIQUE index on
 * users.username_lower; this module only covers the shape.
 *
 * A username is NOT an identity: users.tag (6 public hex) is. That is what
 * lets an AniList-only login coexist with an AniScroll account that already
 * took the same pseudo.
 */

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 20;

/** Names nobody gets to take — impersonation of the site or of a guest. */
const RESERVED = new Set([
  "admin",
  "administrator",
  "aniscroll",
  "anistaff",
  "guest",
  "invite",
  "invité",
  "mod",
  "moderator",
  "moopa",
  "official",
  "root",
  "staff",
  "support",
  "system",
]);

export type UsernameError =
  | "tooShort"
  | "tooLong"
  | "charset"
  | "edge"
  | "repeat"
  | "reserved"
  | "guestFormat";

/**
 * Returns null when the name is acceptable, otherwise a stable error code the
 * UI maps to an i18n string (auth.username.<code>).
 */
export function validateUsername(raw: unknown): UsernameError | null {
  if (typeof raw !== "string") return "charset";
  const name = raw.trim();

  if (name.length < MIN_USERNAME_LENGTH) return "tooShort";
  if (name.length > MAX_USERNAME_LENGTH) return "tooLong";
  if (!/^[a-zA-Z0-9_.]+$/.test(name)) return "charset";
  // No dot/underscore at either end, and no doubled separator: the classic
  // rules, and they keep names readable next to the "#tag" suffix.
  if (/^[._]|[._]$/.test(name)) return "edge";
  if (/[._]{2}/.test(name)) return "repeat";

  const lower = name.toLowerCase();
  if (RESERVED.has(lower)) return "reserved";
  // "Guest#7F3A2C" / "Invité#7F3A2C" is how a signed-out visitor is displayed;
  // an account must not be able to look like one.
  if (/^(guest|invit[eé])[#_.-]?[0-9a-f]{0,6}$/i.test(name)) return "guestFormat";

  return null;
}

/** Canonical form used for the uniqueness reservation. */
export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}
