/**
 * Convert a hex colour to a CSS `filter` string that recolours a BLACK source
 * image to that colour. Pair it with a `brightness(0) saturate(100%)` prefix to
 * first flatten any (white/grey) monochrome glyph to black, then tint it.
 *
 * This is the technique the reference project (AnimeDetailPopup.razor) uses to
 * paint AniList's monochrome external-link icons in each site's brand colour.
 * AniList serves those icons as grey+alpha PNGs, so a plain <img> shows a dull
 * grey glyph; this filter turns it into a crisp brand-coloured one.
 *
 * The solver is the well-known SPSA approach (Barrett Sonntag's "hex to CSS
 * filter"): it searches invert/sepia/saturate/hue-rotate/brightness/contrast
 * values whose composed effect, applied to black, lands on the target colour.
 * We memoise the result, so the per-render cost is a single Map lookup.
 *
 * DETERMINISM (critical): the SPSA solver perturbs in random directions. With
 * Math.random() the server and the client computed DIFFERENT filter strings
 * for the same colour, so the recoloured icon's inline `style` didn't match on
 * hydration → React errors #418/#423/#425. We seed a small PRNG from the
 * target colour instead, so the same hex always yields the exact same filter
 * on the server and in the browser.
 */

type RGB = [number, number, number];

