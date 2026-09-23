/**
 * LA FANFARE — le son d'un badge débloqué.
 *
 * ── J'AVAIS RAISONNÉ À L'ENVERS, ET C'EST LA LEÇON DE CE FICHIER ─────────────
 * Version 1 : un arpège montant de cinq cloches, jugé trop long et trop
 * bavard. Version 2 : un souffle qui se résout en une quinte frappée d'un
 * coup, sur la règle « un son de récompense se REFERME, il ne s'ouvre pas ».
 * Cette règle était inventée, et fausse.
 *
 * La convention du genre — Zelda (item get), Xbox, PlayStation, Mario 1-UP,
 * Celeste — est exactement l'inverse : **une figure MONTANTE, consonante et
 * brève**. Un contour de hauteur qui monte est ce que l'oreille lit comme
 * « quelque chose s'est amélioré » ; un accord qui se pose est ce qu'elle lit
 * comme « quelque chose s'est terminé ». La v2 sonnait donc comme une notification
 * ambiante, pas comme une récompense — ce qui est très exactement le reproche
 * qu'on lui a fait.
 *
 * Les trois paramètres qui séparent une fanfare d'une notification bancaire ne
 * sont PAS « monte ou descend ». Ce sont :
 *
 *   1. LA VITESSE. 52 ms entre les notes, pas 78. À cette cadence, l'oreille
 *      entend UN geste ; à 78 ms elle entend une petite mélodie, et une mélodie
 *      raconte quelque chose, donc elle prend du temps. C'est ici que la v1
 *      péchait, pas dans sa direction.
 *   2. LE REGISTRE. On part du la5 (880 Hz), pas du do4. Le haut du spectre est
 *      ce que l'oreille associe au positif, et c'est aussi la seule bande qui
 *      passe au-dessus d'une bande-son d'épisode sans avoir à monter le volume.
 *   3. LA RÉSOLUTION TENUE. Les trois premières notes sont courtes et sèches,
 *      la QUATRIÈME sonne trois fois plus longtemps. C'est elle la récompense —
 *      les trois autres ne sont que l'élan qui y mène. La v1 finissait sur une
 *      basse qui « posait » l'arpège : elle éteignait justement ce qu'il fallait
 *      laisser sonner.
 *
 * Le motif est donc un accord parfait majeur monté en trois temps, résolu sur
 * l'octave tenue. Trois notes qui montent et une qui reste : ~170 ms d'élan,
 * puis la traîne.
 *
 * ── CE QUE LA RARETÉ CHANGE ──────────────────────────────────────────────────
 * Elle prolonge l'ascension d'un ou deux degrés (la neuvième, puis la onzième —
 * toujours dans l'accord, donc jamais faux) et allonge la tenue finale. Un
 * mythique monte plus haut et sonne plus longtemps : c'est la même phrase, plus
 * ample. Un commun s'arrête à la tierce.
 *
 * ── POURQUOI PAS UN .mp3 ─────────────────────────────────────────────────────
 * Un fichier, c'est un asset dans `public/`, une requête, du quota de
 * déploiement (cf. CLAUDE.md), et un son figé qu'il faudrait décliner en six
 * versions. La déclinaison par rareté n'est ici qu'un tableau de degrés.
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
import { getBadgeSound } from "@/lib/prefs/badgePrefs";

/** La5. Le grave de la figure — et déjà dans l'octave « brillante ». */
const BASE = 880;

/**
 * Les degrés de l'ascension, en rapports de fréquence sur la fondamentale.
 *
 * QUE des intervalles de l'accord parfait majeur : tierce majeure (5/4),
 * quinte juste (3/2), octave (2), neuvième (9/4), onzième (8/3). Aucune note ne
 * peut sonner faux contre une autre, ce qui compte quand deux badges tombent à
 * une seconde d'écart et que leurs traînes se superposent.
 *
 * La DERNIÈRE de chaque liste est la note tenue. Les autres sont l'élan.
 */
const MONTEE: Record<Rarity, number[]> = {
  c: [1, 1.25, 1.5],                  // la · do♯ · mi
  u: [1, 1.25, 1.5, 2],               // + la (octave)
  r: [1, 1.25, 1.5, 2],
  e: [1, 1.25, 1.5, 2, 2.25],         // + si
  l: [1, 1.25, 1.5, 2, 2.25],
  m: [1, 1.25, 1.5, 2, 2.25, 2.667],  // + ré
};

