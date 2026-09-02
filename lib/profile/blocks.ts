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
  /**
   * La couleur du bloc — sa pastille d'icône dans la BIBLIOTHÈQUE, et rien
   * d'autre depuis que les en-têtes ont perdu la leur : une pastille par carte
   * faisait une grille de points colorés qui ne distinguait rien, chaque bloc
   * portant déjà son nom.
   */
  color: string;
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
    source: "device",
    icon: "▶",
  },
  // 1×2 au minimum, 2×4 au maximum (hauteur × largeur) : sous deux colonnes il
  // ne reste pas la place d'une affiche et de son titre à côté des flèches, et
  // au-delà de deux lignes la vitrine serait une bande haute de 900 px pour des
  // couvertures 2:3.
  {
    id: "favorites",
    size: [4, 1],
    min: [2, 1],
    max: [4, 2],
    color: "#E94560",
    source: "list",
    icon: "★",
  },
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
export type BlockOption =
  /** Un interrupteur. */
  | { key: string; on: boolean }
  /** Un choix dans une liste fermée. `on` absent : c'est ce qui les distingue. */
  | { key: string; choices: readonly string[]; value: string }
  /**
   * Une PLAGE de valeurs, deux poignées sur un rail.
   *
   * Elle est rangée comme une chaîne « bas-haut » plutôt que comme deux clés :
   * les deux bornes n'ont aucun sens l'une sans l'autre, et un stockage qui
   * n'accepte que des booléens et des chaînes (cf. GridItem.s) n'a pas eu à
   * apprendre un troisième type pour ça.
   */
  | { key: string; range: [number, number]; step: number; value: string };

/**
 * Les listes que le bloc « favoris » sait mettre en vitrine.
 *
 * `favourites` d'abord — les favoris déclarés, le comportement historique et le
 * défaut. Viennent ensuite les listes de statut, dans l'ordre où elles se lisent
 * ailleurs sur le site (cf. STATUS_TO_LIST). Ce sont des valeurs de
 * STATUS_TO_LIST et pas des statuts AniList bruts : c'est ce que `listLabel`
 * sait traduire, donc le même nom qu'ailleurs pour la même liste.
 */
export const FAVORITE_SOURCES = [
  "favourites",
  "Watching",
  "Rewatching",
  "Completed",
  "Planning",
  "Paused",
  "Dropped",
] as const;

const OPTIONS: Record<string, BlockOption[]> = {
  resume: [{ key: "ambient", on: true }],
  favorites: [
    { key: "source", choices: FAVORITE_SOURCES, value: "favourites" },
    { key: "scores", range: [0, 10], step: 0.5, value: "0-10" },
    /* Faux par défaut, et c'est le point du réglage : la vitrine classe par
       note, donc une entrée sans note n'a pas de rang. Elle finirait en queue
       de bande sans qu'on sache pourquoi elle y est. */
    { key: "unrated", on: false },
    { key: "trailer", on: true },
  ],
};

/** Les bornes d'une plage : ce qui est rangé, sinon le défaut du catalogue. */
export function blockOptionRange(
  id: string,
  key: string,
  saved: Record<string, boolean | string> | undefined,
): [number, number] {
  const def = optionDef(id, key);
  if (!def || !("range" in def)) return [0, 0];
  const parse = (s: string): [number, number] | null => {
    const m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(s);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    // Hors bornes ou à l'envers : la valeur vient d'un navigateur, et une plage
    // inversée ne filtrerait rien du tout sans le dire.
    if (!(lo >= def.range[0] && hi <= def.range[1] && lo <= hi)) return null;
    return [lo, hi];
  };
  const v = saved?.[key];
  return (typeof v === "string" ? parse(v) : null) ?? parse(def.value) ?? def.range;
}

export function blockOptions(id: string): BlockOption[] {
  return OPTIONS[id] ?? [];
}

function optionDef(id: string, key: string): BlockOption | undefined {
  return blockOptions(id).find((o) => o.key === key);
}

/** L'état d'un interrupteur : ce qui est rangé, sinon le défaut du catalogue. */
export function blockOption(
  id: string,
  key: string,
  saved: Record<string, boolean | string> | undefined,
): boolean {
  const v = saved?.[key];
  if (typeof v === "boolean") return v;
  const def = optionDef(id, key);
  return def && "on" in def ? def.on : false;
}

/**
 * Le choix d'un menu déroulant : ce qui est rangé, sinon le défaut.
 *
 * Une valeur rangée qui ne fait PLUS partie des choix est ignorée. Elle arrive
 * d'un navigateur, elle a pu être écrite quand le catalogue proposait autre
 * chose, et un widget qui filtre sur une liste qui n'existe pas serait vide
 * sans rien expliquer.
 */
export function blockOptionValue(
  id: string,
  key: string,
  saved: Record<string, boolean | string> | undefined,
  /** Les choix que le catalogue ne peut pas connaître — les listes
   *  personnalisées d'un profil, qui n'existent que dans SA liste. */
  extra: readonly string[] = [],
): string {
  const def = optionDef(id, key);
  if (!def || !("choices" in def)) return "";
  const v = saved?.[key];
  const ok = typeof v === "string" && (def.choices.includes(v) || extra.includes(v));
  return ok ? (v as string) : def.value;
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
