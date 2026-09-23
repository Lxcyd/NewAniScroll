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

/**
 * ── LA TEXTURE : L'AMÉTHYSTE DE MINECRAFT ────────────────────────────────────
 * La fanfare était juste dans sa FORME (montante, brève, résolue) et fausse
 * dans sa MATIÈRE : attaque de 4 ms, partiel à la douzième bien présent, et un
 * éclat de bruit blanc sur la résolution. Ça donne un métal frappé — net, dur,
 * qui perce. Ce qu'on veut est le geyser d'améthyste : du VERRE. Quatre
 * réglages, et c'est tout ce qui sépare les deux :
 *
 *   - L'ATTAQUE passe de 4 à 30 ms. C'est le réglage principal. Une attaque
 *     courte s'entend comme un coup ; une attaque qui met trente millisecondes
 *     à s'établir s'entend comme un objet qui RÉSONNE. En dessous de ~20 ms
 *     l'oreille entend un transitoire, au-dessus elle entend un timbre.
 *   - LE BATTEMENT. Chaque note est doublée à ±6 centièmes de demi-ton. Deux
 *     sinus si proches se battent lentement (moins d'un hertz), et ce battement
 *     est exactement le miroitement du cristal. C'est ce qui remplace le grain
 *     que le bruit blanc apportait, sans sa dureté.
 *   - LE PARTIEL descend de la douzième (×3, brillante et tendue) à l'octave
 *     (×2, qui se fond dans la fondamentale) et son niveau tombe de 20 % à 9 %.
 *   - UN PASSE-BAS À 3,2 kHz sur tout, qui coupe ce qui pique.
 *
 * L'éclat de bruit blanc est SUPPRIMÉ : c'était le seul élément vraiment dur de
 * la chaîne, et il tombait sur la note qu'on veut laisser respirer.
 */

/** La5. Le grave de la figure — et déjà dans l'octave « brillante ». */
const BASE = 880;

/** L'attaque. Trente millisecondes : au-dessus du seuil où l'oreille entend un
 *  transitoire, donc on entend un timbre qui s'installe et pas un coup. */
const ATTAQUE = 0.03;
/** Le désaccord du doublage, en rapport de fréquence (±6 centièmes). Il produit
 *  un battement sous le hertz — le miroitement, pas un chorus. */
const BATTEMENT = 1.0035;

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

/** L'écart entre deux notes de l'élan.
 *
 *  Remonté de 52 à 72 ms EN MÊME TEMPS que l'attaque s'allongeait, et les deux
 *  vont ensemble : une attaque de 30 ms mange la moitié d'un pas de 52, donc
 *  les notes se chevauchaient en bouillie au lieu de monter. On reste sous le
 *  seuil où l'oreille entendrait une mélodie plutôt qu'un geste. */
const PAS = 0.072;
/** La durée des notes de l'élan. Rallongée aussi : des notes sèches sous une
 *  attaque douce ne sonnent pas, elles cliquent. */
const BREF = 0.55;
/** Le niveau général. Baissé avec le reste : le son doit se remarquer sans
 *  jamais couvrir ce qu'on écoutait, et on le reçoit sans l'avoir demandé. */
const NIVEAU = 0.115;

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
 * Une voix : une sinusoïde et son octave, dans une enveloppe douce.
 *
 * La descente reste EXPONENTIELLE parce que l'oreille entend le volume en log —
 * une descente linéaire s'entend comme une coupure nette à la fin. C'est la
 * MONTÉE qui a changé : linéaire sur 30 ms au lieu de 4.
 */
function voix(ac: AudioContext, dst: AudioNode, f: number, t: number, g: number, len: number) {
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(g, t + ATTAQUE);
  env.gain.exponentialRampToValueAtTime(0.0001, t + len);
  env.connect(dst);

  const o = ac.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(f, t);
  o.connect(env);
  o.start(t);
  o.stop(t + len + 0.05);

  /* L'octave, très en retrait : elle donne du corps sans ajouter de brillance.
     C'est elle qui a remplacé la douzième — trois fois la fondamentale est un
     intervalle tendu, deux fois se confond avec elle. */
  const h = ac.createGain();
  h.gain.setValueAtTime(0.0001, t);
  h.gain.linearRampToValueAtTime(g * 0.09, t + ATTAQUE * 1.4);
  h.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.6);
  h.connect(dst);
  const o2 = ac.createOscillator();
  o2.type = "sine";
  o2.frequency.setValueAtTime(f * 2, t);
  o2.connect(h);
  o2.start(t);
  o2.stop(t + len * 0.6 + 0.05);
}

/**
 * Une note = deux voix désaccordées de part et d'autre de la hauteur juste.
 *
 * C'est TOUT le miroitement. Deux sinus à 6 centièmes d'écart se battent à
 * moins d'un hertz : le son ondule au lieu de rester plat, sans qu'on puisse
 * désigner ce qui bouge. Une seule voix sonne comme un générateur de test ; un
 * désaccord plus large sonnerait comme un chorus des années 80.
 */
function note(ac: AudioContext, dst: AudioNode, f: number, t: number, g: number, len: number) {
  voix(ac, dst, f * BATTEMENT, t, g * 0.5, len);
  voix(ac, dst, f / BATTEMENT, t, g * 0.5, len);
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
       tenue, et douze sinus (six notes × deux voix) dépasseraient 0 dB. */
    const maitre = ac.createGain();
    maitre.gain.value = 0.72;

    /* LE PASSE-BAS, ET IL EST SUR TOUT. Il coupe ce qui pique au-dessus de
       3,2 kHz — c'est-à-dire la zone où un synthé sonne « numérique » et où le
       verre, lui, n'a rien. La pente douce (Q bas) évite la résonance à la
       coupure, qui s'entendrait comme un sifflement. */
    const doux = ac.createBiquadFilter();
    doux.type = "lowpass";
    doux.frequency.value = 3200;
    doux.Q.value = 0.6;
    maitre.connect(doux).connect(ac.destination);

    const fin = degres.length - 1;
    degres.forEach((mult, i) => {
      const t = t0 + i * PAS;
      const dernier = i === fin;
      /* L'élan MONTE aussi en volume vers sa résolution : chaque note est un
         peu plus forte que la précédente, et la tenue est la plus forte de
         toutes. Un élan à volume constant s'entend comme une gamme. */
      const g = NIVEAU * (0.5 + (0.5 * i) / Math.max(1, fin)) * (dernier ? 1.15 : 1);
      note(ac, maitre, BASE * mult, t, g, dernier ? tenue : BREF);
    });
  } catch {
    /* Contexte fermé entre-temps, quota d'oscillateurs : tant pis, pas de son. */
  }
}
