/**
 * Les fonds à motifs d'une plaque de COULEUR : un dessin tiré de la seule
 * couleur choisie, posé sur un fond sombre.
 *
 * Tout est en CSS — dégradés et tuiles SVG en `data:` — : aucune image à
 * servir, aucun hôte à mettre en liste blanche, et le motif suit la couleur
 * sans rien régénérer côté serveur. Ce qui est stocké n'est que l'identifiant ;
 * le dessin se recalcule à l'affichage.
 *
 * Les treize retenus par Luc le 13/10/2026 parmi les cent du catalogue
 * (artefact « Fonds à motifs ») : le numéro du catalogue est en commentaire.
 *
 * Importé par l'API ET par le navigateur : ni base, ni `window`.
 */

/** Le fond sous le motif — celui de la base « Sombre » du catalogue. */
export const PATTERN_BASE = "#15161d";

type Ctx = {
  c: string;
  b: string;
  /** La couleur à p % d'opacité. */
  a: (p: number) => string;
  F: (o: number) => string;
  S: (o: number, w: number) => string;
};

const SQ3 = Math.sqrt(3);
const r1 = (x: number) => Math.round(x * 10) / 10;
const pts = (a: number[][]) => a.map((p) => p.map(r1).join(",")).join(" ");

/** Une tuile SVG répétée, à la taille de son dessin. */
const svg = (w: number, h: number, body: string, size = `${w}px ${h}px`) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>${body}</svg>`,
  )}") 0 0/${size}`;

/** Tirage déterministe (mulberry32) : la même mosaïque à chaque affichage. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Écailles en éventail (seigaiha) : rangées décalées d'un demi-rayon, la plus
   basse peinte en dernier pour recouvrir le bas de la précédente. */
function fans(k: Ctx, R: number, rings: number[], inner: number) {
  let s = "";
  for (let j = 0; j <= 4; j++) {
    const cy = (j * R) / 2;
    for (const cx of j % 2 ? [0, 2 * R] : [R]) {
      s += `<circle cx='${cx}' cy='${cy}' r='${R - 0.5}' fill='${k.b}'/>`;
      if (inner) s += `<circle cx='${cx}' cy='${cy}' r='${R - 0.5}' ${k.F(inner)}/>`;
      rings.forEach((q, i) => (s += `<circle cx='${cx}' cy='${cy}' r='${q}' ${k.S(0.55 - i * 0.08, 1.5)}/>`));
    }
  }
  return svg(2 * R, R, s);
}

/* Asanoha : le réseau triangulaire, et chaque sommet relié au centre de son
   triangle. Tuile de côté s sur deux rangées. */
function asanoha(k: Ctx, s: number) {
  const h = (s * SQ3) / 2;
  const H = 2 * h;
  let d = "";
  for (const x of [-s, 0, s]) d += `M${r1(x)} 0L${r1(x + s)} ${r1(H)}`;
  for (const x of [0, s, 2 * s]) d += `M${r1(x)} 0L${r1(x - s)} ${r1(H)}`;
  for (const y of [0, h, H]) d += `M0 ${r1(y)}H${s}`;
  const tris = [
    [[0, 0], [s, 0], [s / 2, h]], [[-s / 2, h], [s / 2, h], [0, 0]], [[s / 2, h], [(3 * s) / 2, h], [s, 0]],
    [[0, H], [s, H], [s / 2, h]], [[-s / 2, h], [s / 2, h], [0, H]], [[s / 2, h], [(3 * s) / 2, h], [s, H]],
  ];
  for (const t of tris) {
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
    const cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
    for (const p of t) d += `M${r1(p[0])} ${r1(p[1])}L${r1(cx)} ${r1(cy)}`;
  }
  return svg(r1(s), r1(H), `<path d='${d}' ${k.S(0.4, 1)}/>`);
}

/* Cubes en perspective : hexagones pointe en haut, trois losanges d'opacités
   différentes pour les trois faces. */
function cubes(k: Ctx, a: number) {
  const w = a * SQ3;
  let s = "";
  for (const [cx, cy] of [[0, 0], [w, 0], [w / 2, 1.5 * a], [0, 3 * a], [w, 3 * a]]) {
    const T = [cx, cy - a], UR = [cx + w / 2, cy - a / 2], LR = [cx + w / 2, cy + a / 2];
    const B = [cx, cy + a], LL = [cx - w / 2, cy + a / 2], UL = [cx - w / 2, cy - a / 2], C = [cx, cy];
    s += `<polygon points='${pts([T, UR, C, UL])}' ${k.F(0.45)}/>`;
    s += `<polygon points='${pts([UL, C, B, LL])}' ${k.F(0.22)}/>`;
    s += `<polygon points='${pts([C, UR, LR, B])}' ${k.F(0.08)}/>`;
  }
  return svg(r1(w), 3 * a, s);
}

