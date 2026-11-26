/**
 * La table `anime_bgm` : les BGM d'un anime résolues sur YouTube par
 * tools/ost-resolver/bgm.py, servies par /api/v2/anisongs (26/11/2026).
 *
 *   node --env-file=.env scripts/music/import-anime-bgm.mjs --done=done.json
 *   node --env-file=.env scripts/music/import-anime-bgm.mjs --in=bgm.jsonl [--dry]
 *
 * `--done` écrit les ids déjà traités (pour `bgm.py --skip-file`) : comme
 * oped_youtube, LA TABLE EST L'ÉTAT — une ligne à n = 0 veut dire « regardé,
 * rien de sûr », pas « à refaire ».
 *
 * Une ligne par anime (une lecture Turso par ouverture du menu Musique) :
 *   data = [{ t, a, d, r, al, c, y }] — titre, compositeur, durée (s), rang
 *   Deezer, album, pochette Deezer, id YouTube. Rangées par rang décroissant.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : "1"];
  }),
);

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL absent.");
  process.exit(1);
}
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

await db.execute(`CREATE TABLE IF NOT EXISTS anime_bgm (
  ani_id     INTEGER PRIMARY KEY,
  n          INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  cand       INTEGER NOT NULL DEFAULT 0,
  albums     TEXT,
  algo       INTEGER NOT NULL DEFAULT 1,
  checked_at INTEGER NOT NULL
)`);

/* LE RAFRAÎCHISSEMENT (26/11/2026, Luc : « bloque à une certaine date après la
   sortie »). Un nouveau volume d'OST sort pendant la diffusion ou avec les
   Blu-ray, des mois après. Un anime est donc REVU tant qu'il est en cours, à
   venir, en pause, ou fini depuis moins de 12 mois : tous les 14 jours s'il a
   des BGM, tous les 30 jours sinon. Au-delà, sa ligne est figée pour de bon.
   Fin inconnue d'un anime fini : figé. */
const DAY = 86400;
const WINDOW_DAYS = 365;
const EVERY = { full: 14 * DAY, empty: 30 * DAY };
const REFRESH_MAX = 100;

function inWindow(status, end, now) {
  if (status === "RELEASING" || status === "NOT_YET_RELEASED" || status === "HIATUS") return true;
  if (!end?.year) return false;
  const t = Date.UTC(end.year, (end.month ?? 12) - 1, end.day ?? 28) / 1000;
  return now - t < WINDOW_DAYS * DAY;
}

if (args.done) {
  const now = Math.floor(Date.now() / 1000);
  const rs = await db.execute(
    `SELECT b.ani_id, b.n, b.checked_at, a.status, json_extract(a.data, '$.endDate') AS end
       FROM anime_bgm b LEFT JOIN anime a ON a.id = b.ani_id`,
  );
  const done = [];
  const stale = [];
  for (const r of rs.rows) {
    let end = null;
    try {
      end = r.end ? JSON.parse(String(r.end)) : null;
    } catch {}
    const age = now - Number(r.checked_at);
    const due = inWindow(r.status, end, now) && age > (Number(r.n) > 0 ? EVERY.full : EVERY.empty);
    (due ? stale : done).push({ id: Number(r.ani_id), age });
  }
  /* Les plus anciens d'abord, et pas plus de REFRESH_MAX par passage : la
     tranche des nouveaux garde sa place. Le surplus attend le lendemain. */
  stale.sort((a, b) => b.age - a.age);
  const refresh = stale.slice(0, REFRESH_MAX).map((x) => x.id);
  const later = stale.slice(REFRESH_MAX).map((x) => x.id);
  fs.writeFileSync(args.done, JSON.stringify([...done.map((x) => x.id), ...later]), "utf8");
  console.log(`${done.length + later.length} anime(s) à ne pas reprendre -> ${args.done}`);
  if (args.refresh) {
    fs.writeFileSync(args.refresh, JSON.stringify(refresh), "utf8");
    console.log(`${refresh.length} anime(s) à rafraîchir (${stale.length} dus) -> ${args.refresh}`);
  }
}

if (args.in) {
  const YT = /^[A-Za-z0-9_-]{11}$/;
  const lines = fs.readFileSync(args.in, "utf8").split("\n").filter((l) => l.trim());
  /* Le dernier passage d'un même anime l'emporte (le JSONL s'ajoute). */
  const rows = new Map();
  for (const l of lines) {
    const r = JSON.parse(l);
    if (!Number.isInteger(r.ani_id) || r.ani_id <= 0) continue;
    /* L'id part dans l'URL d'une iframe : revalidé ici, pas seulement là-bas. */
    const tracks = (r.tracks ?? [])
      .filter((t) => YT.test(t.y ?? "") && t.t)
      .map((t) => ({ t: t.t, a: t.a, d: t.d, r: t.r, al: t.al, c: t.c ?? null, y: t.y }));
    rows.set(r.ani_id, { id: r.ani_id, tracks, cand: r.cand ?? 0, albums: r.albums ?? [], algo: r.algo ?? 1 });
  }
  /* UN RAFRAÎCHISSEMENT N'ENLÈVE RIEN : Piped en panne rendrait zéro piste, et
     effacerait celles d'hier. L'ancienne liste est fusionnée à la nouvelle
     (par vidéo), puis retriée par rang. */
  const ids = [...rows.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const old = await db.execute({
      sql: `SELECT ani_id, data FROM anime_bgm WHERE n > 0 AND ani_id IN (${part.map(() => "?").join(",")})`,
      args: part,
    });
    for (const o of old.rows) {
      const r = rows.get(Number(o.ani_id));
      let prev = [];
      try {
        prev = JSON.parse(String(o.data));
      } catch {}
      const have = new Set(r.tracks.map((t) => t.y));
      r.tracks = [...r.tracks, ...prev.filter((t) => YT.test(t.y ?? "") && !have.has(t.y))].sort(
        (a, b) => (b.r ?? 0) - (a.r ?? 0),
      );
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const stmts = [...rows.values()].map((r) => ({
    sql: `INSERT INTO anime_bgm (ani_id, n, data, cand, albums, algo, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ani_id) DO UPDATE SET n = excluded.n, data = excluded.data, cand = excluded.cand,
            albums = excluded.albums, algo = excluded.algo, checked_at = excluded.checked_at`,
    args: [r.id, r.tracks.length, JSON.stringify(r.tracks), r.cand, JSON.stringify(r.albums), r.algo, now],
  }));
  const pistes = [...rows.values()].reduce((s, r) => s + r.tracks.length, 0);
  if (args.dry) {
    console.log(`[dry] ${stmts.length} anime(s), ${pistes} BGM.`);
  } else {
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100), "write");
    console.log(`${stmts.length} anime(s) importé(s), ${pistes} BGM.`);
  }
}
