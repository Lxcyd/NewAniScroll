/**
 * LES BLOCS LOURDS SE CHARGENT À LA DEMANDE (26/11/2026, passe vitesse du
 * profil).
 *
 * Mesuré sur le build : le JS propre à la page faisait 777 Ko minifiés, dont
 * ExtraBlocks seul 107 Ko (émojis et stickers de la salle commune compris) —
 * pour des blocs (bingo, épinglés, OP/ED, objectif…) que la plupart des profils
 * n'ont pas posés. Tout était analysé et compilé avant la moindre
 * interactivité, sur mobile comme sur bureau.
 *
 * Pourquoi pas `next/dynamic` : un composant déjà chargé doit s'afficher AU
 * PREMIER rendu, sans image vide — un bloc remonté (onglet, studio, carte
 * refaite par la grille) ne doit jamais clignoter. Ici, une fois le module
 * arrivé, le composant est rendu directement.
 *
 * Rien ne change à l'écran : la grille est rendue côté client seulement, et
 * `preloadBlocks` part pendant l'hydratation (ProfileOverview) pour les blocs
 * posés — leur code arrive pendant que React hydrate le reste de la page, bien
 * avant que la grille ne soit placée. Un bloc dont le code n'est pas encore là
 * a son corps vide, exactement comme un bloc pas encore révélé par la vague
 * (WidgetGrid).
 */
import { useEffect, useState, type ComponentType } from "react";

type Lazy<P> = ComponentType<P> & { preload: () => Promise<void> };

export function lazyBlock<P extends object>(load: () => Promise<ComponentType<P>>): Lazy<P> {
  let Loaded: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  const preload = () =>
    (pending ??= load().then(
      (c) => {
        Loaded = c;
      },
      (err) => {
        /* Un morceau qui n'arrive pas (réseau coupé, déploiement entre-temps) :
           on oublie la tentative, le prochain montage réessaie. */
        pending = null;
        throw err;
      },
    ));
  function LazyBlock(props: P) {
    const [, setTick] = useState(0);
    const ready = Loaded;
    useEffect(() => {
      if (ready) return;
      let live = true;
      preload().then(
        () => live && setTick((n) => n + 1),
        () => {},
      );
      return () => {
        live = false;
      };
    }, [ready]);
    const C = Loaded;
    return C ? <C {...props} /> : null;
  }
  return Object.assign(LazyBlock, { preload });
}

const extra = () => import("./ExtraBlocks");

export const AffinityBlock = lazyBlock(() => extra().then((m) => m.AffinityBlock));
export const AffinityEditor = lazyBlock(() => extra().then((m) => m.AffinityEditor));
export const BingeBlock = lazyBlock(() => extra().then((m) => m.BingeBlock));
export const BingoBlock = lazyBlock(() => extra().then((m) => m.BingoBlock));
export const GoalBlock = lazyBlock(() => extra().then((m) => m.GoalBlock));
export const PinnedBlock = lazyBlock(() => extra().then((m) => m.PinnedBlock));
export const ThemesBlock = lazyBlock(() => extra().then((m) => m.ThemesBlock));
export const CharactersBlock = lazyBlock(() => import("./CharactersBlock").then((m) => m.CharactersBlock));
export const HeatmapBlock = lazyBlock(() => import("./HeatmapBlock").then((m) => m.HeatmapBlock));
/* Paramètre facultatif (`= {}`) : l'inférence rendrait `object`, on le donne. */
type Device = typeof import("./DeviceBlocks");
type PropsOf<F extends (p?: any) => any> = NonNullable<Parameters<F>[0]>;
export const RecentsBlock = lazyBlock<PropsOf<Device["RecentsBlock"]>>(() =>
  import("./DeviceBlocks").then((m) => m.RecentsBlock),
);
export const ResumeBlock = lazyBlock<PropsOf<Device["ResumeBlock"]>>(() =>
  import("./DeviceBlocks").then((m) => m.ResumeBlock),
);

/** Le code de chaque TYPE de bloc (cf. lib/profile/blocks.ts `blockType`). */
const BY_TYPE: Record<string, { preload: () => Promise<void> }[]> = {
  affinity: [AffinityBlock],
  binge: [BingeBlock],
  bingo: [BingoBlock],
  goal: [GoalBlock],
  pinned: [PinnedBlock],
  themes: [ThemesBlock],
  characters: [CharactersBlock],
  heatmap: [HeatmapBlock],
  recents: [RecentsBlock],
  resume: [ResumeBlock],
};

/** Lance le chargement du code des types donnés ; sans argument, de tous. */
export function preloadBlocks(types?: Iterable<string>): void {
  if (typeof window === "undefined") return;
  const list = types ? Array.from(types) : Object.keys(BY_TYPE);
  for (const t of list) for (const c of BY_TYPE[t] ?? []) c.preload().catch(() => {});
}
