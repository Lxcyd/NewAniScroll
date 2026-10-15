import type { CSSProperties } from "react";
import type { HeroLayout } from "@/lib/profile/dressing";

/**
 * La vignette d'un agencement dans le studio : la page en miniature, avec SES
 * pièces à elle — le fond du brouillon, le vrai avatar, le vrai pseudo, les
 * vrais chiffres — et un seul pavé pour le contenu (les widgets).
 *
 * Première version (15/10/2026) refaite le jour même : tout était figuré par
 * des barres (nav, pastilles, onglets, intitulés), et une vignette de 200 px
 * faite de barres ne se lit plus — la pilule du fond passait pour un
 * interrupteur, la ligne de chiffres pour un point rouge. Ici il n'y a que ce
 * qui distingue un agencement d'un autre : où sont l'avatar, le nom, les
 * chiffres, et où commence le contenu.
 *
 * Positions en % de la vignette, tailles de texte en `cqw` : la vignette peut
 * s'étirer avec sa ligne de menu sans que le texte change de proportion.
 */

type Shape =
  | { k: "av"; l: number; t: number; w: number }
  | { k: "name"; l: number; t: number; w: number; size: number; center?: boolean }
  | { k: "cards"; l: number; t: number; w: number; h: number; size: number; rows?: number }
  | { k: "bar"; l: number; t: number; w: number; h: number; size: number }
  | { k: "line"; r: number; t: number; size: number }
  | { k: "panel" | "wid"; l: number; t: number; w: number; h: number; cols?: number }
  | { k: "cue" };

const PLAN: Record<HeroLayout, Shape[]> = {
  band: [
    { k: "av", l: 7, t: 24, w: 17 },
    { k: "name", l: 28, t: 37, w: 64, size: 9 },
    { k: "cards", l: 7, t: 56, w: 86, h: 15, size: 5 },
    { k: "wid", l: 7, t: 77, w: 86, h: 40 },
  ],
  center: [
    { k: "av", l: 41.5, t: 6, w: 17 },
    { k: "name", l: 7, t: 38, w: 86, size: 9, center: true },
    { k: "cards", l: 7, t: 56, w: 86, h: 15, size: 5 },
    { k: "wid", l: 7, t: 77, w: 86, h: 40 },
  ],
  medallion: [
    { k: "av", l: 7, t: 16, w: 26 },
    { k: "name", l: 37, t: 33, w: 56, size: 9 },
    { k: "bar", l: 7, t: 60, w: 86, h: 13, size: 5 },
    { k: "wid", l: 7, t: 79, w: 86, h: 40 },
  ],
  column: [
    { k: "panel", l: 4, t: 18, w: 31, h: 90 },
    { k: "av", l: 7.5, t: 23, w: 12 },
    { k: "name", l: 7.5, t: 46, w: 25, size: 5.5 },
    { k: "cards", l: 7.5, t: 58, w: 24, h: 30, size: 3.4, rows: 2 },
    { k: "wid", l: 39, t: 18, w: 57, h: 90, cols: 2 },
  ],
  showcase: [
    { k: "av", l: 7, t: 58, w: 17 },
    { k: "name", l: 28, t: 64, w: 40, size: 10 },
    { k: "line", r: 7, t: 69, size: 4.6 },
    { k: "cue" },
  ],
};

const PLACEHOLDER = ["—", "—", "—", "—"];

