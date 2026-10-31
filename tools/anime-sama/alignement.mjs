/**
 * ALIGNEMENT d'une fiche anime-sama sur la chaine AniList, par nombre d'episodes.
 *
 * La fiche anime-sama affiche l'id AniList de l'oeuvre (sa premiere saison).
 * On suit les SEQUEL (formats TV) et on remplit les saisons anime-sama DANS
 * L'ORDRE avec les entrees AniList successives, tant que les comptes tombent
 * juste : saison1 = 25 ep. = AniList S1 (12) + S1 Part 2 (13) => Part 2 est
 * dans saison1 a partir de l'episode 13 (decalage 12).
 *
 * Compter les SEQUEL seuls (« saison N = N-1 suites ») se trompait des
 * qu'AniList coupe une saison en deux parties qu'anime-sama reunit (Spy x
 * Family, Mushoku Tensei, Re:Zero, Tokyo Revengers — audit du 30/10/2026).
 *
 * Des que les comptes divergent, on s'arrete : la suite de la fiche n'a pas
 * d'attente (mieux vaut « on ne sait pas » qu'une saison fausse).
 */

const FORMATS_SUITE = ["TV", "TV_SHORT", "ONA"];

/** Les saisons numerotees, dans l'ordre : saison1, saison2-1, saison2-2, saison3… */
export function saisonsOrdonnees(dossiers) {
  return dossiers
    .map((d) => ({ d, m: d.match(/^saison(\d+)(?:-(\d+))?$/) }))
    .filter((x) => x.m && Number(x.m[1]) > 0)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || Number(a.m[2] || 0) - Number(b.m[2] || 0))
    .map((x) => x.d);
}

/**
 * @param saisons  [{dossier, nbEp}] dans l'ordre (nbEp = le panneau le plus fourni, toutes langues)
 * @param chaine   [{id, episodes, status}] : la fiche puis ses SEQUEL successives
 * @returns Map id AniList -> {dossier, decalage}, avec `out.complet` : TOUTES
 *   les saisons alignees et la chaine epuisee (hors entrees pas encore sorties).
 *   Seul un alignement complet peut contredire le resolveur : une saison isolee
 *   peut tomber juste par coincidence quand un cote a une saison que l'autre
 *   n'a pas (Fumoffu, absent de la chaine AniList de Full Metal Panic).
 */
export function aligner(saisons, chaine, { decalageAuxBouts = true } = {}) {
  const out = new Map();
  out.complet = false;
  let alignees = 0, vides = 0;
  let i = 0;
  let rompu = false; // un compte faux (et non une chaine epuisee) a arrete l'alignement
  let rang = -1, rangRompu = -1;
  for (const s of saisons) {
    rang++;
    /* Panneau VIDE (affiche par la fiche, episodes.js vide — Diabolik Lovers
       saison1, The Outcast saison4, 31/10/2026) : il tient la place d'UNE
       entree AniList, sans rien servir. Sans lui, tout ce qui suit glissait. */
    if (!s.nbEp) {
      if (i >= chaine.length) break;
      i++;
      vides++;
      continue;
    }
    const debut = i;
    let somme = 0;
    const membres = [];
    while (i < chaine.length && somme < s.nbEp) {
      const e = chaine[i];
      // Episodes inconnus (en cours de diffusion) : seulement en DERNIER, il prend le
      // reste — et jamais comme complement d'une saison deja entamee (Black Clover :
      // 170 ep. AniList, 171 chez eux, la suite en cours etait avalee).
      if (e.episodes == null) {
        if (i !== chaine.length - 1 || membres.length) { rompu = true; rangRompu = rang; i = debut; membres.length = 0; break; }
        membres.push({ id: e.id, decalage: somme });
        somme = s.nbEp;
        i++;
        break;
      }
      membres.push({ id: e.id, decalage: somme });
      somme += e.episodes;
      i++;
    }
    if (rompu) break;
    if (!membres.length) break; // chaine epuisee : anime-sama a des saisons qu'AniList n'a pas (encore)
    const derniereEnCours = chaine[i - 1]?.status === "RELEASING";
    /* Juste = EXACTEMENT. Une tolerance d'un episode faisait coller The Second
       Raid (13 ep.) sur la saison 2 de Full Metal Panic (Fumoffu, 12 ep., absent
       de la chaine AniList) : les saisons de 12 et 13 episodes sont trop
       courantes. Seule exception : anime-sama en retard sur une entree en cours
       de diffusion. Tout autre ecart : on s'arrete, sans attente. */
    const juste = somme === s.nbEp || (somme > s.nbEp && derniereEnCours);
    if (!juste) { rompu = true; rangRompu = rang; i = debut; break; }
    for (const m of membres) out.set(m.id, { dossier: s.dossier, decalage: m.decalage });
    alignees++;
  }
  const reste = chaine.slice(i).filter((e) => e.status !== "NOT_YET_RELEASED");
  const toutesLesSaisons = alignees + vides === saisons.length;
  const chaineEpuisee = reste.length === 0;
  /* COMPLET (seul cas qui peut contredire le resolveur) :
     - toutes les saisons alignees ET la chaine epuisee ; ou, pour les saisons
       (`decalageAuxBouts`), un seul bout qui depasse, jamais un compte faux :
     - toutes les saisons d'anime-sama alignees, AniList a des saisons de plus
       a la fin (pas encore mises en ligne chez eux : Fairies Album) ;
     - toute la chaine AniList consommee, anime-sama a des saisons de plus a la
       fin (pas encore sur AniList, ou hors chaine : ORIENT).
     Un alignement arrete par un compte FAUX reste partiel (Full Metal Panic,
     faux des sa saison 2) — sauf sur la DERNIERE saison d'anime-sama, qui
     ajoute souvent des speciaux a la fin (L'Attaque des Titans saison4 : 30
     ep. pour 16 + 12 sur AniList) : tout ce qui precede est exact. */
  const rompuAuBout = rompu && rangRompu === saisons.length - 1;
  out.complet = alignees > 0 && (
    (!rompu && toutesLesSaisons && chaineEpuisee) ||
    (decalageAuxBouts && ((!rompu && (toutesLesSaisons || chaineEpuisee)) || rompuAuBout))
  );
  return out;
}

