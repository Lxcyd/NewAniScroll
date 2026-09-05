/**
 * Ecrit ce que oped_youtube contient deja, pour que le rattrapage saute ce qui
 * est fait.
 *
 *   node --env-file=.env.local scripts/oped/dump-resolved-ids.mjs --out=done.json
 *
 * POURQUOI LA TABLE EST L'ETAT. Le rattrapage tenait un `state.json` local, ce
 * qui marche sur un poste et pas dans une Action : le runner est jete a chaque
 * execution. Plutot que d'inventer un stockage d'etat, on lit celui qui existe
 * deja — une ligne dans oped_youtube VEUT DIRE « ce theme a ete traite », y
 * compris quand il n'a rien donne. C'est la regle sur laquelle la table est
 * construite, il suffisait de s'en servir.
 *
 * Indexe par (ani_id, slug) et non par ani_id seul, et c'est ce qui fait que le
 * meme mecanisme couvre les deux besoins : le rattrapage saute les themes deja
 * vus, et un ED ajoute plus tard sur un anime deja traite reste, lui, a faire.
 * Sauter l'anime entier l'aurait rendu invisible pour toujours.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const OUT = args.out || "done.json";

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL absent.");
  process.exit(1);
}
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

/* La table peut ne pas exister au tout premier passage : l'importeur la cree,
   et il n'a encore jamais tourne. Un catalogue vide est la bonne reponse. */
let rows = [];
try {
  const rs = await client.execute(
    "SELECT ani_id, slug FROM oped_youtube",
  );
  rows = rs.rows;
} catch (e) {
  console.warn(`[dump] lecture impossible (${e?.message}) — on repart de zero.`);
}

const paires = rows.map((r) => `${r.ani_id}|${r.slug}`);
fs.writeFileSync(OUT, JSON.stringify(paires), "utf8");

const animes = new Set(rows.map((r) => Number(r.ani_id)));
console.log(`${paires.length} theme(s) deja traite(s), sur ${animes.size} anime(s).`);
console.log(`Ecrit dans ${OUT}`);
