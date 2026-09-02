/**
 * Le catalogue des blocs du profil.
 *
 * Une entrée par widget : sa taille par défaut, sa couleur de pastille, et —
 * le champ qui compte — la SOURCE dont il a besoin pour dire quelque chose de
 * vrai :
 *
 *   "list"   la liste du profil (AniList ou la sauvegarde du compte) ;
 *   "device" les traces de lecture de CET appareil (lib/watch/progress.ts) —
 *            elles ne décrivent que le visiteur, donc ces blocs ne sont
 *            proposés qu'au propriétaire du profil ;
 *   "none"   rien à chercher, le bloc se suffit ;
 *   "soon"   aucune source n'existe encore. Le bloc reste proposé, avec un état
 *            vide explicite : on montre la mise en page sans afficher un
 *            chiffre faux (décision du 31/08/2026).
 *
 * Les libellés passent par i18n (`profile.blocks.<id>.title` / `.desc`).
 */

import { DEFAULT_BOUNDS, type Bounds } from "./grid";

export type BlockSource = "list" | "device" | "none" | "soon";

export type BlockDef = {
  id: string;
  /** [colonnes, lignes] à l'ajout. */
  size: [number, number];
  /**
   * [colonnes, lignes] au plus petit / au plus grand. Absent : la grille entière
   * (1×1 à 4×4). Un bloc dont la mise en page ne tient pas dans une colonne le
   * DIT ici plutôt que de se laisser écraser au coin.
   */
  min?: [number, number];
  max?: [number, number];
  color: string;
  /**
   * `false` retire la pastille de couleur de l'en-tête. Elle sert à distinguer
   * des blocs qui se ressemblent ; sur un bloc qui porte déjà son illustration
   * elle n'ajoute qu'un point de couleur de plus.
   */
  dot?: false;
  source: BlockSource;
  /** Emoji du catalogue — décoratif, jamais porteur d'information seule. */
  icon: string;
};

export const BLOCKS: BlockDef[] = [
  // 1×2 au minimum, 2×4 au maximum (hauteur × largeur) : sous deux colonnes la
  // vignette et le titre ne cohabitent plus, au-delà de deux lignes la carte est
  // un grand vide autour d'une seule ligne d'historique.
  {
    id: "resume",
    size: [2, 1],
    min: [2, 1],
    max: [4, 2],
    color: "#F59E0B",
    dot: false,
    source: "device",
    icon: "▶",
  },
  { id: "favorites", size: [4, 1], color: "#E94560", source: "list", icon: "★" },
  { id: "recents", size: [2, 2], color: "#E94560", source: "device", icon: "↷" },
  { id: "statuses", size: [2, 1], color: "#22c55e", source: "list", icon: "◍" },
  { id: "scores", size: [2, 1], color: "#FFD700", source: "list", icon: "▮" },
  { id: "genres", size: [2, 2], color: "#A855F7", source: "list", icon: "◳" },
  { id: "formats", size: [2, 2], color: "#3B82F6", source: "list", icon: "◧" },
  { id: "studios", size: [2, 1], color: "#FFD700", source: "list", icon: "◆" },
  { id: "season", size: [4, 1], color: "#22c55e", source: "list", icon: "❂" },
  { id: "characters", size: [4, 1], color: "#E94560", source: "list", icon: "☺" },
  // Sans source, pour l'instant — cf. l'en-tête. Chacun sait déjà ce qu'il lui
  // manque, écrit dans sa traduction `.soon`, pour que le bloc vide explique
  // lui-même pourquoi il est vide.
  { id: "calendar", size: [2, 2], color: "#3B82F6", source: "soon", icon: "▦" },
  { id: "heatmap", size: [4, 1], color: "#E94560", source: "soon", icon: "▨" },
  { id: "binge", size: [2, 1], color: "#F59E0B", source: "soon", icon: "⏱" },
  { id: "goal", size: [2, 1], color: "#A855F7", source: "soon", icon: "◎" },
  { id: "pinned", size: [4, 1], color: "#E94560", source: "soon", icon: "❏" },
  { id: "themes", size: [2, 2], color: "#A855F7", source: "soon", icon: "♪" },
  { id: "badges", size: [2, 1], color: "#FFD700", source: "soon", icon: "✦" },
  { id: "affinity", size: [2, 1], color: "#22c55e", source: "soon", icon: "≈" },
  { id: "bingo", size: [2, 2], color: "#3B82F6", source: "soon", icon: "▩" },
];

