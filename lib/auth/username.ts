/**
 * Username rules — "règles classiques", shared by the signup route, the rename
 * action and the form field, so a name can never be accepted by one path and
 * refused by another.
 *
 * Shape only, and that is now the whole story: a pseudo is NOT unique and
 * nothing reserves it. users.tag (6 public digits) is the identity, which is
 * exactly why two people may both be "Lucyd" without either of them having to
 * settle for "Lucyd2".
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

/** Canonical form used to compare two pseudos (lookup, never reservation). */
export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Best-effort conversion of a foreign display name (an AniList pseudo) into
 * something our rules accept. Returns null when nothing usable survives.
 *
 * AniList's charset is wider than ours, so this drops what we don't allow
 * rather than refusing outright — a name is a convenience, and the account's
 * real identity is its tag. A null result is not a failure: the account is
 * created without a pseudo and the AniList name is still shown. Whether
 * another account already carries the result is not asked: it doesn't matter.
 */
export function sanitizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .replace(/\s+/g, "_") // spaces become the separator we do allow
    .replace(/[^a-zA-Z0-9_.]/g, "") // drop everything outside our charset
    .replace(/[._]{2,}/g, "_") // collapse doubled separators
    .replace(/^[._]+|[._]+$/g, "") // and trim them off both ends
    .slice(0, MAX_USERNAME_LENGTH);

  return validateUsername(cleaned) === null ? cleaned : null;
}
