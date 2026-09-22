/**
 * Admin-detection helper. Single source of truth for "is the current
 * NextAuth session allowed into the admin area?".
 *
 * Config:
 *   ADMIN_USERNAMES=Lxcyd,Foo,Bar              (server-only)
 *   NEXT_PUBLIC_ADMIN_USERNAMES=Lxcyd,Foo,Bar  (also exposed to the browser)
 *
 * The two MUST stay in sync if you want both server-side guards (admin
 * page redirect) and client-side affordances (the "Admin" link in the
 * profile menu) to work for the same set of users. Legacy ADMIN_USERNAME
 * (singular) is still respected for backwards compatibility.
 */
export function getAdminNames(): string[] {
  // Prefer the public list because it's available on both server and
  // browser; fall back to the server-only one if the public isn't set.
  const list =
    process.env.NEXT_PUBLIC_ADMIN_USERNAMES || process.env.ADMIN_USERNAMES;
  if (list) {
    return list
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  const legacy = process.env.ADMIN_USERNAME;
  if (legacy) return [legacy.trim().toLowerCase()];
  return [];
}

/** Returns true if the given AniList username is in the admin list. */
export function isAdminName(name?: string | null): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return getAdminNames().includes(lower);
}

/**
 * Returns true if the given NextAuth session belongs to an admin.
 *
 * Two independent sources, either of which is enough:
 *   - `users.role === 'admin'` in the accounts database (carried on the JWT);
 *   - the historical NEXT_PUBLIC_ADMIN_USERNAMES list, kept so nothing that
 *     works today stops working when the accounts DB is unset.
 */
export function isAdminSession(session: any): boolean {
  if (session?.user?.role === "admin") return true;
  return isAdminName(session?.user?.name);
}
