/**
 * Identifier minting, server-side only.
 *
 * Two identifiers per account, on purpose:
 *   - `id`  — a ULID: opaque, sortable by creation time, never shown.
 *   - `tag` — 6 uppercase hex chars, shown next to the pseudo ("Kirito#7F3A2C").
 *
 * The tag is what makes an AniList-only login safe: it never collides with an
 * AniScroll pseudo, so the same display name can exist twice without either
 * account losing its identity. Uniqueness of both is enforced by the DB
 * (PRIMARY KEY / UNIQUE), not by the caller — a client-generated id is never
 * trusted.
 *
 * ULID rather than a dependency: 26 chars, Crockford base32, 48-bit
 * millisecond timestamp then 80 random bits. ~10 lines, no package.
 */

import { randomBytes, randomInt } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

/**
 * Six digits, like a Discord discriminator — a tag is read aloud and typed by
 * people, and letters invite the b/8, O/0, l/1 confusions. One million values,
 * collisions handled by retry in insertUser.
 *
 * Only new accounts get this shape; the hex tags minted before it stay valid
 * (nothing parses a tag, it is only displayed and kept unique).
 */
export function mintTag(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
