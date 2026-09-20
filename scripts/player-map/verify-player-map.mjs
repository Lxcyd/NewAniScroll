/**
 * Incremental player_map verifier — the maintenance loop of the player
 * infrastructure. Re-derives due mappings with the CURRENT resolver code and
 * promotes/demotes them:
 *
 *   node --env-file=.env.local scripts/player-map/verify-player-map.mjs \
 *        [--site=http://localhost:3000] [--limit=200] [--concurrency=6] \
 *        [--ids=123,456] [--from=due|seed|mydublist] [--dry]
 *
 * What gets picked up (oldest deadline first, capped by --limit so a run has a
 * BOUNDED worker budget):
 *   • --from=due (defaut)     — status='heuristic' (ecritures d'execution en
 *                               attente de leur premier controle) et
 *                               expires_at < now (verified RELEASING, broken,
 *                               absent : les catalogues grandissent)
 *   • --from=seed             — les lignes `verified` d'un algorithme perime.
 *                               Elles VIENNENT d'un semis, pas d'un controle,
 *                               et le chemin de lecture les honore sans
 *                               reserve : c'est la classe a drainer en premier.
 *   • --from=mydublist        — les titres doubles en francais qu'on n'a jamais
 *                               sondes en VF (aucune ligne `lang='vf'`)
 *   • --ids                   — re-controles explicites (apres un signalement)
 *
 * CE SCRIPT EST LE SEUL A POUVOIR ECRIRE `verified`. Un semis produit une
 * hypothese, donc `heuristic` ; seul un controle avec le code du jour promeut.
 * Jusqu'au 20/09/2026 les deux ecrivaient `verified`, et 2 246 lignes semees
 * depuis un audit ancien portaient donc une autorite qu'elles n'avaient jamais
 * gagnee — trois lignes seulement, sur 2 325, etaient passees par ici.
 *
 * Verdicts (same safety gates as the seed — KEEP IN SYNC, a une exception pres :
 * la porte MyDubList est volontairement absente du resolveur d'execution, voir
 * son commentaire plus bas) :
 *   verified — inspect found slug(+dir), episode count consistent with
 *              AniList (±1, behind-ok for RELEASING, or merged with offset),
 *              title confidence > 0, no S1-collapse shape, langs consistent.
 *   broken   — found but failing a gate (would serve wrong content).
 *   absent   — inspect found nothing. Trustworthy here (unlike the historic
 *              audit) because we run with the current, fixed resolver.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const SITE = (args.site || process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const LIMIT = Number(args.limit || 200);
const CONCURRENCY = Number(args.concurrency || 6);
const DRY = !!args.dry;
const ONLY_IDS = args.ids
  ? new Set(String(args.ids).split(",").map(Number).filter(Boolean))
  : null;
/* Quelle liste de travail : les lignes echues (defaut), les lignes semees que
   personne n'a jamais controlees (`seed`), ou les titres que MyDubList donne
   doubles en francais et qu'on n'a jamais sondes en VF (`mydublist`). */