export default function LayoutThumb({
  layout,
  plate,
  avatar,
  name,
  stats,
  fill = false,
}: {
  layout: HeroLayout;
  /** Le fond du brouillon, en valeur CSS `background` : on choisit sur son propre fond. */
  plate: string;
  avatar: string | null;
  name: string;
  /** Les quatre chiffres formatés ; la note est le dernier, en couleur d'accent. */
  stats?: string[];
  /** Remplit la hauteur de son parent au lieu de garder le format 16/10. */
  fill?: boolean;
}) {
  const figures = stats && stats.length === 4 ? stats : PLACEHOLDER;
  const num = (v: string, j: number, size: number) => (
    <span
      key={j}
      className={`font-outfit font-bold leading-none tabular-nums ${j === 3 ? "text-action" : "text-white"}`}
      style={{ fontSize: `${size}cqw` }}
    >
      {v}
    </span>
  );
  const box = (s: { l: number; t: number; w: number; h: number }): CSSProperties => ({
    left: `${s.l}%`,
    top: `${s.t}%`,
    width: `${s.w}%`,
    height: `${s.h}%`,
  });

  return (
    <span
      className={`relative block w-full overflow-hidden rounded-lg bg-[#101118] ${
        fill ? "h-full" : "aspect-[16/10]"
      }`}
      style={{ containerType: "inline-size" }}
      aria-hidden
    >
      <span className="absolute inset-0" style={{ background: plate }} />
      <span className="absolute inset-0 bg-gradient-to-b from-black/5 via-black/35 to-black/80" />
      {PLAN[layout].map((s, i) => {
        switch (s.k) {
          case "av":
            return (
              <span
                key={i}
                className="absolute aspect-square overflow-hidden rounded-full bg-gradient-to-br from-[#2f3b66] to-[#7f6bc4] shadow-[0_2px_8px_rgba(0,0,0,.5)] ring-[1.5px] ring-white/90"
                style={{ left: `${s.l}%`, top: `${s.t}%`, width: `${s.w}%` }}
              >
                {avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatar} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : null}
              </span>
            );
          case "name":
            return (
              <span
                key={i}
                className={`absolute truncate font-outfit font-bold leading-none text-white ${
                  s.center ? "text-center" : ""
                }`}
                style={{
                  left: `${s.l}%`,
                  top: `${s.t}%`,
                  width: `${s.w}%`,
                  fontSize: `${s.size}cqw`,
                  textShadow: "0 1px 3px rgba(0,0,0,.7)",
                }}
              >
                {name}
              </span>
            );
          case "cards": {
            const rows = s.rows ?? 1;
            return (
              <span
                key={i}
                className="absolute grid gap-[2.5%]"
                style={{ ...box(s), gridTemplateColumns: `repeat(${4 / rows}, minmax(0, 1fr))` }}
              >
                {figures.map((v, j) => (
                  <span
                    key={j}
                    className="flex items-center overflow-hidden rounded-[4px] bg-[#14151d]/85 px-[1.6cqw] ring-1 ring-white/10"
                  >
                    {num(v, j, s.size)}
                  </span>
                ))}
              </span>
            );
          }
          case "bar":
            return (
              <span
                key={i}
                className="absolute flex items-center justify-around rounded-md bg-black/55 ring-1 ring-white/10"
                style={box(s)}
              >
                {figures.map((v, j) => num(v, j, s.size))}
              </span>
            );
          case "line":
            return (
              <span
                key={i}
                className="absolute flex items-baseline gap-[2.6cqw]"
                style={{ right: `${s.r}%`, top: `${s.t}%`, textShadow: "0 1px 3px rgba(0,0,0,.7)" }}
              >
                {figures.map((v, j) => num(v, j, s.size))}
              </span>
            );
          case "panel":
            return (
              <span key={i} className="absolute rounded-md bg-black/45 ring-1 ring-white/10" style={box(s)} />
            );
          case "wid":
            /* Le contenu : des blocs, rien de plus. Ce qui compte est la
               hauteur où il commence, pas ce qu'il contient. */
            return (
              <span
                key={i}
                className="absolute grid gap-[2.5%]"
                style={{ ...box(s), gridTemplateColumns: `repeat(${s.cols ?? 3}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: s.cols ?? 3 }, (_, j) => (
                  <span key={j} className="rounded-[4px] bg-[#14151d]/80 ring-1 ring-white/10" />
                ))}
              </span>
            );
          case "cue":
            return (
              <span
                key={i}
                className="absolute bottom-[6%] left-1/2 h-[3.6cqw] w-[3.6cqw] -translate-x-1/2 rotate-45 border-b-2 border-r-2 border-white/75"
              />
            );
        }
      })}
    </span>
  );
}