/* La mosaïque NE SE RÉPÈTE PAS : une tuile de 4×4 cases se voyait à l'œil nu
   sur une plaque pleine page. Elle couvre donc ~2400×1440 px UNE FOIS ZOOMÉE,
   quel que soit le zoom — d'où le nombre de cases qui baisse quand le zoom
   monte : une tuile fixe en unités deviendrait au zoom ×8 une image de
   9600 px à rasteriser. Les triangles sont regroupés par opacité (six paliers,
   un chemin chacun) pour garder la donnée sous ~40 Ko. */
const MOSAIC_PX = [2400, 1440];
const mosaicCache = new Map<string, string>();
/* Plafond à 60×36 cases : au zoom ×1 la tuile fait 1200 px et se répète,
   mais une donnée de 17 000 triangles pèserait plus que la page. */
function mosaicSize(zoom: number): [number, number] {
  return [
    Math.min(60, Math.ceil(MOSAIC_PX[0] / (20 * zoom))) * 20,
    Math.min(36, Math.ceil(MOSAIC_PX[1] / (20 * zoom))) * 20,
  ];
}
function mosaic(k: Ctx, zoom: number) {
  const key = `${k.c}|${zoom}`;
  const hit = mosaicCache.get(key);
  if (hit) return hit;
  const [W, H] = mosaicSize(zoom);
  const cols = W / 20;
  const rows = H / 20;
  const R = rng(5);
  const paths: string[] = ["", "", "", "", "", ""];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const X = x * 20, Y = y * 20;
      paths[Math.floor(R() * 6)] += `M${X} ${Y}h20L${X} ${Y + 20}z`;
      paths[Math.floor(R() * 6)] += `M${X + 20} ${Y}v20H${X}z`;
    }
  const out = svg(
    cols * 20,
    rows * 20,
    paths.map((d, i) => (i && d ? `<path d='${d}' ${k.F(r1(i * 0.07))}/>` : "")).join(""),
  );
  mosaicCache.set(key, out);
  return out;
}

/* Kikkō hanabishi : carapace hexagonale (double trait) et une fleur à quatre
   pétales losanges dans chaque alvéole. Les centres voisins hors tuile sont
   dessinés aussi : ce qui en déborde entre dans la tuile. */
function kikkoHanabishi(k: Ctx, a: number) {
  const w = a * SQ3;
  const hex = (cx: number, cy: number, r: number) =>
    pts([0, 1, 2, 3, 4, 5].map((i) => {
      const t = (Math.PI / 3) * i - Math.PI / 2;
      return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
    }));
  let s = "";
  for (const [x, y] of [[0, 0], [w, 0], [w / 2, 1.5 * a], [0, 3 * a], [w, 3 * a], [-w / 2, 1.5 * a], [w * 1.5, 1.5 * a]]) {
    s += `<polygon points='${hex(x, y, a - 1)}' ${k.S(0.4, 1.5)}/><polygon points='${hex(x, y, a - 4)}' ${k.S(0.22, 1)}/>`;
    for (const r of [0, 90, 180, 270])
      s += `<polygon points='0,-9 2.6,-4.5 0,-1.5 -2.6,-4.5' transform='translate(${r1(x)} ${r1(y)}) rotate(${r})' ${k.F(0.5)}/>`;
  }
  return svg(r1(w), 3 * a, s);
}

/* Tokusa (prêle) : des tiges verticales, nœuds à hauteurs tirées au sort. */
function tokusa(k: Ctx) {
  const R = rng(213);
  let s = "";
  for (let i = 0; i < 6; i++) {
    const x = 2 + i * 10;
    s += `<rect x='${x}' y='0' width='6' height='120' ${k.F(r1(0.18 + R() * 0.2))}/>`;
    let y = R() * 30;
    while (y < 120) {
      s += `<rect x='${x - 0.5}' y='${r1(y)}' width='7' height='2' fill='${k.b}'/>`;
      y += 24 + R() * 18;
    }
  }
  return svg(60, 120, s);
}

const HONEY ="M28 66L0 50L0 16L28 0L56 16L56 50L28 66L28 100";

/* Chaque motif tient en UN SEUL calque de fond : l'animation fait glisser
   `background-position`, une valeur pour un calque (globals.css,
   .as-pattern-scroll). Un second calque resterait immobile. */
