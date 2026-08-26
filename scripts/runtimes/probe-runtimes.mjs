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

/**
 * Hotes sondes par defaut : PAS tous les hotes affiches.
 *
 * Mesure du 08/08/2026 (devlog/oped.md, lot top50) : sibnet et sendvid etaient
 * PROPOSES sur ~85 % des saisons et n'ont rien rendu — sendvid repond 502 sur sa
 * propre page d'accueil, sibnet renvoie un 403 nginx nu sur `shell.php` quels que
 * soient le Referer et l'UA. Les mettre dans le defaut, c'est deux resolutions
 * ratees par cellule sur tout le catalogue, soit environ 68 000 requetes pour
 * rien — et autant d'occasions de se faire bannir davantage.
 *
 * `--hosts=all` force la liste complete (pour re-tester un hote reveille).
 */
const WORKING_HOSTS = ["ansembed", "megaplay", "vidmoly-va", "uqload"];
const HOSTS = (
  args.hosts === "all"
    ? DISPLAYED_HOSTS
    : args.hosts
      ? args.hosts.split(",")
      : WORKING_HOSTS
).filter((h) => DISPLAYED_HOSTS.includes(h));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
/**
 * Requetes simultanees CHEZ UN HOTE — toutes confondues, resolution comme
 * lecture de manifeste.
 *
 * Un seul bouton, et c'est le sujet. La version precedente en avait deux
 * (3 plages de front × 4 manifestes) sans jamais borner leur PRODUIT : megaplay
 * recevait douze requetes a la fois et a repondu 429 sur 402 sondes du premier
 * lot de 100 titres. Le meme megaplay ne bronchait pas en sequentiel — c'est
 * donc bien nous qui l'avons fait plier, pas lui qui etait fragile.
 */
const HOST_CONC = Number(args["host-conc"] || 4);
/** Plafond de l'espacement appris. 2 s = 30 requetes/min chez un hote :
 *  assez lent pour n'importe quel budget rencontre, assez rapide pour que la
 *  passe complete tienne dans une nuit. */
const MAX_GAP_MS = Number(args["max-gap"] || 2000);
const ONLY_MISSING = !!args["only-missing"];
const DRY = !!args.dry;

/* Un refus passager, par opposition a un refus definitif. Declare ici, tout en
   haut, parce que `resolveHost` s'en sert bien avant que le limiteur existe. */
const RETRYABLE = /HTTP (429|50\d)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Ce qu'on a deja, charge EN UNE FOIS (--only-missing).
 *
 * La reprise est ce qui rend une passe de plusieurs heures rejouable : c'est la
 * base elle-meme qui sert d'etat, pas un manifeste a cote qui peut en diverger.
 * Mais interroger Turso par (anime, lang, hote) faisait ~6 400 requetes avant
 * meme la premiere sonde — le cout de la reprise depassait celui du travail.
 * Une seule lecture, indexee en memoire, coute une requete.
 */
const COVERAGE = new Map();
async function loadCoverage() {
  const r = await db.execute(
    "SELECT mal_id, lang, host, episode FROM episode_runtimes",
  );
  for (const row of r.rows) {
    const key = `${Number(row.mal_id)}:${row.lang}:${row.host}`;
    let set = COVERAGE.get(key);
    if (!set) COVERAGE.set(key, (set = new Set()));
    set.add(Number(row.episode));
  }
  console.log(
    `[probe] reprise : ${r.rows.length} durees deja en base ` +
      `(${COVERAGE.size} panneaux)`,
  );
}
const known = (malId, lang, host) =>
  COVERAGE.get(`${malId}:${lang}:${host}`) || new Set();

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
  let out;
  try {
    out = JSON.parse(last);
  } catch {
    return { ok: false, episodes: [], errors: [`sortie illisible: ${last?.slice(0, 200)}`] };
  }
  /* `resolve.mjs` ne LEVE pas sur un refus : il le range dans `errors` et rend
     une liste vide. Sans cette traduction, un 429 pendant la resolution passait
     pour « cette saison n'a pas cet hote » — le limiteur n'en savait rien et
     continuait a la meme cadence. C'est ce qui a coute 143 plages megaplay au
     premier lot. On ne re-leve que si RIEN n'a ete resolu : une plage a moitie
     servie a d'autres causes que la cadence. */
  if (!out.episodes?.length && (out.errors || []).some((e) => RETRYABLE.test(e))) {
    throw new Error(`${host}: ${(out.errors || []).find((e) => RETRYABLE.test(e))}`);
  }
  return out;
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

/**
 * N taches de front sur une file, sans dependance. Les travailleurs se servent
 * dans la meme file par un index partage, donc un titre lent n'immobilise que
 * son travailleur — un decoupage en tranches egales, lui, aurait fait attendre
 * tout le monde sur la plus lente.
 */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/**
 * Limiteur ADAPTATIF par hote. Meme principe que le limiteur AIMD du detecteur
 * (`tools/opening-detector/oped/throttle.py`) : on monte doucement quand tout va
 * bien, on divise par deux des le premier refus.
 *
 * Pourquoi adaptatif plutot qu'un plafond fixe bien choisi : il n'existe pas de
 * bon plafond fixe. Il depend de l'hote, de l'heure, et de ce que l'IP a deja
 * consomme. Un chiffre code en dur est soit trop prudent pendant des heures,
 * soit trop gourmand pendant les dix minutes qui declenchent le bannissement.
 */