/* Mulberry32 — tiny deterministic PRNG. Seeded per-solve from the target
   colour so SPSA explores the same path on server and client. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Color {
  r: number;
  g: number;
  b: number;
  constructor(r: number, g: number, b: number) {
    this.r = r;
    this.g = g;
    this.b = b;
  }
  toString() {
    return `rgb(${Math.round(this.r)},${Math.round(this.g)},${Math.round(this.b)})`;
  }
  set(r: number, g: number, b: number) {
    this.r = this.clamp(r);
    this.g = this.clamp(g);
    this.b = this.clamp(b);
  }
  hueRotate(angle = 0) {
    angle = (angle / 180) * Math.PI;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    this.multiply([
      0.213 + cos * 0.787 - sin * 0.213,
      0.715 - cos * 0.715 - sin * 0.715,
      0.072 - cos * 0.072 + sin * 0.928,
      0.213 - cos * 0.213 + sin * 0.143,
      0.715 + cos * 0.285 + sin * 0.14,
      0.072 - cos * 0.072 - sin * 0.283,
      0.213 - cos * 0.213 - sin * 0.787,
      0.715 - cos * 0.715 + sin * 0.715,
      0.072 + cos * 0.928 + sin * 0.072,
    ]);
  }
  grayscale(value = 1) {
    this.multiply([
      0.2126 + 0.7874 * (1 - value),
      0.7152 - 0.7152 * (1 - value),
      0.0722 - 0.0722 * (1 - value),
      0.2126 - 0.2126 * (1 - value),
      0.7152 + 0.2848 * (1 - value),
      0.0722 - 0.0722 * (1 - value),
      0.2126 - 0.2126 * (1 - value),
      0.7152 - 0.7152 * (1 - value),
      0.0722 + 0.9278 * (1 - value),
    ]);
  }
  sepia(value = 1) {
    this.multiply([
      0.393 + 0.607 * (1 - value),
      0.769 - 0.769 * (1 - value),
      0.189 - 0.189 * (1 - value),
      0.349 - 0.349 * (1 - value),
      0.686 + 0.314 * (1 - value),
      0.168 - 0.168 * (1 - value),
      0.272 - 0.272 * (1 - value),
      0.534 - 0.534 * (1 - value),
      0.131 + 0.869 * (1 - value),
    ]);
  }
  saturate(value = 1) {
    this.multiply([
      0.213 + 0.787 * value,
      0.715 - 0.715 * value,
      0.072 - 0.072 * value,
      0.213 - 0.213 * value,
      0.715 + 0.285 * value,
      0.072 - 0.072 * value,
      0.213 - 0.213 * value,
      0.715 - 0.715 * value,
      0.072 + 0.928 * value,
    ]);
  }
  multiply(matrix: number[]) {
    const newR = this.clamp(this.r * matrix[0] + this.g * matrix[1] + this.b * matrix[2]);
    const newG = this.clamp(this.r * matrix[3] + this.g * matrix[4] + this.b * matrix[5]);
    const newB = this.clamp(this.r * matrix[6] + this.g * matrix[7] + this.b * matrix[8]);
    this.r = newR;
    this.g = newG;
    this.b = newB;
  }
  brightness(value = 1) {
    this.linear(value);
  }
  contrast(value = 1) {
    this.linear(value, -(0.5 * value) + 0.5);
  }
  linear(slope = 1, intercept = 0) {
    this.r = this.clamp(this.r * slope + intercept * 255);
    this.g = this.clamp(this.g * slope + intercept * 255);
    this.b = this.clamp(this.b * slope + intercept * 255);
  }
  invert(value = 1) {
    this.r = this.clamp((value + (this.r / 255) * (1 - 2 * value)) * 255);
    this.g = this.clamp((value + (this.g / 255) * (1 - 2 * value)) * 255);
    this.b = this.clamp((value + (this.b / 255) * (1 - 2 * value)) * 255);
  }
  hsl() {
    const r = this.r / 255;
    const g = this.g / 255;
    const b = this.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h /= 6;
    }
    return { h: h * 100, s: s * 100, l: l * 100 };
  }
  clamp(value: number) {
    if (value > 255) value = 255;
    else if (value < 0) value = 0;
    return value;
  }
}

class Solver {
  target: Color;
  targetHSL: { h: number; s: number; l: number };
  reusedColor: Color;
  rng: () => number;
  constructor(target: Color, rng: () => number) {
    this.target = target;
    this.targetHSL = target.hsl();
    this.reusedColor = new Color(0, 0, 0);
    this.rng = rng;
  }
  solve() {
    const result = this.solveNarrow(this.solveWide());
    return this.css(result.values);
  }
  solveWide() {
    const A = 5;
    const c = 15;
    const a = [60, 180, 18000, 600, 1.2, 1.2];
    let best: { loss: number; values: number[] } = { loss: Infinity, values: [] };
    for (let i = 0; best.loss > 25 && i < 3; i++) {
      const initial = [50, 20, 3750, 50, 100, 100];
      const result = this.spsa(A, a, c, initial, 1000);
      if (result.loss < best.loss) best = result;
    }
    return best;
  }
  solveNarrow(wide: { loss: number; values: number[] }) {
    const A = wide.loss;
    const c = 2;
    const A1 = A + 1;
    const a = [0.25 * A1, 0.25 * A1, A1, 0.25 * A1, 0.2 * A1, 0.2 * A1];
    return this.spsa(A, a, c, wide.values, 500);
  }
  spsa(A: number, a: number[], c: number, values: number[], iters: number) {
    const alpha = 1;
    const gamma = 0.16666666666666666;
    let best: number[] | null = null;
    let bestLoss = Infinity;
    const deltas = new Array(6);
    const highArgs = new Array(6);
    const lowArgs = new Array(6);
    for (let k = 0; k < iters; k++) {
      const ck = c / Math.pow(k + 1, gamma);
      for (let i = 0; i < 6; i++) {
        deltas[i] = this.rng() > 0.5 ? 1 : -1;
        highArgs[i] = values[i] + ck * deltas[i];
        lowArgs[i] = values[i] - ck * deltas[i];
      }
      const lossDiff = this.loss(highArgs) - this.loss(lowArgs);
      for (let i = 0; i < 6; i++) {
        const g = (lossDiff / (2 * ck)) * deltas[i];
        const ak = a[i] / Math.pow(A + k + 1, alpha);
        values[i] = fix(values[i] - ak * g, i);
      }
      const loss = this.loss(values);
      if (loss < bestLoss) {
        best = values.slice(0);
        bestLoss = loss;
      }
    }
    return { values: best as number[], loss: bestLoss };

    function fix(value: number, idx: number) {
      let max = 100;
      if (idx === 2) max = 7500;
      else if (idx === 4 || idx === 5) max = 200;
      if (idx === 3) {
        if (value > max) value %= max;
        else if (value < 0) value = max + (value % max);
      } else if (value < 0) value = 0;
      else if (value > max) value = max;
      return value;
    }
  }
  loss(filters: number[]) {
    const color = this.reusedColor;
    color.set(0, 0, 0);
    color.invert(filters[0] / 100);
    color.sepia(filters[1] / 100);
    color.saturate(filters[2] / 100);
    color.hueRotate(filters[3] * 3.6);
    color.brightness(filters[4] / 100);
    color.contrast(filters[5] / 100);
    const colorHSL = color.hsl();
    return (
      Math.abs(color.r - this.target.r) +
      Math.abs(color.g - this.target.g) +
      Math.abs(color.b - this.target.b) +
      Math.abs(colorHSL.h - this.targetHSL.h) +
      Math.abs(colorHSL.s - this.targetHSL.s) +
      Math.abs(colorHSL.l - this.targetHSL.l)
    );
  }
  css(filters: number[]) {
    const fmt = (idx: number, multiplier = 1) =>
      Math.round(filters[idx] * multiplier);
    return (
      `brightness(0) saturate(100%) ` +
      `invert(${fmt(0)}%) sepia(${fmt(1)}%) saturate(${fmt(2)}%) ` +
      `hue-rotate(${fmt(3, 3.6)}deg) brightness(${fmt(4)}%) contrast(${fmt(5)}%)`
    );
  }
}

function hexToRgb(hex: string): RGB | null {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return null;
  const num = parseInt(h, 16);
  if (Number.isNaN(num)) return null;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

const filterCache = new Map<string, string>();

/**
 * CSS `filter` value that recolours a monochrome (black/white) source image to
 * `hex`. Memoised per colour. Returns null for an unparseable colour.
 */
export function hexToCssFilter(hex: string): string | null {
  if (!hex) return null;
  const cached = filterCache.get(hex);
  if (cached !== undefined) return cached;
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return null;
  }
  // Seed the PRNG from the colour so the solve is identical on server/client.
  const seed = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  const solver = new Solver(new Color(rgb[0], rgb[1], rgb[2]), makeRng(seed));
  const filter = solver.solve();
  filterCache.set(hex, filter);
  return filter;
}
