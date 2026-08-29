/**
 * Renseigne le `va_slug` manquant d'un dataset du detecteur.
 *
 *   node bridge/find_va_slugs.mjs datasets/anime.blind10.json [--write]
 *
 * Pourquoi ce script existe : voir-anime est un site SEPARE d'anime-sama, avec
 * ses propres slugs — souvent le titre japonais (`ao-no-exorcist`, pas
 * `blue-exorcist`) et un suffixe `-vf` pour la VF. Sans `va_slug`, le pont
 * retombe sur le slug anime-sama, prend un 404, et vidmoly-va disparait du lot.
 * Mesure du 26/08/2026 : 30 des 50 titres du lot `top50` n'avaient pas de
 * `va_slug` — une part inconnue de « l'aveuglement » du parc etait donc un
 * artefact de donnees d'entree manquantes, pas une realite.
 *
 * Un mauvais slug est PIRE que pas de slug : il sert un autre contenu, donc des
 * bornes fausses (c'est exactement le `contenu_divergent` que le juge traque).
 * D'ou la regle : on n'ecrit QUE ce qui est verifie sur la page — tous les
 * episodes demandes doivent y etre — et l'ambigu est signale a l'humain, jamais
 * devine.
 */
import { readFileSync, writeFileSync } from "node:fs";

const VOIRANIME_BASE = "https://voir-anime.to";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PAUSE_MS = 300;   // la meme IP sert le lot ; on ne la brule pas pour un dataset

