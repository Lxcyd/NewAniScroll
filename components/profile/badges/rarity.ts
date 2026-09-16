/**
 * Le système visuel des raretés, transposé de la maquette du catalogue.
 *
 * La rareté se lit à TROIS choses à la fois, et c'est voulu : l'épaisseur et la
 * couleur de l'anneau, la couleur de l'icône, et le nombre d'étoiles. Un seul
 * de ces signes suffirait à un œil exercé ; les trois ensemble rendent la
 * hiérarchie lisible d'un coup d'œil sur une page qui en aligne cent.
 *
 * Les valeurs viennent telles quelles de « Catalogue badges AniScroll » — elles
 * ne sont pas à réinventer ici, la maquette EST la référence.
 */

import type { Rarity } from "@/lib/badges/catalog";

export type RarityStyle = {
  /** L'anneau : une couleur pleine pour Common, un dégradé pour les autres. */
  ring: string;
  /** Son épaisseur. C'est le signal le plus fort de la hiérarchie. */
  sw: number;
  /** La couleur de l'icône, et du libellé de rareté sous le badge. */
  ic: string;
  /** Le liseré interne. Vide sur Common : le socle reste nu. */
  inner: string;
  /** Un second liseré, plus profond. Epic et au-delà seulement. */
  deep: string;
  /** La plaque du palier : [fond, couleur du texte]. */
  plaque: [string, string];
  /** Combien d'étoiles scintillent autour du jeton. */
  stars: number;
  /** Largeur du balayage lumineux. 0 = pas de balayage. */
  sweep: number;
  /** Les couleurs des étoiles, une par canal. */
  starColors: string[];
};

export const RARITY: Record<Rarity, RarityStyle> = {
  c: {
    ring: "rgba(154,160,171,.5)", sw: 2, ic: "#9aa0ab", inner: "", deep: "",
    plaque: ["linear-gradient(90deg,#c9ccd2,#7b8290)", "#14141f"], stars: 0, sweep: 0,
    starColors: [],
  },
  u: {
    ring: "url(#asRgUncommon)", sw: 3.4, ic: "#34d399", inner: "rgba(110,231,183,.32)", deep: "",
    plaque: ["linear-gradient(90deg,#6ee7b7,#0d9668)", "#0a1f18"], stars: 0, sweep: 0,
    starColors: [],
  },
  r: {
    ring: "url(#asRgRare)", sw: 4.8, ic: "#7fb0ff", inner: "rgba(191,219,254,.34)", deep: "",
    plaque: ["linear-gradient(90deg,#bfdbfe,#3B82F6)", "#0c1526"], stars: 0, sweep: 0,
    starColors: [],
  },
  e: {
    ring: "url(#asRgEpic)", sw: 6.2, ic: "#d8b4fe", inner: "rgba(243,232,255,.4)",
    deep: "rgba(192,132,252,.2)",
    plaque: ["linear-gradient(90deg,#f3e8ff,#a855f7)", "#150f22"], stars: 1, sweep: 0,
    starColors: ["#d8b4fe"],
  },
  l: {
    ring: "url(#asRgLegendary)", sw: 6.8, ic: "#FFD700", inner: "rgba(255,246,207,.45)",
    deep: "rgba(255,215,0,.18)",
    plaque: ["linear-gradient(90deg,#fff6cf,#FFD700)", "#1c1707"], stars: 2, sweep: 46,
    starColors: ["#fff6cf", "#FFD700", "#ffe680"],
  },
  m: {
    ring: "url(#asRgMythic)", sw: 7.6, ic: "#FFb59a", inner: "rgba(255,199,176,.45)",
    deep: "rgba(233,69,96,.22)",
    plaque: ["linear-gradient(90deg,#FF7F57,#E94560)", "#1c0d13"], stars: 3, sweep: 50,
    starColors: ["#ffc7b0", "#FF7F57", "#fff", "#E94560", "#ffc7b0"],
  },
};

