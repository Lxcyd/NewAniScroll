import type { CSSProperties } from "react";
import type { HeroLayout } from "@/lib/profile/dressing";

/**
 * La vignette d'un agencement dans le studio, en SQUELETTE : les formes de la
 * page en gris, comme un écran de chargement — avatar, pseudo, pastilles,
 * chiffres, onglets, widgets — et rien d'autre.
 *
 * Trois versions écartées le 15/10/2026 : toute en barres abstraites (illisible),
 * réduite à l'avatar et au nom (vide), puis en couleurs avec le vrai fond, le
 * vrai avatar et des widgets imités (trop chargée : la vignette rivalisait avec
 * la page qu'elle résume). Le gris laisse la seule chose qui distingue un
 * agencement d'un autre : OÙ tombe chaque pièce.
 *
 * Positions en % de la vignette, tailles en `cqw` : la vignette peut changer
 * de taille avec sa ligne de menu sans que rien ne change de proportion.
 */

type Shape =
  | { k: "av"; l: number; t: number; w: number }
  | { k: "name"; l: number; t: number; w: number; h: number; center?: boolean }
  | { k: "chips"; l: number; t: number; scale?: number; center?: boolean }
  | { k: "cards"; l: number; t: number; w: number; h: number; rows?: number }
  | { k: "bar"; l: number; t: number; w: number; h: number }
  | { k: "line"; r: number; t: number; w: number }
  | { k: "tabs"; l: number; t: number; w: number }
  | { k: "panel"; l: number; t: number; w: number; h: number }
  | { k: "wid"; l: number; t: number; w: number; h: number; cols?: number }
  | { k: "cue" };

const PLAN: Record<HeroLayout, Shape[]> = {
  band: [
    { k: "av", l: 7, t: 19, w: 17 },
    { k: "name", l: 28, t: 29, w: 30, h: 6 },
    { k: "chips", l: 28, t: 41 },
    { k: "cards", l: 7, t: 54, w: 86, h: 14 },
    { k: "tabs", l: 7, t: 72, w: 86 },
    { k: "wid", l: 7, t: 80, w: 86, h: 40 },
  ],
  center: [
    { k: "av", l: 41.5, t: 4, w: 17 },
    { k: "name", l: 35, t: 34, w: 30, h: 6, center: true },
    { k: "chips", l: 0, t: 45, center: true },
    { k: "cards", l: 7, t: 54, w: 86, h: 14 },
    { k: "tabs", l: 7, t: 72, w: 86 },
    { k: "wid", l: 7, t: 80, w: 86, h: 40 },
  ],
  medallion: [
    { k: "av", l: 7, t: 12, w: 26 },
    { k: "name", l: 37, t: 27, w: 30, h: 6 },
    { k: "chips", l: 37, t: 39 },
    { k: "bar", l: 7, t: 56, w: 86, h: 12 },
    { k: "tabs", l: 7, t: 72, w: 86 },
    { k: "wid", l: 7, t: 80, w: 86, h: 40 },
  ],
  column: [
    { k: "panel", l: 4, t: 12, w: 31, h: 95 },
    { k: "av", l: 7.5, t: 17, w: 12 },
    { k: "name", l: 7.5, t: 40, w: 18, h: 4 },
    { k: "chips", l: 7.5, t: 48, scale: 0.6 },
    { k: "cards", l: 7.5, t: 57, w: 24, h: 28, rows: 2 },
    { k: "tabs", l: 39, t: 12, w: 57 },
    { k: "wid", l: 39, t: 21, w: 57, h: 90, cols: 2 },
  ],
  showcase: [
    { k: "av", l: 7, t: 58, w: 17 },
    { k: "name", l: 28, t: 64, w: 26, h: 7 },
    { k: "chips", l: 28, t: 76 },
    { k: "line", r: 7, t: 69, w: 34 },
    { k: "cue" },
  ],
};

/* Trois gris : le fond des objets, les formes pleines, ce qu'on lit d'abord. */
const SURFACE = "bg-white/[0.05] ring-1 ring-white/[0.06]";
const SHAPE = "bg-white/[0.13]";
const STRONG = "bg-white/[0.24]";

