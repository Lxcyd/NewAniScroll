/**
 * Password hashing, on node:crypto only.
 *
 * scrypt rather than bcrypt/argon2 because those ship a native binary, which
 * a Vercel lambda build has to compile or prebuild for. scrypt is in the
 * standard library and memory-hard, which is what matters here.
 *
 * Stored format: scrypt$N$r$p$<salt b64>$<key b64>
 * The parameters travel with the hash so raising N later doesn't invalidate
 * the passwords already in the database.
 *
 * These routes must stay on the Node runtime (the default for pages/api) —
 * node:crypto's scrypt does not exist on the edge runtime.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number }
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
// Default maxmem (32 MB) is too tight for N=16384,r=8: 128*N*r = 16 MB plus
// overhead. Give it room so the hash doesn't throw under load.
const MAXMEM = 64 * 1024 * 1024;

/** Minimum we accept at signup. Length beats character classes. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function validatePassword(password: string): string | null {
  if (typeof password !== "string") return "invalid";
  if (password.length < MIN_PASSWORD_LENGTH) return "tooShort";
  if (password.length > MAX_PASSWORD_LENGTH) return "tooLong";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * Constant-time verification. Returns false — never throws — on a malformed
 * or missing hash, so an AniList-only account (password_hash NULL) simply
 * fails to log in with a password instead of 500-ing.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  try {
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    const actual = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