function makeGate(max) {
  /* Deux nombres, pas un. `limit` est la cadence du moment ; `ceiling` est le
     plus haut qu'on s'autorise a viser. Sans ce second, la remontee ramenait
     toujours vers le `max` demande — mesure sur megaplay : cadence 4 punie,
     retombee a 1, remontee a 3-4, punie de nouveau, en boucle. Le plafond
     descend avec les punitions et ne remonte pas : on cesse de redemander a un
     hote la cadence qu'il vient de refuser. */
  let ceiling = max;
  let limit = max;
  let active = 0;
  let streak = 0;
  /* L'ESPACEMENT, et c'est lui qui compte le plus.
     Mesure sur megaplay : ramene a une seule requete a la fois, il repondait
     ENCORE 429. Une limite de simultaneite ne peut pas expliquer ca — ce qu'il
     compte, ce sont des requetes par minute. Reduire le parallelisme ne fait
     alors que decaler le probleme : un travailleur seul mais rapide depasse le
     meme budget. Il faut un delai minimal entre deux departs, et il s'apprend
     comme le reste : nul tant que l'hote ne dit rien, double a chaque refus. */
  let gap = 0;
  let nextFree = 0;
  const waiters = [];
  return {
    async run(fn) {
      while (active >= limit) await new Promise((r) => waiters.push(r));
      active++;
      // Reservation du creneau AVANT l'attente : deux travailleurs qui partent
      // ensemble prennent deux creneaux distincts, pas le meme.
      const now = Date.now();
      const slot = Math.max(now, nextFree);
      nextFree = slot + gap;
      if (slot > now) await sleep(slot - now);
      try {
        const v = await fn();
        // Remontee PRUDENTE : un cran tous les vingt succes, jamais au-dela du
        // plafond demande. C'est l'additive increase.
        /* Detente, dans l'ordre inverse du serrage : on relache d'abord
           l'espacement (le plus couteux en temps), la simultaneite ensuite. */
        if (++streak >= 20) {
          if (gap > 0) gap = Math.floor(gap / 2);
          else if (limit < ceiling) limit++;
          streak = 0;
        }
        return v;
      } finally {
        active--;
        waiters.shift()?.();
      }
    },
    /** Un refus (429/503) : on divise, et on repart de zero. */
    penalise(host) {
      const wasLimit = limit;
      const wasGap = gap;
      limit = Math.max(1, Math.floor(limit / 2));
      // Le plafond suit la descente, d'un cran au-dessus de la cadence retenue.
      ceiling = Math.max(1, Math.min(ceiling, limit + 1));
      // Deja au minimum de simultaneite ? Alors c'est un budget par minute, et
      // seul l'espacement peut encore ceder.
      if (limit === 1) gap = Math.min(MAX_GAP_MS, gap ? gap * 2 : 250);
      streak = 0;
      if (limit !== wasLimit || gap !== wasGap) {
        console.warn(
          `[probe] ${host}: cadence ${wasLimit} → ${limit}, ` +
            `espacement ${wasGap} → ${gap} ms`,
        );
      }
    },
  };
}

const GATES = new Map(HOSTS.map((h) => [h, makeGate(HOST_CONC)]));


/**
 * Une operation reseau chez un hote : sous limiteur, et REPRISE sur refus.
 *
 * La reprise n'est pas un luxe. Sans elle, un 429 — par definition passager —
 * faisait perdre l'episode DEFINITIVEMENT : la ligne n'etait jamais ecrite et
 * `--only-missing` la redemanderait au prochain passage, pour se faire refuser
 * de la meme façon tant que la cadence n'a pas baisse. Le premier lot a perdu
 * 402 sondes exactement comme ca.
 */
async function viaHost(host, fn, tries = 4) {
  const gate = GATES.get(host);
  for (let attempt = 1; ; attempt++) {
    try {
      return await gate.run(fn);
    } catch (e) {
      if (attempt >= tries || !RETRYABLE.test(String(e?.message))) throw e;
      gate.penalise(host);
      // 2 s, 6 s, 18 s : assez long pour qu'une fenetre de limitation retombe,
      // assez court pour ne pas immobiliser la file.
      await sleep(2000 * 3 ** (attempt - 1));
    }
  }
}

const pending = [];
let probed = 0;
let written = 0;
let failed = 0;
let unresolved = 0;

if (ONLY_MISSING) await loadCoverage();

/* L'ordre de la liste est celui de `export-oped-anime-list.mjs` : par
   popularite decroissante. Une passe interrompue a donc rempli ce que les gens
   regardent le plus, pas une tranche alphabetique au hasard. */
const list = JSON.parse(fs.readFileSync(LIST, "utf8")).slice(0, LIMIT);
console.log(
  `[probe] ${list.length} titres × ${HOSTS.length} hotes (${HOSTS.join(", ")})` +
    (DRY ? " — --dry, rien ne sera ecrit" : ""),
);

