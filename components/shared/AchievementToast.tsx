/**
 * La notification d'un badge débloqué — en haut, au centre, par-dessus tout.
 *
 * ── LE PLEIN ÉCRAN, QUI EST LA VRAIE CONTRAINTE ──────────────────────────────
 * Un badge tombe presque toujours pendant un épisode, donc souvent pendant que
 * le lecteur occupe l'écran. Deux mécaniques coexistent sur ce site :
 *
 *   - le plein écran NORMAL : `enterRootFullscreen()` met `<html>` en plein
 *     écran (lib/player/playerFullscreen.ts) et « le lecteur remplit l'écran »
 *     n'est que du CSS (`.aniscroll-player-fs { position:fixed; inset:0;
 *     z-index:9999 }`). Le document reste donc visible, et un portal sur
 *     `document.body` avec un z-index supérieur à 9999 s'affiche par-dessus.
 *     C'est exactement ce que fait déjà la pile de toasts.
 *
 *   - le plein écran iOS, où c'est la VIDÉO elle-même qui prend l'écran. Là,
 *     rien du document n'est visible, et le seul endroit atteignable est
 *     l'intérieur du lecteur : c'est à quoi sert le registre de surface
 *     (lib/notifications/playerSurface.ts), et pourquoi on portale dedans dès
 *     qu'il se déclare actif.
 *
 * On suit donc la même règle que <NoticeStack/> : dans le lecteur quand il
 * possède l'écran, sur `document.body` sinon.
 *
 * ── POURQUOI UN COMPOSANT À PART ─────────────────────────────────────────────
 * Position, durée, animation et mise en file diffèrent de tout le reste, et une
 * récompense ne doit pas se collapser dans la pile des messages d'erreur. Voir
 * l'en-tête de lib/badges/achievementStore.ts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BY_ID } from "@/lib/badges/catalog";
import { next, useAchievement } from "@/lib/badges/achievementStore";
import { usePlayerSurface } from "@/lib/notifications/playerSurface";
import BadgeDefs from "@/components/profile/badges/BadgeDefs";
import BadgeToken from "@/components/profile/badges/BadgeToken";
import { RARITY } from "@/components/profile/badges/rarity";

/* La ligne du temps, en millisecondes. Les mêmes valeurs que les keyframes
   asAch* de globals.css — elles vivent des deux côtés parce que l'une dessine
   et l'autre enchaîne, et elles doivent rester d'accord. */
const IN_MS = 720;      // le jeton surgit
const OPEN_MS = 520;    // la carte s'ouvre
const HOLD_MS = 3600;   // la pose
/* LA SORTIE EN DEUX TEMPS. Le texte s'efface et la carte se referme (le jeton
   revient donc au centre tout seul, puisque le bloc est centré et rétrécit vers
   son milieu) ; ensuite seulement le jeton remonte en rétrécissant, comme il
   est venu. */
