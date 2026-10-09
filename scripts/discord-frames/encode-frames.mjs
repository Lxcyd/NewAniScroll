#!/usr/bin/env node
/**
 * Fabrique les versions LEGERES des cadres d'avatar et les range dans le KV
 * Cloudflare, ou le Worker les sert (`/w/frame/<asset>/<160|256>.avif`).
 *
 * Pourquoi : Discord ne sert l'animation qu'en APNG d'origine, ~800 Ko a 1 Mo
 * par cadre (`size` est ignore des que l'animation est demandee). La grille du
 * studio en charge des dizaines a la fois et mettait des secondes a s'animer.
 *
 * Pourquoi l'AVIF et pas le WebP : mesure du 09/10/2026 sur 5 cadres, le WebP
 * anime ne descend pas sous ~530 Ko en 160 px quelle que soit la qualite (alpha
 * sans perte, aucune image commune d'une frame a l'autre), alors que l'AVIF
 * anime avec transparence fait ~70-85 Ko en 160 px et ~140-175 Ko en 256 px.
 * Rendu verifie dans Chrome : transparence et animation intactes.
 *
 * PIEGE : le decodeur APNG de ffmpeg coupe parfois en cours de route (« chunk
 * too big ») et rend une animation TRONQUEE sans echouer (39 images sur 60).
 * Chaque sortie est donc recomptee contre la source (au moins autant d images :
 * une source a delais variables en gagne, ffmpeg duplique pour garder le rythme),
 * un nouvel essai, puis le
 * cadre est laisse de cote : le site retombe alors sur l'APNG de Discord.
 *
 * QUOTA : le KV gratuit accepte 1 000 ecritures par jour, et un cadre en coute
 * deux. D'ou `--max` (450 par defaut) : le stock initial passe en deux jours,
 * les nouveautes de la boutique ensuite en une nuit.
 *
 *   node scripts/discord-frames/encode-frames.mjs [--max 450] [--dry]
 *
 * Besoin : ffmpeg (libaom-av1, muxer avif) et ffprobe dans le PATH ;
 * TURSO_DATABASE_URL/TURSO_AUTH_TOKEN, CF_ACCOUNT_ID/CF_KV_NAMESPACE_ID/CF_KV_API_TOKEN.
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { createClient } from "@libsql/client";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const DRY = process.argv.includes("--dry");
const iMax = process.argv.indexOf("--max");
const MAX = iMax > 0 ? Number(process.argv[iMax + 1]) : 450;
const TAILLES = [160, 256];
const PARALLELE = 4;

const { CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_KV_API_TOKEN } = process.env;
if (!DRY && !(CF_ACCOUNT_ID && CF_KV_NAMESPACE_ID && CF_KV_API_TOKEN)) {
  console.error("[encode] CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_KV_API_TOKEN manquants");
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
try {
  await db.execute("ALTER TABLE avatar_frames ADD COLUMN encoded_at INTEGER");
} catch {
  /* colonne deja la */
}

const aFaire = (
  await db.execute({
    sql: "SELECT asset FROM avatar_frames WHERE encoded_at IS NULL ORDER BY rank ASC LIMIT ?",
    args: [MAX],
  })
).rows.map((r) => String(r.asset));
console.log(`[encode] ${aFaire.length} cadre(s) a encoder (plafond ${MAX})`);
if (!aFaire.length) process.exit(0);

const dossier = mkdtempSync(join(tmpdir(), "frames-"));

/* Le flux LE PLUS LONG : un AVIF anime porte aussi une image fixe (et son
   alpha) en tete, comptees chacune pour une seule image. */
async function images(fichier) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", fichier,
  ]);
  return Math.max(0, ...String(stdout).trim().split(/\s+/).map((n) => Number(n) || 0));
}

async function encode(src, taille, out) {
  await run("ffmpeg", [
    "-v", "error", "-y", "-i", src,
    "-filter_complex",
    `[0:v]scale=${taille}:${taille}:flags=lanczos,format=yuva420p,split[c][a];[a]alphaextract[al]`,
    "-map", "[c]", "-map", "[al]",
    "-c:v", "libaom-av1", "-crf", "40", "-cpu-used", "8", "-row-mt", "1",
    "-f", "avif", out,
  ]).catch(() => undefined); /* une coupure se juge au compte d'images, pas au code */
}

async function kvPut(cle, corps) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}` +
    `/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(cle)}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${CF_KV_API_TOKEN}`, "Content-Type": "application/octet-stream" },
    body: corps,
  });
  if (!r.ok) throw new Error(`KV ${cle} -> HTTP ${r.status} ${await r.text()}`);
}

let ok = 0;
let rate = 0;
let poidsAvant = 0;
let poidsApres = 0;

async function traite(asset) {
  const src = join(dossier, `${asset}.png`);
  const res = await fetch(
    `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?passthrough=true`,
  );
  if (!res.ok) throw new Error(`APNG ${asset} -> HTTP ${res.status}`);
  const apng = Buffer.from(await res.arrayBuffer());
  writeFileSync(src, apng);
  const attendu = await images(src);
  const sorties = [];
  for (const t of TAILLES) {
    const out = join(dossier, `${asset}-${t}.avif`);
    let n = 0;
    for (let essai = 0; essai < 2 && n < attendu; essai++) {
      await encode(src, t, out);
      n = await images(out).catch(() => 0);
    }
    if (!attendu || n < attendu) {
      throw new Error(`${asset} ${t}px : ${n} images sur ${attendu} (decodage APNG tronque)`);
    }
    sorties.push([t, readFileSync(out)]);
  }
  if (!DRY) {
    for (const [t, corps] of sorties) await kvPut(`frame:${asset}:${t}`, corps);
    await db.execute({
      sql: "UPDATE avatar_frames SET encoded_at = ? WHERE asset = ?",
      args: [Math.floor(Date.now() / 1000), asset],
    });
  }
  poidsAvant += apng.length;
  poidsApres += sorties[0][1].length;
  ok++;
}

const file = [...aFaire];
await Promise.all(
  Array.from({ length: PARALLELE }, async () => {
    for (let a = file.shift(); a; a = file.shift()) {
      try {
        await traite(a);
      } catch (e) {
        rate++;
        console.warn(`[encode] ${e.message}`);
      }
      if ((ok + rate) % 25 === 0) console.log(`[encode] ${ok + rate}/${aFaire.length}`);
    }
  }),
);
rmSync(dossier, { recursive: true, force: true });
const ko = (n) => Math.round(n / 1024);
console.log(
  `[encode] ${ok} encodes, ${rate} laisses sur l'APNG Discord ; ` +
    `moyenne ${ko(poidsAvant / Math.max(ok, 1))} Ko -> ${ko(poidsApres / Math.max(ok, 1))} Ko (160 px)` +
    (DRY ? " — --dry, rien n'est ecrit" : ""),
);
