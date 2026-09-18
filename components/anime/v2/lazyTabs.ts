import { lazyWithPreload, preloadWhenIdle } from "@/lib/hooks/lazyWithPreload";

/*
 * Les corps d'onglets de la fiche anime qui ne sont JAMAIS rendus au SSR (le
 * serveur rend toujours « overview »). Chacun dans son chunk : ils sortent du
 * chargement initial de la page (~120 Ko de source a eux quatre), et sont
 * precharges au repos juste apres — donc deja la au clic.
 *
 * Partages entre Tabs (desktop) et InfoPageMobile pour qu'un seul chunk serve
 * les deux mises en page.
 */
export const Episodes = lazyWithPreload(() => import("./Episodes"));
export const ScoresTab = lazyWithPreload(() => import("./ScoresTab"));
export const CharactersTab = lazyWithPreload(() => import("./CharactersTab"));
export const Artworks = lazyWithPreload(() => import("./Artworks"));

export const preloadTabBodies = () =>
  preloadWhenIdle(
    Episodes.preload,
    ScoresTab.preload,
    CharactersTab.preload,
    Artworks.preload,
  );
