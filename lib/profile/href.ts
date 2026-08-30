/**
 * Where someone's profile lives.
 *
 * The pseudo half of the URL is decoration — only the tag resolves an identity
 * (lib/auth/users.findByTag), which is why an account always links with it and
 * why a name with a dash in it is harmless.
 *
 * A signed-out visitor has no account and so no shareable URL: their list is
 * localStorage on this device only, and /en/profile/me is the page that reads
 * it. Linking them to a public profile route would 404.
 */
export function profileHref(user: any): string {
  const name = encodeURIComponent(user?.name || "user");
  if (user?.tag) return `/en/profile/${name}-${user.tag}`;
  // An AniList session that predates accounts: the username is the identity.
  if (user?.anilistId && user?.name) return `/en/profile/${name}`;
  return "/en/profile/me";
}
