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
 * Ce qui sépare une fanfare d'une notification bancaire n'est donc PAS « monte
 * ou descend ». Ce sont deux choses :
 *
 *   1. LA VITESSE. Le pas entre les notes doit rester juste au-dessus du temps
 *      qu'une note met à s'établir, et juste en dessous du seuil où l'oreille
 *      entend une mélodie plutôt qu'un geste. Il a donc été remonté deux fois
 *      en suivant les autres réglages (52 → 72 → 88 ms), et jamais par goût :
 *      chaque fois qu'on a allongé l'attaque ou descendu le registre, les notes
 *      se sont mises à se chevaucher.
 *   2. LA RÉSOLUTION TENUE. Les premières notes sont brèves, la DERNIÈRE sonne
 *      plusieurs secondes. C'est elle la récompense — les autres ne sont que
 *      l'élan qui y mène. La v1 finissait sur une basse qui « posait » l'arpège :
 *      elle éteignait justement ce qu'il fallait laisser sonner.
 *
 * Le motif est un accord parfait majeur monté en trois temps, résolu sur
 * l'octave tenue, sous laquelle entre un socle de graves.
 *
 * ── CE QUE LA RARETÉ CHANGE ──────────────────────────────────────────────────
 * Trois choses, toutes dans le même sens : elle prolonge l'ascension d'un ou
 * deux degrés (la neuvième, puis la onzième — toujours dans l'accord, donc
 * jamais faux), allonge la tenue finale, et ouvre le socle. Un commun s'arrête
 * à la tierce et n'a AUCUN grave ; un mythique monte plus haut, sonne plus
 * longtemps et pèse. C'est la même phrase, plus ample — pas une autre phrase.
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

/**
 * ── « PLUS ÉPIQUE ET MOINS AIGU » — ET LES DEUX SE RÈGLENT ENSEMBLE ──────────
 * La5 (880 Hz) piquait. On descend d'une octave à LA4, et ce seul changement
 * règle la moitié du reproche : la figure entière se pose dans le registre où
 * une cloche a du corps, au lieu du registre où elle siffle.
 *
 * L'autre moitié — l'ampleur — ne s'obtient PAS en montant le volume. Une
 * fanfare paraît grande parce qu'elle occupe le spectre, pas parce qu'elle est
 * forte. On ajoute donc un SOCLE : deux notes très graves (l'octave et la
 * double octave en dessous de la fondamentale) qui entrent sous la résolution,
 * avec une attaque lente et une traîne longue. On ne les entend pas comme des
 * notes — on les sent comme du poids. C'est ce que fait un orchestre quand les
 * contrebasses entrent sous un accord de cuivres.
 *
 * Le socle entre SOUS LA RÉSOLUTION et pas au début, et c'est délibéré : posé
 * dès la première note, il transformerait l'élan en tapis et écraserait la
 * montée. Il arrive quand la montée a fini son travail.
 */

/** La4. Une octave sous la version précédente. */
const BASE = 440;

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

/** Combien de temps la note finale sonne, par rareté. Allongé avec la descente
 *  d'octave : une note grave a besoin de plus de temps pour s'établir, et c'est
 *  la traîne qui fait l'ampleur. */
const TENUE: Record<Rarity, number> = {
  c: 1.2, u: 1.5, r: 1.9, e: 2.3, l: 2.8, m: 3.4,
};

/** Le poids du socle, par rareté. Zéro sur le commun : un badge courant n'a pas
 *  à faire trembler les murs, et c'est ce qui rend l'entrée des graves
 *  significative quand elle arrive. */
const SOCLE: Record<Rarity, number> = {
  c: 0, u: 0.35, r: 0.6, e: 0.8, l: 1, m: 1.3,
};

/** L'écart entre deux notes de l'élan.
 *
 *  Remonté deux fois, et chaque fois pour la même raison : le pas doit rester
 *  plus long que le temps qu'une note met à s'établir, sinon elles se
 *  chevauchent en bouillie au lieu de monter. 52 → 72 quand l'attaque est
 *  passée à 30 ms ; 72 → 88 quand la figure est descendue d'une octave, parce
 *  qu'une note grave prend plus de temps à se poser qu'une aiguë (il lui faut
 *  plus de cycles pour que l'oreille en lise la hauteur). */
const PAS = 0.088;
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
 * LE SOCLE : l'octave et la double octave sous la fondamentale, très douces et
 * très longues, qui entrent sous la résolution.
 *
 * Attaque de 180 ms — six fois celle des notes. À cette lenteur, le grave ne
 * s'entend pas comme une note qui commence mais comme une masse qui était déjà
 * là : c'est précisément ce qui donne l'ampleur sans donner l'impression qu'on
 * a ajouté quelque chose.
 *
 * Il ne passe PAS par le passe-bas global — il n'a rien au-dessus de 200 Hz à
 * couper — mais il passe par le maître, donc il reste dans l'équilibre.
 */
function socle(ac: AudioContext, dst: AudioNode, t: number, g: number, len: number) {
  if (g <= 0) return;
  for (const [mult, part] of [
    [0.5, 1],
    [0.25, 0.55],
  ] as const) {
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(g * part, t + 0.18);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    env.connect(dst);
    const o = ac.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(BASE * mult, t);
    o.connect(env);
    o.start(t);
    o.stop(t + len + 0.05);
  }
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
       2,6 kHz — c'est-à-dire la zone où un synthé sonne « numérique » et où le
       verre, lui, n'a rien. Descendu de 3,2 avec la figure : la brillance utile
       se mesure en rapport à la fondamentale, pas en hertz absolus. La pente douce (Q bas) évite la résonance à la
       coupure, qui s'entendrait comme un sifflement. */
    const doux = ac.createBiquadFilter();
    doux.type = "lowpass";
    doux.frequency.value = 2600;
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
      /* Les graves entrent un cheveu AVANT la résolution (30 ms), pas avec
         elle : leur attaque dure 180 ms, donc partir en même temps les ferait
         arriver bien après, et on entendrait deux événements au lieu d'un. */
      if (dernier) {
        socle(ac, maitre, t - 0.03, NIVEAU * (SOCLE[rarity] ?? 0), tenue * 1.3);
      }
    });
  } catch {
    /* Contexte fermé entre-temps, quota d'oscillateurs : tant pis, pas de son. */
  }
}