const DRAW: Record<string, (k: Ctx, zoom: number) => string> = {
  /* 2 */ "diag-wide": (k: Ctx) => `repeating-linear-gradient(45deg,${k.a(26)} 0 14px,transparent 14px 28px)`,
  /* 9 */ candy: (k: Ctx) => `repeating-linear-gradient(-45deg,${k.a(42)} 0 10px,${k.a(10)} 10px 20px)`,
  /* 11 — en SVG, plus en quatre dégradés : leurs arrêts nets laissaient un
     filet clair à chaque jointure de tuile. */
  zigzag: (k: Ctx) => svg(40, 40, `<polygon points='0,0 20,20 40,0 40,20 20,40 0,20' ${k.F(0.32)}/>`),
  /* 18 — le fondu est dans STILL : il ne défile pas avec la trame. */
  halftone: (k: Ctx) => `radial-gradient(${k.a(65)} 35%,transparent 37%) 0 0/10px 10px`,
  /* 33 */ tatami: (k: Ctx) =>
    svg(60, 60, `<path d='M.5 .5h39v19H.5zM40.5 .5h19v39h-19zM.5 20.5h19v39H.5zM20.5 20.5h19v19h-19zM20.5 40.5h39v19h-39z' ${k.S(0.32, 1)}/>`),
  /* 45 */ weave: (k: Ctx) =>
    svg(24, 24, `<path d='M0 3H12M0 6H12M0 9H12M12 15H24M12 18H24M12 21H24M15 0V12M18 0V12M21 0V12M3 12V24M6 12V24M9 12V24' ${k.S(0.32, 1)}/>`),
  /* 47 */ seigaiha: (k: Ctx) => fans(k, 20, [19, 14.5, 10, 5.5], 0),
  /* 52 */ scales: (k: Ctx) => fans(k, 14, [13.5], 0.1),
  /* 57 */ honeycomb: (k: Ctx) => svg(56, 100, `<path d='${HONEY}' ${k.S(0.4, 2)}/>`, "28px 50px"),
  /* 59 */ cubes: (k: Ctx) => cubes(k, 16),
  /* 66 */ mosaic: (k: Ctx, zoom: number) => mosaic(k, zoom),
  /* 72 */ asanoha: (k: Ctx) => asanoha(k, 28),
  /* 153 */ "kikko-hanabishi": (k: Ctx) => kikkoHanabishi(k, 18),
  /* 186 */ tokusa: (k: Ctx) => tokusa(k),
};

/** Ce qui reste FIXE quand le motif défile (posé par-dessus) — pour l'image
    immobile : vignettes, plaque sans animation. */
const STILL: Record<string, (k: Ctx) => string> = {
  halftone: (k) => `linear-gradient(90deg,${k.b},transparent 75%)`,
};

/* Le même fondu, en MASQUE, pour la plaque animée. Posé par-dessus un calque
   qui défile, le fondu laissait percer un liseré rose au bord du cadre : le
   calque animé est composité à part, et son bord ne tombe pas au même pixel
   que celui du fondu. Un masque efface le motif lui-même — il n'y a plus rien
   de rose sous le bord à faire percer. */
const MASK: Record<string, string> = {
  halftone: "linear-gradient(90deg,transparent,#000 75%)",
};

/* La PÉRIODE de défilement, en px avant zoom : une translation de ce vecteur
   redonne exactement le même motif, d'où une boucle sans couture. Les rayures
   défilent à l'horizontale (√2 × leur pas, puisqu'elles sont à 45°) : le long
   de la diagonale elles glisseraient sur elles-mêmes et paraîtraient figées.
   Les tuiles, elles, défilent en diagonale d'une tuile. */
const PERIOD: Record<string, (zoom: number) => [number, number] | [number, number, number]> = {
  /* [px, py, facteur] : le pas d'une rayure à 45° se mesure le long du
     dégradé, l'écart horizontal qui la reproduit vaut √2 fois ce pas. */
  "diag-wide": () => [28, 0, Math.SQRT2],
  candy: () => [20, 0, Math.SQRT2],
  zigzag: () => [40, 40],
  halftone: () => [10, 10],
  tatami: () => [60, 60],
  weave: () => [24, 24],
  seigaiha: () => [40, 20],
  scales: () => [28, 14],
  honeycomb: () => [28, 50],
  /* Arrondies comme la `background-size` de leur tuile (r1), sinon la boucle
     glisserait d'une fraction de pixel à chaque tour. */
  cubes: () => [r1(16 * SQ3), 48],
  mosaic: (zoom) => mosaicSize(zoom),
  asanoha: () => [28, r1(28 * SQ3)],
  "kikko-hanabishi": () => [r1(18 * SQ3), 54],
  tokusa: () => [60, 120],
};

/** Dans l'ordre où le studio les propose : du plus simple au plus chargé
    (tri demandé par Luc le 13/10/2026). « Diagonales fines » retiré le même
    jour ; un profil qui le portait retombe sur l'aplat (`isPatternId` le
    refuse). */
