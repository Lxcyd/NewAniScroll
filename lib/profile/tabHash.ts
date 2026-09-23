/**
 * L'ONGLET DU PROFIL VIT DANS L'ADRESSE — comme sur la page d'un anime.
 *
 * Il n'y vivait pas : l'onglet était un `useState` local, donc un rechargement
 * ramenait toujours sur « Aperçu ». C'est la page d'info qui avait raison
 * (components/anime/v2/Tabs.tsx) et son patron est repris tel quel : lecture au
 * montage, synchronisation sur `hashchange` ET `popstate`, écriture en
 * `replaceState` pour ne pas empiler une entrée d'historique par clic d'onglet.
 *
 * ── LE FRAGMENT EST DÉJÀ HABITÉ, ET C'EST LE PIÈGE ──────────────────────────
 * Les badges s'en servaient avant nous : la notification envoie `#badge-<id>`
 * (ouvrir l'onglet ET montrer celui-là), la pastille des non-vus `#badge-`
 * (ouvrir l'onglet, sans élire personne) — cf. lib/badges/reveal.ts. Deux
 * conséquences, et aucune n'est facultative :
 *
 *   - `lireOnglet` doit rendre « badges » pour `#badges` COMME pour tout
 *     `#badge-…`, sinon arriver par la notification afficherait « Aperçu » ;
 *   - l'adresse ne se réécrit QUE sur un clic (`ecrireOnglet`), jamais à la
 *     restauration. Réécrire au montage remplacerait `#badge-<id>` par
 *     `#badges` et ProfileBadges perdrait la cible qu'il doit surligner.
 *
 * Les deux profils (celui d'un compte et celui d'un invité) partagent ce
 * module : même liste d'onglets, même comportement, un seul endroit à corriger.
 */
import { replaceUrlPreservingState } from "@/lib/navigation/replaceUrl";

export const PROFILE_TABS = ["overview", "list", "stats", "badges"] as const;
export type ProfileTabKey = (typeof PROFILE_TABS)[number];

/** L'onglet demandé par l'adresse. « overview » par défaut — c'est aussi celui
 *  qui ne s'écrit pas, pour garder l'URL propre. */
export function lireOnglet(): ProfileTabKey {
  if (typeof window === "undefined") return "overview";
  const h = window.location.hash.replace(/^#/, "");
  /* `#badge-…` vaut « badges » : c'est la même destination, avec en plus un
     badge à surligner, et ce travail-là appartient à ProfileBadges. */
  if (h.startsWith("badge-")) return "badges";
  return (PROFILE_TABS as readonly string[]).includes(h)
    ? (h as ProfileTabKey)
    : "overview";
}

/** Poser l'onglet dans l'adresse. À n'appeler que sur un geste de l'utilisateur
 *  (cf. l'en-tête : la restauration, elle, ne doit rien réécrire). */
export function ecrireOnglet(tab: string): void {
  if (typeof window === "undefined") return;
  const fragment = tab === "overview" ? "" : `#${tab}`;
  replaceUrlPreservingState(
    window.location.pathname + window.location.search + fragment,
  );
}
