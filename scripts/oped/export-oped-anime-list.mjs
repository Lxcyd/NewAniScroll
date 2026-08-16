/**
 * Export the anime.json contract that the offline OP/ED detector
 * (tools/opening-detector/batch_detect.py) consumes. ZERO worker calls, ZERO
 * Upstash — one read of the Turso tables the app ALREADY populated.
 *
 *   node --env-file=.env.local scripts/oped/export-oped-anime-list.mjs \
 *        --out=tools/opening-detector/anime.json [--source=animesama] \
 *        [--limit=50] [--min-episodes=1]
 *
 * The detector does NOT derive the AniList/MAL id ↔ anime-sama slug ↔ season
 * mapping — that's the app's season resolver, whose VERIFIED output already
 * lives in `player_map`. So this just reshapes verified player_map rows (joined
 * with `anime` for the MAL id AnimeThemes needs) into:
 *
 *   [{ "mal_id": 16498, "anilist_id": 16498,
 *      "slug": "shingeki-no-kyojin",
 *      "va_slug": "shingeki-no-kyojin",
 *      "seasons": [{ "season_dir": "saison1", "lang": "vostfr",
 *                    "ep_start": 1, "ep_end": 25 }] }]
 *
 * `va_slug` is voir-anime's slug for the same title (the `vidmoly-va` host);
 * it differs from anime-sama's for most anime — see the JOIN comment below.
 *
 * We emit anime-sama rows by default: the detector's multi-host resolver bridge
 * is anime-sama-centric (sibnet/vidmoly/megaplay come from that slug). A row is
 * exported only when it has the slug + a MAL id (AnimeThemes lookup key) + a
 * usable episode count.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const OUT = args.out || "tools/opening-detector/anime.json";
const SOURCE = args.source || "animesama";
const LIMIT = args.limit ? Number(args.limit) : 0;
const MIN_EP = args["min-episodes"] ? Number(args["min-episodes"]) : 1;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Verified mappings only — we never feed the batch a guessed (heuristic) or
// broken slug/season (it would waste hours of ffmpeg on the wrong stream).
// The voir-anime slug is joined in as `va_slug`: the detector's `vidmoly-va`
// host resolves against voir-anime, which uses a DIFFERENT slug from
// anime-sama's for most titles (anime-sama "anohana" vs voir-anime
// "ano-hi-mita-hana-no-namae-wo-bokutachi-wa-mada-shiranai"). Without it,
// batch_detect falls back to the anime-sama slug and vidmoly-va 404s — measured
// over player_map: of the 411 anime that HAVE a voir-anime row, 265 (64%) use a
// different slug, so the batch was silently losing that host on two thirds of
// them while the app played it fine.
//
// `heuristic` rows are accepted here, unlike the anime-sama row above — but
// only after `vaSlugVerdict()` below vouches for them. The original reasoning
// ("a wrong voir-anime slug simply 404s and the host is cleanly filtered out")
// was WRONG, and measurably so: a bad heuristic slug is usually a REAL page for
// a DIFFERENT work, which resolves 200 and feeds ffmpeg the wrong anime for
// hours. Measured on the audit lot: `ashita-no-joe-2-vf` is Ashita no Joe *2*,
// so all three VF episodes were detected against season 1's AnimeThemes
// references and yielded nothing — 6 of the sheet's 6 "absent" cells, all from
// this one row. `_duration_cohort` cannot catch it either: a voir-anime-only
// panel has exactly one host, so there is no cohort to disagree with.
const r = await db.execute({
  sql: `SELECT pm.ani_id       AS ani_id,
               pm.lang         AS lang,
               pm.slug         AS slug,
               pm.season_dir   AS season_dir,
               pm.episode_count AS episode_count,
               a.id_mal        AS id_mal,
               a.popularity    AS popularity,
               va.slug         AS va_slug
          FROM player_map pm
          JOIN anime a ON a.id = pm.ani_id
          LEFT JOIN player_map va
                 ON va.ani_id = pm.ani_id
                AND va.lang   = pm.lang
                AND va.source = 'voiranime'
                AND va.status IN ('verified', 'heuristic')
                AND va.slug IS NOT NULL
         WHERE pm.source = ?
           AND pm.status = 'verified'
           AND pm.slug IS NOT NULL
           AND a.id_mal IS NOT NULL`,
  args: [SOURCE],
});

console.log(`[export-oped] ${r.rows.length} verified ${SOURCE} rows`);

// Group rows into one entry per anime, each carrying all its (season_dir, lang)
// panels. The detector wants a per-season episode range; player_map gives a
// per-panel episode_count, and anime-sama panels are 1-based per season, so
// ep_start = 1 and ep_end = count. (A merged-offset panel would need the offset
// applied, but verified anime-sama season panels are already per-season.)
const byAnime = new Map();
let skippedNoEp = 0;
for (const row of r.rows) {
  const aniId = Number(row.ani_id);
  const malId = Number(row.id_mal);
  const slug = String(row.slug);
  const seasonDir = row.season_dir ? String(row.season_dir) : "saison1";
  const lang = String(row.lang);
  const count = row.episode_count == null ? null : Number(row.episode_count);
  if (!count || count < MIN_EP) {
    skippedNoEp++;
    continue;
  }
  if (!byAnime.has(aniId)) {
    byAnime.set(aniId, {
      mal_id: malId,
      anilist_id: aniId,
      slug,
      // Sert UNIQUEMENT au tri ci-dessous, et n'est pas écrit dans le JSON :
      // le détecteur ne consomme pas ce champ et un contrat qui grossit sans
      // raison finit par être copié de travers.
      _popularity: Number(row.popularity) || 0,
      seasons: [],
    });
  }
  byAnime.get(aniId).seasons.push({
    season_dir: seasonDir,
    lang,
    ep_start: 1,
    ep_end: count,
    // PER-LANG, not per-anime: voir-anime slugs differ BETWEEN languages, not
    // just from anime-sama's. Ashita no Joe is `ashita-no-joe` in VOSTFR and
    // `ashita-no-joe-2-vf` in VF. Hanging one va_slug off the anime meant
    // whichever lang was read first silently overwrote the other.
    ...(row.va_slug ? { va_slug: String(row.va_slug) } : {}),
  });
}

// VOIR-ANIME-ONLY LANGUAGES. The query above is anime-sama-centric, so a
// language that exists ONLY on voir-anime produced no panel at all and the
// detector never saw it. Ashita no Joe is the case that surfaced it: anime-sama
// carries only VOSTFR, while the app offers a VF through Voir-Anime Vidmoly —
// so every VF run was invisible to the batch, and the audit sheet reported one
// unlabelled "vidmoly-va" row that was in fact VOSTFR only.
//
// Such a panel borrows the anime-sama season_dir and episode range of the
// anime's other language (voir-anime rows carry no season dir). The anime-sama
// hosts will simply report "not offered by anime-sama for this season" and be
// filtered out, exactly as they already are for any host a season lacks —
// vidmoly-va is the one that can serve it, and it now can.
const vaLangs = await db.execute({
  sql: `SELECT ani_id, lang, slug FROM player_map
         WHERE source = 'voiranime' AND slug IS NOT NULL
           AND status IN ('verified', 'heuristic')`,
  args: [],
});
// ANIME-SAMA LANGUAGES THAT ARE ONLY `heuristic`. The main query demands
// `verified`, which is right for the slug/season (a wrong one sends ffmpeg at
// hours of the WRONG stream) — but it also drops languages the seed never
// covered. VF panels are mostly written at RUNTIME by the app, so they are
// `heuristic` far more often than VOSTFR: 69 heuristic VF rows against 542
// verified. Dandadan is the case Luc hit — the app offers Anime-Sama Ansembed
// in VF, the batch never tried it.
//
// Accepted ONLY when the slug AND season_dir match a row already verified for
// this anime: the risky part is then vouched for, and all that differs is the
// language sub-path (`…/saison1/vf/` instead of `…/saison1/vostfr/`), which
// resolves cleanly or 404s.
const asLangs = await db.execute({
  sql: `SELECT ani_id, lang, slug, season_dir, episode_count FROM player_map
         WHERE source = ? AND status = 'heuristic' AND slug IS NOT NULL`,
  args: [SOURCE],
});
let addedHeuristicLang = 0;
for (const row of asLangs.rows) {
  const entry = byAnime.get(Number(row.ani_id));
  if (!entry) continue;
  const lang = String(row.lang);
  if (entry.seasons.some((s) => s.lang === lang)) continue;
  const dir = row.season_dir ? String(row.season_dir) : "saison1";
  const twin = entry.seasons.find(
    (s) => s.season_dir === dir && entry.slug === String(row.slug),
  );
  if (!twin) continue;
  const count = row.episode_count == null ? twin.ep_end : Number(row.episode_count);
  entry.seasons.push({
    season_dir: dir,
    lang,
    ep_start: 1,
    ep_end: count && count >= MIN_EP ? count : twin.ep_end,
  });
  addedHeuristicLang++;
}
if (addedHeuristicLang) {
  console.log(
    `[export-oped] ${addedHeuristicLang} heuristic-language panel(s) added ` +
      `(slug+season already verified)`,
  );
}

// ── COHERENCE GATE on voir-anime slugs ───────────────────────────────────────
// The app already refuses a mapped voir-anime slug whose season contradicts the
// resolver (see the "COHERENCE GUARD" block in pages/api/v2/source/index.js —
// written after a Redis-poisoning window wrote a "-2" slug onto a season-1
// entry). This exporter had no equivalent, so the very rows the app throws away
// were the ones the detector ran on.
//
// Two failure shapes are in the table today, both `heuristic`:
//   WRONG SEASON  ani 2402  Ashita no Joe          → ashita-no-joe-2-vf
//                 ani 15809 Hataraku Maou-sama!    → hataraku-maou-sama-2-vf
//   WRONG WORK    ani 155179 Journey               → sousou-no-frieren-vf
//                 ani 199411 Yu Ling Shi           → digimon-tamers-vf
//                 ani 336   Ginyuu Mokushiroku …   → yamada-kun-to-lv999-…-vf
// Both are decided offline from data we already hold — no worker call, no probe.
// PAGINÉ (07/08). En un seul appel, cette requête tire le blob JSON complet de
// chaque anime et Turso refuse la réponse :
//   LibsqlError: SQLITE_UNKNOWN: Resource exhausted: mem_hrana_response/…
// L'exporteur — qui produit le contrat consommé par le détecteur — était donc
// simplement cassé, et le restera silencieusement à chaque fois que la table
// grossit si on remet un `SELECT` non borné. Des pages de 250 tiennent
// largement sous la limite ; le coût est quelques appels de plus, une fois.
const PAGE = 250;
const titleRowsAll = [];
for (let offset = 0; ; offset += PAGE) {
  const page = await db.execute({
    sql: "SELECT id, data FROM anime WHERE data IS NOT NULL LIMIT ? OFFSET ?",
    args: [PAGE, offset],
  });
  titleRowsAll.push(...page.rows);
  if (page.rows.length < PAGE) break;
}
const titlesById = new Map();
for (const row of titleRowsAll) {
  let d;
  try { d = JSON.parse(String(row.data)); } catch { continue; }
  const t = d?.title ?? {};
  const all = [t.romaji, t.english, t.native, ...(d?.synonyms ?? [])];
  const tokens = new Set();
  const squashes = new Set();
  for (const name of all) {
    if (!name) continue;
    const toks = slugTokens(String(name));
    for (const tok of toks) tokens.add(tok);
    if (toks.length) squashes.add(toks.join(""));
  }
  if (tokens.size) titlesById.set(Number(row.id), { tokens, squashes });
}

/**
 * A title/slug reduced to comparable lowercase word tokens.
 *
 * Slugs arrive percent-encoded for anything non-ASCII (`sk%e2%88%9e` = SK∞,
 * `space%e2%98%86dandy` = Space☆Dandy). Tokenising the raw form turns the
 * escape bytes into words (`e2`, `98`, `86`) that match no title and sink the
 * overlap ratio — decoding first is what keeps those slugs from being rejected.
 * `×` becomes `x` because that is how the slugs spell it (SPY×FAMILY →
 * `spyxfamily`).
 */
