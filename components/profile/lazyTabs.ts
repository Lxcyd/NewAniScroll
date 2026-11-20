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
import { BadgesSkeleton, FriendsSkeleton, GridSkeleton, ListSkeleton } from "./TabSkeletons";

/* Le squelette de chaque onglet tient la place tant que son code arrive
   (21/11/2026) : un clic avant le préchargement ne montre plus un trou. */
export const ProfileList = lazyWithPreload(() => import("./ProfileList"), ListSkeleton);
export const ProfileStatsPanel = lazyWithPreload(() => import("./ProfileStats"), GridSkeleton);
export const ProfileBadges = lazyWithPreload(() => import("./ProfileBadges"), BadgesSkeleton);
export const ProfileFriends = lazyWithPreload(() => import("./ProfileFriends"), FriendsSkeleton);

/** Précharge le code d'un onglet (survol / focus de son bouton). */
export function preloadProfileTab(key: string) {
  const p =
    key === "list" ? ProfileList.preload
    : key === "badges" ? ProfileBadges.preload
    : key === "friends" ? ProfileFriends.preload
    : key === "stats" ? ProfileStatsPanel.preload
    : null;
  p?.().catch(() => {});
}

/** A appeler dans un effet de montage ; rend la fonction d'annulation. */
export function preloadProfileTabs() {
  return preloadWhenIdle(
    ProfileList.preload,
    ProfileStatsPanel.preload,
    ProfileBadges.preload,
    ProfileFriends.preload,
  );
}
