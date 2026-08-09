/**
 * Plausibilité arithmétique d'un intervalle OP/ED, au moment de l'IMPORT.
 *
 * Pourquoi ici et pas seulement dans le détecteur : `tools/opening-detector/
 * oped/validate.py` fait déjà ce travail — et bien plus finement (bande de
 * longueur 25-150 s, bord rogné, couverture des votes, divergence audio/image,
 * chevauchement OP/ED). Mesure du 07/08 : **zéro violation sur nos 690 cellules**.
 * Le détecteur ne produit pas d'impossibles.
 *
 * Ce module ne le double donc pas : il garde la **frontière de la base**, par
 * laquelle passent aussi ce que le détecteur n'a pas produit — surcharges
 * manuelles saisies à la main, JSONL édité, futur candidat externe. Une faute de
 * frappe dans une saisie manuelle est une erreur comme une autre, et la base ne
 * doit jamais contenir un timing arithmétiquement impossible.
 *
 * La règle est délibérément **minimale et sans hypothèse sur le contenu** : un
 * OP en plein milieu d'épisode passe, un générique de fin sur la chanson
 * d'ouverture passe (cas Erased ep1). On ne rejette que ce qui ne peut pas
 * exister. Tout jugement plus fin appartient à validate.py, qui a le contexte
 * pour le porter.
 *
 * Référence : DEVLOG.md, « 2026-08-07 — Audit OP/ED », §2 (3,3 % de ce qu'on
 * servait était arithmétiquement impossible) et §6.
 */

/** Un bord peut dépasser la fin du fichier de ce peu sans être suspect : les
 *  durées sont mesurées à ~0,1 s près selon les sondes, et un ED qui court
 *  jusqu'à la dernière image tombe pile sur la borne. */
export const DURATION_SLACK_S = 2;

/** En dessous, l'intervalle est dégénéré : aucun bouton « passer » n'a de sens,
 *  et c'est presque toujours le résidu d'un appariement raté. */
export const MIN_INTERVAL_S = 5;

/**
 * @param {{start:number,end:number}} interval
 * @param {number|null|undefined} duration  durée du média contre lequel
 *   l'intervalle a été mesuré (`canonical_duration` côté réconcilié,
 *   `duration` côté par-hôte). Inconnue → on ne peut que vérifier la forme.
 * @returns {string|null} la raison du rejet, ou null si l'intervalle est possible.
 */
export function implausibleReason(interval, duration) {
  const { start, end } = interval || {};
  if (typeof start !== "number" || typeof end !== "number") return "bornes absentes";
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "bornes non finies";
  if (start < 0) return `debut negatif (${start.toFixed(1)}s)`;
  if (end - start < MIN_INTERVAL_S) {
    return `intervalle degenere (${(end - start).toFixed(1)}s < ${MIN_INTERVAL_S}s)`;
  }
  // Sans durée on s'arrête là : rejeter faute d'information transformerait une
  // donnée incomplète en donnée perdue.
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  if (start >= duration) {
    return `commence apres la fin (${start.toFixed(1)}s >= ${duration.toFixed(1)}s)`;
  }
  if (end > duration + DURATION_SLACK_S) {
    return `finit apres la fin (${end.toFixed(1)}s > ${duration.toFixed(1)}s)`;
  }
  return null;
}

/** Vrai quand l'intervalle est arithmétiquement possible sur ce média. */
export function isPlausible(interval, duration) {
  return implausibleReason(interval, duration) === null;
}
