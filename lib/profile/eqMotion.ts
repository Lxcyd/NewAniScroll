/**
 * LE MOUVEMENT DE L'ÉGALISEUR de la case musique du profil (17/10/2026).
 *
 * Il ne suit pas le son : celui d'une iframe YouTube est hors d'atteinte d'une
 * page (essais du jour dans devlog/site.md). Il IMITE un spectre, calculé à
 * chaque image à partir du temps du lecteur :
 *   - un battement propre au morceau (0,42-0,56 s, ~105-140 BPM), tiré de son
 *     identifiant pour que deux profils ne dansent pas pareil ;
 *   - trois frappes sur ce battement — grosse caisse sur chaque temps, caisse
 *     claire un temps sur deux, charleston au demi-temps — que chaque barre
 *     reçoit selon sa place (basses à gauche, aigus à droite) par des cloches
 *     LARGES : deux voisines se ressemblent sans jamais bouger en bloc ;
 *   - un fond qui baisse vers les aigus, un bruit lent propre à chaque barre,
 *     une énergie qui monte et descend sur ~16 temps (couplet, refrain) ;
 *   - monte vite, retombe doucement, comme un vu-mètre.
 *
 * Remplace des animations CSS par rôle (reprises de pill-player) : vues image
 * par image, les barres d'un même rôle bougeaient d'un bloc et la caisse
 * claire creusait un trou au milieu.
 */

type Bar = {
  kick: number;
  snare: number;
  hat: number;
  tilt: number;
  gain: number;
  f: [number, number, number];
  p: [number, number, number];
  cur: number;
};

export type EqVoice = { beat: number; bars: Bar[]; sectionPhase: number };

export function eqVoice(videoId: string, n: number): EqVoice {
  let h = 2166136261;
  for (let i = 0; i < videoId.length; i++) h = Math.imul(h ^ videoId.charCodeAt(i), 16777619);
  const rnd = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const beat = 0.42 + rnd() * 0.14;
  const bars = Array.from({ length: n }, (_, i): Bar => {
    const x = n === 1 ? 0 : i / (n - 1); // 0 = basses, 1 = aigus
    const bell = (c: number, w: number) => Math.exp(-((x - c) ** 2) / (2 * w * w));
    return {
      kick: bell(0.05, 0.22),
      snare: 0.85 * bell(0.5, 0.2),
      hat: 0.7 * bell(0.95, 0.2),
      tilt: 0.34 - 0.1 * x,
      gain: 0.75 + rnd() * 0.5,
      // Trois sinus de fréquences sans rapport : un bruit qui ne se répète pas.
      f: [1.3 + rnd() * 1.7, 2.9 + rnd() * 2.3, 5.1 + rnd() * 3.1],
      p: [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28],
      cur: 0.2,
    };
  });
  return { beat, bars, sectionPhase: rnd() * 6.28 };
}

const pulse = (since: number, sharp: number) => Math.exp(-since * sharp);
const TAU = Math.PI * 2;

/** Écrit dans `out` la hauteur (0-1) de chaque barre au temps `t` du morceau. */
export function eqLevels(v: EqVoice, t: number, dt: number, out: Float32Array) {
  const b = v.beat;
  const pos = t / b;
  const inBeat = (pos % 1) * b;
  const kick = pulse(inBeat, 9);
  const snare = Math.floor(pos) % 2 === 1 ? pulse(inBeat, 11) : 0;
  const hat = pulse(((pos * 2) % 1) * (b / 2), 14);
  const section = 0.8 + 0.2 * Math.sin((pos / 16) * TAU + v.sectionPhase);
  const up = 1 - Math.exp(-dt * 40);
  const down = 1 - Math.exp(-dt * 9);
  v.bars.forEach((bar, i) => {
    const noise =
      (Math.sin(t * bar.f[0] * TAU + bar.p[0]) +
        0.6 * Math.sin(t * bar.f[1] * TAU + bar.p[1]) +
        0.35 * Math.sin(t * bar.f[2] * TAU + bar.p[2])) /
      1.95;
    const target = Math.min(
      1,
      Math.max(
        0.08,
        (bar.tilt + 0.26 * noise + bar.gain * (1.05 * bar.kick * kick + bar.snare * snare + 0.75 * bar.hat * hat)) *
          section,
      ),
    );
    bar.cur += (target - bar.cur) * (target > bar.cur ? up : down);
    out[i] = bar.cur;
  });
}