export default function LayoutThumb({
  layout,
  fill = false,
}: {
  layout: HeroLayout;
  /** Remplit la hauteur de son parent au lieu de garder le format 16/10. */
  fill?: boolean;
}) {
  const box = (s: { l: number; t: number; w: number; h: number }): CSSProperties => ({
    left: `${s.l}%`,
    top: `${s.t}%`,
    width: `${s.w}%`,
    height: `${s.h}%`,
  });
  /* Un chiffre : une valeur (forte) sur son intitulé (pâle). */
  const figure = (j: number, label = true) => (
    <span key={j} className="flex flex-col gap-[0.8cqw]">
      {label ? <span className={`h-[0.9cqw] w-[6cqw] rounded-full ${SHAPE}`} /> : null}
      <span className={`h-[2.2cqw] w-[7cqw] rounded-full ${STRONG}`} />
    </span>
  );

  return (
    <span
      className={`relative block w-full overflow-hidden rounded-lg bg-[#17181f] ${
        fill ? "h-full" : "aspect-[16/10]"
      }`}
      style={{ containerType: "inline-size" }}
      aria-hidden
    >
      {PLAN[layout].map((s, i) => {
        switch (s.k) {
          case "av":
            return (
              <span
                key={i}
                className={`absolute aspect-square rounded-full ${STRONG}`}
                style={{ left: `${s.l}%`, top: `${s.t}%`, width: `${s.w}%` }}
              />
            );
          case "name":
            return <span key={i} className={`absolute rounded-full ${STRONG}`} style={box(s)} />;
          case "chips": {
            const k = s.scale ?? 1;
            return (
              <span
                key={i}
                className={`absolute flex ${s.center ? "inset-x-0 justify-center" : ""}`}
                style={{ left: s.center ? undefined : `${s.l}%`, top: `${s.t}%`, gap: `${k}cqw` }}
              >
                {[9, 13].map((w) => (
                  <span
                    key={w}
                    className={`rounded-[2px] ${SHAPE}`}
                    style={{ width: `${w * k}cqw`, height: `${2.4 * k}cqw` }}
                  />
                ))}
              </span>
            );
          }
          case "cards": {
            const rows = s.rows ?? 1;
            return (
              <span
                key={i}
                className="absolute grid gap-[2.5%]"
                style={{ ...box(s), gridTemplateColumns: `repeat(${4 / rows}, minmax(0, 1fr))` }}
              >
                {[0, 1, 2, 3].map((j) => (
                  <span key={j} className={`flex items-center overflow-hidden rounded-[4px] px-[1.6cqw] ${SURFACE}`}>
                    {figure(j, rows === 1)}
                  </span>
                ))}
              </span>
            );
          }
          case "bar":
            return (
              <span
                key={i}
                className={`absolute flex items-center justify-around rounded-md ${SURFACE}`}
                style={box(s)}
              >
                {[0, 1, 2, 3].map((j) => figure(j))}
              </span>
            );
          case "line":
            return (
              <span
                key={i}
                className="absolute flex justify-between"
                style={{ right: `${s.r}%`, top: `${s.t}%`, width: `${s.w}%` }}
              >
                {[0, 1, 2, 3].map((j) => figure(j))}
              </span>
            );
          case "tabs":
            return (
              <span
                key={i}
                className="absolute flex items-center justify-between"
                style={{ left: `${s.l}%`, top: `${s.t}%`, width: `${s.w}%`, height: "3.2cqw" }}
              >
                <span className="flex h-full items-center gap-[1.4cqw]">
                  <span className={`h-full w-[8cqw] rounded-full ${STRONG}`} />
                  {[5, 6, 4].map((w) => (
                    <span key={w} className={`h-[0.9cqw] rounded-full ${SHAPE}`} style={{ width: `${w}cqw` }} />
                  ))}
                </span>
                <span className={`h-full w-[9cqw] rounded-full ${SHAPE}`} />
              </span>
            );
          case "panel":
            return <span key={i} className={`absolute rounded-md ${SURFACE}`} style={box(s)} />;
          case "wid":
            return (
              <span
                key={i}
                className="absolute grid gap-[2.5%]"
                style={{ ...box(s), gridTemplateColumns: `repeat(${s.cols ?? 3}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: s.cols ?? 3 }, (_, j) => (
                  <span key={j} className={`flex flex-col gap-[1.4cqw] rounded-[4px] p-[1.8cqw] ${SURFACE}`}>
                    <span className={`h-[1.2cqw] w-[45%] rounded-full ${STRONG}`} />
                    <span className={`aspect-[2/1] w-full rounded-[2px] ${SHAPE}`} />
                    <span className={`h-[1cqw] w-[80%] rounded-full ${SHAPE}`} />
                    <span className={`h-[1cqw] w-[55%] rounded-full ${SHAPE}`} />
                  </span>
                ))}
              </span>
            );
          case "cue":
            return (
              <span
                key={i}
                className="absolute bottom-[6%] left-1/2 h-[3.4cqw] w-[3.4cqw] -translate-x-1/2 rotate-45 border-b-2 border-r-2 border-white/25"
              />
            );
        }
      })}
    </span>
  );
}
