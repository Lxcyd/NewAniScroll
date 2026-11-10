/**
 * L'EMPREINTE d'une page voir-anime, et son rattachement a AniList.
 *
 * voir-anime n'expose AUCUN identifiant (ni AniList, ni MAL : pas de lien, API
 * WordPress fermee, jaquettes chez eux — verifie le 31/10/2026). Mais son bloc
 * de metadonnees est recopie d'AniList : Native / Romaji / English, type,
 * statut, studios, nombre d'episodes, dates de debut et de fin. Le titre y est
 * a l'identique ; les DATES, elles, sont souvent fausses de quelques jours a
 * quelques semaines (Kingdom 5 : 07/01 chez eux, 14/01 sur AniList).
 *
 * D'ou : le titre EXACT est obligatoire (ou a la seule ecriture de la saison
 * pres), puis on compte les preuves independantes, et une seule contradiction
 * elimine le candidat.
 *
 *   preuves      date de debut a 1 jour (3) ou a 45 jours (1), meme nombre
 *                d'episodes (2), un studio en commun (2), date de fin a 45 jours
 *                (1), meme type (1), titre natif identique (1)
 *   contradiction  une serie de plus de 3 episodes contre un film ; debut a
 *                plus de 400 jours. (Un nombre d'episodes different n'en est
 *                PAS une : voir-anime compte a sa facon.)
 *
 * Retenu : score >= 4 avec au moins DEUX preuves differentes, et aucun autre
 * candidat a moins de 3 points. Sinon : rien (ou « ambigu »).
 */

export const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const MOIS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
export function dateTexte(t) {
  const m = String(t || "").match(/([A-Z][a-z]{2})\w*\s+(\d{1,2}),\s*(\d{4})/);
  if (!m || !MOIS[m[1]]) return null;
  return `${m[3]}-${String(MOIS[m[1]]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
const dateAni = (d) => (d?.year && d?.month && d?.day ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null);
const jours = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 864e5 : null);

/** Le bloc de metadonnees d'une page (HTML brut) -> champs normalises. */
export function lireMeta(texte) {
  const meta = {};
  for (const m of texte.matchAll(/<div class="post-content_item[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g)) {
    const t = m[1].replace(/<[^>]*>/g, " ").replace(/&#0?39;|&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const k = t.split(" ")[0];
    meta[k] = t.slice(k.length).trim();
  }
  const nb = Number(String(meta.Episodes || "").match(/\d+/)?.[0]);
  return {
    romaji: meta.Romaji || null, natif: meta.Native || null, anglais: meta.English || null, francais: meta.French || null,
    type: meta.Type || null, statut: meta.Status || null,
    debut: dateTexte(meta.Start), fin: dateTexte(meta.End),
    studios: (meta.Studios || "").split(",").map((s) => s.trim()).filter(Boolean),
    nbAnnonce: Number.isFinite(nb) && nb > 0 ? nb : null,
    brut: meta,
  };
}

/** Un titre ramene a « base#saison » : « X 2nd Season », « X Season 2 », « X S2 », « X 2 », « X II » -> « x#2 ». */
const ROMAINS = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
export function formeSaison(t) {
  let s = String(t || "").normalize("NFKC").toLowerCase().trim();
  if (!s) return null;
  let n = 1, m;
  if ((m = s.match(/^(.*?)[\s:-]*(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\s+season$/))) { s = m[1]; n = +m[2]; }
  else if ((m = s.match(/^(.*?)[\s:-]*season\s*(\d{1,2})$/))) { s = m[1]; n = +m[2]; }
  else if ((m = s.match(/^(.*?)[\s:-]+s(\d{1,2})$/))) { s = m[1]; n = +m[2]; }
  else if ((m = s.match(/^(.*?)\s*第(\d{1,2})(?:期|シーズン|シリーズ)$/))) { s = m[1]; n = +m[2]; }
  else if ((m = s.match(/^(.*\D)\s+(\d{1,2})$/)) && +m[2] <= 12) { s = m[1]; n = +m[2]; }
  else if ((m = s.match(/^(.*?)\s+(ii|iii|iv|v|vi)$/))) { s = m[1]; n = ROMAINS[m[2]]; }
  const base = norm(s);
  return base.length >= 3 ? `${base}#${n}` : null;
}

const FAMILLE = (f) => {
  const x = String(f || "").toUpperCase().replace(/\s+/g, "_");
  if (x === "MOVIE") return "film";
  if (["TV", "TV_SHORT", "ONA"].includes(x)) return "serie";
  if (["OVA", "SPECIAL"].includes(x)) return "special";
  return x ? "autre" : null;
};

