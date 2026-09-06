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
  /**
   * Les réglages du bloc — un interrupteur (booléen) ou un choix dans une liste
   * (chaîne), uniquement ceux que le propriétaire a TOUCHÉS. Absent, ou clé
   * absente : le bloc garde son défaut (cf. `blockOptions` dans blocks.ts).
   *
   * Ils vivent ici, dans la disposition, plutôt que dans un stockage à eux :
   * la disposition est déjà persistée, déjà servie à tous les visiteurs et déjà
   * nettoyée en un seul endroit (`sanitizeLayout`). Un second canal aurait
   * demandé sa propre colonne, sa propre route et sa propre validation pour
   * transporter trois booléens attachés à des blocs qui voyagent déjà.
   */
  s?: Record<string, boolean | string>;
};

export const COLS = 4;
/**
 * Les bornes d'un bloc, en unités de grille — largeur ET hauteur.
 *
 * Notation retenue avec l'auteur des widgets : « 1×2 » se lit HAUTEUR × LARGEUR,
 * donc `{ minH: 1, minW: 2 }`. Le catalogue (lib/profile/blocks.ts) les exprime
 * dans l'ordre `[w, h]` des autres champs ; c'est ici qu'elles deviennent une
 * contrainte, appliquée au redimensionnement comme à l'aperçu qui suit le
 * curseur — sans quoi le coin laisserait tirer une taille que la disposition
 * refuserait ensuite, et le bloc sauterait au relâchement.
 */
export type Bounds = { minW: number; minH: number; maxW: number; maxH: number };

export const DEFAULT_BOUNDS: Bounds = { minW: 1, minH: 1, maxW: COLS, maxH: 4 };

/** Ramène une taille dans ses bornes, puis dans la grille. */
export function clampSize(w: number, h: number, b: Bounds = DEFAULT_BOUNDS): [number, number] {
  return [
    Math.min(COLS, Math.min(b.maxW, Math.max(b.minW, w))),
    Math.min(b.maxH, Math.max(b.minH, h)),
  ];
}

/** Hauteur d'une ligne, en px. */
export const ROW = 230;
/** Gouttière horizontale ET verticale, en px. */
export const GAP = 16;

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
  bounds: Bounds = DEFAULT_BOUNDS,
): GridItem[] {
  const [width, height] = clampSize(w, h, bounds);
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
 * Les réglages d'un bloc, ramenés à ce qu'ils ont le droit d'être.
 *
 * Ce sac est ouvert : n'importe quelle clé peut s'y trouver, et il arrive d'un
 * navigateur avant d'être relu par d'AUTRES visiteurs du profil. Il n'est donc
 * pas comparé au catalogue des blocs — grid.ts ne le connaît pas et n'a pas à
 * le connaître — mais borné en forme : des booléens ou des chaînes courtes,
 * sous des clés courtes, en petit nombre. Une clé retirée du catalogue plus
 * tard ne fait rien de mal ; un objet de dix mille entrées, si.
 *
 * Une chaîne n'est PAS validée contre les choix du bloc : celui qui l'a écrite
 * connaissait un catalogue qui a pu changer depuis, et le lecteur retombe de
 * toute façon sur le défaut quand la valeur ne lui dit rien (`blockOptionValue`).
 * Ce qui compte ici est qu'elle ne puisse pas être un roman.
 */
const MAX_OPTIONS = 8;
/** La longueur d'une valeur de réglage — dont le NOM qu'on donne à un bloc
    (clé réservée `title`), d'où l'export : le champ de renommage coupe à la
    même longueur plutôt que de laisser écrire ce que le nettoyage jettera. */
export const MAX_VALUE = 48;
function cleanOptions(s: unknown): Record<string, boolean | string> | null {
  if (!s || typeof s !== "object") return null;
  const out: Record<string, boolean | string> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k.length > 32) continue;
    if (typeof v !== "boolean" && !(typeof v === "string" && v.length <= MAX_VALUE)) continue;
    out[k] = v;
    if (Object.keys(out).length >= MAX_OPTIONS) break;
  }
  return Object.keys(out).length ? out : null;
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
  boundsOf: (id: string) => Bounds = () => DEFAULT_BOUNDS,
): GridItem[] {
  const seen = new Set<string>();
  const clean: GridItem[] = [];
  for (const o of items) {
    if (!isKnown(o.i) || seen.has(o.i)) continue;
    seen.add(o.i);
    /* Les bornes sont appliquées ICI aussi, pas seulement au coin : une
       disposition écrite avant qu'un bloc n'ait un minimum arrive encore d'un
       autre appareil, et rien d'autre ne la corrigerait. */
    const [w, h] = clampSize(Math.round(o.w), Math.round(o.h), boundsOf(o.i));
    const s = cleanOptions(o.s);
    clean.push({
      i: o.i,
      w,
      h,
      x: Math.min(Math.max(0, Math.round(o.x)), COLS - w),
      y: Math.max(0, Math.round(o.y)),
      ...(s ? { s } : {}),
    });
  }
  return compact(clean);
}
