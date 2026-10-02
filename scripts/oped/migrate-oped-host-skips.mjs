/**
 * Amene `oped_host_skips` a sa definition courante (colonnes ajoutees apres
 * coup, index de lecture par saison) et affiche le schema obtenu. Idempotent.
 * L'importeur fait la meme chose avant d'ecrire ; ce script sert a preparer la
 * base SANS rien importer.
 *
 *   node --env-file=.env.local scripts/oped/migrate-oped-host-skips.mjs
 */
import { createClient } from "@libsql/client";
import { migrate } from "../../lib/db/opedHostSkipsSchema.js";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
await migrate(db);
const schema = await db.execute(
  "select name, sql from sqlite_master where tbl_name = 'oped_host_skips' and sql is not null",
);
for (const r of schema.rows) console.log(`-- ${r.name}\n${r.sql}\n`);
const n = await db.execute("select count(*) n from oped_host_skips");
console.log(`${n.rows[0].n} ligne(s)`);