/** Note un candidat AniList pour une page. -> {score, preuves[], contre[]} */
export function noter(p, m) {
  const preuves = [], contre = [];
  let score = 0;
  const tousM = [m.title?.romaji, m.title?.native, m.title?.english, ...(m.synonyms || [])].filter(Boolean);
  const tousP = [p.romaji, p.natif, p.anglais].filter(Boolean);
  const titres = tousM.map(norm);
  const exacts = tousP.map(norm).filter((t) => t && titres.includes(t));
  if (!exacts.length) {
    // « 3-gatsu no Lion 2 » (voir-anime) = « 3-gatsu no Lion 2nd Season » (AniList) : meme base, meme saison.
    const formes = new Set(tousM.map(formeSaison).filter(Boolean));
    /* « Vampire Miyu (TV) » : AniList distingue deux entrees homonymes par une
       parenthese que voir-anime ne recopie pas. « Tsuyokiss: Cool×Sweet » :
       voir-anime garde le titre sans le sous-titre. Ces deux-la exigent en plus
       une date de debut au jour pres (verifie plus bas). */
    const sansParenthese = (t) => norm(String(t).replace(/\s*\([^)]*\)\s*$/, ""));
    /* Et le titre sans son DERNIER segment « - … » : « JoJo no Kimyou na Bouken:
       Steel Ball Run - 1st STAGE » (AniList) = « …: Steel Ball Run » (voir-anime,
       qui fusionne les STAGE sur une page). Couper au premier separateur ne
       laissait que « JoJo no Kimyou na Bouken » (10/11/2026). */
    const avantSousTitre = (t) => [
      norm(String(t).split(/\s*:\s+|\s+-\s+/)[0]),
      norm(String(t).replace(/\s+-\s+[^-]*$/, "")),
    ];
    const nP = new Set(tousP.map(norm));
    if (tousP.map(formeSaison).some((f) => f && formes.has(f))) preuves.push("titre~saison");
    else if (tousM.some((t) => /\)\s*$/.test(t) && nP.has(sansParenthese(t)))) preuves.push("titre~parenthese");
    else if (tousM.some((t) => avantSousTitre(t).some((b) => b.length >= 6 && b !== norm(t) && nP.has(b)))) preuves.push("titre~soustitre");
    else return { score: -1, preuves, contre: ["titre"] };
  }
  if (p.natif && m.title?.native && norm(p.natif) === norm(m.title.native)) { score += 1; preuves.push("natif"); }

  /* Leur TYPE est approximatif (Pokemon The Origin « Movie », un episode unique
     note « TV ») : seule une vraie SERIE (plus de 3 episodes) face a un film
     contredit — Wave!! Surfing Yappe!! (TV, 12 ep) n'est pas le film. */
  const fp = FAMILLE(p.type), fm = FAMILLE(m.format);
  if (fp && fm) {
    const serieContreFilm = (fm === "film" && fp === "serie" && (p.nbAnnonce || 0) > 3)
      || (fp === "film" && fm === "serie" && (m.episodes || 0) > 3);
    if (serieContreFilm) contre.push(`type ${p.type}/${m.format}`);
    else if (String(p.type).toUpperCase().replace(/\s+/g, "_") === m.format) { score += 1; preuves.push("type"); }
  }
  /* AniList ne connait parfois que l'ANNEE (vieux films, speciaux) : la date
     complete manque, l'annee seule contredit encore. « Hashire Melos! » (1992)
     tombait sur le film de 1979. (voir-anime note ces annees-la au 30/11.) */
  if (!dateAni(m.startDate) && m.startDate?.year && p.debut && Math.abs(Number(p.debut.slice(0, 4)) - m.startDate.year) > 1) {
    contre.push(`annee ${p.debut.slice(0, 4)}/${m.startDate.year}`);
  }
  const dDebut = jours(p.debut, dateAni(m.startDate));
  if (dDebut != null) {
    if (dDebut <= 1) { score += 3; preuves.push("debut"); }
    else if (dDebut <= 45) { score += 1; preuves.push("debut~"); }
    else if (dDebut > 400) contre.push(`debut ${p.debut}/${dateAni(m.startDate)}`);
  }
  const dFin = jours(p.fin, dateAni(m.endDate));
  if (dFin != null && dFin <= 45) { score += 1; preuves.push("fin"); }
  /* Le nombre d'episodes est une PREUVE quand il tombe juste, jamais une
     contradiction : voir-anime compte a sa facon (cours fusionnes, SNK 3 = 22
     pour 12 + 10 ; un special en plus ; Gintama 367). Mesure du 31/10/2026 :
     53 ancres justes perdues quand l'ecart eliminait. */
  if (p.nbAnnonce && m.episodes && p.nbAnnonce === m.episodes) { score += 2; preuves.push("episodes"); }
  const studiosM = (m.studios?.nodes || []).map((s) => norm(s.name));
  if (p.studios?.length && studiosM.length && p.studios.some((s) => studiosM.includes(norm(s)))) { score += 2; preuves.push("studio"); }
  // Titre approche par parenthese ou sous-titre : il faut la date de debut au jour pres.
  if ((preuves.includes("titre~parenthese") || preuves.includes("titre~soustitre")) && !preuves.includes("debut")) contre.push("titre approche sans date exacte");
  return { score, preuves, contre };
}

