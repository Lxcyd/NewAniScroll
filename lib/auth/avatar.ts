/**
 * Which picture to show for someone, in one place.
 *
 * There are two of them and they are not the same thing:
 *
 *   users.avatar_url          — the AniScroll picture. Nothing sets it yet;
 *                               it is where an uploaded avatar will go.
 *   users.anilist_avatar_url  — the picture AniList serves for the linked
 *                               account. Ours to display, never ours to keep:
 *                               unlinking drops it.
 *
 * They used to share one column, so linking AniList overwrote the account's
 * own picture and unlinking erased it. The rule is: the AniScroll picture
 * wins, AniList's fills in for it.
 *
 * The shape varies by where the value comes from — the database sends a URL,
 * AniList sends `{ large, medium }` — and reading only one of the two shapes is
 * what left the sync card with an empty grey circle after a password sign-in.
 * Everything that draws an avatar goes through here.
 */

export function avatarFrom(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object") {
    const shape = value as { large?: unknown; medium?: unknown };
    return avatarFrom(shape.large) || avatarFrom(shape.medium);
  }
  return null;
}

/**
 * The avatar of a session user or of an account row, in order of precedence.
 * `image` is the AniList-shaped claim the session has always carried.
 */
export function pickAvatar(user: any): string | null {
  return (
    avatarFrom(user?.avatarUrl) ||
    avatarFrom(user?.anilistAvatarUrl) ||
    avatarFrom(user?.image) ||
    null
  );
}