/* ── Films et OAV : meme alignement, sur la FRANCHISE triee par date ────────
   Le panneau `film` d'anime-sama porte les films de la franchise, un par
   episode, dans l'ordre de sortie (verifie le 30/10/2026 sur les titres des
   embeds : « Bleach Film 1 Memories of Nobody » … « Film 4 Hell Verse »,
   « S800E01/E02 »). `film`, `film2`… se remplissent comme des saisons.
   OAV : les seules entrees OVA — les SPECIAL d'AniList melent mini-episodes et
   bonus, leurs comptes ne collent presque jamais. */
export const GENRES_HORS_SAISON = [
  { re: /^film(\d*)$/, formats: ["MOVIE"] },
  { re: /^oav(\d*)$/, formats: ["OVA"] },
];
// Les liens qui restent dans la meme histoire (pas CHARACTER, OTHER, ALTERNATIVE, SPIN_OFF).
export const LIENS_FRANCHISE = new Set(["SEQUEL", "PREQUEL", "SIDE_STORY", "PARENT", "SUMMARY"]);
const dateDe = (m) => (m?.startDate?.year || 9999) * 10000 + (m?.startDate?.month || 12) * 100 + (m?.startDate?.day || 31);

/** Panneaux d'un genre (film, film2…) dans l'ordre. */
export function panneauxGenre(dossiers, re) {
  const pans = dossiers.map((d) => ({ d, m: d.match(re) })).filter((x) => x.m);
  /* `film` ET `film1` sur la meme fiche : ordre ambigu (Sword Art Online, ou
     `film` porte « SAO S01E01 » et `film1` « S01E02… »). On ne conclut pas. */
  const rangs = pans.map((x) => Number(x.m[1] || 1));
  if (new Set(rangs).size !== rangs.length) return [];
  return pans.sort((a, b) => Number(a.m[1] || 1) - Number(b.m[1] || 1)).map((x) => x.d);
}
/** La chaine d'un genre : les membres de la franchise de ces formats, par date de sortie. */
export function chaineGenre(membres, formats) {
  return membres
    // Pas encore sorti : ne peut pas etre chez anime-sama (SAO Integral Domain, 2028).
    .filter((m) => m && formats.includes(m.format) && m.status !== "NOT_YET_RELEASED")
    .sort((a, b) => dateDe(a) - dateDe(b))
    .map((m) => ({ id: m.id, episodes: m.episodes ?? null, status: m.status ?? null }));
}

/** La chaine SEQUEL depuis `id` avec un chargeur `media(id)` -> {id, episodes, status, relations}. */
export async function chaineSequel(id, media, max = 30) {
  const chaine = [];
  const vus = new Set();
  let cur = id;
  while (cur && !vus.has(cur) && chaine.length < max) {
    vus.add(cur);
    const m = await media(cur);
    if (!m || m.status === "NOT_YET_RELEASED") break; // annonce : pas chez anime-sama
    chaine.push({ id: m.id, episodes: m.episodes ?? null, status: m.status ?? null });
    cur = suiteTV(m);
    /* Pas de suite TV directe : la suite passe parfois par un FILM (Major S4 ->
       film -> S5). On fait ce seul detour, sans compter le film comme saison. */
    if (!cur) {
      const detour = m.relations?.edges?.find((e) => e.relationType === "SEQUEL" && !FORMATS_SUITE.includes(e.node?.format))?.node?.id;
      if (detour && !vus.has(detour)) {
        vus.add(detour);
        cur = suiteTV(await media(detour));
      }
    }
  }
  return chaine;
}
const suiteTV = (m) => m?.relations?.edges?.find((e) => e.relationType === "SEQUEL" && FORMATS_SUITE.includes(e.node?.format))?.node?.id ?? null;
/** Les ids qu'un parcours de chaine peut demander : suites TV et detours (pour charger par lots). */
export const suitesPossibles = (m) => (m?.relations?.edges || []).filter((e) => e.relationType === "SEQUEL").map((e) => e.node.id);
