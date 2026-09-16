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
const IN_MS = 600;      // le jeton surgit
const OPEN_MS = 500;    // la carte s'ouvre
const HOLD_MS = 3500;   // la pose
const OUT_MS = 600;     // le retrait
const CARD_W = 300;

type Phase = "in" | "open" | "hold" | "out";

/** Douze éclats, semés une fois par badge pour qu'ils ne sautent pas au re-rendu. */
function sparks(seed: number) {
  const out: { dx: number; dy: number; sc: number; delay: number; color: string }[] = [];
  let s = seed || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 12; i++) {
    /* Répartis sur le cercle, avec un peu de désordre : douze angles
       parfaitement réguliers donneraient une roue de feu d'artifice de
       clipart. */
    const a = (i / 12) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
    const dist = 42 + rnd() * 38;
    out.push({
      dx: Math.cos(a) * dist,
      dy: Math.sin(a) * dist,
      sc: 0.4 + rnd() * 0.8,
      delay: rnd() * 120,
      color: "",
    });
  }
  return out;
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
    at(IN_MS + OPEN_MS + HOLD_MS, () => setPhase("out"));
    at(IN_MS + OPEN_MS + HOLD_MS + OUT_MS, () => next());
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
          maxWidth: "min(92vw, 460px)",
        }}
      >
        {/* Le jeton, et ce qui l'accompagne à l'impact. */}
        <div
          className="as-ach-token"
          style={{
            position: "relative",
            flexShrink: 0,
            animation: closing
              ? `asAchOut ${OUT_MS}ms cubic-bezier(.4,0,.8,.2) forwards`
              : `asAchIn ${IN_MS}ms cubic-bezier(.22,1.2,.36,1) both`,
          }}
        >
          <div
            className="as-ach-halo"
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              margin: "auto",
              width: 96,
              height: 96,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${R.ic}55 0%, transparent 70%)`,
              animation: `asAchHalo 900ms ease-out ${IN_MS * 0.4}ms both`,
              pointerEvents: "none",
            }}
          />
          {bits.map((b, i) => (
            <span
              key={i}
              className="as-ach-spark"
              aria-hidden="true"
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                width: 6,
                height: 6,
                marginTop: -3,
                marginLeft: -3,
                borderRadius: "50%",
                background: R.starColors[i % (R.starColors.length || 1)] || R.ic,
                ["--as-dx" as string]: `${b.dx}px`,
                ["--as-dy" as string]: `${b.dy}px`,
                ["--as-sc" as string]: String(b.sc),
                animation: `asAchSpark 850ms ease-out ${IN_MS * 0.35 + b.delay}ms both`,
                pointerEvents: "none",
              }}
            />
          ))}
          <BadgeToken
            id={def.id}
            rarity={def.rarity}
            icon={def.icon}
            tag={def.tag}
            unlocked
            size={86}
          />
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
            borderRadius: "0 12px 12px 0",
            background: "linear-gradient(90deg, rgba(20,20,31,.97), rgba(20,20,31,.88))",
            border: "1px solid rgba(255,255,255,.1)",
            borderLeft: "none",
            boxShadow: "0 8px 30px rgba(0,0,0,.55)",
            padding: opened ? "12px 18px 12px 24px" : "12px 0",
            position: "relative",
            animation: closing
              ? `asAchClose ${OUT_MS}ms ease-in forwards`
              : phase === "in"
                ? "none"
                : `asAchOpen ${OPEN_MS}ms cubic-bezier(.22,1,.36,1) both`,
          }}
        >
          <div
            style={{
              font: "500 9px Karla, sans-serif",
              letterSpacing: ".18em",
              textTransform: "uppercase",
              color: R.ic,
              marginBottom: 4,
            }}
          >
            {t("badges.ui.unlocked", "Badge débloqué")}
          </div>
          <div
            style={{
              font: "600 15px/1.2 Outfit, sans-serif",
              color: "#fff",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {t(`badges.${def.id}.name`)}
          </div>
          <div
            style={{
              font: "400 11.5px/1.35 Karla, sans-serif",
              color: "rgba(255,255,255,.55)",
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
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
              background: `linear-gradient(90deg, transparent, ${R.ic}22, transparent)`,
              animation: phase === "hold" ? "asAchShine 1.6s ease-in-out 1" : "none",
              pointerEvents: "none",
            }}
          />
        </div>
      </div>
    </>,
    target,
  );
}