/**
 * LES RÉGLAGES D'UN BLOC.
 *
 * Un interrupteur, une clé, un défaut. La valeur choisie voyage dans la
 * disposition (`GridItem.s`, cf. grid.ts) et n'y est écrite que si elle DIFFÈRE
 * du défaut — une grille par défaut reste ainsi exactement l'objet qu'elle
 * était, et changer d'avis sur un défaut change le comportement des profils qui
 * n'y ont jamais touché, ce qui est le but d'un défaut.
 *
 * La roue dentée est offerte sur TOUS les blocs, y compris ceux qui n'ont
 * encore rien à régler : la commande est au même endroit partout, et un panneau
 * qui dit « rien à régler ici » se lit mieux qu'un bouton qui apparaît sur
 * certaines cartes et pas sur d'autres. Le libellé d'une option est
 * `profile.widgets.options.<clé>`.
 */
export type BlockOption = { key: string; on: boolean };

const OPTIONS: Record<string, BlockOption[]> = {
  resume: [{ key: "ambient", on: true }],
};

export function blockOptions(id: string): BlockOption[] {
  return OPTIONS[id] ?? [];
}

/** L'état d'un interrupteur : ce qui est rangé, sinon le défaut du catalogue. */
export function blockOption(
  id: string,
  key: string,
  saved: Record<string, boolean> | undefined,
): boolean {
  return saved?.[key] ?? blockOptions(id).find((o) => o.key === key)?.on ?? false;
}

const BY_ID = new Map(BLOCKS.map((b) => [b.id, b]));

export function blockDef(id: string): BlockDef | undefined {
  return BY_ID.get(id);
}

export function isKnownBlock(id: string): boolean {
  return BY_ID.has(id);
}

export function blockSize(id: string): [number, number] {
  return BY_ID.get(id)?.size ?? [2, 1];
}

/** Les bornes de redimensionnement d'un bloc, pour lib/profile/grid.ts. */
export function blockBounds(id: string): Bounds {
  const def = BY_ID.get(id);
  if (!def) return DEFAULT_BOUNDS;
  return {
    minW: def.min?.[0] ?? DEFAULT_BOUNDS.minW,
    minH: def.min?.[1] ?? DEFAULT_BOUNDS.minH,
    maxW: def.max?.[0] ?? DEFAULT_BOUNDS.maxW,
    maxH: def.max?.[1] ?? DEFAULT_BOUNDS.maxH,
  };
}

/**
 * La disposition de départ : ce qu'un profil montre avant que son propriétaire
 * n'y touche. Uniquement des blocs alimentés — un profil neuf ne s'ouvre pas
 * sur une grille d'états vides.
 *
 * Le visiteur d'un profil qui n'est pas le sien ne voit pas les blocs
 * "device" : ils décriraient SA lecture à lui, pas celle du profil.
 */
export const DEFAULT_BLOCKS = [
  "resume",
  "favorites",
  "recents",
  "statuses",
  "scores",
  "genres",
] as const;

/**
 * Les blocs qu'un visiteur peut voir sur le profil d'un autre : tous.
 *
 * Cette fonction retirait les blocs `device` — reprendre la lecture, vu
 * récemment. Ce n'était pas de la pudeur : ils lisaient le localStorage du
 * navigateur qui AFFICHE la page, donc sur le profil d'un autre ils auraient
 * montré la lecture du visiteur sous le nom du propriétaire. Les masquer était
 * la seule réponse honnête tant que la source était celle-là.
 *
 * Elle ne l'est plus. lib/profile/activity.ts reconstruit l'historique du
 * PROPRIÉTAIRE depuis sa sauvegarde de compte, et le rendu serveur le passe aux
 * blocs quand le lecteur n'est pas chez lui. Le motif du masquage a disparu
 * avec la cause.
 *
 * Le paramètre `isOwner` reste : quatre appelants le passent, et c'est encore
 * lui qui dira quoi faire le jour où un réglage de visibilité apparaîtra —
 * aujourd'hui il n'y en a aucun, on retire le bloc pour ne rien publier, la
 * disposition étant elle-même publique.
 */
export function visibleTo(_isOwner: boolean, id: string): boolean {
  return BY_ID.has(id);
}
