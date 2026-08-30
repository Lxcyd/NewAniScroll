/**
 * Accès partagé aux deux fournisseurs participatifs (AniSkip, Anime-Skip).
 *
 * Extrait de `_crosscheck_skip.mjs` le 08/08 quand un second outil
 * (`_compare_sources.mjs`, point 6 du plan) a eu besoin des mêmes appels.
 * La raison d'extraire plutôt que de copier est celle qui a déjà fait compiler
 * `lib/skip/providers.ts` au lieu d'en réécrire les appels : deux copies
 * dérivent, et le jour où elles dérivent la mesure hors-ligne cesse de décrire
 * ce que le lecteur reçoit vraiment.
 *
 * Le cache disque est partagé entre les deux outils À DESSEIN — c'est la même
 * question posée à la même paire (anime, épisode), donc la reposer serait
 * doublement payer un fournisseur gratuit qu'on ne veut pas fâcher.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(HERE, "../..");
const CACHE = join(HERE, "cache/skip-crosscheck");

/** Compile `lib/skip/providers.ts` une fois et rend ses deux fonctions. */
export async function loadProviders() {
  const BUILD = join(CACHE, "build");
  const SRC = join(ROOT, "lib/skip/providers.ts");
  const COMPILED = join(BUILD, "providers.js");
  mkdirSync(BUILD, { recursive: true });
  if (!existsSync(COMPILED) || statSync(COMPILED).mtimeMs < statSync(SRC).mtimeMs) {
    // Appeler tsc par `node` directement : spawner `npx.cmd` demande un shell
    // sous Windows et échoue en ENOENT depuis execFileSync.
    execFileSync(
      process.execPath,
      [join(ROOT, "node_modules/typescript/lib/tsc.js"),
       SRC, "--outDir", BUILD, "--module", "esnext", "--target", "es2020",
       "--moduleResolution", "bundler", "--skipLibCheck"],
      { cwd: ROOT, stdio: "inherit" },
    );
    // tsc émet du .js ; Node veut l'extension ESM pour honorer `export`.
    writeFileSync(join(BUILD, "providers.mjs"),
                  readFileSync(join(BUILD, "providers.js"), "utf8"), "utf8");
  }
  return import(pathToFileURL(join(BUILD, "providers.mjs")).href);
}

/**
 * Interroge les deux fournisseurs pour une paire (anime, épisode), sur cache.
 *
 * Ni l'un ni l'autre ne connaît la LANGUE : les lignes vostfr et vf du même
 * épisode sont la même question posée deux fois, d'où la clé sans langue.
 */
export function makeLookup({ fetchFromAniSkip, fetchFromAnimeSkip }) {
  mkdirSync(CACHE, { recursive: true });
  return async function lookup({ mal_id, anilist_id, episode, episode_length }) {
    const cacheFile = join(CACHE, `${mal_id}_${episode}.json`);
    if (existsSync(cacheFile)) {
      try { return JSON.parse(readFileSync(cacheFile, "utf8")); } catch { /* refetch */ }
    }
    const [aniskip, animeskip] = await Promise.all([
      fetchFromAniSkip(mal_id, episode, episode_length)
        .catch((e) => ({ error: String(e?.message || e) })),
      anilist_id
        ? fetchFromAnimeSkip(anilist_id, episode)
            .catch((e) => ({ error: String(e?.message || e) }))
        : Promise.resolve([]),
    ]);
    const rec = {
      aniskip: Array.isArray(aniskip) ? aniskip : [],
      animeskip: Array.isArray(animeskip) ? animeskip : [],
      errors: [aniskip, animeskip].filter((x) => x && x.error).map((x) => x.error),
    };
    writeFileSync(cacheFile, JSON.stringify(rec), "utf8");
    return rec;
  };
}

/** Exécute `fn` sur `items` avec N ouvriers, en signalant l'avancement. */
export async function pool(items, fn, { concurrency = 3, label = "" } = {}) {
  const queue = [...items];
  let done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const it = queue.shift();
      if (!it) return;
      await fn(it);
      if (++done % 25 === 0) {
        process.stderr.write(`  ${label}${done}/${items.length}\n`);
      }
    }
  }));
}