const FROM = String(args.from || "due");

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/* ── gating helpers (KEEP IN SYNC with seed-player-map.mjs + source/index.js) ── */
const SLUG_STOPWORDS = new Set([
  "the", "les", "des", "une", "der", "die", "das", "and", "for", "you", "her",
  "his", "day", "new", "of", "my", "no", "to", "wa", "ga", "ni", "de", "la",
  "le", "wo", "san", "kun", "chan", "season", "part", "tv", "ova", "ona", "aux",
  "sur",
]);
const normalize = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const titleToSlug = (t) => normalize(t).replace(/\s+/g, "-");
const significantTokens = (s) => [
  ...new Set(normalize(String(s).replace(/-/g, " ")).split(" ").filter((t) => t.length >= 3 && !SLUG_STOPWORDS.has(t))),
];
function slugTitleConfidence(slug, titles) {
  const slugSig = significantTokens(slug);
  if (slugSig.length === 0) return 1;
  const slugLen = slugSig.reduce((a, t) => a + t.length, 0);
  let best = 0;
  for (const t of (titles || []).filter(Boolean)) {
    const ts = titleToSlug(t);
    if (ts === slug || ts.replace(/-/g, "") === slug.replace(/-/g, "")) return 1;
    const titleSig = new Set(significantTokens(t));
    if (titleSig.size === 0) continue;
    const matched = slugSig.filter((tok) => titleSig.has(tok)).reduce((a, tok) => a + tok.length, 0);
    /* On divise par la longueur du SLUG, pas par `Math.min(slugLen, titleLen)`.
       Diviser par le plus court des deux faisait qu'un synonyme d'un seul mot
       certifiait n'importe quel slug le contenant : Kaitou Joker porte le
       synonyme « JOKER », donc `joker-game` sortait a 1,00 et « game » n'etait
       demande a personne. Meme mecanique pour `isekai-ojisan` contre le
       synonyme « Isekai no Yu ». Au 20/09/2026 la colonne affichait 1,00 sur
       6 496 lignes de 6 962 : elle ne discriminait plus rien.
       La porte `<= 0` des appelants ne bouge PAS : `matched` vaut zero dans les
       deux formules ou dans aucune, donc ce changement n'accepte ni ne refuse
       un slug de plus. Il rend seulement la valeur relisible, pour qu'un seuil
       puisse un jour se choisir sur des mesures plutot qu'au jugé. */
    const cov = matched / slugLen;
    if (cov > best) best = cov;
  }
  return best;
}
/**
 * La version d'algorithme sous laquelle ce script estampille ce qu'il ecrit.
 *
 * Lue dans lib/db/playerMap.ts plutot que recopiee : une constante dupliquee
 * derive, et celle-ci decide de ce que le chemin de lecture accepte encore.
 * Jusqu'au 20/09/2026 ce script n'ecrivait PAS la colonne du tout — ni dans la
 * liste, ni dans le DO UPDATE SET — si bien qu'une ligne qu'il venait de
 * confirmer avec le code du jour restait a `algo_version = 0`, indiscernable
 * d'une ligne semee depuis un audit ancien. Toute garde fondee sur la version
 * aurait donc rejete aussi les lignes legitimement verifiees, pour toujours.
 * On echoue bruyamment plutot que de retomber sur un defaut : se tromper ici ne
 * se voit nulle part et se paie partout.
 */
const SEASON_ALGO_VERSION = (() => {
  const src = fs.readFileSync(new URL("../../lib/db/playerMap.ts", import.meta.url), "utf8");
  const m = src.match(/export const SEASON_ALGO_VERSION\s*=\s*(\d+)/);
  if (!m) throw new Error("SEASON_ALGO_VERSION introuvable dans lib/db/playerMap.ts");
  return Number(m[1]);
})();

/**
 * Le juge EXTERIEUR : les titres que MyDubList donne doubles en francais.
 *
 * Nos propres scores ne peuvent pas voir qu'un slug pointe vers un autre anime
 * quand il RESSEMBLE au titre : `joker-game` pour Kaitou Joker, `youjo-senki`
 * pour le court Youjo Shenki — cinq des douze erreurs trouvees le 20/09/2026
 * portaient `confidence: 1`. Croise avec les lignes VF reellement constatees,
 * MyDubList concorde a 97,8 % (541 sur 553) ; les douze desaccords etaient
 * douze vraies erreurs.
 *
 * Deliberement HORS LIGNE, contrairement aux autres portes de ce fichier : le
 * resolveur d'execution ne doit jamais dependre d'une liste tierce pour servir
 * une page. Et si le telechargement echoue, la porte est INERTE — une ignorance
 * ne ferme pas une porte, c'est la meme regle que `frembedPossible`.
 */
const MYDUBLIST_FR =
  "https://raw.githubusercontent.com/Joelis57/MyDubList/main/dubs/confidence/low/dubbed_french.json";