/** Combien de temps la note finale sonne, par rareté. */
const TENUE: Record<Rarity, number> = {
  c: 0.9, u: 1.1, r: 1.35, e: 1.6, l: 1.9, m: 2.3,
};

/** L'écart entre deux notes de l'élan. Sous ~60 ms, l'oreille entend UN geste
 *  et non une mélodie — c'est tout le réglage de ce fichier. */
const PAS = 0.052;
/** La durée des notes de l'élan : courtes et sèches, elles ne doivent pas
 *  masquer la tenue finale. */
const BREF = 0.34;
/** Le niveau général. Volontairement bas : on reçoit ce son sans l'avoir
 *  demandé, et il doit passer au-dessus d'un épisode sans le couvrir. */
const NIVEAU = 0.15;

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
 * Une note : une sinusoïde et son partiel à la douzième, dans une enveloppe
 * percussive.
 *
 * L'attaque de 4 ms sépare une cloche d'un clic. La descente est EXPONENTIELLE
 * parce que l'oreille entend le volume en log — une descente linéaire s'entend
 * comme une coupure nette à la fin.
 *
 * La FLORAISON (un huitième de demi-ton au-dessus, qui retombe en 90 ms) est le
 * détail qui empêche le son d'être « un sinus » : c'est ce que fait un métal
 * frappé, et sans elle la figure sonne comme une tonalité de test.
 */
function note(ac: AudioContext, dst: AudioNode, f: number, t: number, g: number, len: number) {
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(g, t + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, t + len);
  env.connect(dst);

  const o = ac.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(f * 1.008, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.09);
  o.connect(env);
  o.start(t);
  o.stop(t + len + 0.05);

  const h = ac.createGain();
  h.gain.setValueAtTime(0.0001, t);
  h.gain.linearRampToValueAtTime(g * 0.2, t + 0.003);
  h.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.4);
  h.connect(dst);
  const o2 = ac.createOscillator();
  o2.type = "triangle";
  o2.frequency.setValueAtTime(f * 3, t);
  o2.connect(h);
  o2.start(t);
  o2.stop(t + len * 0.4 + 0.05);
}

/**
 * L'éclat, sur la note tenue seulement : 90 ms de bruit très aigu et très
 * discret.
 *
 * Il ne porte aucune hauteur et on ne l'entend pas comme un son séparé — il
 * ajoute du grain là où la figure se pose, exactement comme les étincelles
 * ajoutent du grain autour du jeton. C'est le peu qui empêche la fanfare de
 * sonner « synthétisée ».
 */
function eclat(ac: AudioContext, dst: AudioNode, t: number) {
  const n = Math.max(1, Math.floor(ac.sampleRate * 0.14));
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;

  const hp = ac.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 5200;

  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(NIVEAU * 0.3, t + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

  src.connect(hp).connect(env).connect(dst);
  src.start(t);
  src.stop(t + 0.18);
}

/**
 * Joue la fanfare. Ne jette jamais : appelé depuis un effet de rendu.
 */
export function playBadgeChime(rarity: Rarity): void {
  if (!getBadgeSound()) return;
  const ac = audio();
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume().catch(() => {});

  const degres = MONTEE[rarity] || MONTEE.c;
  const tenue = TENUE[rarity] ?? TENUE.c;
  const t0 = ac.currentTime + 0.02;

  try {
    /* Un gain maître : les traînes des notes de l'élan se superposent à la
       tenue, et six sinus en phase dépasseraient 0 dB. */
    const maitre = ac.createGain();
    maitre.gain.value = 0.72;
    maitre.connect(ac.destination);

    const fin = degres.length - 1;
    degres.forEach((mult, i) => {
      const t = t0 + i * PAS;
      const dernier = i === fin;
      /* L'élan MONTE aussi en volume vers sa résolution : chaque note est un
         peu plus forte que la précédente, et la tenue est la plus forte de
         toutes. Un élan à volume constant s'entend comme une gamme. */
      const g = NIVEAU * (0.5 + (0.5 * i) / Math.max(1, fin)) * (dernier ? 1.15 : 1);
      note(ac, maitre, BASE * mult, t, g, dernier ? tenue : BREF);
      if (dernier) eclat(ac, maitre, t);
    });
  } catch {
    /* Contexte fermé entre-temps, quota d'oscillateurs : tant pis, pas de son. */
  }
}
