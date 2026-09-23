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
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { BY_ID } from "@/lib/badges/catalog";
import { next, useAchievement } from "@/lib/badges/achievementStore";
import { playBadgeChime } from "@/lib/badges/chime";
import { dockRect, markUnseen } from "@/lib/badges/dock";
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
const CARD_W = 336;
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

type Confetto = { x: number; delay: number; dur: number; sway: number; spin: number; w: number; h: number; col: string };

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
 */
function confetti(seed: number): Confetto[] {
  const out: Confetto[] = [];
  let s = (seed ^ 0x9e3779b9) >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const cols = ["#ffc7b0", "#FF7F57", "#ffffff", "#E94560", "#ffd9a0"];
  for (let i = 0; i < 46; i++) {
    out.push({
      x: rnd() * 100,
      delay: rnd() * 900,
      dur: 2100 + rnd() * 1600,
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
  const { sound, fx } = useBadgePrefs();
  const router = useRouter();
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("in");
  /** Vrai tant que la souris (ou le clavier) tient la notification. */
  const [held, setHeld] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** Ce qui reste de la pose. Décrémenté à chaque suspension — c'est ce qui
   *  distingue une VRAIE pause d'un compte à rebours relancé à zéro. */
  const left = useRef(HOLD_MS);
  /** Le jeton, pour mesurer d'où il part quand il file vers l'avatar. */
  const tokenRef = useRef<HTMLDivElement | null>(null);
  /** Le vecteur du vol, calculé au tout début de la sortie. `null` = pas encore
   *  mesuré, `false` = pas de quai en vue, on repart par le haut. */
  const [flight, setFlight] = useState<{ dx: number; dy: number; s: number } | null | false>(null);

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
    setFlight(null);
    left.current = HOLD_MS;
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    at(inMs, () => setPhase("open"));
    at(inMs + openMs, () => setPhase("hold"));
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [ach?.key, ach, muted, inMs, openMs]);

  /* Le carillon part avec l'impact, pas avec le montage : le jeton met 720 ms à
     tomber, et un son qui précède son objet s'entend comme un son de trop.

     `sound` n'est pas testé ici mais dans `playBadgeChime` : la valeur du hook
     est `true` au premier rendu (pas de `localStorage` côté serveur), et
     couper sur elle laisserait passer un son pendant la fraction de seconde où
     elle n'est pas encore lue. La lecture synchrone, elle, est juste. */
  useEffect(() => {
    if (!ach || muted || !def) return;
    const t = setTimeout(() => playBadgeChime(def.rarity), inMs * 0.36);
    return () => clearTimeout(t);
  }, [ach?.key, ach, muted, def, inMs, sound]);

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

  /* La sortie, une fois lancée, ne se suspend plus : on ne rattrape pas une
     notification déjà partie. C'est ici que le badge passe dans les « non
     vus » : à l'instant où il quitte l'écran, et pas à son arrivée — un badge
     qu'on est en train de regarder n'est pas en attente d'être vu. */
  useEffect(() => {
    if (phase !== "textOut" || !def) return;
    const a = setTimeout(() => setPhase("out"), TEXT_OUT_MS);
    const b = setTimeout(() => {
      markUnseen(def.id);
      next();
    }, TEXT_OUT_MS + outMs);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [phase, def, outMs]);

  /**
   * ── LE VOL VERS L'AVATAR ───────────────────────────────────────────────────
   *
   * Mesuré ICI et pas plus tôt, dans un effet de MISE EN PAGE. Les deux
   * précisions comptent :
   *
   *   - PAS PLUS TÔT : la carte se referme pendant `textOut`, et comme le bloc
   *     entier est centré, le jeton DÉRIVE de presque la moitié de la largeur
   *     de la carte en se recentrant. Un vecteur calculé avant la fermeture
   *     viserait 160 px à côté.
   *   - `useLayoutEffect` : la mesure se fait avant la peinture, donc le jeton
   *     ne reste jamais une image sans animation. Avec un `useEffect`, on verrait
   *     un clignotement d'une frame entre « rien » et « il part ».
   *
   * `dockRect()` rend `null` quand la navbar est absente (page de visionnage)
   * ou hors de l'écran (barre rétractée) : on repart alors par le haut comme
   * avant. On ne vise pas une cible qu'on ne voit pas.
   */
  useLayoutEffect(() => {
    if (phase !== "out" || flight !== null) return;
    const quai = fx ? dockRect() : null;
    const el = tokenRef.current;
    if (!quai || !el) {
      setFlight(false);
      return;
    }
    const d = el.getBoundingClientRect();
    setFlight({
      dx: quai.left + quai.width / 2 - (d.left + d.width / 2),
      dy: quai.top + quai.height / 2 - (d.top + d.height / 2),
      /* On vise la taille de l'avatar, pas zéro : le jeton doit avoir l'air de
         se RANGER, pas de s'évaporer en chemin. */
      s: Math.max(0.12, quai.width / Math.max(1, d.width)),
    });
  }, [phase, flight, fx]);

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
  const confettis = useMemo(() => (mythic ? confetti(seed) : []), [seed, mythic]);

  if (!ach || !def || muted) return null;
  if (typeof document === "undefined") return null;

  const R = RARITY[def.rarity];
  const closing = phase === "out";
  const opened = phase === "open" || phase === "hold";

  /** L'animation du jeton. Trois cas : l'arrivée, le vol vers l'avatar, et le
   *  retrait par le haut quand il n'y a pas de quai. `"none"` le temps d'UNE
   *  image, entre l'entrée dans la sortie et la mesure du vecteur — invisible,
   *  et c'est le prix d'une mesure juste (cf. le `useLayoutEffect` plus haut). */
  const tokenAnim = closing
    ? flight === null
      ? "none"
      : flight === false
        ? `asAchOut ${outMs}ms cubic-bezier(.5,-0.2,.75,.2) forwards`
        : `asAchFly ${outMs}ms cubic-bezier(.55,0,.35,1) forwards`
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
                animation: `asAchConfetti ${c.dur}ms cubic-bezier(.25,.5,.5,1) ${c.delay}ms both`,
              }}
            />
          ))}
        </div>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        onMouseEnter={() => setHeld(true)}
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
             voit encore (il s'efface avant sa taille maximale). */
          position: "fixed",
          top: 54,
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
        {/* Le jeton, et ce qui l'accompagne à l'impact.

            DEUX NIVEAUX, et il en faut deux : l'extérieur joue l'arrivée puis
            le départ, l'intérieur respire pendant la pose. Empiler les deux
            animations sur le même élément ferait que la seconde écrase la
            transformation finale de la première — le jeton sauterait. */}
        <div
          ref={tokenRef}
          className="as-ach-token"
          style={{
            position: "relative",
            flexShrink: 0,
            /* Devant la carte : c'est lui la médaille, elle est la plaque. */
            zIndex: 2,
            ...(flight
              ? {
                  ["--as-fx" as string]: `${flight.dx}px`,
                  ["--as-fy" as string]: `${flight.dy}px`,
                  ["--as-fs" as string]: String(flight.s),
                }
              : null),
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

        {/* La carte : elle s'ouvre en largeur derrière le jeton, ce qui donne
            l'impression que celui-ci se décale pour lui laisser la place.

            ── UN VRAI FLOU, ET RIEN D'AUTRE ───────────────────────────────────
            Il y a eu trois états, et les deux premiers étaient faux :

              1. un VOILE SOMBRE opaque à coins arrondis. C'était une boîte.
              2. le voile remplacé par `brightness(.5)` sur le backdrop-filter.
                 On croyait avoir gardé « un flou, pas une boîte » — en vrai
                 c'était toujours une boîte, simplement peinte par un filtre au
                 lieu d'un dégradé : ce qu'on voyait à l'écran était une tache
                 sombre, et le flou ne comptait pour presque rien dedans.
              3. celui-ci : `blur` et `saturate`, AUCUN assombrissement.

            Le prix est réel et c'est tout le sujet : un flou seul NE FONCE PAS,
            donc il ne rend rien lisible. Sur une bannière claire, du blanc
            floutée reste du blanc. La lisibilité est donc entièrement reportée
            SUR LE TEXTE — un contour sombre autour des lettres, comme un
            sous-titre d'anime (cf. `.as-ach-line` dans globals.css). C'est la
            seule technique qui tient sur n'importe quelle image sans rien
            peindre derrière, et c'est pour ça que les sous-titres font ça
            depuis quarante ans.

            Le rayon monte de 18 à 30 px : sans l'assombrissement, un flou
            discret ne se voit tout simplement plus. Le masque radial reste — il
            est ce qui empêche le flou de redevenir un cadre à quatre bords
            nets, en haut et en bas comme sur les côtés. */}
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
            backdropFilter: "blur(30px) saturate(118%)",
            WebkitBackdropFilter: "blur(30px) saturate(118%)",
            maskImage:
              "radial-gradient(82% 62% at 32% 50%, #000 24%, rgba(0,0,0,.55) 64%, transparent 100%)",
            WebkitMaskImage:
              "radial-gradient(82% 62% at 32% 50%, #000 24%, rgba(0,0,0,.55) 64%, transparent 100%)",
            padding: opened ? "14px 26px 14px 26px" : "14px 0",
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
          <div
            className="as-ach-line as-ach-name"
            style={{
              font: "700 20px/1.2 Outfit, sans-serif",
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
              font: "500 12.5px/1.35 Karla, sans-serif",
              color: "rgba(255,255,255,.82)",
              marginTop: 5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              animation: line(phase, 110),
            }}
          >
            {t(`badges.${def.id}.cond`)}
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
