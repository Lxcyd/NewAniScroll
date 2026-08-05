/**
 * Canonical mapping between the app's user-facing SERVER ids (lib/servers.js)
 * and the OFFLINE OP/ED detector's HOST names (tools/opening-detector/).
 *
 * Why this file exists:
 *   The detector fingerprints per HOST (sibnet, megaplay, …) because the OP/ED
 *   position is encode-specific (SnK ep1: OP at 2:02 on sibnet but 2:19 on
 *   megaplay). Its results are stored per host in `oped_host_skips`. But the DB
 *   must ONLY ever hold hosts that are actually shown to a viewer — this map is
 *   the single source of truth for "which hosts are displayed", so the importer
 *   can reject/purge anything else and the serve path can translate the player's
 *   active server id into the (host, lang) row to read.
 *
 * A displayed server maps to a detector host via (host, lang): the detector runs
 * per language already, so e.g. `animesama-sibnet-vo` == host `sibnet` + lang
 * `vostfr`, and `animesama-sibnet` == host `sibnet` + lang `vf`. Megaplay is a
 * `multi` server (one chip, subtitle tracks per language); the detector only
 * resolves it under vostfr (see VF_INCOMPATIBLE_HOSTS), so its row is stored
 * under lang `vostfr` and serves the single megaplay chip.
 */

import SERVERS from "./servers.js";

/** serverId → { host, lang } for every server the detector can fingerprint. */
export const SERVER_TO_HOST = {
  megaplay: { host: "megaplay", lang: "vostfr" },

  "animesama-sibnet": { host: "sibnet", lang: "vf" },
  "animesama-sibnet-vo": { host: "sibnet", lang: "vostfr" },
  "animesama-sendvid": { host: "sendvid", lang: "vf" },
  "animesama-sendvid-vo": { host: "sendvid", lang: "vostfr" },
  "animesama-vidmoly": { host: "vidmoly", lang: "vf" },
  "animesama-vidmoly-vo": { host: "vidmoly", lang: "vostfr" },
  // Ansembed is Vidmoly's stream on a white-label domain, but it is a SEPARATE
  // anime-sama entry with its own uploads — so it is its own encode and needs
  // its own detector host. Sharing `vidmoly`'s rows would serve one encode's
  // OP/ED timing on the other's video.
  "animesama-ansembed": { host: "ansembed", lang: "vf" },
  "animesama-ansembed-vo": { host: "ansembed", lang: "vostfr" },
  "voiranime-vidmoly": { host: "vidmoly-va", lang: "vf" },
  "voiranime-vidmoly-vo": { host: "vidmoly-va", lang: "vostfr" },
  "animesama-uqload": { host: "uqload", lang: "vf" },
  "animesama-uqload-vo": { host: "uqload", lang: "vostfr" },
};

// Fail loud if a displayed server has no mapping: the registry must be updated
// whenever a fingerprint-able server is added to lib/servers.js, otherwise its
// skips would silently never be stored/served. `api`/`multi` iframe servers with
// no detector host (none today) would need an entry here too.
const _unmapped = SERVERS.map((s) => s.id).filter((id) => !SERVER_TO_HOST[id]);
if (_unmapped.length) {
  throw new Error(
    `lib/hostRegistry: server(s) in lib/servers.js not mapped to a detector host: ` +
      `${_unmapped.join(", ")} — add them to SERVER_TO_HOST (or intentionally skip).`,
  );
}

/**
 * The ONLY detector hosts allowed in the DB — derived from the map above, so it
 * stays in lockstep with what lib/servers.js actually displays. Removing a
 * server from lib/servers.js (and its map entry) drops its host here, which the
 * importer's purge then uses to delete the now-undisplayed rows.
 */
export const DISPLAYED_HOSTS = Object.freeze([
  ...new Set(Object.values(SERVER_TO_HOST).map((v) => v.host)),
]);

const _hostSet = new Set(DISPLAYED_HOSTS);

/** True if `host` maps to a currently-displayed server. */
export function isDisplayedHost(host) {
  return _hostSet.has(host);
}

/** serverId → { host, lang } | null. */
export function serverToHost(serverId) {
  return SERVER_TO_HOST[serverId] || null;
}
