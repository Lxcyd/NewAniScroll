/**
 * The caller's IP address, from behind Vercel's proxy and/or Cloudflare.
 *
 * This existed three times — lib/watch2gether/rateLimit.ts, /api/v2/track and
 * /api/v2/admin/bug-report — and the copies had drifted apart in a way that
 * mattered. Two of them tested `typeof xff === "string"` without checking the
 * string was non-empty, so an empty `x-forwarded-for` header yielded `""`
 * instead of falling through to the socket address. That is not cosmetic:
 * bug-report gates its per-IP spam throttle on `if (ip)`, so an empty header
 * skipped the throttle entirely, and every such request in the analytics table
 * shared one blank key.
 *
 * One implementation, with the guard, for anything that keys on the caller —
 * rate limits, IP bans, abuse counting, analytics.
 */

import type { NextApiRequest } from "next";
import { BlockList, isIP } from "net";

// https://www.cloudflare.com/ips/ (fetched 29/10/2026; the list changes
// every few years at most).
const CLOUDFLARE = new BlockList();
for (const cidr of [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
]) CLOUDFLARE.addSubnet(cidr.split("/")[0], +cidr.split("/")[1], "ipv4");
for (const cidr of [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]) CLOUDFLARE.addSubnet(cidr.split("/")[0], +cidr.split("/")[1], "ipv6");

const isCloudflare = (ip: string) => {
  const v = isIP(ip);
  return v !== 0 && CLOUDFLARE.check(ip, v === 6 ? "ipv6" : "ipv4");
};

function firstForwarded(req: Pick<NextApiRequest, "headers" | "socket">): string | null {
  const xff = req.headers["x-forwarded-for"];
  // x-forwarded-for is "client, proxy1, proxy2" — the first entry is the
  // original caller. An empty header is treated as absent, not as an IP.
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length && xff[0]) return xff[0].trim();
  return req.socket?.remoteAddress || null;
}

export function getClientIp(req: Pick<NextApiRequest, "headers" | "socket">): string | null {
  const cfHeader = req.headers["cf-connecting-ip"];
  const cf = typeof cfHeader === "string" ? cfHeader.trim() : "";
  const seen = firstForwarded(req);
  // Self-hosted (VM behind the Tunnel): the socket is cloudflared and
  // x-forwarded-for's first entry is whatever the client sent, so
  // cf-connecting-ip is the only trustworthy value.
  if (!process.env.VERCEL) return cf || seen;
  // On Vercel, x-forwarded-for is rewritten by Vercel to the address that
  // connected to it. With the Cloudflare proxy on (orange cloud) that is a
  // Cloudflare edge — every visitor would share one rate-limit key. Trust
  // cf-connecting-ip only then: a client hitting Vercel directly could
  // otherwise forge it to dodge rate limits.
  if (cf && seen && isCloudflare(seen)) return cf;
  return seen;
}
