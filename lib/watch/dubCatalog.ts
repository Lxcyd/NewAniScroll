/**
 * Cote navigateur : cet anime a-t-il un doublage francais ?
 *
 * Avec l'ordre de langues « VF d'abord », ouvrir une serie jamais doublee
 * faisait essayer les lecteurs VF l'un apres l'autre, chacun repondant
 * « absent » a son tour — une dizaine de secondes pour apprendre ce que
 * MyDubList sait d'avance.
 *
 * La liste est demandee une fois par session (mise en cache au bord une
 * demi-journee, et ici dans `localStorage` pour la journee). Tant qu'on ne l'a
 * pas, `vfPossible` repond `true` : on ne prive personne d'un lecteur sur une
 * ignorance. Meme regle que `frembedCatalog`.
 *
 * Ce qu'on NE fait pas : retirer les lecteurs VF. Le verdict sert a les
 * RETROGRADER — on n'en ouvre plus un d'emblee, mais les sondes de fond partent
 * quand meme, en dernier. Croisement du 20/09/2026 : MyDubList concorde a 97,8 %
 * avec nos lignes VF constatees. Les ~2 % restants sont des VF non officielles
 * qu'anime-sama heberge malgre tout, et une exclusion franche les rendrait
 * invisibles ET irrecuperables, pour ne gagner que des invocations de sonde.
 *
 * Donnees : MyDubList — https://mydublist.com — CC BY 4.0.
 */

import { idCatalog } from "./idCatalog";

const catalogue = idCatalog("aniscroll:dubCatalog", "/api/v2/dub-catalog?lang=french");

/** Charge la liste si besoin. A appeler au repos, jamais dans un chemin bloquant. */
export const chargeDubCatalog: () => void = catalogue.charge;

/** `false` seulement si la liste est connue ET ne contient pas cet anime (id MAL). */
export const vfPossible: (idMal: number | string | null | undefined) => boolean =
  catalogue.possible;
