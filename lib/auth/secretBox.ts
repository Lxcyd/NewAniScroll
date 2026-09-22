/**
 * Symmetric encryption for third-party credentials we have to keep.
 *
 * One thing goes through here today: the AniList access token. It has to live
 * in the users database — an account signed in with its password must still be
 * able to sync, and that means the account, not the browser, holds the link —
 * but a bearer token for someone's AniList account is not something to leave in
 * clear text in a row. A dump of the database gives away nothing without the
 * key, which lives only in the environment.
 *
 * AES-256-GCM, key derived from NEXTAUTH_SECRET (the same secret that already
 * protects the session cookie, so there is no new thing to rotate). Rotating it
 * invalidates stored tokens the same way it invalidates sessions: sync asks for
 * a new AniList sign-in, nothing is lost.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const VERSION = "v1";

function key(): Buffer | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  // A hash, not a KDF: the input is already a high-entropy secret, and this
  // runs on the login path.
  return createHash("sha256").update(`aniscroll:secretbox:${secret}`).digest();
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. Null when there is no key. */
export function seal(plain: string): string | null {
  const k = key();
  if (!k) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/** Null on anything unreadable — a wrong key, an old format, a truncated row. */
export function open(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const k = key();
  if (!k) return null;
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      k,
      Buffer.from(iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
