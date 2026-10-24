#!/usr/bin/env node
/**
 * Envoie les fonds animés (lib/profile/fonds.ts) dans le bucket R2
 * `aniscroll-fonds`, servi sous https://fonds.aniscroll.com.
 *
 * Prérequis, UNE fois : R2 activé dans le tableau de bord Cloudflare (sinon
 * l'API répond « Please enable R2 », code 10042), et wrangler connecté
 * (`cd worker && npx wrangler whoami`).
 *
 * usage :
 *   node scripts/fonds/upload.mjs <dossier>          # ex. C:/Users/Luc/Downloads/aniscroll-fonds
 *   node scripts/fonds/upload.mjs <dossier> --dry    # liste sans rien envoyer
 *
 * Idempotent : un fichier déjà envoyé (noté dans <dossier>/.envoyes.json) avec
 * la même taille n'est pas renvoyé.
 * Le bucket, sa règle CORS et son domaine sont créés s'ils manquent.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [dir] = process.argv.slice(2);
const DRY = process.argv.includes("--dry");
if (!dir) {
  console.error("usage : node scripts/fonds/upload.mjs <dossier> [--dry]");
  process.exit(1);
}
const BUCKET = "aniscroll-fonds";
const DOMAIN = "fonds.aniscroll.com";
const WORKER = resolve("worker"); // le wrangler connecté du dépôt

function wrangler(args, { quiet = false } = {}) {
  try {
    return execFileSync("npx", ["--no-install", "wrangler", ...args], {
      cwd: WORKER,
      encoding: "utf8",
      shell: true,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    });
  } catch (e) {
    if (quiet) return null;
    throw e;
  }
}

const catalogue = JSON.parse(readFileSync("lib/profile/fonds.json", "utf8"));
const fichiers = catalogue.flatMap((f) => [
  { key: f.file, type: "video/webm" },
  { key: f.poster, type: "image/jpeg" },
  ...(f.thumb ? [{ key: f.thumb, type: "image/webp" }] : []),
]);
for (const f of fichiers) f.size = statSync(join(dir, f.key)).size;
const total = fichiers.reduce((a, f) => a + f.size, 0);
console.log(`${fichiers.length} fichiers, ${(total / 1e6).toFixed(0)} Mo`);
if (DRY) process.exit(0);

// 1. Le bucket.
const buckets = wrangler(["r2", "bucket", "list"]) || "";
if (!buckets.includes(BUCKET)) {
  console.log(`création du bucket ${BUCKET}`);
  wrangler(["r2", "bucket", "create", BUCKET]);
}

// 2. CORS : le site (et le local) lisent les vidéos ; GET/HEAD seulement.
const cors = join(tmpdir(), "fonds-cors.json");
writeFileSync(
  cors,
  JSON.stringify({
    rules: [
      {
        allowed: {
          origins: ["https://aniscroll.com", "https://www.aniscroll.com", "https://dev.aniscroll.com", "http://localhost:3123"],
          methods: ["GET", "HEAD"],
          headers: ["Range"],
        },
        exposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
        maxAgeSeconds: 86400,
      },
    ],
  }),
);
wrangler(["r2", "bucket", "cors", "set", BUCKET, "--file", cors, "--force"], { quiet: true }) ??
  console.warn("⚠ règle CORS non posée (wrangler trop ancien ?) — à faire dans le tableau de bord");

// 3. Les fichiers. Un an de cache : un fond ne change jamais sous le même nom.
// Ce qui est déjà parti est noté dans <dossier>/.envoyes.json (clé → taille) :
// wrangler n'a pas de HEAD, et relire l'objet coûterait le fichier entier.
const journal = join(dir, ".envoyes.json");
let deja = {};
try {
  deja = JSON.parse(readFileSync(journal, "utf8"));
} catch {}
let envoyes = 0;
for (const f of fichiers) {
  if (deja[f.key] === f.size) continue;
  wrangler([
    "r2", "object", "put", `"${BUCKET}/${f.key}"`,
    "--file", `"${join(dir, f.key)}"`,
    "--content-type", f.type,
    "--cache-control", `"public, max-age=31536000, immutable"`,
    "--remote",
  ]);
  envoyes++;
  deja[f.key] = f.size;
  writeFileSync(journal, JSON.stringify(deja));
  if (envoyes % 10 === 0) console.log(`${envoyes} envoyés…`);
}
console.log(`${envoyes} fichiers envoyés (${fichiers.length - envoyes} déjà en place)`);

// 4. Le domaine : aniscroll.com est sur ce compte Cloudflare (proxy.aniscroll.com).
const domaines = wrangler(["r2", "bucket", "domain", "list", BUCKET], { quiet: true }) || "";
if (!domaines.includes(DOMAIN)) {
  console.log(`branchement de ${DOMAIN}`);
  const ok = wrangler(["r2", "bucket", "domain", "add", BUCKET, "--domain", DOMAIN, "--force"], { quiet: true });
  if (ok == null)
    console.warn(
      `⚠ domaine non branché automatiquement : tableau de bord > R2 > ${BUCKET} > Settings > Custom Domains > ${DOMAIN}`,
    );
}
console.log(`fini — test : curl -I https://${DOMAIN}/${fichiers[0].key}`);