function slugTokens(s) {
  let str = String(s);
  try { str = decodeURIComponent(str); } catch { /* keep the raw form */ }
  return str
    .toLowerCase()
    .replace(/[×✕✖]/g, "x")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // é → e
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const seasonOfDir = (dir) => {
  const m = /saison(\d+)/i.exec(dir || "");
  return m ? Number(m[1]) : 1;
};

/**
 * Is `slug` a believable voir-anime slug for this anime and this season?
 * Returns null when fine, else a short reason (used for the dropped-rows log).
 *
 * The trailing "-N" test only fires when N is NOT part of the anime's own
 * title: `kaiju-no-8` and `mob-psycho-100` carry their number in every title
 * variant, so the digits are a name, not a season — reading them as a season
 * would throw away two perfectly good slugs.
 */
function vaSlugVerdict(slug, aniId, panelSeason) {
  const title = titlesById.get(aniId);
  const base = String(slug).replace(/-(?:vf|vostfr)$/i, "");
  const parts = slugTokens(base);
  if (!parts.length) return "slug vide";

  const last = parts[parts.length - 1];
  const trailingNum = /^\d{1,2}$/.test(last) && !(title?.tokens.has(last))
    ? Number(last)
    : null;
  const nameParts = trailingNum === null ? parts : parts.slice(0, -1);

  // WRONG WORK — the slug's words are not this anime's words at all. Needs a
  // title to compare against; without one we cannot judge, so we let it pass.
  if (title && nameParts.length) {
    const hit = nameParts.filter((p) => title.tokens.has(p)).length;
    // Word-for-word overlap misses slugs that run the title together
    // (`spyxfamily` vs SPY×FAMILY's `spy`/`x`/`family`), so a separator-free
    // comparison gets the second word: if the squashed forms match, the slug
    // names this anime whatever the token split says.
    const squashed = nameParts.join("");
    const squashOk = [...title.squashes].some(
      (s) => s === squashed
        || (s.length >= 6 && squashed.length >= 6
            && (s.includes(squashed) || squashed.includes(s))),
    );
    if (hit / nameParts.length < 0.5 && !squashOk) {
      return `titre incoherent (${hit}/${nameParts.length} mots en commun)`;
    }
  }

  // WRONG SEASON — the app's guard, applied to the panel's own season.
  if (trailingNum !== null && trailingNum !== panelSeason) {
    return `saison ${trailingNum} pour un panneau saison ${panelSeason}`;
  }
  return null;
}

const vaDropped = [];

// Voir-anime slug per (anime, language). Applied to EVERY season at the end
// rather than during the main query, so the panels added above get theirs too —
// the JOIN only ever saw the languages that query returned.
const vaByKey = new Map();
for (const row of vaLangs.rows) {
  vaByKey.set(`${row.ani_id}:${row.lang}`, String(row.slug));
}

let addedVaOnly = 0;
for (const [aniId, entry] of byAnime) {
  for (const s of entry.seasons) {
    const slug = vaByKey.get(`${aniId}:${s.lang}`);
    // The JOIN in the main query may already have set a va_slug; re-check it
    // here (same gate, same panel season) and DELETE it on a bad verdict —
    // leaving it would let a rejected slug through the back door.
    const verdict = slug ? vaSlugVerdict(slug, aniId, seasonOfDir(s.season_dir)) : null;
    if (slug && !verdict) {
      s.va_slug = slug;
    } else {
      if (verdict) vaDropped.push({ aniId, lang: s.lang, slug, verdict });
      delete s.va_slug;
    }
  }
  // …then languages voir-anime has and anime-sama does not.
  for (const [key, slug] of vaByKey) {
    const [id, lang] = key.split(":");
    if (Number(id) !== aniId) continue;
    if (entry.seasons.some((s) => s.lang === lang)) continue;
    const model = entry.seasons[0];
    if (!model) continue;
    // A voir-anime-only panel is the DANGEROUS case: vidmoly-va is its only
    // host, so nothing downstream can contradict a wrong slug. Gate it before
    // creating the panel at all.
    const verdict = vaSlugVerdict(slug, aniId, seasonOfDir(model.season_dir));
    if (verdict) {
      vaDropped.push({ aniId, lang, slug, verdict, vaOnly: true });
      continue;
    }
    entry.seasons.push({
      season_dir: model.season_dir,
      lang,
      ep_start: model.ep_start,
      ep_end: model.ep_end,
      va_slug: slug,
      va_only: true, // anime-sama has no panel for this language
    });
    addedVaOnly++;
  }
}
if (vaDropped.length) {
  console.log(
    `[export-oped] ${vaDropped.length} voir-anime slug(s) rejetes par le garde-fou :`,
  );
  for (const d of vaDropped.slice(0, 15)) {
    console.log(
      `  ani ${String(d.aniId).padEnd(7)} ${String(d.lang).padEnd(6)} ` +
        `${String(d.slug).padEnd(44)} ${d.verdict}${d.vaOnly ? " [panneau va-only supprime]" : ""}`,
    );
  }
  if (vaDropped.length > 15) console.log(`  … et ${vaDropped.length - 15} autres`);
}
if (addedVaOnly) {
  console.log(`[export-oped] ${addedVaOnly} voir-anime-only language panel(s) added`);
}

// --include-heuristic : LES TITRES LES PLUS REGARDÉS SONT AUJOURD'HUI EXCLUS.
// La requête principale exige `status = 'verified'`, et c'est la bonne règle par
// défaut — un slug faux envoie ffmpeg sur des heures du MAUVAIS flux. Mais
// mesuré le 07/08 : **36 titres de plus de 400 000 de popularité n'ont AUCUNE
// ligne verified**, dont Shingeki no Kyojin (1 039 137, le plus populaire de
// tous), dont les quatre lignes player_map sont `heuristic`. Ils ne sont donc
// pas « oubliés » par nos lots d'audit : ils en sont FILTRÉS, en silence, et
// c'est la cause mécanique du biais d'échantillon du DEVLOG §11.
//
// L'option les fait entrer, mais seulement à travers `vaSlugVerdict` — le même
// juge que pour les panneaux voir-anime : le slug doit nommer CETTE œuvre et
// CETTE saison. Un slug qui échoue est rejeté et listé, jamais exporté en
// silence. Reste opt-in : le défaut ne change pas.
if (args["include-heuristic"]) {
  const heur = await db.execute({
    sql: `SELECT pm.ani_id, pm.lang, pm.slug, pm.season_dir, pm.episode_count,
                 a.id_mal, a.popularity
            FROM player_map pm
            JOIN anime a ON a.id = pm.ani_id
           WHERE pm.source = ? AND pm.status = 'heuristic'
             AND pm.slug IS NOT NULL AND a.id_mal IS NOT NULL`,
    args: [SOURCE],
  });
  let added = 0;
  const refused = [];
  for (const row of heur.rows) {
    const aniId = Number(row.ani_id);
    const slug = String(row.slug);
    const dir = row.season_dir ? String(row.season_dir) : "saison1";
    const lang = String(row.lang);
    const eps = Number(row.episode_count) || 0;
    if (!eps) continue;
    const entry = byAnime.get(aniId);
    if (entry && entry.seasons.some((s) => s.season_dir === dir && s.lang === lang)) {
      continue;                       // déjà couvert par une ligne verified
    }
    const verdict = vaSlugVerdict(slug, aniId, seasonOfDir(dir));
    if (verdict) {
      refused.push(`  ani ${String(aniId).padEnd(7)} ${lang.padEnd(6)} ${slug.padEnd(44)} ${verdict}`);
      continue;
    }
    const target = entry || {
      mal_id: Number(row.id_mal), anilist_id: aniId, slug,
      _popularity: Number(row.popularity) || 0, seasons: [],
    };
    target.seasons.push({ season_dir: dir, lang, ep_start: 1, ep_end: eps });
    byAnime.set(aniId, target);
    added += 1;
  }
  console.log(`[export-oped] --include-heuristic : ${added} panneau(x) heuristic ajoute(s), `
    + `${refused.length} refuse(s) par vaSlugVerdict`);
  for (const line of refused.slice(0, 15)) console.log(line);
  if (refused.length > 15) console.log(`  … et ${refused.length - 15} autres`);
}

let list = [...byAnime.values()].filter((a) => a.seasons.length > 0);
// TRI PAR POPULARITÉ AVANT DE TRANCHER (07/08). `--limit` découpait jusqu'ici
// dans l'ordre d'insertion de la Map, donc `--limit=50` rendait 50 titres
// ARBITRAIRES. C'est ainsi que nos lots d'audit ont fini par ne contenir aucun
// des 20 titres les plus populaires — SnK, Demon Slayer, One Piece n'ont jamais
// été passés au détecteur — et que chaque taux de couverture mesuré décrivait
// un échantillon défavorable sans que rien ne le signale (DEVLOG §11).
list.sort((a, b) => b._popularity - a._popularity);
if (LIMIT > 0) list = list.slice(0, LIMIT);
// La popularité SORT désormais dans le contrat, sous son vrai nom (08/08).
// Elle était jetée ici parce qu'elle n'avait servi qu'au tri — mais elle est
// aussi le poids du point 6 : « couverture pondérée par le trafic » n'a aucun
// sens sans elle. `_compare_sources.mjs` lisait un fichier qui n'en portait
// pas, prenait 1 partout, et annonçait quand même un chiffre « pondéré ».
// `batch_detect` ignore les clés qu'il ne connaît pas, la sortir ne coûte rien.
list = list.map(({ _popularity, ...rest }) => ({ ...rest, popularity: _popularity }));

const totalSeasons = list.reduce((n, a) => n + a.seasons.length, 0);
console.log(
  `[export-oped] ${list.length} anime, ${totalSeasons} season/lang panels ` +
    `(skipped ${skippedNoEp} rows with no usable episode count)`,
);

fs.mkdirSync(OUT.replace(/[/\\][^/\\]*$/, "") || ".", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(list, null, 2), "utf8");
console.log(`[export-oped] wrote ${OUT}`);