/* Le travail, a plat : une tache = une plage contigue d'episodes, sur un hote.
   Le mettre a plat AVANT de travailler est ce qui permet de le repartir — la
   triple boucle imbriquee d'origine ne pouvait rien faire d'autre que du
   sequentiel. L'ordre de `list` (popularite decroissante) est preserve dans
   chaque file, donc une passe interrompue a toujours rempli la tete du
   catalogue. */
const byHost = new Map(HOSTS.map((h) => [h, []]));
for (const anime of list) {
  for (const season of anime.seasons || []) {
    for (const host of HOSTS) {
      const have = ONLY_MISSING ? known(anime.mal_id, season.lang, host) : new Set();
      let wanted = episodesOf(season);
      if (ONLY_MISSING) wanted = wanted.filter((e) => !have.has(e));
      if (!wanted.length) continue;
      for (const [epStart, epEnd] of runsOf(wanted)) {
        byHost.get(host).push({ anime, season, host, epStart, epEnd });
      }
    }
  }
}

const total = [...byHost.values()].reduce((a, q) => a + q.length, 0);
console.log(
  `[probe] ${total} plages a resoudre — ` +
    [...byHost].map(([h, q]) => `${h}:${q.length}`).join(" "),
);

/** Une plage : resolution puis lecture des durees. */
async function handle({ anime, season, host, epStart, epEnd }) {
  let res;
  try {
    res = await viaHost(host, () =>
      resolveHost({
        slug: anime.slug,
        seasonDir: season.season_dir,
        lang: season.lang,
        epStart,
        epEnd,
        host,
        malId: anime.mal_id,
        vaSlug: season.va_slug,
      }),
    );
  } catch (e) {
    failed++;
    console.warn(`[probe] ${anime.slug} ${season.lang} ${host}: ${e.message}`);
    return;
  }

  /* Un episode demande que `resolve.mjs` n'a pas rendu n'est ni un succes ni une
     exception : il disparait simplement de `res.episodes`. Sans ce relevé il ne
     restait AUCUNE trace — 37 episodes demandes, 23 sondes, « 0 echecs ». C'est
     la lecon du lot top50 (devlog/oped.md, §08/08) : un repli silencieux ne se
     distingue pas d'une absence de donnee. `resolve.mjs` dit lui-meme lequel des
     deux c'est, dans `errors`. */
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

  /* Les manifestes d'une meme plage partent ensemble, mais TOUS par le limiteur
     de l'hote : c'est lui, et lui seul, qui decide combien passent a la fois.
     Un `.ffconcat` est un fichier local — il ne consomme aucun credit et n'a
     rien a faire dans le limiteur. */
  await pool(res.episodes || [], HOST_CONC, async (ep) => {
    let seconds = null;
    try {
      seconds = ep.url.endsWith(".ffconcat")
        ? ffconcatDuration(ep.url)
        : await viaHost(host, () =>
            ep.isM3U8 ? hlsDuration(ep.url, ep.referer) : mp4Duration(ep.url),
          );
    } catch (e) {
      failed++;
      console.warn(`[probe] ${anime.slug} ep${ep.ep} ${host}: ${e.message}`);
      return;
    }
    probed++;
    if (!(Number.isFinite(seconds) && seconds >= MIN_S && seconds <= MAX_S)) {
      failed++;
      return;
    }
    pending.push({
      malId: anime.mal_id,
      episode: Number(ep.ep),
      lang: season.lang,
      host,
      seconds: Math.round(seconds),
    });
  });

  /* On ecrit A CHAQUE PLAGE, pas tous les 200 releves.
     Le premier lot l'a paye : le processus s'est arrete a 700/824 plages et le
     compteur `probe` n'avait pas bouge — des centaines de mesures etaient encore
     dans le tampon, jamais ecrites, donc refaites au passage suivant. Une passe
     de plusieurs heures doit rendre son travail durable au rythme ou elle
     l'accomplit, et la plage est justement la granularite de la reprise.
     Le cout est une ecriture groupee d'une dizaine de lignes par plage. */
  if (pending.length) written += await flush();
}

/* Une file par hote, chacune avec SA limite. Le plafond doit etre par hote et
   non global : c'est un hote qu'on fait plier, pas « le reseau ». Trois est
   volontairement bas — le lot d'aout a valu un blocage de sibnet, et rien ici
   ne justifie de courir ce risque pour gagner une heure. Les quatre files
   avancent en meme temps, donc le parallelisme utile vient surtout de la. */
let done = 0;
const t0 = Date.now();
await Promise.all(
  [...byHost].map(([, queue]) =>
    pool(queue, HOST_CONC, async (task) => {
      await handle(task);
      done++;
      if (done % 50 === 0) {
        const per = (Date.now() - t0) / done / 1000;
        const left = ((total - done) * per) / 60;
        console.log(
          `[probe] ${done}/${total} plages — ${probed} sondes, ` +
            `reste ~${left.toFixed(0)} min`,
        );
      }
    }),
  ),
);
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