/** Choisit parmi les candidats. -> {id|null, note, score, preuves} */
export function choisir(p, candidats) {
  const notes = [...new Map(candidats.map((m) => [m.id, m])).values()]
    .map((m) => ({ m, ...noter(p, m) }))
    .filter((x) => x.score >= 0 && !x.contre.length)
    .sort((a, b) => b.score - a.score);
  /* Un titre EXACT passe avant tout titre approche (saison, parenthese,
     sous-titre) : « Promare: Galo-hen » ne concurrence pas « Promare ». */
  const approche = (x) => x.preuves.some((p) => p.startsWith("titre~"));
  if (notes.some((x) => !approche(x))) for (let i = notes.length - 1; i >= 0; i--) if (approche(notes[i])) notes.splice(i, 1);
  const [a, b] = notes;
  // Les preuves INDEPENDANTES du titre (le titre est une condition, pas une preuve).
  const differentes = new Set((a?.preuves || []).filter((x) => !x.startsWith("titre")).map((x) => x.replace("~", ""))).size;
  if (!a || a.score < 4 || differentes < 2) {
    return { id: null, note: a ? `preuves-insuffisantes (${a.m.id}: ${a.preuves.join("+") || "aucune"})` : "aucun-candidat", score: a?.score ?? null };
  }
  if (b && a.score - b.score < 3) return { id: null, note: `ambigu (${a.m.id}:${a.score} / ${b.m.id}:${b.score})`, score: a.score };
  return { id: a.m.id, note: `empreinte: ${a.preuves.join("+")}`, score: a.score, preuves: a.preuves };
}

/** Recherche AniList par lots de 10 titres (alias GraphQL). */
export const CHAMPS_MEDIA = "id format episodes status startDate{year month day} endDate{year month day} title{romaji native english} synonyms studios(isMain:true){nodes{name}}";
export async function rechercherLot(termes, { dors, compteur } = {}) {
  const vars = {}, defs = [], corps = [];
  termes.forEach((t, i) => {
    vars[`s${i}`] = t; defs.push(`$s${i}:String`);
    corps.push(`a${i}:Page(perPage:10){media(search:$s${i},type:ANIME){${CHAMPS_MEDIA}}}`);
  });
  for (let essai = 0; essai < 4; essai++) {
    if (compteur) compteur.anilist++;
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query(${defs.join(",")}){${corps.join(" ")}}`, variables: vars }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!r || r.status === 429 || r.status >= 500) { await dors(30000); continue; }
    const j = await r.json().catch(() => null);
    await dors(2200); // AniList : ~30 requetes / minute
    return termes.map((_, i) => j?.data?.[`a${i}`]?.media || []);
  }
  return null;
}

/**
 * Rattache des pages : recherche par romaji, natif et anglais, les candidats
 * de toutes les recherches sont notes ENSEMBLE (un meme titre romaji peut
 * renvoyer la saison 1 et le film ; le natif departage).
 * pages: [{slug, romaji, natif, anglais, ...empreinte}] -> Map slug -> choix
 */
export async function ancrer(pages, outils) {
  const out = new Map();
  const candidats = new Map(pages.map((p) => [p.slug, []]));
  const resolues = new Set();
  for (const champ of ["romaji", "natif", "anglais"]) {
    // Une page deja rattachee sans ambiguite n'a pas besoin d'une recherche de plus.
    for (const p of pages) if (!resolues.has(p.slug) && candidats.get(p.slug).length && choisir(p, candidats.get(p.slug)).id) resolues.add(p.slug);
    const aChercher = pages.filter((p) => p[champ] && !resolues.has(p.slug) && !out.has(p.slug));
    for (let i = 0; i < aChercher.length; i += 10) {
      const lot = aChercher.slice(i, i + 10);
      const res = await rechercherLot(lot.map((p) => p[champ]), outils);
      if (!res) { lot.forEach((p) => out.set(p.slug, { id: null, note: "anilist-injoignable" })); continue; }
      lot.forEach((p, k) => candidats.get(p.slug).push(...res[k]));
      if (outils?.progres) outils.progres(champ, i + lot.length, aChercher.length);
    }
  }
  // Les candidats vus, pour rejouer les regles sans re-interroger AniList.
  if (outils?.candidats) for (const p of pages) outils.candidats.set(p.slug, candidats.get(p.slug));
  for (const p of pages) {
    if (out.has(p.slug)) continue;
    if (!p.romaji && !p.natif && !p.anglais) { out.set(p.slug, { id: null, note: "sans-titre" }); continue; }
    out.set(p.slug, choisir(p, candidats.get(p.slug)));
  }
  return out;
}
