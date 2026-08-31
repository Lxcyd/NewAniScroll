/**
 * La grille de widgets du profil — géométrie pure, sans React ni DOM.
 *
 * Modèle repris de react-grid-layout, sans la dépendance : COLS colonnes de
 * largeur égale, des lignes de hauteur fixe, et un compactage vers le haut
 * après chaque déplacement. Un bloc est un rectangle `{i, x, y, w, h}` en
 * unités de grille ; la conversion en pixels est faite par le composant, qui
 * seul connaît la largeur réelle du conteneur.
 *
 * Tout est ici plutôt que dans le composant pour une raison : ces fonctions
 * décident de ce que l'utilisateur voit BOUGER, et une erreur de compactage se
 * diagnostique sur un tableau, pas dans un pointerdown.
 */

export type GridItem = {
  /** Identifiant du bloc (cf. lib/profile/blocks.ts). */
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export const COLS = 4;
/** Hauteur d'une ligne, en px. */
export const ROW = 230;
/** Gouttière horizontale ET verticale, en px. */
export const GAP = 16;

/** Tailles types, façon widgets iOS : [colonnes, lignes]. */
export const SIZES: Record<string, [number, number]> = {
  s: [1, 1],
  m: [2, 1],
  l: [2, 2],
  xl: [4, 2],
};

export function collides(a: GridItem, b: GridItem): boolean {
  return (
    a.i !== b.i &&
    a.x + a.w > b.x &&
    a.x < b.x + b.w &&
    a.y + a.h > b.y &&
    a.y < b.y + b.h
  );
}

/**
 * Remonte chaque bloc tant qu'il ne heurte rien, dans l'ordre de lecture.
 *
 * `pinned` est le bloc que l'utilisateur tient sous le curseur : il garde la
 * ligne où il a été déposé (sinon il remonterait sous la main pendant qu'on le
 * déplace), les autres se referment autour de lui.
 */
export function compact(items: GridItem[], pinned?: string): GridItem[] {
  const sorted = items
    .slice()
    .sort(
      (a, b) =>
        (a.i === pinned ? -1 : b.i === pinned ? 1 : 0) || a.y - b.y || a.x - b.x,
    );
  const out: GridItem[] = [];
  for (const src of sorted) {
    const it: GridItem = { ...src, y: Math.max(0, src.y) };
    if (it.i !== pinned) {
      while (it.y > 0 && !out.some((o) => collides({ ...it, y: it.y - 1 }, o))) {
        it.y -= 1;
      }
    }
    while (out.some((o) => collides(it, o))) it.y += 1;
    out.push(it);
  }
  return out;
}

/** Le premier emplacement libre pour un bloc w×h, balayé en lecture. */
export function place(
  items: GridItem[],
  w: number,
  h: number,
): { x: number; y: number } {
  const width = Math.min(COLS, Math.max(1, w));
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x + width <= COLS; x++) {
      if (!items.some((o) => collides({ i: "__probe", x, y, w: width, h }, o))) {
        return { x, y };
      }
    }
  }
  return { x: 0, y: 0 };
}

/** Ajoute un bloc au premier trou qui l'accueille. */
export function addItem(
  items: GridItem[],
  id: string,
  w: number,
  h: number,
): GridItem[] {
  const p = place(items, w, h);
  return compact(items.concat([{ i: id, x: p.x, y: p.y, w, h }]));
}

/**
 * Repose une liste de blocs dans l'ordre donné, en gardant la taille de chacun.
 * Sert aux flèches monter/descendre, qui raisonnent en ordre de lecture et pas
 * en coordonnées.
 */
export function reflow(
  keys: string[],
  current: GridItem[],
  sizeOf: (id: string) => [number, number],
): GridItem[] {
  let items: GridItem[] = [];
  for (const k of keys) {
    const prev = current.find((o) => o.i === k);
    const [dw, dh] = sizeOf(k);
    const w = prev ? prev.w : dw;
    const h = prev ? prev.h : dh;
    const p = place(items, w, h);
    items = items.concat([{ i: k, x: p.x, y: p.y, w, h }]);
  }
  return compact(items);
}

/** L'ordre de lecture (haut→bas, gauche→droite) des blocs posés. */
export function readingOrder(items: GridItem[]): string[] {
  return items
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((o) => o.i);
}

/** Nombre de lignes occupées — la hauteur que le conteneur doit réserver. */
export function rowCount(items: GridItem[]): number {
  return items.reduce((m, o) => Math.max(m, o.y + o.h), 0);
}

/** Largeur d'une colonne pour un conteneur de `containerWidth` px. */
export function columnWidth(containerWidth: number): number {
  return (containerWidth - GAP * (COLS - 1)) / COLS;
}

/** Rectangle en pixels d'un bloc, pour un conteneur de largeur donnée. */
export function pixelRect(
  it: GridItem,
  containerWidth: number,
): { left: number; top: number; width: number; height: number } {
  const cw = columnWidth(containerWidth);
  return {
    left: it.x * (cw + GAP),
    top: it.y * (ROW + GAP),
    width: it.w * cw + (it.w - 1) * GAP,
    height: it.h * ROW + (it.h - 1) * GAP,
  };
}

/** Redimensionne un bloc en le gardant dans la grille, puis recompacte. */
export function resizeItem(
  items: GridItem[],
  id: string,
  w: number,
  h: number,
): GridItem[] {
  const width = Math.min(COLS, Math.max(1, w));
  const height = Math.max(1, h);
  return compact(
    items.map((o) =>
      o.i === id
        ? { ...o, w: width, h: height, x: Math.min(o.x, COLS - width) }
        : o,
    ),
    id,
  );
}

/** Une disposition venue du stockage est-elle exploitable telle quelle ? */
export function isValidLayout(value: unknown): value is GridItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (o) =>
        o &&
        typeof o === "object" &&
        typeof (o as GridItem).i === "string" &&
        Number.isFinite((o as GridItem).x) &&
        Number.isFinite((o as GridItem).y) &&
        Number.isFinite((o as GridItem).w) &&
        Number.isFinite((o as GridItem).h),
    )
  );
}

/**
 * Nettoie une disposition lue ailleurs (autre appareil, version précédente) :
 * les blocs inconnus disparaissent, les doublons aussi, et tout est ramené dans
 * la grille avant d'être recompacté. Sans ça un identifiant retiré du registre
 * laisserait un trou que rien ne peut remplir ni enlever.
 */
export function sanitizeLayout(
  items: GridItem[],
  isKnown: (id: string) => boolean,
): GridItem[] {
  const seen = new Set<string>();
  const clean: GridItem[] = [];
  for (const o of items) {
    if (!isKnown(o.i) || seen.has(o.i)) continue;
    seen.add(o.i);
    const w = Math.min(COLS, Math.max(1, Math.round(o.w)));
    clean.push({
      i: o.i,
      w,
      h: Math.max(1, Math.round(o.h)),
      x: Math.min(Math.max(0, Math.round(o.x)), COLS - w),
      y: Math.max(0, Math.round(o.y)),
    });
  }
  return compact(clean);
}