export const PATTERN_IDS = [
  "diag-wide", "candy", "zigzag", "halftone", "tokusa", "tatami", "weave",
  "honeycomb", "scales", "seigaiha", "cubes", "kikko-hanabishi", "asanoha", "mosaic",
] as const;

export type PatternId = (typeof PATTERN_IDS)[number];

export function isPatternId(v: unknown): v is PatternId {
  return typeof v === "string" && (PATTERN_IDS as readonly string[]).includes(v);
}

/** Le zoom du motif : un multiplicateur de toutes ses tailles. Défaut ×8 — à
    ×1, les tuiles du catalogue étaient faites pour des vignettes, et se
    perdaient en grain sur une plaque pleine page. */
export const PATTERN_ZOOM_MIN = 1;
export const PATTERN_ZOOM_MAX = 16;
export const PATTERN_ZOOM_STEP = 0.1;
/* ×8 par défaut, ×16 au plus (Luc, 13/10/2026) : ×4 restait trop fin. */
export const PATTERN_ZOOM_DEFAULT = 8;

export function clampPatternZoom(v: unknown): number {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return PATTERN_ZOOM_DEFAULT;
  return Math.max(PATTERN_ZOOM_MIN, Math.min(PATTERN_ZOOM_MAX, Math.round(n * 10) / 10));
}

/** Vitesse du défilement, en px d'écran par seconde. */
export const PATTERN_SPEED_MIN = 4;
export const PATTERN_SPEED_MAX = 160;
export const PATTERN_SPEED_DEFAULT = 24;

export function clampPatternSpeed(v: unknown): number {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return PATTERN_SPEED_DEFAULT;
  return Math.max(PATTERN_SPEED_MIN, Math.min(PATTERN_SPEED_MAX, Math.round(n)));
}

/* Mélange `t` (0..1) de la couleur dans le fond, en hexadécimal PLEIN.
   Le fond sous le motif est toujours PATTERN_BASE : une teinte pré-mélangée
   rend exactement la même couleur qu'une opacité, sans que deux traits qui se
   croisent s'additionnent en une teinte plus vive. */
function mixHex(color: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(PATTERN_BASE);
  const c = p(color);
  const u = Math.max(0, Math.min(1, t));
  return `#${a.map((v, i) => Math.round(v + (c[i] - v) * u).toString(16).padStart(2, "0")).join("")}`;
}

export type PatternLayers = {
  /** Le motif qui défile (sans le fond). */
  moving: string;
  /** Ce qui reste en place par-dessus, ou `null`. */
  still: string | null;
  /** Le même effet en masque du calque qui défile (plaque animée), ou `null`. */
  mask: string | null;
  /** Une période de défilement, en px d'écran (zoom compris). */
  period: [number, number];
};

/**
 * Les calques d'un motif. Le zoom multiplie chaque longueur en `px` de la
 * valeur — pas de `transform` qui agrandirait une image déjà rasterisée : les
 * dégradés et les tuiles SVG sont redessinés nets à leur nouvelle taille. Les
 * tuiles SVG n'écrivent aucune unité dans leur dessin, seule leur
 * `background-size` est touchée.
 */
export function patternLayers(id: PatternId, color: string, zoom = 1): PatternLayers {
  const k: Ctx = {
    c: color,
    b: PATTERN_BASE,
    a: (p) => mixHex(color, p / 100),
    F: (o) => `fill='${mixHex(color, o)}'`,
    S: (o, w) => `fill='none' stroke='${mixHex(color, o)}' stroke-width='${w}'`,
  };
  const z = clampPatternZoom(zoom);
  /* Longueurs ARRONDIES au pixel entier : une tuile de 110,8 px se pose à
     cheval sur deux pixels d'écran, et la jointure se voit en filet clair. La
     période de défilement est arrondie de la même façon, sinon la boucle
     glisserait d'une fraction à chaque tour. */
  const px1 = (n: number) => Math.round(n * z);
  const scale = (css: string) => css.replace(/(-?\d*\.?\d+)px/g, (_, n) => `${px1(Number(n))}px`);
  const [px, py, f = 1] = PERIOD[id](z);
  return {
    moving: scale(DRAW[id](k, z)),
    still: STILL[id] ? scale(STILL[id](k)) : null,
    mask: MASK[id] ?? null,
    period: [px1(px) * f, px1(py) * f],
  };
}

/** La valeur CSS `background` complète, immobile : le motif, puis le fond. */
export function patternBackground(id: PatternId, color: string, zoom = 1): string {
  const { moving, still } = patternLayers(id, color, zoom);
  return `${still ? `${still},` : ""}${moving},${PATTERN_BASE}`;
}
