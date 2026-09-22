/**
 * Cote navigateur : frembed peut-il avoir cet anime ?
 *
 * Frembed est le lecteur le plus rapide du site (CDN direct, ~100 ms) et il est
 * classe premier — mais son catalogue ne compte que quelques centaines de
 * fiches. Pour tout le reste, on le choisissait quand meme, on attendait son
 * « absent », puis on basculait : un aller-retour et un chip qui clignote,
 * a chaque ouverture, sur l'immense majorite des series.
 *
 * La liste est demandee une fois par session (mise en cache au bord une
 * demi-journee, et ici dans `localStorage` pour la journee). Tant qu'on ne l'a
 * pas, `frembedPossible` repond `true` : on ne prive personne d'un lecteur sur
 * une ignorance.
 */

import { idCatalog } from "./idCatalog";

const catalogue = idCatalog("aniscroll:frembedCatalog", "/api/v2/frembed-catalog");

/** Charge la liste si besoin. A appeler au repos, jamais dans un chemin bloquant. */
export const chargeFrembedCatalog: () => void = catalogue.charge;

/** `false` seulement si la liste est connue ET ne contient pas cet anime (id AniList). */
export const frembedPossible: (aniId: number | string | null | undefined) => boolean =
  catalogue.possible;

/** Les ids frembed a ecarter d'une liste de candidats pour cet anime. */
export function sansFrembed(servers: string[], aniId: number | string): string[] {
  if (frembedPossible(aniId)) return servers;
  return servers.filter((id) => !/^frembed/.test(id));
}
