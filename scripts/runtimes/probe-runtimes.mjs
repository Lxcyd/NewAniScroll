/**
 * Sonde la duree reelle de chaque episode CHEZ CHAQUE LECTEUR, hors ligne, et
 * l'ecrit dans `episode_runtimes`.
 *
 *   node --env-file=.env.local scripts/runtimes/probe-runtimes.mjs \
 *        --anime-list=tools/opening-detector/anime.json [--hosts=sibnet,ansembed] \
 *        [--limit=20] [--only-missing] [--dry]
 *
 * OU CA TOURNE, ET POURQUOI CA NE COUTE RIEN A LA PROD
 *   Ce script parle DIRECTEMENT a anime-sama / voir-anime / aux hotes, puis
 *   DIRECTEMENT a Turso. Il ne passe par aucune route Next : zero invocation
 *   Vercel, zero Upstash. C'est la meme regle que le bridge du detecteur (cf.
 *   l'en-tete de tools/opening-detector/bridge/resolve.mjs), et c'est ce qui
 *   permet de balayer le catalogue sans toucher au quota du site.
 *   Corollaire : il faut le lancer depuis une machine dont l'IP est acceptee.
 *   anime-sama refuse les IP de datacenter (erreur Cloudflare 1042), donc ni un
 *   runner CI ni le worker ne feront l'affaire — une machine perso, oui.
 *
 * COMMENT LA DUREE EST LUE
 *   `resolve.mjs` rend l'URL du flux par episode. Ensuite :
 *     - HLS (.m3u8) : on somme les `#EXTINF` du variant que ffmpeg choisirait
 *       (`playlistDurations`, le meme code que le lecteur). Deux petits GET de
 *       texte, rien de plus — ni segment ni video telechargee.
 *     - MP4 : `ffprobe` lit l'entete a distance. Plus lourd, mais c'est une
 *       poignee de requetes de plage, pas le fichier.
 *
 * CE QU'IL N'ECRASE PAS
 *   Une ligne `player` — la mesure d'un vrai lecteur — n'est jamais remplacee
 *   par une sonde. Elle est plus recente et decrit le fichier tel qu'il est
 *   servi ; nous, on lit peut-etre un cache. Meme regle que seed-from-oped.mjs.
 */
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import { DISPLAYED_HOSTS } from "../../lib/hostRegistry.js";
import { playlistDurations } from "../../lib/hlsMerge.js";

const execFileP = promisify(execFile);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const LIST = args["anime-list"] || "tools/opening-detector/anime.json";
const HOSTS = (args.hosts ? args.hosts.split(",") : DISPLAYED_HOSTS).filter((h) =>
  DISPLAYED_HOSTS.includes(h),
);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const ONLY_MISSING = !!args["only-missing"];
const DRY = !!args.dry;

const MIN_S = 60;
const MAX_S = 4 * 3600;
const RESOLVER = "tools/opening-detector/bridge/resolve.mjs";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

