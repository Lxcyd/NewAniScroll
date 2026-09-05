/**
 * Import the OST resolver's JSON into the oped_youtube Turso table
 * (served by /api/v2/themes/{id}). Batched writes, no worker, no Upstash.
 *
 *   node --env-file=.env.local scripts/oped/import-oped-youtube.mjs \
 *        --in=tools/ost-resolver/out.json [--dry]
 *
 * Input: the array written by `tools/ost-resolver/resolve.py --json`, one entry
 * per theme:
 *
 *   { "anilist_id": 127230, "slot": "ED6", "title": "Dainou-teki na Rendezvous",
 *     "artists": ["Kanaria"], "artist_source": "animethemes", "verdict": "OK",
 *     "best": { "video_id": "S0j4mcEFqfo", "title": "大脳的なランデブー",
 *               "channel": "Kanaria", "duration": 133 } }
 *
 * WHAT IS WRITTEN, AND WHAT IS NOT.
 *
 * Every processed theme upserts a row, absences included — the same rule as
 * oped_host_skips. A row means "this was looked at"; without that, a re-run
 * cannot tell an absence from something it never tried, and re-does the whole
 * catalogue forever.
 *
 * But the verdict is carried through UNCHANGED, and that is the point. Only
 * `ok` is ever served (see lib/db/opedYoutube.ts). `review` rows are stored so a
 * human can look at them, never so the site can fall back to them: they hold one
 * agreeing signal, and the failure they exist to catch looks completely
 * plausible — the right artist's channel, a full-length runtime, the wrong song.
 * Chainsaw Man ED3 was validated that way before the second signal existed.
 *
 * REJECTED OUTRIGHT (never written):
 *   - no anilist_id — the table is keyed on it; a name is not a key. This is
 *     what a --from-json run without --anilist-id produces.
 *   - a verdict of `ok` with a video_id that is not an 11-char YouTube id. It
 *     ends up in an iframe URL, so a malformed one is a bug to surface now
 *     rather than a row to serve later.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const IN = args.in || "tools/ost-resolver/out.json";
const DRY = !!args.dry;
/** Bougé quand le scoring du résolveur change, pour re-passer le parc. */
const ALGO_VERSION = 1;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VERDICTS = new Set(["ok", "review", "absent", "api_fail"]);

if (!fs.existsSync(IN)) {
  console.error(`Introuvable : ${IN}`);
  process.exit(1);
}
const brut = JSON.parse(fs.readFileSync(IN, "utf8"));
if (!Array.isArray(brut)) {
  console.error("Le fichier doit contenir un tableau (resolve.py --json).");
  process.exit(1);
}

const rows = [];
const rejets = [];

for (const e of brut) {
  const aniId = Number(e.anilist_id);
  if (!Number.isFinite(aniId) || aniId <= 0) {
    rejets.push(`${e.slot ?? "?"} ${e.title ?? "?"} — pas d'id AniList`);
    continue;
  }

  const verdict = String(e.verdict ?? "").toLowerCase();
  if (!VERDICTS.has(verdict)) {
    rejets.push(`${e.slot} ${e.title} — verdict inconnu « ${e.verdict} »`);
    continue;
  }

  /* Le candidat est conservé MÊME en `review`, et c'est ce qui rend la file
     relisable : sans lui on stocke « un titre, une chaîne, une durée » sans le
     moyen d'aller écouter, et personne ne peut trancher. Rien n'est risqué à le
     garder — c'est la REQUÊTE qui protège (verdict = 'ok'), pas l'effacement de
     l'identifiant. */
  const best = e.best ?? null;
  const brutId = best?.video_id ? String(best.video_id) : null;
  const videoId = brutId && YT_ID.test(brutId) ? brutId : null;
  if (verdict === "ok" && !videoId) {
    rejets.push(`${e.slot} ${e.title} — id YouTube malformé « ${brutId} »`);
    continue;
  }

  rows.push({
    aniId,
    slug: String(e.slot ?? "").slice(0, 16),
    verdict,
    videoId,
    ytTitle: best?.title ? String(best.title).slice(0, 300) : null,
    ytChannel: best?.channel ? String(best.channel).slice(0, 200) : null,
    duration: Number.isFinite(best?.duration) ? Number(best.duration) : null,
    artist: Array.isArray(e.artists) && e.artists.length ? String(e.artists[0]).slice(0, 200) : null,
    artistSrc: e.artist_source ? String(e.artist_source).slice(0, 32) : null,
  });
}

const parVerdict = {};
for (const r of rows) parVerdict[r.verdict] = (parVerdict[r.verdict] ?? 0) + 1;

console.log(`${brut.length} entrée(s) lue(s) — ${rows.length} à écrire`);
console.log("  verdicts :", JSON.stringify(parVerdict));
console.log(`  servables (ok) : ${parVerdict.ok ?? 0}`);
if (rejets.length) {
  console.log(`\n${rejets.length} rejet(s) :`);
  for (const r of rejets.slice(0, 15)) console.log("  -", r);
  if (rejets.length > 15) console.log(`  … et ${rejets.length - 15} de plus`);
}

if (DRY) {
  console.log("\n--dry : rien n'a été écrit.");
  process.exit(0);
}
if (!rows.length) {
  console.log("\nRien à écrire.");
  process.exit(0);
}

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL absent (utiliser --env-file=.env.local).");
  process.exit(1);
}
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

/* La table se crée ici, comme les autres importeurs : rien n'applique
   schema.sql en migration, ce fichier en est la copie de référence. */
await client.execute(`
  CREATE TABLE IF NOT EXISTS oped_youtube (
    ani_id       INTEGER NOT NULL,
    slug         TEXT    NOT NULL,
    verdict      TEXT    NOT NULL,
    video_id     TEXT,
    yt_title     TEXT,
    yt_channel   TEXT,
    duration     INTEGER,
    artist       TEXT,
    artist_src   TEXT,
    algo_version INTEGER NOT NULL DEFAULT 1,
    checked_at   INTEGER NOT NULL,
    PRIMARY KEY (ani_id, slug)
  )`);
await client.execute(
  `CREATE INDEX IF NOT EXISTS idx_oped_youtube_verdict ON oped_youtube(verdict)`,
);

const now = Math.floor(Date.now() / 1000);
const SQL = `INSERT INTO oped_youtube
  (ani_id, slug, verdict, video_id, yt_title, yt_channel, duration,
   artist, artist_src, algo_version, checked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ani_id, slug) DO UPDATE SET
    verdict = excluded.verdict, video_id = excluded.video_id,
    yt_title = excluded.yt_title, yt_channel = excluded.yt_channel,
    duration = excluded.duration, artist = excluded.artist,
    artist_src = excluded.artist_src, algo_version = excluded.algo_version,
    checked_at = excluded.checked_at`;

const LOT = 50;
let ecrits = 0;
for (let i = 0; i < rows.length; i += LOT) {
  const lot = rows.slice(i, i + LOT).map((r) => ({
    sql: SQL,
    args: [r.aniId, r.slug, r.verdict, r.videoId, r.ytTitle, r.ytChannel,
           r.duration, r.artist, r.artistSrc, ALGO_VERSION, now],
  }));
  await client.batch(lot, "write");
  ecrits += lot.length;
  console.log(`  écrit ${ecrits}/${rows.length}`);
}

console.log(`\nTerminé — ${ecrits} ligne(s) dans oped_youtube.`);