/** L'hexagone. Une seule définition, partagée par le jeton et ses liserés. */
export const HEX =
  "M52 6.04A14 14 0 0 1 66 6.04L101.4 26.46A14 14 0 0 1 108.4 38.58L108.4 79.42A14 14 0 0 1 101.4 91.54L66 111.96A14 14 0 0 1 52 111.96L16.6 91.54A14 14 0 0 1 9.6 79.42L9.6 38.58A14 14 0 0 1 16.6 26.46Z";

/** L'échelle du masque de balayage, par rareté (il doit épouser l'anneau). */
export const CLIP_SCALE: Record<Rarity, number> = {
  c: 1.047, u: 1.06, r: 1.074, e: 1.087, l: 1.093, m: 1.1,
};

/* ── Les constellations ──────────────────────────────────────────────────────
   Chaque jeton a SA propre disposition d'étoiles, tirée au sort — mais
   toujours la même pour un badge donné. Un tirage aléatoire à chaque rendu
   ferait sauter les étoiles d'une position à l'autre à chaque re-rendu de la
   page ; une disposition figée dans le code, elle, donnerait cent jetons
   identiques. Le hasard est donc SEMÉ par l'id du badge : reproductible, et
   différent d'un badge à l'autre.

   Porté tel quel de la maquette, y compris ses garde-fous : rien derrière la
   plaque, jamais deux étoiles superposées, un tempo propre à chaque canal. */

const CX = 59, CY = 52, R_MIN = 30, R_MAX = 45;
const SIZES = [10, 8, 7, 6, 5];
/** Les cycles d'animation disponibles (cf. les keyframes asTw* de globals.css). */
const RATIOS = [14, 17, 20, 23, 26];

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Star = { x: number; y: number; s: number; f: string; anim: string };

export function starsFor(key: string, n: number, colors: string[]): Star[] {
  if (!n || !colors.length) return [];
  let seed = seedOf(key);
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  /** Chaque canal enchaîne trois apparitions, à trois endroits différents. */
  const POS = 3;
  const taken: [number, number][] = [];
  const place = (): [number, number] | null => {
    /* On tente d'abord un écart confortable, puis on se resserre : mieux vaut
       deux étoiles un peu proches qu'une étoile manquante. */
    for (const sep of [22, 18, 14]) {
      for (let g = 0; g < 160; g++) {
        const a = rnd() * Math.PI * 2;
        const down = Math.sin(a);
        if (down > 0.62) continue; // rien derrière la plaque
        const rad = R_MIN + rnd() * (R_MAX - R_MIN) * (1 - 0.25 * Math.abs(Math.cos(a)));
        const x = CX + Math.cos(a) * rad;
        const y = CY + down * rad * 0.94;
        if (taken.some((q) => (q[0] - x) ** 2 + (q[1] - y) ** 2 < sep * sep)) continue;
        taken.push([x, y]);
        return [x, y];
      }
    }
    return null;
  };

  const out: Star[] = [];
  for (let c = 0; c < n; c++) {
    const vis = 1.6 + rnd() * 0.8;   // durée allumée
    const gap = 0.6 + rnd() * 0.9;   // temps mort avant de réapparaître ailleurs
    const want = (100 * vis) / (POS * (vis + gap));
    const ratio = RATIOS.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    const cycle = +((vis * 100) / ratio).toFixed(2);
    const phase = +(rnd() * cycle).toFixed(2);
    const size = +(SIZES[c] - (n === 1 ? 1 : 0) + (rnd() - 0.5) * 1.4).toFixed(1);
    const col = colors[c % colors.length];
    for (let j = 0; j < POS; j++) {
      const p = place();
      if (!p) continue;
      out.push({
        x: +p[0].toFixed(1),
        y: +p[1].toFixed(1),
        s: size,
        f: col,
        anim: `asTw${ratio} ${cycle}s ease-in-out ${+((j * cycle) / POS - phase).toFixed(2)}s infinite`,
      });
    }
  }
  return out;
}
