/**
 * LA SIGNATURE — le son d'un badge débloqué.
 *
 * ── CE QU'ON CHERCHE, ET CE QU'ON A JETÉ ─────────────────────────────────────
 * Un arpège de cloches montant (la première version) : cinq notes, presque une
 * seconde, qui ANNONCENT au lieu de conclure. Ça sonnait comme une notification
 * bancaire, et surtout ça occupait tout le premier temps de l'animation en
 * racontant sa propre petite histoire pendant que le jeton racontait la sienne.
 *
 * La règle qui en sort : **un son de récompense se referme, il ne s'ouvre pas.**
 * Une attaque, puis une queue qui s'éteint. Pas une phrase.
 *
 * ── LE MOTIF, EN DEUX GESTES ─────────────────────────────────────────────────
 *   1. UN SOUFFLE. Du bruit passé dans un passe-bande qui monte de 600 Hz à
 *      4 kHz en 150 ms. Il ne porte aucune note : il prépare l'oreille, comme
 *      la gerbe d'étincelles prépare l'œil, et il est ce qui rend le son
 *      reconnaissable sans être bruyant — personne d'autre ne commence comme ça.
 *   2. UNE QUINTE JUSTE, les deux notes FRAPPÉES ENSEMBLE. C'est l'intervalle le
 *      plus stable qui existe : il ne pose pas de question, donc il conclut. Un
 *      seul événement, pas une mélodie — c'est ce qui le garde discret.
 *
 * La queue est longue (1,6 s) et très basse : on l'entend s'éteindre sous le
 * texte au lieu de couper net. C'est là que passe l'essentiel du caractère.
 *
 * ── CE QUE LA RARETÉ CHANGE ──────────────────────────────────────────────────
 * Elle n'ajoute PAS de notes — ce serait retomber dans l'arpège. Elle ouvre
 * l'accord vers le haut (l'octave, puis la neuvième) et allonge la queue. Un
 * mythique est le même son, plus large et plus long : on le reconnaît avant de
 * savoir ce qu'on a gagné.
 *
 * ── POURQUOI PAS UN .mp3 ─────────────────────────────────────────────────────
 * Un fichier, c'est un asset dans `public/`, une requête, du quota de
 * déploiement (cf. CLAUDE.md), et un son figé qu'il faudrait décliner en six
 * versions. Trente lignes de WebAudio font la même chose, pèsent zéro octet
 * réseau, et la déclinaison par rareté n'est qu'un tableau.
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

/** La fondamentale : un la4. Assez haut pour passer au-dessus d'une bande-son
 *  d'épisode, assez bas pour ne pas percer. */
const BASE = 440;

/** Les partiels de l'accord, en rapports de fréquence, et la longueur de la
 *  queue — les deux seules choses que la rareté fait bouger.
 *
 *  1,5 est la quinte juste. 2 est l'octave, 3 la douzième : QUE des rapports
 *  entiers ou simples, c'est-à-dire des notes qui sont déjà dans le spectre de
 *  la fondamentale. C'est pour ça que le mythique ne sonne pas « en plus » mais
 *  « en plus large » — on n'ajoute pas une note, on éclaire une harmonique. */
const ACCORD: Record<Rarity, { r: number[]; queue: number }> = {
  c: { r: [1, 1.5], queue: 1.25 },
  u: { r: [1, 1.5], queue: 1.5 },
  r: { r: [1, 1.5, 2], queue: 1.8 },
  e: { r: [1, 1.5, 2], queue: 2.1 },
  l: { r: [0.5, 1, 1.5, 2], queue: 2.5 },
  m: { r: [0.5, 1, 1.5, 2, 3], queue: 3 },
};

/** Le niveau général. Volontairement bas : le son doit s'entendre par-dessus un
 *  épisode sans jamais le couvrir, et on le reçoit sans l'avoir demandé. */
const NIVEAU = 0.13;

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
 * Une voix de l'accord : la note, plus son partiel à la douzième, très en
 * retrait — c'est lui qui donne le « verre » plutôt que le « sinus ».
 *
 * L'attaque de 6 ms sépare une cloche d'un clic ; la descente est EXPONENTIELLE
 * parce que l'oreille entend le volume en log, et qu'une descente linéaire
 * s'entend comme une coupure nette à la fin.
 */
function voix(ac: AudioContext, dst: AudioNode, f: number, t: number, g: number, len: number) {
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(g, t + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, t + len);
  env.connect(dst);

  const o = ac.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(f, t);
  /* LA FLORAISON : un huitième de demi-ton au-dessus, qui retombe en 120 ms.
     C'est ce que fait un métal frappé, et c'est le détail qui empêche le son
     d'être « un sinus » — sans lui, il sonne comme une tonalité de test. */
  o.frequency.setValueAtTime(f * 1.008, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.12);
  o.connect(env);
  o.start(t);
  o.stop(t + len + 0.05);

  const h = ac.createGain();
  h.gain.setValueAtTime(0.0001, t);
  h.gain.linearRampToValueAtTime(g * 0.16, t + 0.004);
  h.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.45);
  h.connect(dst);
  const o2 = ac.createOscillator();
  o2.type = "triangle";
  o2.frequency.setValueAtTime(f * 3, t);
  o2.connect(h);
  o2.start(t);
  o2.stop(t + len * 0.45 + 0.05);
}

/** Le souffle : 150 ms de bruit dans un passe-bande qui monte. Aucune note. */
function souffle(ac: AudioContext, dst: AudioNode, t: number) {
  const n = Math.max(1, Math.floor(ac.sampleRate * 0.2));
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;

  const bp = ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.3;
  bp.frequency.setValueAtTime(600, t);
  bp.frequency.exponentialRampToValueAtTime(4200, t + 0.15);

  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(NIVEAU * 0.5, t + 0.1);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);

  src.connect(bp).connect(env).connect(dst);
  src.start(t);
  src.stop(t + 0.24);
}

/**
 * Joue la signature. Ne jette jamais : appelé depuis un effet de rendu.
 */
export function playBadgeChime(rarity: Rarity): void {
  if (!getBadgeSound()) return;
  const ac = audio();
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume().catch(() => {});

  const { r, queue } = ACCORD[rarity] || ACCORD.c;
  const t0 = ac.currentTime + 0.02;

  try {
    /* Un gain maître, pour que l'accord ne se somme pas en saturation quand il
       compte cinq voix : cinq sinus en phase à 0,13 dépasseraient 0 dB. */
    const maitre = ac.createGain();
    maitre.gain.value = 1 / Math.sqrt(r.length);
    maitre.connect(ac.destination);

    souffle(ac, maitre, t0);
    /* La quinte tombe À LA FIN du souffle, pas après : les deux se chevauchent
       de 20 ms, et c'est ce recouvrement qui en fait un seul geste au lieu de
       deux événements qui se suivent. */
    const frappe = t0 + 0.13;
    r.forEach((mult, i) => {
      /* Les voix aiguës sont plus discrètes ET s'éteignent plus vite : c'est ce
         que fait un vrai métal, et ça évite que le haut du spectre s'empile. */
      voix(ac, maitre, BASE * mult, frappe, NIVEAU / (1 + i * 0.55), queue / (1 + i * 0.3));
    });
  } catch {
    /* Contexte fermé entre-temps, quota d'oscillateurs : tant pis, pas de son. */
  }
}
