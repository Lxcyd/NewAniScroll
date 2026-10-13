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

function mosaic(k: Ctx) {
  const R = rng(5);
  let s = "";
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const X = x * 20, Y = y * 20;
      s += `<polygon points='${X},${Y} ${X + 20},${Y} ${X},${Y + 20}' ${k.F(r1(R() * 0.35))}/>`;
      s += `<polygon points='${X + 20},${Y} ${X + 20},${Y + 20} ${X},${Y + 20}' ${k.F(r1(R() * 0.35))}/>`;
    }
  return svg(80, 80, s);
}

const HONEY = "M28 66L0 50L0 16L28 0L56 16L56 50L28 66L28 100";

const DRAW = {
  /* 1 */ "diag-fine": (k: Ctx) => `repeating-linear-gradient(45deg,${k.a(35)} 0 2px,transparent 2px 12px)`,
  /* 2 */ "diag-wide": (k: Ctx) => `repeating-linear-gradient(45deg,${k.a(26)} 0 14px,transparent 14px 28px)`,
  /* 9 */ candy: (k: Ctx) => `repeating-linear-gradient(-45deg,${k.a(42)} 0 10px,${k.a(10)} 10px 20px)`,
  /* 11 */ zigzag: (k: Ctx) => {
    const A = k.a(32);
    return `linear-gradient(135deg,${A} 25%,transparent 25%) -20px 0/40px 40px,linear-gradient(225deg,${A} 25%,transparent 25%) -20px 0/40px 40px,linear-gradient(315deg,${A} 25%,transparent 25%) 0 0/40px 40px,linear-gradient(45deg,${A} 25%,transparent 25%) 0 0/40px 40px`;
  },
  /* 18 */ halftone: (k: Ctx) =>
    `linear-gradient(90deg,${k.b},transparent 75%),radial-gradient(${k.a(65)} 35%,transparent 37%) 0 0/10px 10px`,
  /* 33 */ tatami: (k: Ctx) =>
    svg(60, 60, `<path d='M.5 .5h39v19H.5zM40.5 .5h19v39h-19zM.5 20.5h19v39H.5zM20.5 20.5h19v19h-19zM20.5 40.5h39v19h-39z' ${k.S(0.32, 1)}/>`),
  /* 45 */ weave: (k: Ctx) =>
    svg(24, 24, `<path d='M0 3H12M0 6H12M0 9H12M12 15H24M12 18H24M12 21H24M15 0V12M18 0V12M21 0V12M3 12V24M6 12V24M9 12V24' ${k.S(0.32, 1)}/>`),
  /* 47 */ seigaiha: (k: Ctx) => fans(k, 20, [19, 14.5, 10, 5.5], 0),
  /* 52 */ scales: (k: Ctx) => fans(k, 14, [13.5], 0.1),
  /* 57 */ honeycomb: (k: Ctx) => svg(56, 100, `<path d='${HONEY}' ${k.S(0.4, 2)}/>`, "28px 50px"),
  /* 59 */ cubes: (k: Ctx) => cubes(k, 16),
  /* 66 */ mosaic: (k: Ctx) => mosaic(k),
  /* 72 */ asanoha: (k: Ctx) => asanoha(k, 28),
} as const;

export type PatternId = keyof typeof DRAW;

/** Dans l'ordre où le studio les propose. */
export const PATTERN_IDS = Object.keys(DRAW) as PatternId[];

export function isPatternId(v: unknown): v is PatternId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(DRAW, v);
}

/** La valeur CSS `background` complète : le motif, puis le fond sombre. */
export function patternBackground(id: PatternId, color: string): string {
  const k: Ctx = {
    c: color,
    b: PATTERN_BASE,
    a: (p) => `color-mix(in srgb,${color} ${p}%,transparent)`,
    F: (o) => `fill='${color}' fill-opacity='${o}'`,
    S: (o, w) => `fill='none' stroke='${color}' stroke-opacity='${o}' stroke-width='${w}'`,
  };
  return `${DRAW[id](k)},${PATTERN_BASE}`;
}
