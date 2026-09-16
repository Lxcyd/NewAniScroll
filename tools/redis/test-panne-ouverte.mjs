#!/usr/bin/env node
/**
 * LE CACHE PEUT TOMBER. LE SITE, NON.
 *
 * Le 16/09/2026, le palier gratuit d'Upstash (500 000 commandes par mois) a été
 * atteint. Chaque commande s'est mise à répondre `ERR max requests limit
 * exceeded`, et cette erreur est remontée telle quelle jusqu'à la réponse HTTP :
 * `/api/v2/episode/:id` en 500, `/api/v2/source` en 503, tous les lecteurs
 * cassés sur toutes les pages. Un cache plein avait mis le site hors service.
 *
 * Ce banc vérifie que ça ne peut plus arriver. Il pointe le client sur une
 * adresse qui refuse la connexion — la panne la plus brutale possible, plus
 * franche qu'un quota dépassé — et exige que CHAQUE commande :
 *   1. ne lève jamais ;
 *   2. rende la valeur d'un cache vide, documentée dans lib/redisRest.ts ;
 *   3. cesse d'appeler le réseau une fois le disjoncteur ouvert.
 *
 * Le point 3 n'est pas du confort : une fonction Vercel est facturée à la
 * seconde de CPU, et attendre un refus connu d'avance ferait payer le quota
 * Vercel — celui qui a mis le compte en pause le 11/09 — pour un cache déjà
 * mort. C'est l'enchaînement exact qu'on veut rendre impossible.
 *
 *     node tools/redis/test-panne-ouverte.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* Même procédé que tools/badges/check-catalog.mjs : le compilateur déjà présent
   dans le projet, et de VRAIS fichiers sous la racine — sans quoi `@upstash/redis`
   ne se résout pas (Node remonte l'arborescence depuis le fichier). */
const ts = (
  await import(
    pathToFileURL(join(ROOT, "node_modules", "typescript", "lib", "typescript.js")).href
  )
).default;
const CACHE = join(ROOT, "node_modules", ".cache", "redis-check");

const src = readFileSync(join(ROOT, "lib", "redisRest.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
mkdirSync(CACHE, { recursive: true });
const out = join(CACHE, "redisRest.mjs");
writeFileSync(out, js);

/* Une adresse qui refuse tout de suite : le port 1 n'écoute jamais. On ne
   contacte AUCUN service — surtout pas le nôtre : une boucle de sondes contre
   aniscroll.com est précisément ce que le garde-fou de quota interdit. */
process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
process.env.UPSTASH_REDIS_REST_TOKEN = "jeton-de-test";
delete process.env.REDIS_URL;

const { createRestRedis, redisAvailable } = await import(pathToFileURL(out).href);

let pass = 0;
const fails = [];
const eq = (nom, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass += 1;
  else fails.push(`${nom} : attendu ${b}, obtenu ${a}`);
};
const ok = (nom, cond) => {
  if (cond) pass += 1;
  else fails.push(nom);
};

const redis = createRestRedis();
ok("le client se construit malgré une adresse injoignable", !!redis);

/* ── 1. Aucune commande ne lève, et chacune rend la valeur d'un cache vide ──
 *
 * La liste est exhaustive À DESSEIN : c'est elle qui échouera le jour où
 * quelqu'un ajoutera une commande au shim sans lui donner de valeur de repli.
 * Une commande sans repli rendrait `null`, et un `null` là où l'appelant attend
 * un tableau relance exactement le genre de 500 qu'on vient de supprimer. */
const attendu = [
  ["get", ["k"], null],
  ["set", ["k", "v", "EX", 60], null],
  ["del", ["k"], 0],
  ["mget", ["a", "b", "c"], [null, null, null]],
  ["keys", ["*"], []],
  ["exists", ["k"], 0],
  ["expire", ["k", 60], 0],
  ["incr", ["k"], 0],
  ["sadd", ["s", "m"], 0],
  ["srem", ["s", "m"], 0],
  ["sismember", ["s", "m"], 0],
  ["smembers", ["s"], []],
  ["hset", ["h", "f", "v"], 0],
  ["hget", ["h", "f"], null],
  ["hgetall", ["h"], null],
  ["hdel", ["h", "f"], 0],
  ["zadd", ["z", 1, "m"], 0],
  ["zrem", ["z", "m"], 0],
  ["zrange", ["z", 0, -1], []],
  ["rpush", ["l", "v"], 0],
  ["lrange", ["l", 0, -1], []],
  ["ltrim", ["l", 0, 9], "OK"],
  ["publish", ["c", "m"], 0],
  ["scan", [0, "MATCH", "*"], ["0", []]],
];

for (const [nom, args, want] of attendu) {
  let got;
  try {
    got = await redis[nom](...args);
  } catch (e) {
    fails.push(`${nom} a LEVÉ (${e?.message ?? e}) — le site retomberait en 500`);
    continue;
  }
  eq(`${nom} rend la valeur d'un cache vide`, got, want);
}

/* `mget` est le cas où la valeur de repli dépend des arguments : rendre `null`
   au lieu d'un tableau de la bonne longueur ferait planter la déstructuration
   des appelants (`const [cached, lock] = await redis.mget(...)`). */
eq("mget rend autant d'entrées que de clés demandées", (await redis.mget("x")).length, 1);

/* ── 2. Le pipeline aussi ── */
try {
  const r = await redis.pipeline().hset("h", { a: "1" }).expire("h", 60).exec();
  eq("un pipeline refusé rend une liste vide", r, []);
} catch (e) {
  fails.push(`pipeline.exec a LEVÉ (${e?.message ?? e})`);
}

/* ── 3. Le disjoncteur est ouvert, et il coupe vraiment le réseau ──
 *
 * La mesure de temps est le seul moyen de distinguer « rendu par repli sans
 * appel » de « appelé puis rattrapé ». Cent commandes qui partiraient vraiment
 * sur le réseau ne tiendraient pas dans quelques millisecondes. */
ok("le disjoncteur s'est ouvert après la première erreur", redisAvailable() === false);

const t0 = Date.now();
for (let i = 0; i < 100; i++) await redis.get(`k${i}`);
const ms = Date.now() - t0;
ok(
  `100 commandes pendant la panne ne touchent pas le réseau (${ms} ms)`,
  ms < 150,
);

/* ── Verdict ── */
if (fails.length) {
  console.error(`\n✗ ${fails.length} échec(s) sur ${pass + fails.length} :\n`);
  for (const f of fails) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `${pass} assertions passées — une panne de cache rend le site lent, pas mort.`,
);
