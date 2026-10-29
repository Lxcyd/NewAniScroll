/**
 * SSRF guard for the video proxies (proxy/m3u8, download, download-stream),
 * which fetch any URL a visitor passes them.
 *
 * Not a host allowlist: the players' CDNs rotate domains (megaplay, megaup,
 * VOE…), a list would break playback every few weeks. What must never be
 * reachable is the inside of the machine: on a self-hosted VM that is Redis /
 * SRH on the Docker network and the cloud metadata service (169.254.169.254).
 * So: http(s) only, and every address the host resolves to must be public.
 */

import { lookup } from "dns/promises";
import { BlockList, isIP } from "net";
import { boundedSet } from "../boundedSet";

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4],
]) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
]) PRIVATE.addSubnet(net, bits, "ipv6");
// No ::ffff:0:0/96 rule: BlockList already checks IPv4-mapped IPv6 against the
// IPv4 subnets, and that rule would match EVERY IPv4 address.

const isPrivate = (ip) => PRIVATE.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

/** Resolves to true when `raw` is an http(s) URL whose host is public. */
export async function isPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !isPrivate(host);
  if (!host.includes(".")) return false; // Docker service names, localhost
  // The m3u8 proxy is hit once per segment: memo the verdict per host.
  const hit = verdicts.get(host);
  if (hit && Date.now() - hit.t < VERDICT_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const addrs = await lookup(host, { all: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivate(a.address));
  } catch {}
  boundedSet(verdicts, host, { t: Date.now(), ok }, 1000);
  return ok;
}

const verdicts = new Map(); // host → { t, ok }
const VERDICT_TTL_MS = 10 * 60 * 1000;
