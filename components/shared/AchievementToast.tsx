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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BY_ID } from "@/lib/badges/catalog";
import { next, useAchievement } from "@/lib/badges/achievementStore";
import { playBadgeChime } from "@/lib/badges/chime";
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
function sparks(seed: number): Spark[] {
  const out: Spark[] = [];
  let s = seed || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < SPARKS; i++) {
    const a = (i / SPARKS) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
    const dist = 46 + rnd() * 52;
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
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("in");
  /** Vrai tant que la souris (ou le clavier) tient la notification. */
  const [held, setHeld] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** Ce qui reste de la pose. Décrémenté à chaque suspension — c'est ce qui
   *  distingue une VRAIE pause d'un compte à rebours relancé à zéro. */
  const left = useRef(HOLD_MS);

  /* Le lecteur possède l'écran : on ne montre rien et on ne démarre rien. Le
     badge reste en tête de file et partira à la sortie du plein écran. */
  const muted = surface.active;

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
    at(IN_MS, () => setPhase("open"));
    at(IN_MS + OPEN_MS, () => setPhase("hold"));
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [ach?.key, ach, muted]);

  /* Le carillon part avec l'impact, pas avec le montage : le jeton met 720 ms à
     tomber, et un son qui précède son objet s'entend comme un son de trop. */
  useEffect(() => {
    if (!ach || muted) return;
    const def = BY_ID[ach.id];
    if (!def) return;
    const t = setTimeout(() => playBadgeChime(def.rarity), IN_MS * 0.36);
    return () => clearTimeout(t);
  }, [ach?.key, ach, muted]);

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
     notification déjà partie. */
  useEffect(() => {
    if (phase !== "textOut") return;
    const a = setTimeout(() => setPhase("out"), TEXT_OUT_MS);
    const b = setTimeout(() => next(), TEXT_OUT_MS + OUT_MS);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [phase]);

  /** Abréger : on saute à la sortie, animation comprise. Depuis l'arrivée comme
   *  depuis la pose — on peut congédier un badge avant même de l'avoir lu. */
  const dismiss = useCallback(() => {
    setPhase((p) => (p === "textOut" || p === "out" ? p : "textOut"));
  }, []);

  /* Échap ferme, comme partout ailleurs sur le site. */
  useEffect(() => {
    if (!ach || muted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ach?.key, ach, muted, dismiss]);

  const def = ach ? BY_ID[ach.id] : null;
  const seed = useMemo(() => (ach ? ach.key * 2654435761 : 0), [ach?.key, ach]);
  const bits = useMemo(() => sparks(seed), [seed]);

  if (!ach || !def || muted) return null;
  if (typeof document === "undefined") return null;

  const R = RARITY[def.rarity];
  const closing = phase === "out";
  const opened = phase === "open" || phase === "hold";

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
          className="as-ach-token"
          style={{
            position: "relative",
            flexShrink: 0,
            /* Devant la carte : c'est lui la médaille, elle est la plaque. */
            zIndex: 2,
            animation: closing
              ? `asAchOut ${OUT_MS}ms cubic-bezier(.5,-0.2,.75,.2) forwards`
              : `asAchIn ${IN_MS}ms cubic-bezier(.3,.8,.3,1) both`,
          }}
        >
          {/* L'impact : le halo, l'onde, les rayons, la gerbe. Tout est
              `aria-hidden` et `pointer-events:none` — c'est de la peinture. */}
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
              animation: `asAchHalo 950ms ease-out ${IN_MS * 0.38}ms both`,
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
              animation: `asAchRing 760ms cubic-bezier(.16,.8,.3,1) ${IN_MS * 0.4}ms both`,
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
                animation: `asAchRay 620ms cubic-bezier(.2,.9,.3,1) ${IN_MS * 0.42}ms both`,
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
                animation: `asAchSpark 1100ms cubic-bezier(.12,.7,.3,1) ${IN_MS * 0.34 + b.delay}ms both`,
                pointerEvents: "none",
              }}
            />
          ))}
          <div
            className="as-ach-breathe"
            style={{
              /* La respiration ne démarre qu'à la pose : pendant l'arrivée elle
                 se battrait avec les rebonds. Elle continue sous le survol —
                 c'est ce qui dit que la notification attend et n'a pas planté. */
              animation:
                phase === "hold" ? "asAchBreathe 2.6s ease-in-out infinite" : "none",
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
            /* La carte est la seule zone cliquable : survol, croix, et rien de
               plus. Fermée (largeur nulle) elle n'attrape rien. */
            pointerEvents: opened ? "auto" : "none",
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
            onClick={dismiss}
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