const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith("--"));
const WRITE = args.includes("--write");
if (!FILE) {
  console.error("usage: node bridge/find_va_slugs.mjs <dataset.json> [--write]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: `${VOIRANIME_BASE}/` } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
}

// `/anime/feed/` est le flux RSS de WordPress, pas un anime — sans ce filtre il
// remonte comme candidat sur toute recherche pauvre (vu sur kaguya-sama).
const NOT_AN_ANIME = new Set(["feed", "page", "category", "tag"]);

/** Les slugs /anime/<slug>/ que la recherche voir-anime renvoie pour ce titre. */
async function search(title) {
  const url = `${VOIRANIME_BASE}/?s=${encodeURIComponent(title)}&post_type=wp-manga`;
  const html = await fetchPage(url);
  const out = new Set();
  const re = new RegExp(`href="${VOIRANIME_BASE.replace(/\./g, "\\.")}/anime/([a-z0-9-]+)/"`, "gi");
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!NOT_AN_ANIME.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/** Les titres MAL d'un anime — le romaji d'abord.
 *
 *  C'est la vraie cle du probleme : voir-anime nomme en ROMAJI la ou anime-sama
 *  nomme en anglais. Chercher « blue exorcist » ne trouve pas `ao-no-exorcist`,
 *  « fire force » ne trouve pas `enen-no-shouboutai`. Jikan, sans cle d'API,
 *  donne exactement la forme utilisee (cf. [[score-grid-jikan]]). */
const titleCache = new Map();
async function malTitles(malId) {
  if (!malId) return [];
  if (titleCache.has(malId)) return titleCache.get(malId);
  let out = [];
  // Deux essais : Jikan limite a ~3 req/s et rend un 429 passager. Sans reprise,
  // un seul 429 prive le titre de son romaji — donc de son departage — et le
  // laisse « ambigu » pour une raison qui n'a rien a voir avec voir-anime.
  for (let attempt = 0; attempt < 2 && !out.length; attempt++) {
    if (attempt) await sleep(2000);
    try {
      const r = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
      if (r.ok) {
        const d = (await r.json()).data || {};
        const seen = new Set();
        for (const t of d.titles || []) {
          // Le japonais en kana ne sert a rien pour un slug latin.
          if (t.type === "Japanese") continue;
          const v = (t.title || "").trim();
          if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
        }
      }
    } catch { /* reseau : l'essai suivant tranchera */ }
    await sleep(400);
  }
  // Ne JAMAIS memoriser un echec : ce serait propager la panne a tout le lot.
  if (out.length) titleCache.set(malId, out);
  return out;
}

/** Les numeros d'episode presents sur la page d'un slug.
 *  Meme regex que buildVoirEpRegex dans resolve.mjs — source de verite la-bas. */
async function episodesOf(slug) {
  const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
  const re = new RegExp(
    `href=["'](${baseEsc}/anime/${slugEsc}(?:-[a-z0-9]{1,3})?/[^"']+?-(\\d+)(?:-(?:vf|vostfr))?/)["']`,
    "gi",
  );
  const html = await fetchPage(`${VOIRANIME_BASE}/anime/${slug}/`);
  const eps = new Set();
  let m;
  while ((m = re.exec(html)) !== null) eps.add(parseInt(m[2], 10));
  return eps;
}

/** Le numero de saison porte par un slug voir-anime, si present (`…-2-kyoto…` → 2). */
const seasonOf = (slug) => {
  const m = slug.replace(/-vf$/, "").match(/-(\d{1,2})(?:-|$)/);
  return m ? parseInt(m[1], 10) : 1;
};

/** Un titre MAL reduit a la forme d'un slug voir-anime. */
const slugify = (s) => s.toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

async function resolveSeason(animeSlug, season, malId) {
  const wantVf = (season.lang || "vostfr") === "vf";
  const wantSeason = parseInt((season.season_dir || "saison1").replace(/\D/g, ""), 10) || 1;
  // Les datasets portent l'un ou l'autre format (liste explicite, ou bornes) —
  // batch_detect lit les deux, le resolveur doit en faire autant.
  const wantEps = season.episodes && season.episodes.length
    ? season.episodes
    : (Number.isFinite(season.ep_start) && Number.isFinite(season.ep_end)
        ? Array.from({ length: season.ep_end - season.ep_start + 1 }, (_, i) => season.ep_start + i)
        : []);

  // Plusieurs formulations du meme titre : le romaji de MAL trouve ce que le
  // slug anime-sama ne trouve pas, et reciproquement pour les titres anglicises.
  const titles = await malTitles(malId);
  const terms = [...new Set([animeSlug.replace(/-/g, " "), ...titles])];
  const found = new Set();
  for (const t of terms.slice(0, 4)) {
    try {
      for (const s of await search(t)) found.add(s);
    } catch { /* une recherche muette n'invalide pas les autres */ }
    await sleep(PAUSE_MS);
  }
  // La VF porte le suffixe ; la VOSTFR est le slug nu. Confondre les deux sert
  // l'autre doublage, donc un autre montage : filtre dur, pas une preference.
  const candidates = [...found].filter((s) => (s.endsWith("-vf") ? wantVf : !wantVf))
    // Le slug le plus court est le plus souvent la saison 1 nue ; le tester en
    // premier evite qu'une troncature ecarte la bonne reponse.
    .sort((a, b) => a.length - b.length);
  if (!candidates.length) return { status: "aucun candidat" };

  const scored = [];
  for (const slug of candidates.slice(0, 20)) {
    await sleep(PAUSE_MS);
    let eps;
    try {
      eps = await episodesOf(slug);
    } catch (e) {
      continue;   // page absente ou refusee : ce candidat ne prouve rien
    }
    const max = eps.size ? Math.max(...eps) : 0;
    const askedWithin = wantEps.filter((e) => e <= max).length;
    const covered = wantEps.filter((e) => eps.has(e)).length;
    scored.push({ slug, covered, askedWithin, max, total: eps.size, season: seasonOf(slug) });
  }

  // On n'accepte que ce qui porte tous les episodes demandes QUI EXISTENT chez
  // ce candidat : le dataset reclame parfois un numero au-dela de la saison
  // (ep 25 d'une saison de 24), et l'exiger rejetait la bonne reponse.
  const full = scored.filter((s) => s.max > 0 && s.covered === s.askedWithin && s.askedWithin > 0);
  if (!full.length) {
    const best = scored.sort((a, b) => b.covered - a.covered)[0];
    return { status: "aucun candidat complet", best };
  }
  // Departage : le titre MAL slugifie. `enen-no-shouboutai` (S1) et
  // `enen-no-shouboutai-ni-no-shou` (S2) portent tous deux les eps 1-12 ; seul
  // le titre canonique dit lequel est la saison demandee.
  // Les titres viennent de MAL dans l'ordre canonique-puis-synonymes. On les
  // essaie DANS CET ORDRE : « Hunter x Hunter (2011) » doit gagner contre le
  // synonyme « Hunter x Hunter », qui designe la serie de 1999.
  let named = [];
  for (const t of titles) {
    const s = slugify(t);
    const hit = full.filter((c) => c.slug.replace(/-vf$/, "") === s);
    if (hit.length) { named = hit; break; }
  }
  if (named.length === 1) return { status: "ok", slug: named[0].slug, info: named[0] };

  const exact = (named.length ? named : full).filter((s) => s.season === wantSeason);
  const pool = exact.length ? exact : (named.length ? named : full);
  if (pool.length > 1) return { status: "ambigu", pool };
  return { status: "ok", slug: pool[0].slug, info: pool[0] };
}

const data = JSON.parse(readFileSync(FILE, "utf8"));
let filled = 0, already = 0;
const problems = [];

for (const anime of data) {
  for (const season of anime.seasons) {
    if (season.va_slug || anime.va_slug) { already++; continue; }
    const r = await resolveSeason(anime.slug, season, anime.mal_id);
    const tag = `${anime.slug} ${season.season_dir} ${season.lang}`;
    if (r.status === "ok") {
      season.va_slug = r.slug;
      filled++;
      console.log(`  OK    ${tag.padEnd(46)} -> ${r.slug}  (${r.info.total} ep)`);
    } else {
      problems.push({ tag, ...r });
      const detail = r.pool ? r.pool.map((p) => p.slug).join(" | ")
        : r.best ? `meilleur: ${r.best.slug} (${r.best.covered}/${(season.episodes || []).length} ep)`
        : "";
      console.log(`  ${r.status.toUpperCase().padEnd(5)} ${tag.padEnd(46)} ${detail}`);
    }
    await sleep(PAUSE_MS);
  }
}

console.log(`\n${filled} rempli(s), ${already} deja present(s), ${problems.length} a trancher a la main`);
if (WRITE && filled) {
  writeFileSync(FILE, JSON.stringify(data, null, 1) + "\n", "utf8");
  console.log(`-> ${FILE} mis a jour`);
} else if (filled) {
  console.log("(--write absent : rien n'a ete ecrit)");
}