if (!HOSTS.length) {
  console.error(`[probe] aucun hote valide. Connus : ${DISPLAYED_HOSTS.join(", ")}`);
  process.exit(2);
}
if (!fs.existsSync(LIST)) {
  console.error(`[probe] liste introuvable : ${LIST}`);
  console.error("  la produire avec scripts/oped/export-oped-anime-list.mjs");
  process.exit(2);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

await db.execute(`
CREATE TABLE IF NOT EXISTS episode_runtimes (
  mal_id     INTEGER NOT NULL,
  episode    INTEGER NOT NULL,
  lang       TEXT    NOT NULL,
  host       TEXT    NOT NULL,
  seconds    REAL    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'player',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mal_id, episode, lang, host)
)`);

/** Ce qu'on a deja, pour ne pas re-sonder (--only-missing). */
async function known(malId, lang, host) {
  const r = await db.execute({
    sql: `SELECT episode FROM episode_runtimes
           WHERE mal_id = ? AND lang = ? AND host = ?`,
    args: [malId, lang, host],
  });
  return new Set(r.rows.map((x) => Number(x.episode)));
}

/** Une passe de `resolve.mjs`, forcee sur UN SEUL hote. */
async function resolveHost({ slug, seasonDir, lang, epStart, epEnd, host, malId, vaSlug }) {
  const { stdout } = await execFileP(
    process.execPath,
    [
      RESOLVER,
      slug,
      seasonDir,
      lang,
      String(epStart),
      String(epEnd),
      host,
      String(malId ?? ""),
      vaSlug ?? "",
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 },
  );
  // resolve.mjs journalise sur stdout ET termine par UNE ligne JSON : c'est la
  // derniere ligne qui fait foi, pas la sortie entiere.
  const last = stdout.trim().split("\n").filter(Boolean).pop();
  try {
    return JSON.parse(last);
  } catch {
    return { ok: false, episodes: [], errors: [`sortie illisible: ${last?.slice(0, 200)}`] };
  }
}

async function hlsDuration(url, referer) {
  const [d] = await playlistDurations([url], {
    fetchText: async (u) => {
      const r = await fetch(u, {
        headers: { "User-Agent": BROWSER_UA, ...(referer ? { Referer: referer } : {}) },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
  });
  return d;
}

/**
 * Episode en plusieurs parties (vidmoly-va) : `resolve.mjs` rend un .ffconcat
 * local, pas une URL. Ses directives `duration` portent deja la longueur de
 * chaque partie — la somme EST la duree de l'episode tel que le lecteur le
 * presente. Rien a sonder, rien a telecharger.
 */
function ffconcatDuration(path) {
  const total = fs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("duration "))
    .reduce((a, l) => a + Number(l.slice(9)), 0);
  return total > 0 ? total : NaN;
}

async function mp4Duration(url) {
  const { stdout } = await execFileP(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", url],
    { timeout: 120 * 1000 },
  );
  return Number(stdout.trim());
}

/**
 * Les episodes vises par une saison. Les jeux de donnees ecrivent ca de DEUX
 * façons et il faut lire les deux : `ep_start`/`ep_end` pour une saison entiere
 * (anime.full.json), `episodes: [1,2,3,12,30]` pour un echantillon
 * (anime.top50.json). Ne lire que la premiere sautait les seconds EN SILENCE.
 */
function episodesOf(season) {
  if (Array.isArray(season.episodes) && season.episodes.length) {
    return [...new Set(season.episodes.map(Number).filter(Number.isInteger))].sort(
      (a, b) => a - b,
    );
  }
  const start = Number(season.ep_start || 1);
  const end = Number(season.ep_end || 0);
  if (!end || end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/**
 * Suites contigues. `resolve.mjs` ne prend qu'une PLAGE : demander 1..30 pour
 * obtenir [1,2,3,12,30] ferait 30 extractions au lieu de 5. Un appel par suite
 * en fait exactement 5, en trois appels.
 */
function runsOf(eps) {
  const runs = [];
  for (const ep of eps) {
    const last = runs[runs.length - 1];
    if (last && ep === last[1] + 1) last[1] = ep;
    else runs.push([ep, ep]);
  }
  return runs;
}

const pending = [];
let probed = 0;
let written = 0;
let failed = 0;
let unresolved = 0;

const list = JSON.parse(fs.readFileSync(LIST, "utf8")).slice(0, LIMIT);
console.log(
  `[probe] ${list.length} titres × ${HOSTS.length} hotes (${HOSTS.join(", ")})` +
    (DRY ? " — --dry, rien ne sera ecrit" : ""),
);

for (const anime of list) {
  for (const season of anime.seasons || []) {
    for (const host of HOSTS) {
      const have = ONLY_MISSING ? await known(anime.mal_id, season.lang, host) : new Set();
      let wanted = episodesOf(season);
      if (ONLY_MISSING) wanted = wanted.filter((e) => !have.has(e));
      if (!wanted.length) continue;

      for (const [epStart, epEnd] of runsOf(wanted)) {
        let res;
        try {
          res = await resolveHost({
            slug: anime.slug,
            seasonDir: season.season_dir,
            lang: season.lang,
            epStart,
            epEnd,
            host,
            malId: anime.mal_id,
            vaSlug: season.va_slug,
          });
        } catch (e) {
          failed++;
          console.warn(`[probe] ${anime.slug} ${season.lang} ${host}: ${e.message}`);
          continue;
        }

        /* Un episode demande que `resolve.mjs` n'a pas rendu n'est ni un succes
           ni une exception : il disparait simplement de `res.episodes`. Sans ce
           relevé il ne restait AUCUNE trace — 37 episodes demandes, 23 sondes,
           « 0 echecs ». C'est la lecon du lot top50 (devlog/oped.md, §08/08) :
           un repli silencieux ne se distingue pas d'une absence de donnee.
           `resolve.mjs` dit lui-meme lequel des deux c'est, dans `errors`. */
        const got = new Set((res.episodes || []).map((e) => Number(e.ep)));
        const missing = [];
        for (let e = epStart; e <= epEnd; e++) if (!got.has(e)) missing.push(e);
        if (missing.length) {
          unresolved += missing.length;
          const why = (res.errors || [])[0] || "sans raison rendue";
          console.warn(
            `[probe] ${anime.slug} ${season.lang} ${host}: ` +
              `${missing.length}/${epEnd - epStart + 1} non resolus — ${why}`,
          );
        }

        for (const ep of res.episodes || []) {
          let seconds = null;
          try {
            seconds = ep.isM3U8
              ? await hlsDuration(ep.url, ep.referer)
              : ep.url.endsWith(".ffconcat")
                ? ffconcatDuration(ep.url)
                : await mp4Duration(ep.url);
          } catch (e) {
            failed++;
            console.warn(`[probe] ${anime.slug} ep${ep.ep} ${host}: ${e.message}`);
            continue;
          }
          probed++;
          if (!(Number.isFinite(seconds) && seconds >= MIN_S && seconds <= MAX_S)) {
            failed++;
            continue;
          }
          pending.push({
            malId: anime.mal_id,
            episode: Number(ep.ep),
            lang: season.lang,
            host,
            seconds: Math.round(seconds),
          });
        }

        if (pending.length >= 200) written += await flush();
      }
    }
  }
}
written += await flush();

console.log(
  `[probe] ${probed} sondes, ${written} lignes ecrites, ` +
    `${failed} echecs de sonde, ${unresolved} episodes non resolus`,
);

/** Ecrit le lot en cours. `WHERE source <> 'player'` : une mesure de lecteur ne
 *  se fait jamais ecraser par une sonde (cf. l'en-tete). */
async function flush() {
  if (!pending.length) return 0;
  const rows = pending.splice(0, pending.length);
  if (DRY) {
    console.log(`[probe] --dry : ${rows.length} lignes non ecrites`);
    return 0;
  }
  const now = Math.floor(Date.now() / 1000);
  await db.batch(
    rows.map((r) => ({
      sql: `INSERT INTO episode_runtimes
              (mal_id, episode, lang, host, seconds, source, updated_at)
            VALUES (?, ?, ?, ?, ?, 'probe', ?)
            ON CONFLICT(mal_id, episode, lang, host) DO UPDATE SET
              seconds = excluded.seconds,
              source = excluded.source,
              updated_at = excluded.updated_at
            WHERE episode_runtimes.source <> 'player'`,
      args: [r.malId, r.episode, r.lang, r.host, r.seconds, now],
    })),
    "write",
  );
  return rows.length;
}
