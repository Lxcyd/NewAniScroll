/**
 * Les onglets secondaires du profil (Liste, Stats, Badges), hors du chunk
 * d'entree.
 *
 * Les deux profils — celui d'un compte (pages/en/profile/[user].tsx) et celui
 * d'un invite (components/profile/LocalProfile.tsx) — arrivent TOUJOURS sur
 * « Apercu » : l'onglet vit dans le fragment de l'adresse (lib/profile/tabHash),
 * que le serveur ne voit pas, donc le rendu serveur et l'hydratation sont
 * toujours sur l'apercu. Ces trois composants n'etaient telecharges au
 * chargement que pour attendre un clic (~35 Ko bruts, dont les 24 Ko de la
 * vitrine des badges).
 *
 * `lazyWithPreload` plutot que `next/dynamic` : precharges au repos juste apres
 * l'affichage (`preloadProfileTabs`), ils s'affichent au clic exactement comme
 * s'ils avaient ete importes en dur — pas de rendu vide intermediaire.
 */
import { lazyWithPreload, preloadWhenIdle } from "@/lib/hooks/lazyWithPreload";

export const ProfileList = lazyWithPreload(() => import("./ProfileList"));
export const ProfileStatsPanel = lazyWithPreload(() => import("./ProfileStats"));
export const ProfileBadges = lazyWithPreload(() => import("./ProfileBadges"));

/** A appeler dans un effet de montage ; rend la fonction d'annulation. */
export function preloadProfileTabs() {
  return preloadWhenIdle(
    ProfileList.preload,
    ProfileStatsPanel.preload,
    ProfileBadges.preload,
  );
}