const dubFr = await (async () => {
  try {
    const r = await fetch(MYDUBLIST_FR, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j?.dubbed) || j.dubbed.length < 500) {
      throw new Error(`liste suspecte (${j?.dubbed?.length ?? 0} entrees)`);
    }
    return new Set(j.dubbed.map(Number));
  } catch (e) {
    console.warn(`[verify] MyDubList indisponible (${e.message}) — porte VF inerte`);
    return null;
  }
})();

const DAY = 86400;
const ttl = (status, animeStatus) => {
  switch (status) {
    case "verified":  return animeStatus === "RELEASING" ? 7 * DAY : 90 * DAY;
    case "broken":    return 7 * DAY;
    case "absent":    return 30 * DAY;
    default:          return 14 * DAY;
  }
};

/* ── pick work ──────────────────────────────────────────────────────────── */
const now = Math.floor(Date.now() / 1000);
let rows;
if (ONLY_IDS) {
  const ids = [...ONLY_IDS];
  const ph = ids.map(() => "?").join(",");
  rows = (await db.execute({
    sql: `SELECT * FROM player_map WHERE ani_id IN (${ph})`,
    args: ids,
  })).rows;
} else if (FROM === "seed") {
  /* Les lignes SEMEES : `verified` en apparence, mais estampillees par un audit
     unique et ancien, jamais passees par ce script. Elles sont lues AVANT toute
     heuristique, donc une ligne fausse d'algorithme 0 masque un resolveur qui a
     raison — c'est la classe a drainer en premier. */
  rows = (await db.execute({
    sql: `SELECT * FROM player_map
           WHERE status = 'verified' AND algo_version < ?
           ORDER BY expires_at ASC LIMIT ?`,
    args: [SEASON_ALGO_VERSION, LIMIT],
  })).rows;
} else if (FROM === "mydublist") {
  /* Les titres que MyDubList donne doubles en francais et pour lesquels on n'a
     AUCUNE ligne VF : des doublages que le site pourrait offrir et n'offre pas,
     faute d'avoir jamais regarde. On fabrique les groupes de travail, puisqu'il
     n'existe pas encore de ligne a relire. */
  if (!dubFr) {
    console.error("[verify] --from=mydublist exige la liste, qui n'a pas pu etre lue");
    process.exit(1);
  }
  const cands = (await db.execute({
    sql: `SELECT f.anilist_id AS ani_id, f.mal_id
            FROM fribb_map f
           WHERE f.mal_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM player_map p
                              WHERE p.ani_id = f.anilist_id AND p.lang = 'vf')`,
  })).rows.filter((r) => dubFr.has(Number(r.mal_id)));
  rows = [];
  for (const c of cands.slice(0, LIMIT)) {
    for (const source of ["animesama", "voiranime"]) {
      rows.push({ ani_id: c.ani_id, source, lang: "vf" });
    }
  }
  console.log(`[verify] --from=mydublist : ${cands.length} titres candidats, ${Math.min(cands.length, LIMIT)} pris`);
} else {
  rows = (await db.execute({
    sql: `SELECT * FROM player_map
           WHERE expires_at < ? OR status = 'heuristic'
           ORDER BY expires_at ASC LIMIT ?`,
    args: [now, LIMIT],
  })).rows;
}
// Group by (aniId, source) so we verify both langs together (cross-lang gate).
const groups = new Map();
for (const r of rows) {
  const k = `${r.ani_id}:${r.source}`;
  if (!groups.has(k)) groups.set(k, { aniId: Number(r.ani_id), source: String(r.source), langs: new Set() });
  groups.get(k).langs.add(String(r.lang));
}
/* L'etat AVANT, garde pour que `--dry` puisse montrer ce qui changerait. Lire
   un verdict sans savoir ce qu'il remplace ne dit rien : c'est l'ECART qui se
   relit. */
const avant = new Map(
  rows.map((r) => [
    `${r.ani_id}:${r.source}:${r.lang}`,
    { status: r.status ?? "(aucune)", slug: r.slug ?? null, dir: r.season_dir ?? null },
  ]),
);
console.log(`[verify] ${rows.length} rows due → ${groups.size} (anime,source) groups  site=${SITE}`);
if (groups.size === 0) process.exit(0);

