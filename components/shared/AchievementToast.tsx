/**
 * La notification d'un badge débloqué — en haut, au centre, par-dessus tout.
 *
 * ── ELLE NE S'AFFICHE PLUS PAR-DESSUS UN ÉPISODE ─────────────────────────────
 * Elle le faisait, et c'était le comportement demandé au départ : un badge
 * tombe presque toujours pendant un épisode, donc on allait le chercher jusque
 * dans le lecteur en plein écran (portal dans la surface du lecteur pour le
 * plein écran iOS, où la VIDÉO prend l'écran et où plus rien du document n'est
 * visible ; simple z-index au-dessus du 9999 de `.aniscroll-player-fs` sinon).
 *
 * C'est retiré le 23/09/2026 : une gerbe d'étincelles en haut de l'écran
 * pendant qu'on regarde est une interruption, pas une récompense. LE BADGE
 * N'EST PAS PERDU POUR AUTANT — il attend dans la file (lib/badges/
 * achievementStore.ts), la ligne du temps ne démarre pas tant que le lecteur
 * possède l'écran, et elle part toute seule à la sortie du plein écran. C'est
 * pour cela qu'on lit toujours `usePlayerSurface()` : il ne sert plus à choisir
 * OÙ portaler, mais à savoir QUAND se taire.
 *
 * ── LA POSE EST SUSPENDUE AU SURVOL ──────────────────────────────────────────
 * Quatre secondes, c'est assez pour lire trois lignes et trop peu pour regarder
 * le jeton. Le survol met la pose en pause (le temps restant est mémorisé, on
 * ne repart pas de zéro), et la jauge sous le texte s'arrête avec elle — sans
 * quoi l'arrêt ressemblerait à un bug. La croix, elle, déclenche la vraie
 * sortie animée : on ne coupe pas, on abrège.
 *
 * ── POURQUOI UN COMPOSANT À PART ─────────────────────────────────────────────
 * Position, durée, animation et mise en file diffèrent de tout le reste, et une
 * récompense ne doit pas se collapser dans la pile des messages d'erreur. Voir
 * l'en-tête de lib/badges/achievementStore.ts.
 */

import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { BY_ID } from "@/lib/badges/catalog";
import { next, useAchievement } from "@/lib/badges/achievementStore";
import { revealHref } from "@/lib/badges/reveal";
import { useBadgePrefs } from "@/lib/prefs/badgePrefs";
import { usePlayerSurface } from "@/lib/notifications/playerSurface";
import BadgeDefs from "@/components/profile/badges/BadgeDefs";
import BadgeToken from "@/components/profile/badges/BadgeToken";
import { RARITY } from "@/components/profile/badges/rarity";

/* La ligne du temps, en millisecondes. Les mêmes valeurs que les keyframes
   asAch* de globals.css — elles vivent des deux côtés parce que l'une dessine
   et l'autre enchaîne, et elles doivent rester d'accord. */
const IN_MS = 720;      // le jeton surgit
const OPEN_MS = 520;    // la carte s'ouvre
const HOLD_MS = 4200;   // la pose
/* LA SORTIE EN DEUX TEMPS. Le texte s'efface et la carte se referme (le jeton
   revient donc au centre tout seul, puisque le bloc est centré et rétrécit vers
   son milieu) ; ensuite seulement le jeton remonte en rétrécissant, comme il
   est venu. */
const TEXT_OUT_MS = 420;
const OUT_MS = 620;     // le retrait du jeton
/* 336 px tant que le nom faisait 20 px ; il en fait 25 (et la condition 14),
   donc la même phrase demande une ligne plus longue avant de se faire couper
   par l'ellipse. Le total reste sous le `maxWidth` du conteneur : 104 (jeton)
   + 360 − 10 (chevauchement) = 454, pour 470 disponibles. */
const CARD_W = 360;
/** Le côté du jeton dans la notification. Plus gros que dans la liste : il est
 *  seul à l'écran pendant tout le premier temps, c'est lui le spectacle. */
const TOKEN = 104;
const SPARKS = 18;

type Phase = "in" | "open" | "hold" | "textOut" | "out";

type Spark = {
  dx: number; dy: number; fall: number;
  sc: number; delay: number; size: number; square: boolean;
};

/**
 * La gerbe d'éclats, semée une fois par badge pour qu'elle ne saute pas au
 * re-rendu.
 *
 * Trois désordres, et chacun corrige un défaut visible : les ANGLES sont
 * bruités (douze rayons réguliers font une roue de clipart), les DÉPARTS sont
 * décalés (tout partir à la même image fait un seul « pouf » plat), et chaque
 * éclat RETOMBE d'une hauteur qui lui est propre — c'est ce qui donne une
 * gerbe plutôt qu'une explosion symétrique.
 */
function sparks(seed: number, wide = false): Spark[] {
  const out: Spark[] = [];
  let s = seed || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const n = wide ? SPARKS * 2 : SPARKS;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
    const dist = (46 + rnd() * 52) * (wide ? 3.2 : 1);
    out.push({
      dx: Math.cos(a) * dist,
      dy: Math.sin(a) * dist,
      /* La chute est plus forte sur les éclats partis vers le haut : ce sont
         eux qu'on voit retomber, et c'est ce retour qui donne du poids. */
      fall: 22 + rnd() * 46,
      sc: 0.45 + rnd() * 0.9,
      delay: rnd() * 160,
      size: 4 + Math.round(rnd() * 4),
      /* Un éclat sur trois est un carré : deux formes qui tournent lisent
         mieux qu'une pluie de ronds identiques. */
      square: rnd() < 0.34,
    });
  }
  return out;
}

