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
export type Bounds = {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
  /** Largeur = hauteur, toujours (28/10/2026) : le calendrier n'existe qu'en
   *  2×2 et 3×3. Le côté est la moyenne des deux demandés, arrondie. */
  square?: boolean;
};

export const DEFAULT_BOUNDS: Bounds = { minW: 1, minH: 1, maxW: COLS, maxH: 4 };

/** Ramène une taille dans ses bornes, puis dans la grille. */
export function clampSize(w: number, h: number, b: Bounds = DEFAULT_BOUNDS): [number, number] {
  if (b.square) {
    const n = Math.min(
      COLS,
      Math.min(b.maxW, b.maxH),
      Math.max(b.minW, b.minH, Math.round((w + h) / 2)),
    );
    return [n, n];
  }
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

/**
 * L'ÉCHANGE, COMME LES CARTES DU BINGO (07/11/2026, Luc).
 *
 * Le bloc `id` est porté le long d'un axe — `"x"` dans sa rangée, `"y"` dans
 * sa colonne — et `center` est la position, fractionnaire en cases, de son
 * centre sur cet axe.
 *
 * LA BANDE. Sur l'axe x, c'est la hauteur du bloc, élargie à tout bloc qui la
 * chevauche, jusqu'à ce que plus rien ne dépasse : un calendrier 2×2 à côté de
 * deux blocs 1×2 empilés forme une bande de deux lignes. (Sur l'axe y, même
 * chose avec les colonnes.)
 *
 * LES TRANCHES. Dans la bande, les blocs qui se recouvrent sur l'axe font une
 * seule tranche : les deux blocs empilés bougent ENSEMBLE. Si le centre du
 * bloc porté est sur une autre tranche, la sienne prend ce rang et celles
 * d'entre les deux se décalent d'un cran — à deux, c'est un échange : le
 * calendrier passe à droite, la pile à gauche. Les tranches se rangent ensuite
 * bout à bout depuis la première, chacune gardant son dessin intérieur.
 *
 * D'ABORD SANS ÉLARGIR. La bande élargie peut avaler tout le profil (un bloc
 * pleine largeur au-dessus de deux blocs empilés soude toute la colonne) : on
 * essaie donc d'abord avec les seuls blocs contenus dans la bande du bloc
 * porté, les autres faisant mur, et on n'élargit qu'à défaut.
 *
 * `null` : le centre n'est sur aucune autre tranche, ou ça ne tient pas.
 */
export function reorderLine(
  items: GridItem[],
  id: string,
  center: number,
  axis: "x" | "y",
): GridItem[] | null {
  return lineSwap(items, id, center, axis, false) ?? lineSwap(items, id, center, axis, true);
}

function lineSwap(
  items: GridItem[],
  id: string,
  center: number,
  axis: "x" | "y",
  grow: boolean,
): GridItem[] | null {
  const me = items.find((o) => o.i === id);
  if (!me) return null;
  /* `p` : la position sur l'axe du geste, `s` sa taille ; `q`/`t` l'autre axe. */
  const p = (o: GridItem) => (axis === "x" ? o.x : o.y);
  const s = (o: GridItem) => (axis === "x" ? o.w : o.h);
  const q = (o: GridItem) => (axis === "x" ? o.y : o.x);
  const t = (o: GridItem) => (axis === "x" ? o.h : o.w);

  let lo = q(me);
  let hi = q(me) + t(me);
  for (let grew = grow; grew; ) {
    grew = false;
    for (const o of items) {
      if (q(o) < hi && q(o) + t(o) > lo && (q(o) < lo || q(o) + t(o) > hi)) {
        lo = Math.min(lo, q(o));
        hi = Math.max(hi, q(o) + t(o));
        grew = true;
      }
    }
  }
  const inBand = (o: GridItem) => q(o) >= lo && q(o) + t(o) <= hi;
  const band = items.filter(inBand).sort((a, b) => p(a) - p(b));
  /* Les blocs à cheval sur la bande sont des murs. */
  const walls = items.filter((o) => !inBand(o) && q(o) < hi && q(o) + t(o) > lo);

  type Slice = { a: number; b: number; ids: string[] };
  const slices: Slice[] = [];
  for (const o of band) {
    const last = slices[slices.length - 1];
    if (last && p(o) < last.b) {
      last.b = Math.max(last.b, p(o) + s(o));
      last.ids.push(o.i);
    } else slices.push({ a: p(o), b: p(o) + s(o), ids: [o.i] });
  }
  const from = slices.findIndex((sl) => sl.ids.includes(id));
  const to = slices.findIndex((sl, k) => k !== from && center >= sl.a && center < sl.b);
  if (from < 0 || to < 0) return null;

  /* Seulement les tranches d'entre les deux bougent ; un mur au milieu, et
     l'échange ne se fait pas. */
  const [i0, i1] = from < to ? [from, to] : [to, from];
  const span = slices.slice(i0, i1 + 1);
  const a0 = span[0].a;
  const b1 = span[span.length - 1].b;
  if (walls.some((o) => p(o) < b1 && p(o) + s(o) > a0)) return null;
  const order = span.filter((sl) => sl !== slices[from]);
  order.splice(to - i0, 0, slices[from]);
  let at = a0;
  const shift = new Map<string, number>();
  for (const sl of order) {
    for (const i of sl.ids) shift.set(i, at - sl.a);
    at += sl.b - sl.a;
  }
  if (axis === "x" && at > COLS) return null;
  return compact(
    items.map((o) => {
      const d = shift.get(o.i);
      if (!d) return o;
      return axis === "x" ? { ...o, x: o.x + d } : { ...o, y: o.y + d };
    }),
    id,
  );
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
/* 12 depuis le 04/11/2026 : le bingo range à lui seul neuf réglages. */
const MAX_OPTIONS = 12;
/** La longueur d'une valeur de réglage — dont le NOM qu'on donne à un bloc
    (clé réservée `title`), d'où l'export : le champ de renommage coupe à la
    même longueur plutôt que de laisser écrire ce que le nettoyage jettera. */
export const MAX_VALUE = 48;
/** Une case à cocher MULTIPLE (clé `lists`, cf. `blockOptionList`) range un
    tableau JSON de noms de listes : 48 caractères n'en tiennent que deux ou
    trois. Toujours borné, juste plus large. */
const MAX_LIST_VALUE = 800;
/** Les réglages qui rangent un tableau JSON et ont droit à cette longueur :
    les listes cochées, les trois épinglés avec leur phrase, les génériques
    favoris (03/11/2026). */
const LONG_KEYS = new Set(["lists", "pins", "themes", "bingoCells", "bingoSeason", "bingoState"]);
/** Le Top OP / ED / Musique n'a plus de nombre maximum (03/11/2026, Luc) :
    ~24 caractères par morceau, 6000 en tiennent environ 250. */
const MAX_THEMES_VALUE = 6000;
function cleanOptions(s: unknown): Record<string, boolean | string> | null {
  if (!s || typeof s !== "object") return null;
  const out: Record<string, boolean | string> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k.length > 32) continue;
    /* `affOrder` / `affHidden` : des tags d'amis (6 car.), jusqu'à 500 amis. */
    /* `bingoCustom` : les objectifs écrits à la main (titre 40 + description 90). */
    const cap = k === "themes" || k === "affOrder" || k === "affHidden" || k === "bingoCustom" || k === "bingoLabels" ? MAX_THEMES_VALUE : LONG_KEYS.has(k) ? MAX_LIST_VALUE : MAX_VALUE;
    if (typeof v !== "boolean" && !(typeof v === "string" && v.length <= cap)) continue;
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
