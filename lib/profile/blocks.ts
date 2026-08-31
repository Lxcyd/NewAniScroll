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

export type BlockSource = "list" | "device" | "none" | "soon";

export type BlockDef = {
  id: string;
  /** [colonnes, lignes] à l'ajout. */
  size: [number, number];
  color: string;
  source: BlockSource;
  /** Emoji du catalogue — décoratif, jamais porteur d'information seule. */
  icon: string;
};

export const BLOCKS: BlockDef[] = [
  { id: "resume", size: [2, 1], color: "#F59E0B", source: "device", icon: "▶" },
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