/** Les huit rayons de l'impact, à angles réguliers — eux ont le droit. */
const RAYS = Array.from({ length: 8 }, (_, i) => i * 45);

type Confetto = {
  x: number; delay: number; dur: number; cycles: number;
  sway: number; spin: number; w: number; h: number; col: string;
};

/**
 * LA PLUIE DE CONFETTIS — mythique seulement.
 *
 * Elle tombe SUR TOUTE LA LARGEUR DE L'ÉCRAN et derrière la carte, pas autour
 * du jeton : la gerbe d'étincelles occupe déjà le centre, et y ajouter des
 * confettis ne ferait qu'un tas plus dense au même endroit. Ce qu'on veut dire
 * est « ça déborde de la notification », et pour ça il faut qu'ils tombent là
 * où il n'y a rien.
 *
 * Trois désordres, comme pour la gerbe, et pour la même raison : un départ
 * échelonné (sinon tout tombe en rideau), une durée propre à chacun (sinon ils
 * atterrissent en même temps, ce qu'aucun objet ne fait), et un BALANCEMENT
 * latéral — c'est lui qui distingue un confetti d'une goutte de pluie, parce
 * qu'un rectangle léger ne tombe jamais droit.
 *
 * ── LA PLUIE FINIT AVEC LE BADGE, ET C'EST CALCULÉ, PAS APPROCHÉ ─────────────
 * Elle a d'abord été une salve unique : l'écran se vidait pendant les trois
 * dernières secondes, c'est-à-dire pendant la POSE, le moment où l'on regarde.
 * Puis `infinite`, qui règle ça mais ouvre l'autre bout du défaut : au démontage
 * de la notification, des confettis en pleine chute disparaissent D'UN COUP au
 * milieu de l'écran.
 *
 * On ne veut ni l'un ni l'autre : la pluie doit couvrir toute la ligne du temps
 * ET s'être entièrement écoulée par le bas au moment où le jeton repart. Un
 * nombre entier de cycles ne tombe évidemment pas juste tout seul ; c'est donc
 * la DURÉE qui est recalée sur lui.
 *
 *   fin     = `total` moins un retard propre à chacun, TIRÉ SUR UNE CHUTE
 *             ENTIÈRE (jusqu'à 0,9 × `brut`) — c'est ce qui fait que la pluie
 *             SE TARIT au lieu de s'arrêter net. Il a d'abord valu 700 ms fixes,
 *             et 700 ms sur une chute de 2 à 3 secondes ne sépare rien : les
 *             quarante-six confettis sortaient par le bas dans la même
 *             demi-seconde, ce qui se lit comme une disparition d'un coup — le
 *             rideau qu'on croyait avoir évité, déplacé à l'autre bout. Avec un
 *             retard à l'échelle de la chute, le dernier confetti qui apparaît
 *             en haut touche le bas de l'écran au moment où le jeton repart, et
 *             ceux d'avant s'écoulent échelonnés derrière lui.
 *   cycles  = le nombre entier de chutes le plus proche de la durée tirée.
 *   dur     = (fin − départ) / cycles, donc à quelques pourcents de la durée
 *             tirée, et toujours différente d'un confetti à l'autre.
 *
 * L'arrondi ne change donc la vitesse que de ce qu'il faut pour que la dernière
 * chute se termine à l'heure. Avec `both`, un confetti qui a fini tient sa
 * dernière image : sous l'écran, opacité nulle.
 */
function confetti(seed: number, total: number): Confetto[] {
  const out: Confetto[] = [];
  let s = (seed ^ 0x9e3779b9) >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const cols = ["#ffc7b0", "#FF7F57", "#ffffff", "#E94560", "#ffd9a0"];
  for (let i = 0; i < 46; i++) {
    const brut = 2100 + rnd() * 1600;
    /* ── LE DÉPART EST ÉTALÉ SUR UNE CHUTE ENTIÈRE, ET C'EST CE QUI FAIT UNE
       PLUIE PLUTÔT QUE DES SALVES ──────────────────────────────────────────
       Il l'était sur 900 ms, pour une chute de 2 à 3,7 s. Conséquence : les
       quarante-six confettis partaient tous dans le premier tiers de la
       première chute, donc ils RECOMMENÇAIENT tous ensemble aussi — et on
       voyait deux vagues nettement séparées, chacune suivie d'un trou.

       Le défaut n'est pas dans le nombre de confettis, il est dans leur
       PHASE : une pluie continue demande que les phases soient réparties sur
       tout le cycle, pas groupées dans un coin. Le départ est donc tiré sur
       la durée d'une chute complète, ce qui répartit les départs ET tous les
       recommencements qui en découlent. Le prix est un début plus progressif
       qu'un rideau simultané — et c'est mieux : la gerbe d'étincelles occupe
       déjà l'instant de l'impact. */
    const delay = rnd() * brut;
    /* Le `max` n'est pas décoratif : une pose abrégée (la croix, Échap) peut
       rendre `total` plus court qu'une seule chute, et une durée négative
       ferait disparaître la pluie au lieu de l'accélérer. */
    const fin = Math.max(brut * 0.6, total - rnd() * brut * 0.9 - delay);
    const cycles = Math.max(1, Math.round(fin / brut));
    out.push({
      x: rnd() * 100,
      delay,
      dur: fin / cycles,
      cycles,
      sway: (rnd() - 0.5) * 120,
      spin: 360 + rnd() * 900,
      w: 5 + Math.round(rnd() * 5),
      h: 8 + Math.round(rnd() * 8),
      col: cols[Math.floor(rnd() * cols.length)],
    });
  }
  return out;
}