/* ── anime meta (episodes, status, titles) from local cache ─────────────── */
const aniIds = [...new Set([...groups.values()].map((g) => g.aniId))];
const metaById = new Map();
for (let i = 0; i < aniIds.length; i += 500) {
  const chunk = aniIds.slice(i, i + 500);
  const ph = chunk.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT id, status,
                 json_extract(data,'$.idMal')          AS mal,
                 json_extract(data,'$.episodes')       AS eps,
                 json_extract(data,'$.title.english')  AS en,
                 json_extract(data,'$.title.romaji')   AS ro,
                 json_extract(data,'$.title.native')   AS na,
                 json_extract(data,'$.synonyms')       AS syn
            FROM anime WHERE id IN (${ph})`,
    args: chunk,
  });
  for (const row of r.rows) {
    let syn = []; try { syn = JSON.parse(row.syn || "[]"); } catch {}
    metaById.set(Number(row.id), {
      status: row.status,
      idMal: row.mal == null ? null : Number(row.mal),
      episodes: row.eps == null ? null : Number(row.eps),
      titles: [row.en, row.ro, row.na, ...syn].filter(Boolean),
    });
  }
}

/* ── verification ───────────────────────────────────────────────────────── */
async function inspect(aniId, source, lang) {
  const u = `${SITE}/api/v2/source/inspect?aniId=${aniId}&source=${source}&lang=${lang}`;
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function judge(aniId, source, lang, insp, sibling, meta) {
  if (!insp) return null; // transient — leave the row alone
  if (!insp.found || !insp.slug) return { status: "absent", note: "verify:not-found" };
  if (source === "animesama" && !insp.chosenSeasonDir) return { status: "absent", note: "verify:no-panel" };

  const conf = slugTitleConfidence(insp.slug.replace(/-vf$/i, ""), meta?.titles || []);
  if (conf <= 0) return { status: "broken", note: "verify:zero-title-confidence" };

  /* Le juge exterieur. Une VF sur un titre que MyDubList ne donne pas double en
     francais signale presque toujours un slug qui pointe ailleurs — verifie une
     a une sur les douze cas du 20/09/2026, zero faux positif. On rétrograde
     plutot que de laisser passer : une ligne `verified` fausse sert le MAUVAIS
     CONTENU, ce qui est pire qu'un chip manquant.
     La note est explicite pour que les ~2 % de desaccords legitimes (VF non
     officielle sur anime-sama) se retrouvent d'une requete et se signalent en
     amont. Inerte si la liste manque, ou si l'anime n'a pas d'id MAL. */
  if (lang === "vf" && dubFr && meta?.idMal && !dubFr.has(meta.idMal)) {
    return { status: "broken", note: "verify:vf-inconnue-de-mydublist" };
  }

  // S1-collapse shape: a later season on saison1 with no merged offset.
  if (
    source === "animesama" &&
    (insp.seasonNum || 1) > 1 &&
    /^saison1($|\b|hs)/.test(insp.chosenSeasonDir || "") &&
    !(insp.mergedOffset > 0)
  ) {
    return { status: "broken", note: "verify:s1-collapse" };
  }

  // Cross-lang: the sibling lang resolving the SAME slug to a broken shape
  // poisons this one too (count coincidences can't be trusted).
  //
  // Sauf quand la soeur n'est tombee que sur la porte MyDubList. Celle-ci dit
  // « pas de doublage francais pour ce titre », ce qui a DEUX lectures : le slug
  // pointe ailleurs, ou la VF existe sans etre officielle. Propager a la VOSTFR
  // choisit la premiere sans preuve — et sur les ~2 % ou c'est la seconde, ca
  // retirerait un VOSTFR parfaitement valable, dans la langue principale du
  // site. On retrograde donc ce que MyDubList soutient reellement (la ligne VF)
  // et rien de plus ; un slug faux cote VOSTFR se corrige par sa propre
  // re-derivation, le resolveur actuel le resolvant deja correctement.
  if (
    sibling &&
    sibling.judged?.status === "broken" &&
    sibling.judged?.note !== "verify:vf-inconnue-de-mydublist" &&
    sibling.insp?.slug === insp.slug
  ) {
    return { status: "broken", note: "verify:sibling-broken" };
  }

  // Episode count consistency. effectiveEpisodes (merged panels) wins.
  const got = insp.merged && insp.effectiveEpisodes != null ? insp.effectiveEpisodes : insp.episodeCount;
  const ani = meta?.episodes ?? null;
  if (ani && got) {
    const diff = got - ani;
    const releasing = meta?.status === "RELEASING";
    const countOk =
      Math.abs(diff) <= 1 ||
      (diff > 1 && !insp.merged) ||      // bigger panel (cours merged) — content right
      (diff < 0 && releasing);           // source behind on an airing show
    if (!countOk) return { status: "broken", note: `verify:count ${got}/${ani}` };
  }

  return {
    status: "verified",
    note: "verify:ok",
    slug: insp.slug,
    seasonDir: source === "animesama" ? insp.chosenSeasonDir : null,
    epOffset: insp.mergedOffset || 0,
    episodeCount: insp.episodeCount ?? null,
    confidence: Math.round(conf * 100) / 100,
  };
}

const tally = {};
const queue = [...groups.values()];
let active = 0, done = 0;

async function worker() {
  for (;;) {
    const g = queue.shift();
    if (!g) return;
    const langs = [...g.langs];
    const inspections = {};
    for (const lang of langs) inspections[lang] = { insp: await inspect(g.aniId, g.source, lang) };
    // two passes so the cross-lang gate sees the sibling's verdict
    for (const lang of langs) {
      const sib = langs.find((l) => l !== lang);
      inspections[lang].judged = judge(g.aniId, g.source, lang, inspections[lang].insp, sib ? inspections[sib] : null, metaById.get(g.aniId));
    }
    for (const lang of langs) {
      const v = inspections[lang].judged;
      if (!v) { tally["skipped:transient"] = (tally["skipped:transient"] || 0) + 1; continue; }
      tally[v.status] = (tally[v.status] || 0) + 1;
      if (DRY) {
        const a = avant.get(`${g.aniId}:${g.source}:${lang}`) || {};
        const ou = (s, d) => (s ? `${s}${d ? "/" + d : ""}` : "—");
        const de = ou(a.slug, a.dir);
        const vers = ou(v.slug, v.seasonDir);
        const bouge = a.status !== v.status || de !== vers;
        console.log(
          `${bouge ? "CHANGE" : "  =   "} ${String(g.aniId).padEnd(7)} ${g.source.padEnd(10)} ${String(lang).padEnd(7)}` +
            ` ${String(a.status).padEnd(10)} -> ${String(v.status).padEnd(10)} ${de.padEnd(34)} -> ${vers.padEnd(34)} ${v.note}`,
        );
      }
      if (!DRY) {
        const meta = metaById.get(g.aniId);
        await db.execute({
          sql: `INSERT INTO player_map
                  (ani_id, source, lang, status, slug, season_dir, ep_offset,
                   episode_count, confidence, fail_count, note, algo_version,
                   checked_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                ON CONFLICT(ani_id, source, lang) DO UPDATE SET
                  status        = excluded.status,
                  slug          = excluded.slug,
                  season_dir    = excluded.season_dir,
                  ep_offset     = excluded.ep_offset,
                  episode_count = excluded.episode_count,
                  confidence    = excluded.confidence,
                  fail_count    = 0,
                  note          = excluded.note,
                  algo_version  = excluded.algo_version,
                  checked_at    = excluded.checked_at,
                  expires_at    = excluded.expires_at`,
          args: [
            g.aniId, g.source, lang, v.status,
            v.slug ?? null, v.seasonDir ?? null, v.epOffset ?? 0,
            v.episodeCount ?? null, v.confidence ?? null, v.note,
            SEASON_ALGO_VERSION,
            now, now + ttl(v.status, meta?.status),
          ],
        });
      }
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`\r[verify] ${done}/${groups.size} groups`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\n[verify] done — ${JSON.stringify(tally)}`);
