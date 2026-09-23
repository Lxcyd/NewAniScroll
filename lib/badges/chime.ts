/**
 * Le petit carillon d'un badge débloqué — synthétisé, pas téléchargé.
 *
 * ── POURQUOI PAS UN .mp3 ─────────────────────────────────────────────────────
 * Un fichier audio, c'est un asset de plus dans `public/`, une requête de plus,
 * un octet de plus dans le quota de déploiement (cf. CLAUDE.md), et un son figé
 * qu'il faudrait décliner en six versions pour que le mythique ne sonne pas
 * comme le commun. Quatre oscillateurs et une enveloppe font le même travail en
 * quarante lignes, pèsent zéro octet réseau, et se déclinent gratuitement : la
 * rareté ne change qu'un tableau de fréquences.
 *
 * ── LES DEUX PIÈGES DU NAVIGATEUR ────────────────────────────────────────────
 *   - L'AUTOPLAY. Un `AudioContext` créé hors d'un geste utilisateur naît
 *     `suspended`. On tente un `resume()` et on abandonne en silence : un badge
 *     muet est un défaut mineur, une exception qui remonte dans le rendu ne
 *     l'est pas.
 *   - LE COÛT D'UN CONTEXTE. Les navigateurs en plafonnent le nombre (six sur
 *     certains Safari) et n'en libèrent pas toujours. On en garde donc UN seul,
 *     partagé, créé à la première demande — jamais à l'import, sinon le simple
 *     chargement du module réveillerait la carte son.
 */

import type { Rarity } from "@/lib/badges/catalog";

/** Coupe le son sans toucher au reste. Lu à chaque coup : l'utilisateur peut
 *  le poser depuis la console ou un futur panneau de réglages sans recharger. */
const MUTE_KEY = "aniscroll:badge-sound";

/** L'arpège, par rareté : plus c'est rare, plus ça monte haut et longtemps.
 *  Une pentatonique majeure en Do — aucune note ne peut sonner faux avec une
 *  autre, ce qui compte quand deux badges tombent à une seconde d'écart. */
const NOTES: Record<Rarity, number[]> = {
  c: [523.25, 659.25],                                  // do — mi
  u: [523.25, 659.25, 783.99],                          // + sol
  r: [523.25, 659.25, 783.99, 1046.5],                  // + do aigu
  e: [523.25, 659.25, 783.99, 1046.5, 1174.66],         // + ré
  l: [523.25, 659.25, 783.99, 1046.5, 1318.51],         // + mi aigu
  m: [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98], // + sol aigu
};

/** L'écart entre deux notes. Assez court pour que ça reste un carillon et non
 *  une mélodie : l'arpège doit tenir dans le temps de l'impact visuel. */
const STEP = 78;
const PEAK = 0.16;

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/**
 * Une cloche : deux oscillateurs — la fondamentale et son harmonique douce à
 * la douzième — dans une enveloppe percussive.
 *
 * L'attaque de 8 ms est ce qui fait la différence entre « une cloche » et
 * « un bip » : attaquer à zéro produit un clic, attaquer trop lentement produit
 * une nappe. La descente est EXPONENTIELLE parce que l'oreille entend le volume
 * en log — une descente linéaire s'entend comme une coupure nette à la fin.
 */
function bell(ac: AudioContext, freq: number, at: number, gain: number, len: number) {
  const out = ac.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.linearRampToValueAtTime(gain, at + 0.008);
  out.gain.exponentialRampToValueAtTime(0.0001, at + len);
  out.connect(ac.destination);

  for (const [mult, part, wave] of [
    [1, 1, "sine"],
    [3, 0.22, "triangle"],
  ] as const) {
    const osc = ac.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq * mult, at);
    const g = ac.createGain();
    g.gain.setValueAtTime(part, at);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + len + 0.05);
  }
}

/**
 * Joue le carillon du badge. Ne jette jamais : appelé depuis un effet de rendu.
 */
export function playBadgeChime(rarity: Rarity): void {
  try {
    if (localStorage.getItem(MUTE_KEY) === "off") return;
  } catch {
    /* localStorage refusé (navigation privée, cookies bloqués) : on joue. */
  }
  const ac = audio();
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume().catch(() => {});

  const notes = NOTES[rarity] || NOTES.c;
  const t0 = ac.currentTime + 0.02;
  try {
    notes.forEach((f, i) => {
      /* Les notes s'éteignent de plus en plus vite en montant : c'est ce que
         fait un vrai métal, et ça évite que les aiguës s'empilent en bouillie. */
      bell(ac, f, t0 + (i * STEP) / 1000, PEAK * (1 - i * 0.06), 1.5 - i * 0.14);
    });
    /* La dernière note revient une octave plus bas, longue et discrète : elle
       pose l'arpège au lieu de le laisser suspendu en l'air. */
    bell(ac, notes[0] / 2, t0 + (notes.length * STEP) / 1000, PEAK * 0.5, 2.2);
  } catch {
    /* Contexte fermé entre-temps, quota d'oscillateurs : tant pis, pas de son. */
  }
}
