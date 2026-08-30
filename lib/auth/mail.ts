/**
 * Transactional e-mail through Resend's REST API — plain `fetch`, no SDK.
 *
 * Without RESEND_API_KEY we log the link and report success: a preview deploy
 * or a local run must still be able to walk the whole signup path, and the
 * link shows up in the Vercel/terminal logs. In production the key is set and
 * this degradation never triggers.
 *
 * Requires the aniscroll.com DNS records to be verified on the Resend side
 * before MAIL_FROM will be accepted.
 */

import type { NextApiRequest } from "next";

const ENDPOINT = "https://api.resend.com/emails";

/**
 * Where the link in the mail should point.
 *
 * Taken from the REQUEST that triggered the send, not from NEXTAUTH_URL: a
 * signup on dev.aniscroll.com must get a dev link. Relying on the env var
 * sent every preview deploy's links to production — where the route may not
 * even exist yet — and the token then 404s instead of working.
 *
 * `x-forwarded-*` is what Vercel's proxy sets; the env vars are the fallback
 * for a context with no request (there is none today, but the signature
 * allows it).
 */
export function originFromRequest(req?: NextApiRequest): string {
  const host = req?.headers["x-forwarded-host"] || req?.headers.host;
  if (host) {
    const proto = req?.headers["x-forwarded-proto"] || "https";
    const h = Array.isArray(host) ? host[0] : host;
    const p = Array.isArray(proto) ? proto[0] : proto;
    return `${p}://${h}`;
  }
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://aniscroll.com";
}

function from(): string {
  return process.env.MAIL_FROM || "AniScroll <no-reply@aniscroll.com>";
}

async function send(to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[mail] RESEND_API_KEY missing — would have sent to ${to}: ${subject}`);
    return true;
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ from: from(), to, subject, html }),
    });
    if (!res.ok) {
      console.error(`[mail] Resend refused (${res.status}): ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[mail] Resend unreachable", err);
    return false;
  }
}

/**
 * Minimal, inline-styled shell — mail clients strip everything else, so no
 * stylesheet, no flexbox, and centring is done the way it still works
 * everywhere: `text-align` on the parent and `margin:0 auto` on blocks.
 *
 * The logo is loaded from the site that sent the mail, which is why `origin`
 * travels this far down: a dev mail must show the dev deploy's asset, and a
 * hardcoded production URL would 404 on a preview.
 */
function shell(origin: string, inner: string): string {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b10;color:#e7e7ee;padding:32px">
    <div style="max-width:520px;margin:0 auto;background:#14141c;border-radius:14px;padding:28px;text-align:center">
      <img src="${origin}/logo.png" width="56" height="56" alt="AniScroll"
           style="display:block;margin:0 auto 18px;border-radius:14px" />
      ${inner}
    </div>
  </div>`;
}

function layout(
  origin: string,
  title: string,
  body: string,
  cta: { href: string; label: string }
): string {
  /* No raw URL under the button. It was there as a fallback for clients that
     strip links, but those are gone, and a 200-character token in the body is
     what makes a message look like phishing to both the reader and the spam
     filter. */
  return shell(
    origin,
    `
      <h1 style="margin:0 0 12px;font-size:20px;color:#fff">${title}</h1>
      <p style="margin:0 0 22px;line-height:1.6;color:#b9b9c8">${body}</p>
      <a href="${cta.href}"
         style="display:inline-block;background:#e94560;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600">
        ${cta.label}
      </a>`
  );
}

export function sendVerifyEmail(
  to: string,
  token: string,
  origin: string
): Promise<boolean> {
  const href = `${origin}/api/v2/account/verify-email?token=${encodeURIComponent(token)}`;
  return send(
    to,
    "Confirm your AniScroll address",
    layout(
      origin,
      "Confirm your address",
      "Confirm this address to finish creating your AniScroll account. The link expires in 24 hours.",
      { href, label: "Confirm my address" }
    )
  );
}

/**
 * Confirmation code for a sensitive change made from an already-signed-in
 * session (new password, account deletion).
 *
 * No link: a link in this mail would be a one-click way to perform the change
 * from the mailbox, which is the opposite of what the code is for. The code
 * has to be carried back to the page that asked for it.
 */
export function sendCodeEmail(
  to: string,
  code: string,
  action: "password" | "delete",
  origin: string
): Promise<boolean> {
  const what =
    action === "delete"
      ? "delete your AniScroll account"
      : "change your AniScroll password";
  return send(
    to,
    `${code} — your AniScroll confirmation code`,
    shell(
      origin,
      `
        <h1 style="margin:0 0 12px;font-size:20px;color:#fff">Confirmation code</h1>
        <p style="margin:0 0 20px;line-height:1.6;color:#b9b9c8">
          Someone asked to ${what}. Enter this code on the page to confirm. It
          expires in 15 minutes.
        </p>
        <div style="font-size:32px;letter-spacing:8px;font-weight:700;color:#fff;background:#0b0b10;border-radius:10px;padding:16px">
          ${code}
        </div>
        <p style="margin:22px 0 0;font-size:12px;color:#71718a">
          If it wasn't you, ignore this message and change your password —
          someone may know it.
        </p>`
    )
  );
}

export function sendResetEmail(
  to: string,
  token: string,
  origin: string
): Promise<boolean> {
  const href = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
  return send(
    to,
    "Reset your AniScroll password",
    layout(
      origin,
      "Reset your password",
      "Someone asked to reset the password on this account. The link expires in one hour. If it wasn't you, ignore this message — nothing changes.",
      { href, label: "Choose a new password" }
    )
  );
}