/**
 * L'entrée d'une ligne de texte, décalée de `delay`.
 *
 * `"none"` tant que la carte n'est pas ouverte : le style de repli du CSS
 * (`.as-ach-line` sans animation) laisse la ligne visible, et c'est voulu —
 * elle est de toute façon derrière une carte de largeur nulle, et un
 * `opacity: 0` en dur laisserait le texte invisible si l'animation ne partait
 * jamais (onglet en arrière-plan, animations coupées par le système).
 */
function line(phase: Phase, delay: number): string {
  if (phase === "in" || phase === "out") return "none";
  /* À la sortie les lignes partent DANS L'ORDRE INVERSE : la condition d'abord,
     le nom en dernier — on quitte le texte par où on ne lisait plus. */
  if (phase === "textOut") {
    return `asAchLineOut 240ms ease-in ${Math.max(0, 175 - delay)}ms both`;
  }
  return `asAchLine 380ms cubic-bezier(.22,1,.36,1) ${delay}ms both`;
}

export default function AchievementToast() {
  const ach = useAchievement();
  const surface = usePlayerSurface();
  const { fx } = useBadgePrefs();
  const router = useRouter();
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("in");
  /** Vrai tant que la souris (ou le clavier) tient la notification. */
  const [held, setHeld] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** Ce qui reste de la pose. Décrémenté à chaque suspension — c'est ce qui
   *  distingue une VRAIE pause d'un compte à rebours relancé à zéro. */
  const left = useRef(HOLD_MS);
  const def = ach ? BY_ID[ach.id] : null;

  /* Le lecteur possède l'écran : on ne montre rien et on ne démarre rien. Le
     badge reste en tête de file et partira à la sortie du plein écran. */
  const muted = surface.active;

  /** ── LE MYTHIQUE A DROIT À PLUS, ET LE PLUS EST DU TEMPS ───────────────────
   *  Six raretés, et jusqu'ici seul le NOMBRE D'ÉTOILES du jeton les
   *  distinguait côté animation : un mythique arrivait exactement comme un
   *  commun, à la même vitesse, avec la même gerbe. Le facteur ci-dessous
   *  étire toute la ligne du temps — l'arrivée, l'ouverture, la sortie. C'est
   *  le ralenti le moins cher qui existe : aucune image de plus à peindre,
   *  juste les mêmes courbes lues plus lentement. */
  const slow = fx && def?.rarity === "m" ? 1.3 : 1;
  const inMs = Math.round(IN_MS * slow);
  const openMs = Math.round(OPEN_MS * slow);
  const outMs = Math.round(OUT_MS * slow);

  /* La ligne du temps est relancée à chaque badge (`ach.key` change même si
     c'est le même id), et TOUS les minuteurs sont annulés au démontage :
     laisser tourner un `setTimeout` qui appelle `next()` après un changement de
     page ferait défiler la file dans le vide. */
  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (!ach || muted) return;
    setPhase("in");
    setHeld(false);
    left.current = HOLD_MS;
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    at(inMs, () => setPhase("open"));
    at(inMs + openMs, () => setPhase("hold"));
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [ach?.key, ach, muted, inMs, openMs]);

  /* ── IL N'Y A PLUS DE SON, ET C'EST UN ABANDON, PAS UN OUBLI ───────────────
     Un carillon partait ici, 260 ms après le montage, pour tomber sur l'impact
     du jeton. Il a été refait cinq fois — arpège de cloches, souffle résolu en
     quinte, fanfare montante, descente d'octave, retrait de la basse — puis
     deux bancs d'essai de vingt et vingt-quatre variantes. Aucune n'a convaincu.

     Le son est donc RETIRÉ, avec son module (`lib/badges/chime.ts`), son
     interrupteur et ses traductions. Ce qu'on retient : un son de récompense
     n'est pas un problème de réglages — toutes ces versions étaient justes dans
     leur forme (montante, consonante, brève, comme le genre le fait) et le
     reproche portait à chaque fois ailleurs. Une notification qu'on reçoit sans
     l'avoir demandée n'a peut-être simplement pas sa place dans le son d'un site
     où l'on est déjà en train d'écouter un épisode.

     Le badge garde toute sa fête visuelle, et l'interrupteur « animation »
     reste le vrai correctif à `prefers-reduced-motion`. */

  /**
   * LA POSE, ET ELLE SEULE EST SUSPENDABLE.
   *
   * Le nettoyage de cet effet fait double emploi, et c'est voulu : il annule le
   * minuteur ET retranche le temps déjà écoulé. Il tourne aussi bien quand la
   * souris arrive (suspension) que quand la pose s'achève (`left` n'est alors
   * plus lu) — une seule branche à écrire, aucune date à tenir ailleurs.
   */
  useEffect(() => {
    if (phase !== "hold" || held) return;
    const from = Date.now();
    const t = setTimeout(() => setPhase("textOut"), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (Date.now() - from));
    };
  }, [phase, held]);

  /* ── LA SORTIE, EN DEUX EFFETS, ET IL EN FAUT DEUX ─────────────────────────
     Ces deux transitions ont tenu dans UN SEUL effet, et c'était un bug : il
     posait deux minuteurs (passer à « out », puis appeler `next()`) et dépendait
     de `phase`. Le premier minuteur changeait justement `phase` — donc React
     nettoyait l'effet, donc il ANNULAIT LE SECOND. `next()` n'était jamais
     appelé, `current` restait occupé à vie, et tous les badges suivants
     s'empilaient dans une file qui n'avançait plus.

     Ça ne se voyait pas sur un vrai badge (on n'en gagne pas deux dans la
     minute) mais le bouton de test le montrait au deuxième clic : le premier
     s'affichait, plus jamais rien.

     La règle qui en sort : **un effet ne pose pas un minuteur qui survivra au
     changement d'état qu'un autre de ses minuteurs provoque.** Un effet par
     transition, chacun déclenché par la phase qu'il quitte. */
  useEffect(() => {
    if (phase !== "textOut") return;
    const t = setTimeout(() => setPhase("out"), TEXT_OUT_MS);
    return () => clearTimeout(t);
  }, [phase]);

  /* Le jeton est parti : on passe au badge suivant de la file. */
  useEffect(() => {
    if (phase !== "out") return;
    const t = setTimeout(next, outMs);
    return () => clearTimeout(t);
  }, [phase, outMs]);

  /* ── LE VOL VERS L'AVATAR A ÉTÉ RETIRÉ (23/09) ─────────────────────────────
     Le jeton filait vers l'avatar de la navbar en fin de sortie, pour que la
     récompense ait une destination. Retiré à la demande : voir passer le badge
     à travers la page tire l'œil vers un coin au moment précis où il n'y a plus
     rien à y voir, et le geste raconte « ça s'en va » alors qu'on voulait « ça
     se range ». Le jeton repart donc par le haut, comme il est venu.

     La pastille des non-vus qui devait lui survivre sur l'avatar a ete retiree
     dans la foulee, et son registre avec. */

  /** Abréger : on saute à la sortie, animation comprise. Depuis l'arrivée comme
   *  depuis la pose — on peut congédier un badge avant même de l'avoir lu. */
  const dismiss = useCallback(() => {
    setPhase((p) => (p === "textOut" || p === "out" ? p : "textOut"));
  }, []);

  /**
   * LE CLIC MÈNE QUELQUE PART. L'animation appelait déjà le geste — un jeton
   * qui surgit au centre de l'écran avec son nom se clique — et il ne menait
   * nulle part.
   *
   * On abrège AVANT de naviguer plutôt qu'après : la notification vit sur
   * `document.body` et survit donc au changement de page, ce qui la laisserait
   * finir sa pose par-dessus la destination pendant qu'on la lit. `dismiss()`
   * joue la sortie, `next()` suivra tout seul, et la file continue.
   */
  const open = useCallback(() => {
    if (!def) return;
    dismiss();
    void router.push(revealHref(def.id));
  }, [def, dismiss, router]);

  /* Échap ferme, comme partout ailleurs sur le site. */
  useEffect(() => {
    if (!ach || muted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ach?.key, ach, muted, dismiss]);

  const seed = useMemo(() => (ach ? ach.key * 2654435761 : 0), [ach?.key, ach]);
  /* Le mythique reçoit une gerbe PLEIN ÉCRAN : deux fois plus d'éclats, projetés
     trois fois plus loin. Rien n'a d'`overflow: hidden` sur ce chemin, donc les
     éclats sortent bel et bien du cadre de la notification. */
  const mythic = def?.rarity === "m" && fx;
  const bits = useMemo(() => sparks(seed, mythic), [seed, mythic]);
  /* Toute la ligne du temps, du surgissement du jeton à son retrait — c'est
     l'horizon sur lequel la pluie est calée. Il suit `slow` sans qu'on y pense,
     puisque les trois durées animées le portent déjà. */
  const total = inMs + openMs + HOLD_MS + TEXT_OUT_MS + outMs;
  const confettis = useMemo(
    () => (mythic ? confetti(seed, total) : []),
    [seed, mythic, total],
  );

  if (!ach || !def || muted) return null;
  if (typeof document === "undefined") return null;

  const R = RARITY[def.rarity];
  const closing = phase === "out";
  const opened = phase === "open" || phase === "hold";

  /** L'animation du jeton : il arrive, puis il repart par le haut. Avec les
   *  effets coupés, il se pose et se retire au lieu de tomber et bondir. */
  const tokenAnim = closing
    ? `asAchOut ${outMs}ms cubic-bezier(.5,-0.2,.75,.2) forwards`
    : fx
      ? `asAchIn ${inMs}ms cubic-bezier(.3,.8,.3,1) both`
      : `asAchPlain ${Math.round(inMs * 0.4)}ms ease-out both`;

  /* ── POURQUOI CE `key`, ET IL EST TOUT LE SUJET ─────────────────────────────
     Au deuxième badge, l'impact ne jouait plus : ni halo, ni onde, ni rayons.
     Le bouton d'essai le montrait à chaque clic — le premier était une fête, les
     suivants une carte qui s'ouvre toute seule.

     Ce n'est pas le CSS, c'est la réconciliation. Ces éléments portent une
     `animation` dont la valeur ne change JAMAIS (`asAchHalo 950ms … both`), et
     React réutilise les mêmes nœuds d'un badge à l'autre : le navigateur voit la
     même propriété sur le même élément, donc il ne rejoue rien. L'animation
     restait figée sur sa dernière image — laquelle est, pour toutes, une opacité
     nulle. Les étincelles échappaient seules à la panne, par accident : leur
     `delay` est tiré au sort, donc leur valeur d'animation change.

     Une clé sur tout le sous-arbre démonte et reconstruit, ce qui est la seule
     façon FIABLE de rejouer un lot d'animations CSS — la relance manuelle
     (`element.getAnimations().forEach(a => a.cancel())`, ou le tour du reflow
     forcé) demanderait une ref par élément et un effet de plus, pour le même
     résultat. */
  return createPortal(
    <Fragment key={ach.key}>
      <BadgeDefs />

      {/* LA PLUIE DE CONFETTIS — mythique seulement, et sur TOUTE la largeur.
          Une couche à part, sous la notification (z-index d'un cran en dessous)
          et surtout `pointer-events: none` sur tout : elle couvre l'écran entier
          pendant trois secondes, et un seul pixel cliquable ici bloquerait la
          page. Elle sort du `Fragment` clé, donc elle se reconstruit à chaque
          badge comme le reste — même raison, même remède. */}
      {confettis.length ? (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 999999998,
            pointerEvents: "none",
            overflow: "hidden",
          }}
        >
          {confettis.map((c, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                top: -24,
                left: `${c.x}%`,
                width: c.w,
                height: c.h,
                background: c.col,
                borderRadius: 1,
                ["--as-cx" as string]: `${c.sway}px`,
                ["--as-cr" as string]: `${c.spin}deg`,
                /* LE TEMPS EST LINÉAIRE, ET C'EST UN CORRECTIF. Avec une
                   courbe (`cubic-bezier(.25,.5,.5,1)`), les confettis
                   semblaient s'arrêter à mi-chute puis repartir : une fonction
                   d'interpolation CSS s'applique ENTRE CHAQUE PAIRE DE
                   KEYFRAMES, pas sur toute la durée — la courbe décélérait
                   jusqu'au keyframe à 50 %, puis recommençait. Linéaire est en
                   plus le plus juste : un rectangle de papier atteint sa
                   vitesse limite en quelques centimètres.

                   Le nombre de cycles est calculé (cf. `confetti`) pour que la
                   dernière chute sorte de l'écran quand le jeton repart. */
                animation: `asAchConfetti ${c.dur}ms linear ${c.delay}ms ${c.cycles} both`,
                /* ── LA PLUIE NE SE FIGE PLUS AU SURVOL ────────────────────
                   Elle le faisait, pour garder le calage : le survol allonge
                   la pose, donc sans pause les confettis auraient fini avant
                   le jeton. Sauf qu'une pluie arrêtée en plein vol, avec des
                   confettis suspendus au milieu de l'écran, est un BUG à
                   l'œil — on ne met pas la gravité en pause parce qu'on
                   approche la souris.
                   Le calage reste ce qu'il vaut pour une pose normale ; sur
                   une pose prolongée, la pluie s'achève avant le badge, ce
                   qui est simplement ce que fait une pluie. */
              }}
            />
          ))}
        </div>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        /* `onMouseMove` ET PAS `onMouseEnter`, et la nuance a des dents : la
           carte APPARAÎT sous le curseur (elle surgit en haut au centre, là où
           on vient souvent de cliquer). Avec `mouseenter`, le navigateur la
           considère survolée dès qu'elle se peint sous un pointeur immobile,
           `held` passe à vrai, et comme la souris ne bouge pas il n'y aura
           jamais de `mouseleave` : la pose ne se termine plus. Un mouvement
           réel, lui, ne peut pas se produire par accident. */
        onMouseMove={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocusCapture={() => setHeld(true)}
        onBlurCapture={() => setHeld(false)}
        style={{
          /* Fixé à l'écran. Le z-index reste au-dessus du 9999 de
             `.aniscroll-player-fs` : le lecteur en plein écran n'affiche plus
             de badge du tout, mais il existe d'autres façons d'empiler des
             couches sur ce site, et cette notification passe devant.

             LA HAUTEUR EST DICTÉE PAR L'IMPACT, PAS PAR LE JETON. À 18 px du
             bord, l'onde se faisait couper : elle se détend jusqu'à 2,7 fois le
             jeton, soit un rayon de 140 px autour d'un centre qui était à 70 px
             du haut de l'écran — la moitié du rond sortait de la page, et les
             étincelles montantes avec. On descend donc le tout d'une demi-onde,
             ce qui laisse le cercle entier dans le cadre au moment où il se
             voit encore (il s'efface avant sa taille maximale).

             ── ET ELLE DESCEND SOUS LA BARRE DE NAVIGATION ──────────────────
             54 px laissaient le jeton chevaucher la barre : celle-ci fait
             48 px de contenu plus 12 px de marge haute et basse (`min-h-[48px]`
             et `py-3` dans NavBar.tsx), soit 72 px. La notification commence
             donc à 88 px : 16 px de marge, le strict nécessaire.

             Le voile flouté déborde plus haut que ça (26 px, cf.
             `.as-ach-blur`), et ce n'est pas une contradiction : son masque
             vaut ZÉRO sur ses propres bords et ne devient franc qu'au tiers du
             chemin vers le centre. Ce qui dépasse sur la barre ne peint rien —
             c'est précisément la marge dont le dégradé a besoin pour
             s'éteindre. */
          position: "fixed",
          top: 88,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 999999999,
          display: "flex",
          alignItems: "center",
          /* Le conteneur laisse passer les clics ; seule la carte les prend
             (plus bas). Sans quoi ce bloc invisible de 470 px masquerait le haut
             de la page pendant cinq secondes. */
          pointerEvents: "none",
          maxWidth: "min(94vw, 470px)",
        }}
      >
        {/* LE FLOU DU FOND, ET IL EST ICI POUR UNE RAISON PRÉCISE.

            Il a d'abord été posé DANS la carte, autour des deux lignes — et il
            ne floutait rien du tout, en production comme en local. Ce n'est pas
            un réglage : un `backdrop-filter` ne voit que ce qui est peint
            derrière lui À L'INTÉRIEUR DE SON « backdrop root », et un ancêtre
            qui anime son OPACITÉ en crée un. La carte fait exactement ça
            (`asAchOpen`, opacité 0 → 1, en `both`), donc le voile était enfermé
            dans un groupe où il n'y a, derrière lui, rien d'autre que la carte
            elle-même. Le `filter` de `.as-ach-text` a le même effet, ce qui
            interdit aussi d'en faire un `::before` de ce bloc.

            Il est donc SORTI des deux, au premier niveau de la notification —
            qui ne porte, lui, ni filtre ni opacité animée (son `transform` est
            sans effet là-dessus). Il couvre du coup toute la notification,
            jeton compris : ça ne se voit pas (le jeton est opaque) et ça évite
            de recalculer une région. `z-index: 0` sur un élément positionné le
            met sous la carte (positionnée, z-index auto, plus loin dans le
            DOM) et sous le jeton (z-index 2). */}
        <div
          className="as-ach-blur"
          aria-hidden="true"
          /* IL S'ÉTEINT AVEC LE TEXTE, SINON IL DISPARAÎT NET. Le voile n'avait
             aucune sortie : il vivait à pleine force jusqu'au démontage, et le
             fond retrouvait sa netteté d'une image à l'autre — une coupure
             franche au milieu d'une sortie entièrement faite de fondus.

             Le fondu couvre TOUTE la fin (l'effacement du texte PUIS le retrait
             du jeton), pas seulement le premier temps : il doit se terminer au
             démontage, pas avant, sinon on aurait juste déplacé la coupure.
             Fondre l'opacité revient à ramener progressivement le fond net
             par-dessus sa version floutée — c'est exactement le dé-floutage
             qu'on veut, sans animer `backdrop-filter` (qui, lui, repasse par le
             filtre à chaque image).

             La valeur est la MÊME chaîne pendant `textOut` et pendant `out` :
             le changement de phase ne doit pas relancer l'animation depuis le
             début, ce qui rallumerait le voile à mi-sortie. */
          style={{
            animation:
              phase === "textOut" || closing
                ? `asAchBlurOut ${TEXT_OUT_MS + outMs}ms ease-out forwards`
                : undefined,
          }}
        />

        {/* Le jeton, et ce qui l'accompagne à l'impact.

            DEUX NIVEAUX, et il en faut deux : l'extérieur joue l'arrivée puis
            le départ, l'intérieur respire pendant la pose. Empiler les deux
            animations sur le même élément ferait que la seconde écrase la
            transformation finale de la première — le jeton sauterait. */}
        <div
          className="as-ach-token"
          /* LE JETON MÈNE OÙ MÈNE LE TEXTE. Seule la carte était cliquable, et
             c'était la moitié de la cible la moins évidente : ce qui ressemble
             à un bouton dans cette notification, c'est la médaille. Elle prend
             donc le clic ET le survol (qui remonte au conteneur, lequel tient
             `held`), sans rôle ni tabindex : la carte porte déjà le `role` et
             le clavier, et deux liens pour une destination feraient deux
             arrêts de tabulation pour rien. */
          onClick={opened ? open : undefined}
          style={{
            position: "relative",
            flexShrink: 0,
            /* Devant la carte : c'est lui la médaille, elle est la plaque. */
            zIndex: 2,
            /* Le conteneur ne prend rien (`pointerEvents: none`) ; le jeton se
               réactive, comme la carte, une fois la notification ouverte. */
            pointerEvents: opened ? "auto" : "none",
            cursor: "pointer",
            animation: tokenAnim,
          }}
        >
          {/* L'impact : le halo, l'onde, les rayons, la gerbe. Tout est
              `aria-hidden` et `pointer-events:none` — c'est de la peinture, et
              c'est exactement ce que l'interrupteur « animation » éteint
              (lib/prefs/badgePrefs.ts). Le badge reste annoncé, avec son nom et
              sa condition : ce qui part est la fête, pas l'information. */}
          {fx ? (
            <>
              <div
                className="as-ach-halo"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  margin: "auto",
                  width: TOKEN + 20,
                  height: TOKEN + 20,
                  borderRadius: "50%",
                  background: `radial-gradient(circle, ${R.ic}66 0%, transparent 70%)`,
                  animation: `asAchHalo ${950 * slow}ms ease-out ${inMs * 0.38}ms both`,
                  pointerEvents: "none",
                }}
              />
              <div
                className="as-ach-ring"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  margin: "auto",
                  width: TOKEN,
                  height: TOKEN,
                  borderRadius: "50%",
                  border: `10px solid ${R.ic}`,
                  animation: `asAchRing ${760 * slow}ms cubic-bezier(.16,.8,.3,1) ${inMs * 0.4}ms both`,
                  pointerEvents: "none",
                }}
              />
              {RAYS.map((deg) => (
                <span
                  key={deg}
                  className="as-ach-ray"
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: 3,
                    height: TOKEN * 1.5,
                    marginTop: -TOKEN * 0.75,
                    marginLeft: -1.5,
                    borderRadius: 2,
                    background: `linear-gradient(to bottom, transparent, ${R.ic}, transparent)`,
                    ["--as-rot" as string]: `${deg}deg`,
                    animation: `asAchRay ${620 * slow}ms cubic-bezier(.2,.9,.3,1) ${inMs * 0.42}ms both`,
                    pointerEvents: "none",
                  }}
                />
              ))}
              {bits.map((b, i) => (
                <span
                  key={i}
                  className="as-ach-spark"
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: b.size,
                    height: b.size,
                    marginTop: -b.size / 2,
                    marginLeft: -b.size / 2,
                    borderRadius: b.square ? 1 : "50%",
                    background: R.starColors[i % (R.starColors.length || 1)] || R.ic,
                    boxShadow: `0 0 6px ${R.ic}aa`,
                    ["--as-dx" as string]: `${b.dx}px`,
                    ["--as-dy" as string]: `${b.dy}px`,
                    ["--as-fall" as string]: `${b.fall}px`,
                    ["--as-sc" as string]: String(b.sc),
                    animation: `asAchSpark ${(mythic ? 1700 : 1100) * slow}ms cubic-bezier(.12,.7,.3,1) ${inMs * 0.34 + b.delay}ms both`,
                    pointerEvents: "none",
                  }}
                />
              ))}
            </>
          ) : null}
          <div
            className="as-ach-breathe"
            style={{
              /* La respiration ne démarre qu'à la pose : pendant l'arrivée elle
                 se battrait avec les rebonds. Elle continue sous le survol —
                 c'est ce qui dit que la notification attend et n'a pas planté. */
              animation:
                fx && phase === "hold" ? "asAchBreathe 2.6s ease-in-out infinite" : "none",
            }}
          >
            {/* LE SURVOL GROSSIT, ET C'EST TOUT CE QU'IL FAUT DIRE. Rien
                n'indiquait que la notification MÈNE quelque part : pas de
                soulignement, pas de changement de couleur — le curseur seul,
                qu'on ne regarde pas. Un léger agrandissement suffit, et il
                porte sur les DEUX (jeton et texte) parce que la destination
                est la même : survoler l'un doit répondre pour l'ensemble.

                `held` est déjà exactement « la souris est sur la
                notification » — le conteneur ne reçoit rien, seuls le jeton et
                la carte font remonter `onMouseMove`. Une troisième couche
                porte l'échelle : l'extérieur joue l'arrivée, le milieu
                respire, et empiler un `transform` de plus sur l'un des deux
                écraserait le sien. */}
            <div
              style={{
                transform: held ? "scale(1.07)" : "scale(1)",
                transition: "transform .2s cubic-bezier(.22,1,.36,1)",
              }}
            >
              <BadgeToken
                id={def.id}
                rarity={def.rarity}
                icon={def.icon}
                tag={def.tag}
                unlocked
                size={TOKEN}
              />
            </div>
          </div>
        </div>

        {/* La carte : elle s'ouvre en largeur derrière le jeton, ce qui donne
            l'impression que celui-ci se décale pour lui laisser la place.

            ── IL N'Y A PLUS DE FOND DU TOUT, ET C'ÉTAIT LA SEULE SORTIE ───────
            Quatre états, dont trois étaient la même erreur sous trois formes :

              1. un VOILE SOMBRE opaque à coins arrondis. Une boîte.
              2. le voile remplacé par `brightness(.5)` sur le backdrop-filter.
                 On écrivait « un flou, pas une boîte » — en vrai c'était
                 toujours une boîte, simplement peinte par un filtre au lieu
                 d'un dégradé.
              3. le flou SEUL, à 30 px, sans assombrissement. Honnête, et
                 toujours moche : une zone translucide à bords doux posée sur
                 une image chargée fait une TACHE. Pas parce qu'elle est mal
                 réglée — parce que c'est une zone. Un bord flou sur un fond
                 net n'a aucune façon de ne pas ressembler à une salissure.
              4. celui-ci : AUCUN fond. Ni voile, ni flou, ni masque.

            LE FOND NE SE RÈGLE PAS, IL SE SUPPRIME. Ce qu'on voulait, c'est que
            le texte se détache sans qu'on peigne un objet derrière lui ; tant
            qu'on peint une RÉGION, on peint un objet. La seule façon d'assombrir
            uniquement là où il faut, c'est que l'assombrissement ait la FORME DES
            LETTRES — et c'est exactement ce que fait un `drop-shadow` en filtre,
            qui suit le canal alpha de ce qu'il traverse au lieu de remplir un
            rectangle. Trois halos de rayons croissants sur le bloc de texte, plus
            le contour de sous-titre sur chaque lettre (cf. `.as-ach-text` dans
            globals.css), et il n'y a plus rien à border ni à masquer.

            La carte reste un élément, et sa LARGEUR reste animée : c'est elle
            qui fait l'ouverture (le jeton a l'air de se décaler pour laisser la
            place). Simplement, elle ne peint plus rien. */}
        <div
          className="as-ach-card"
          /* Un `div` et pas un `button` : il contient DÉJÀ un bouton (la croix),
             et un bouton dans un bouton n'est pas du HTML valide — le navigateur
             défait l'imbrication et la croix se retrouve hors de la carte. Le
             rôle et la gestion du clavier sont donc posés à la main. */
          role="link"
          tabIndex={opened ? 0 : -1}
          aria-label={t("badges.ui.openInProfile", "Voir ce badge dans le profil")}
          onClick={open}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open();
            }
          }}
          style={{
            ["--as-ach-w" as string]: `${CARD_W}px`,
            overflow: "hidden",
            whiteSpace: "nowrap",
            width: opened ? CARD_W : 0,
            marginLeft: -10,
            padding: opened ? "14px 26px 14px 22px" : "14px 0",
            position: "relative",
            /* La carte est la seule zone cliquable : survol, clic, croix, et
               rien de plus. Fermée (largeur nulle) elle n'attrape rien. */
            pointerEvents: opened ? "auto" : "none",
            cursor: "pointer",
            animation:
              phase === "textOut" || closing
                ? `asAchClose ${TEXT_OUT_MS}ms cubic-bezier(.4,0,.6,1) forwards`
                : phase === "in"
                  ? "none"
                  : `asAchOpen ${OPEN_MS}ms cubic-bezier(.22,1,.36,1) both`,
          }}
        >
          {/* DEUX LIGNES, PLUS TROIS. Le kicker « BADGE DÉBLOQUÉ » est parti :
              il ne portait aucune information que le reste ne donnait déjà, et
              un jeton qui vient d'exploser à l'écran n'a pas besoin de
              s'annoncer par écrit. Le nom récupère la place et la taille.

              Elles entrent DÉCALÉES une fois la carte ouverte — le nom, puis la
              condition, dans l'ordre où on veut qu'ils soient lus. Apparaître
              d'un bloc ferait de la carte un panneau au lieu d'une annonce. */}
          {/* Le bloc de texte porte le filtre : les halos doivent suivre les
              deux lignes ENSEMBLE, pas chacune la sienne — sinon la condition
              projette son ombre sur le nom. */}
          <div
            className="as-ach-text"
            /* Même réponse que le jeton, même raison (cf. plus haut). L'origine
               est à GAUCHE : le texte grandit vers la droite, dans le vide de
               la carte, au lieu de repousser son propre début vers le jeton. */
            style={{
              transform: held ? "scale(1.04)" : "scale(1)",
              transformOrigin: "left center",
              transition: "transform .2s cubic-bezier(.22,1,.36,1)",
            }}
          >
          <div
            className="as-ach-line as-ach-name"
            style={{
              font: "700 25px/1.2 Outfit, sans-serif",
              letterSpacing: "-.015em",
              color: "#fff",
              overflow: "hidden",
              textOverflow: "ellipsis",
              animation: line(phase, 0),
            }}
          >
            {t(`badges.${def.id}.name`)}
          </div>
          <div
            className="as-ach-line as-ach-cond"
            style={{
              font: "500 14px/1.35 Karla, sans-serif",
              color: "rgba(255,255,255,.82)",
              marginTop: 5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              animation: line(phase, 110),
            }}
          >
            {t(`badges.${def.id}.cond`)}
          </div>
          </div>

          {/* La croix. Discrète au repos, franche au survol de la carte — elle
              n'a pas à disputer l'attention au nom du badge, mais elle doit être
              là AVANT qu'on la cherche. Elle reste atteignable au clavier. */}
          <button
            type="button"
            className="as-ach-close"
            /* `stopPropagation` OBLIGATOIRE : la carte entière navigue vers le
               profil, et sans ça fermer enverrait aussi sur la page du badge —
               c'est-à-dire le contraire exact de ce qu'on demande à une croix. */
            onClick={(e) => {
              e.stopPropagation();
              dismiss();
            }}
            aria-label={t("common.close", "Fermer")}
            style={{
              position: "absolute",
              top: 7,
              right: 7,
              width: 22,
              height: 22,
              display: "grid",
              placeItems: "center",
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: "rgba(255,255,255,.55)",
              cursor: "pointer",
              padding: 0,
              lineHeight: 0,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M1.5 1.5l9 9M10.5 1.5l-9 9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* (Une jauge de temps restant a été essayée le 23/09 sous le texte,
              puis retirée : elle rendait la pause lisible, mais elle mettait un
              compte à rebours sous une récompense — la seule chose qu'on ne veut
              pas faire lire ici. La pause reste, silencieuse.) */}
        </div>
      </div>
    </Fragment>,
    /* Toujours le document : le lecteur en plein écran n'affiche plus de badge,
       il n'y a donc plus de surface alternative à choisir. */
    document.body,
  );
}