const TEXT_OUT_MS = 420;
const OUT_MS = 620;     // le retrait du jeton
const CARD_W = 316;
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
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /* La ligne du temps est relancée à chaque badge (`ach.key` change même si
     c'est le même id), et TOUS les minuteurs sont annulés au démontage :
     laisser tourner un `setTimeout` qui appelle `next()` après un changement de
     page ferait défiler la file dans le vide. */
  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (!ach) return;
    setPhase("in");
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    at(IN_MS, () => setPhase("open"));
    at(IN_MS + OPEN_MS, () => setPhase("hold"));
    at(IN_MS + OPEN_MS + HOLD_MS, () => setPhase("textOut"));
    at(IN_MS + OPEN_MS + HOLD_MS + TEXT_OUT_MS, () => setPhase("out"));
    at(IN_MS + OPEN_MS + HOLD_MS + TEXT_OUT_MS + OUT_MS, () => next());
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [ach?.key, ach]);

  const def = ach ? BY_ID[ach.id] : null;
  const seed = useMemo(() => (ach ? ach.key * 2654435761 : 0), [ach?.key, ach]);
  const bits = useMemo(() => sparks(seed), [seed]);

  if (!ach || !def) return null;
  if (typeof document === "undefined") return null;

  const R = RARITY[def.rarity];
  const insidePlayer = surface.active && !!surface.el;
  const target = insidePlayer ? surface.el! : document.body;
  const closing = phase === "out";
  const opened = phase === "open" || phase === "hold";

  return createPortal(
    <>
      <BadgeDefs />
      <div
        role="status"
        aria-live="polite"
        style={{
          /* Dans le lecteur : absolu, sous la barre de titre. Sinon : fixé à
             l'écran, au-dessus du 9999 de `.aniscroll-player-fs`. */
          position: insidePlayer ? "absolute" : "fixed",
          top: insidePlayer ? 24 : 18,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: insidePlayer ? 60 : 999999999,
          display: "flex",
          alignItems: "center",
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
                 se battrait avec les rebonds. */
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
            l'impression que celui-ci se décale pour lui laisser la place. */}
        <div
          className="as-ach-card"
          style={{
            ["--as-ach-w" as string]: `${CARD_W}px`,
            overflow: "hidden",
            whiteSpace: "nowrap",
            width: opened ? CARD_W : 0,
            marginLeft: -10,
            /* PAS DE BOÎTE. Une carte opaque posée en haut de l'écran masque la
               page et se voit comme un panneau collé par-dessus. On ne garde
               que ce qui rend le texte LISIBLE : un flou d'arrière-plan et un
               voile très léger. Le contenu de la page reste visible dessous,
               simplement adouci. */
            borderRadius: 16,
            background:
              "linear-gradient(90deg, rgba(10,10,16,.55), rgba(10,10,16,.3) 70%, rgba(10,10,16,0))",
            backdropFilter: "blur(14px) saturate(120%)",
            WebkitBackdropFilter: "blur(14px) saturate(120%)",
            /* Le bord droit se dissout au lieu de s'arrêter net : sans masque,
               un flou rectangulaire redevient une boîte. */
            maskImage:
              "linear-gradient(90deg, #000 0%, #000 72%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(90deg, #000 0%, #000 72%, transparent 100%)",
            textShadow: "0 1px 10px rgba(0,0,0,.85)",
            padding: opened ? "12px 26px 12px 26px" : "12px 0",
            position: "relative",
            animation:
              phase === "textOut" || closing
                ? `asAchClose ${TEXT_OUT_MS}ms cubic-bezier(.4,0,.6,1) forwards`
                : phase === "in"
                  ? "none"
                  : `asAchOpen ${OPEN_MS}ms cubic-bezier(.22,1,.36,1) both`,
          }}
        >
          {/* Les trois lignes entrent DÉCALÉES, une fois la carte ouverte : on
              lit « badge débloqué », puis son nom, puis sa condition — dans
              l'ordre où on veut qu'ils soient lus. Apparaître d'un bloc ferait
              de la carte un panneau au lieu d'une annonce. */}
          <div
            className="as-ach-line"
            style={{
              font: "500 9px Karla, sans-serif",
              letterSpacing: ".18em",
              textTransform: "uppercase",
              color: R.ic,
              marginBottom: 4,
              animation: line(phase, 0),
            }}
          >
            {t("badges.ui.unlocked", "Badge débloqué")}
          </div>
          <div
            className="as-ach-line"
            style={{
              font: "600 15.5px/1.2 Outfit, sans-serif",
              color: "#fff",
              overflow: "hidden",
              textOverflow: "ellipsis",
              animation: line(phase, 90),
            }}
          >
            {t(`badges.${def.id}.name`)}
          </div>
          <div
            className="as-ach-line"
            style={{
              font: "400 11.5px/1.35 Karla, sans-serif",
              color: "rgba(255,255,255,.55)",
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              animation: line(phase, 175),
            }}
          >
            {t(`badges.${def.id}.cond`)}
          </div>
          {/* Le liseré qui court pendant la pose. */}
          <span
            className="as-ach-shine"
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: 60,
              background: `linear-gradient(90deg, transparent, ${R.ic}33, transparent)`,
              /* Deux passages pendant la pose, pas un : le premier tombe encore
                 dans l'ouverture de la carte et se voit mal. */
              animation: phase === "hold" ? "asAchShine 1.7s ease-in-out .15s 2" : "none",
              pointerEvents: "none",
            }}
          />
        </div>
      </div>
    </>,
    target,
  );
}
