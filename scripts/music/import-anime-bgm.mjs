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

if (args.done) {
  /* Un vide de plus de 60 jours se refait : l'OST d'un anime en cours sort
     souvent après lui. */
  const rs = await db.execute({
    sql: "SELECT ani_id FROM anime_bgm WHERE n > 0 OR checked_at > ?",
    args: [Math.floor(Date.now() / 1000) - 60 * 86400],
  });
  const ids = rs.rows.map((r) => Number(r.ani_id));
  fs.writeFileSync(args.done, JSON.stringify(ids), "utf8");
  console.log(`${ids.length} anime(s) déjà traité(s) -> ${args.done}`);
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
