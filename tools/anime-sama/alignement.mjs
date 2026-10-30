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
export function aligner(saisons, chaine) {
  const out = new Map();
  out.complet = false;
  let alignees = 0;
  let i = 0;
  for (const s of saisons) {
    let somme = 0;
    const membres = [];
    while (i < chaine.length && somme < s.nbEp) {
      const e = chaine[i];
      // Episodes inconnus (en cours de diffusion) : seulement en DERNIER, il prend le
      // reste — et jamais comme complement d'une saison deja entamee (Black Clover :
      // 170 ep. AniList, 171 chez eux, la suite en cours etait avalee).
      if (e.episodes == null) {
        if (i !== chaine.length - 1 || membres.length) return out;
        membres.push({ id: e.id, decalage: somme });
        somme = s.nbEp;
        i++;
        break;
      }
      membres.push({ id: e.id, decalage: somme });
      somme += e.episodes;
      i++;
    }
    if (!membres.length) break;
    const derniereEnCours = chaine[i - 1]?.status === "RELEASING";
    /* Juste = EXACTEMENT. Une tolerance d'un episode faisait coller The Second
       Raid (13 ep.) sur la saison 2 de Full Metal Panic (Fumoffu, 12 ep., absent
       de la chaine AniList) : les saisons de 12 et 13 episodes sont trop
       courantes. Seule exception : anime-sama en retard sur une entree en cours
       de diffusion. Tout autre ecart : on s'arrete, sans attente. */
    const juste = somme === s.nbEp || (somme > s.nbEp && derniereEnCours);
    if (!juste) break;
    for (const m of membres) out.set(m.id, { dossier: s.dossier, decalage: m.decalage });
    alignees++;
  }
  const reste = chaine.slice(i).filter((e) => e.status !== "NOT_YET_RELEASED");
  out.complet = alignees === saisons.length && saisons.length > 0 && reste.length === 0;
  return out;
}

/** La chaine SEQUEL depuis `id` avec un chargeur `media(id)` -> {id, episodes, status, relations}. */
export async function chaineSequel(id, media, max = 30) {
  const chaine = [];
  const vus = new Set();
  let cur = id;
  while (cur && !vus.has(cur) && chaine.length < max) {
    vus.add(cur);
    const m = await media(cur);
    if (!m) break;
    chaine.push({ id: m.id, episodes: m.episodes ?? null, status: m.status ?? null });
    cur = m.relations?.edges?.find((e) => e.relationType === "SEQUEL" && FORMATS_SUITE.includes(e.node?.format))?.node?.id ?? null;
  }
  return chaine;
}
