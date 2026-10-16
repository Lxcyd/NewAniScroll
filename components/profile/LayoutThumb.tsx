import type { CSSProperties } from "react";
import type { HeroLayout } from "@/lib/profile/dressing";

/**
 * La vignette d'un agencement dans le studio, en SQUELETTE : les formes de la
 * page en gris, comme un écran de chargement — pastilles, onglets, widgets —
 * avec, seules pièces réelles, l'avatar, le pseudo et les quatre chiffres du
 * profil : ce qu'on déplace en changeant d'agencement, c'est son identité.
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

type Align = "start" | "center" | "end";

type Shape =
  | { k: "av"; l: number; t: number; w: number }
  /* `badges` : les badges sur la ligne du pseudo, à sa droite (leur échelle). */
  | { k: "name"; l: number; t: number; w: number; size: number; center?: boolean; badges?: number }
  /* La ligne d'identité (logo AniList, identifiant, date). Avec `w`, alignée
     dans cette largeur ; sans, posée à `l`. */
  | { k: "chips"; l: number; t: number; w?: number; scale?: number; align?: Align }
  /* Les badges mis en avant, seuls sur leur ligne. */
  | { k: "badges"; l: number; t: number; w: number; scale?: number; align?: Align }
  | { k: "cards"; l: number; t: number; w: number; h: number; rows?: number }
  | { k: "bar"; l: number; t: number; w: number; h: number }
  /* Les quatre chiffres en 2 × 2, sans cartes (médaillon). */
  | { k: "grid2"; l: number; t: number; w: number; h: number }
  | { k: "tabs"; l: number; t: number; w: number }
  | { k: "panel"; l: number; t: number; w: number; h: number }
  | { k: "wid"; l: number; t: number; w: number; h: number; cols?: number };

/* Redessinées le 16/10/2026 sur les agencements tels qu'ils sont devenus :
   badges à côté du pseudo (bandeau), dessous (centré, colonne), au-dessus des
   chiffres (vitrine) ; chiffres en 2 × 2 dans le médaillon ; plus de chevron
   en vitrine, ce sont les onglets qui dépassent en bas. */
const PLAN: Record<HeroLayout, Shape[]> = {
  band: [
    { k: "av", l: 7, t: 19, w: 17 },
    { k: "name", l: 28, t: 24, w: 64, size: 8, badges: 1 },
    { k: "chips", l: 28, t: 38 },
    { k: "cards", l: 7, t: 54, w: 86, h: 14 },
    { k: "tabs", l: 7, t: 72, w: 86 },
    { k: "wid", l: 7, t: 80, w: 86, h: 40 },
  ],
  center: [
    { k: "av", l: 42.5, t: 3, w: 15 },
    { k: "name", l: 7, t: 28, w: 86, size: 7.5, center: true },
    { k: "badges", l: 7, t: 39, w: 86, align: "center" },
    { k: "chips", l: 7, t: 47.5, w: 86, scale: 0.8, align: "center" },
    { k: "cards", l: 7, t: 56, w: 86, h: 13 },
    { k: "tabs", l: 7, t: 73, w: 86 },
    { k: "wid", l: 7, t: 81, w: 86, h: 40 },
  ],
  medallion: [
    /* Une plaque vitrée qui tient tout, portrait compris. */
    { k: "panel", l: 7, t: 22, w: 86, h: 44 },
    { k: "av", l: 10, t: 30, w: 17 },
    { k: "name", l: 30, t: 33, w: 30, size: 6.5, badges: 0.75 },
    { k: "chips", l: 30, t: 46, scale: 0.8 },
    { k: "grid2", l: 62, t: 27, w: 28, h: 34 },
    { k: "tabs", l: 7, t: 73, w: 86 },
    { k: "wid", l: 7, t: 80, w: 86, h: 40 },
  ],
  column: [
    { k: "panel", l: 4, t: 12, w: 31, h: 95 },
    { k: "av", l: 13.5, t: 16, w: 12 },
    { k: "name", l: 4, t: 37, w: 31, size: 5, center: true },
    { k: "badges", l: 4, t: 45, w: 31, scale: 0.6, align: "center" },
    { k: "chips", l: 4, t: 51.5, w: 31, scale: 0.55, align: "center" },
    { k: "cards", l: 7.5, t: 58, w: 24, h: 28, rows: 2 },
    { k: "tabs", l: 39, t: 12, w: 57 },
    { k: "wid", l: 39, t: 21, w: 57, h: 90, cols: 2 },
  ],
  showcase: [
    { k: "av", l: 6, t: 57, w: 16 },
    { k: "name", l: 25, t: 62, w: 28, size: 7 },
    { k: "chips", l: 25, t: 75, scale: 0.8 },
    { k: "badges", l: 55, t: 57, w: 39, scale: 0.8, align: "end" },
    { k: "bar", l: 55, t: 70, w: 39, h: 11 },
    { k: "tabs", l: 6, t: 92, w: 88 },
  ],
};

/* Trois gris : le fond des objets, les formes pleines, ce qu'on lit d'abord. */
const SURFACE = "bg-white/[0.05] ring-1 ring-white/[0.06]";
const SHAPE = "bg-white/[0.13]";
const STRONG = "bg-white/[0.24]";

const PLACEHOLDER = ["—", "—", "—", "—"];

export default function LayoutThumb({
  layout,
  avatar,
  name,
  stats,
  fill = false,
}: {
  layout: HeroLayout;
  avatar: string | null;
  name: string;
  /** Les quatre chiffres formatés du haut de profil. */
  stats?: string[];
  /** Remplit la hauteur de son parent au lieu de garder le format 16/10. */
  fill?: boolean;
}) {
  const values = stats && stats.length === 4 ? stats : PLACEHOLDER;
  const box = (s: { l: number; t: number; w: number; h: number }): CSSProperties => ({
    left: `${s.l}%`,
    top: `${s.t}%`,
    width: `${s.w}%`,
    height: `${s.h}%`,
  });
  /* Un chiffre : sa vraie valeur, sous son intitulé (pâle, en gris). */
  const figure = (j: number, label = true, size = 3.6) => (
    <span key={j} className="flex flex-col gap-[0.8cqw]">
      {label ? <span className={`h-[0.9cqw] w-[6cqw] rounded-full ${SHAPE}`} /> : null}
      <span
        className="font-outfit font-bold leading-none tabular-nums text-white/80"
        style={{ fontSize: `${size}cqw` }}
      >
        {values[j]}
      </span>
    </span>
  );

  /* Un badge : un hexagone, comme les vrais jetons. */
  const badgeRow = (k: number) =>
    [0, 1, 2].map((j) => (
      <span
        key={j}
        className={`shrink-0 ${j === 0 ? "bg-white/[0.32]" : STRONG}`}
        style={{
          width: `${4.6 * k}cqw`,
          height: `${4.6 * k}cqw`,
          clipPath: "polygon(50% 0, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)",
        }}
      />
    ));
  const justify = (a?: Align) =>
    a === "center" ? "justify-center" : a === "end" ? "justify-end" : "justify-start";

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
                className={`absolute aspect-square overflow-hidden rounded-full ${STRONG}`}
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
                className={`absolute flex items-center gap-[1.6cqw] ${s.center ? "justify-center" : ""}`}
                style={{ left: `${s.l}%`, top: `${s.t}%`, width: `${s.w}%` }}
              >
                <span
                  className="min-w-0 truncate font-outfit font-bold leading-none text-white/90"
                  style={{ fontSize: `${s.size}cqw` }}
                >
                  {name}
                </span>
                {s.badges ? (
                  <span className="flex shrink-0" style={{ gap: `${0.8 * s.badges}cqw` }}>
                    {badgeRow(s.badges)}
                  </span>
                ) : null}
              </span>
            );
          case "chips": {
            const k = s.scale ?? 1;
            return (
              <span
                key={i}
                className={`absolute flex items-center ${justify(s.align)}`}
                style={{
                  left: `${s.l}%`,
                  top: `${s.t}%`,
                  width: s.w != null ? `${s.w}%` : undefined,
                  gap: `${k}cqw`,
                }}
              >
                {/* Le logo AniList, rond, puis l'identifiant et la date. */}
                <span
                  className={`shrink-0 rounded-full ${STRONG}`}
                  style={{ width: `${2.6 * k}cqw`, height: `${2.6 * k}cqw` }}
                />
                {[7, 13].map((w) => (
                  <span
                    key={w}
                    className={`shrink-0 rounded-[2px] ${SHAPE}`}
                    style={{ width: `${w * k}cqw`, height: `${2.4 * k}cqw` }}
                  />
                ))}
              </span>
            );
          }
          case "badges": {
            const k = s.scale ?? 1;
            return (
              <span
                key={i}
                className={`absolute flex ${justify(s.align)}`}
                style={{ left: `${s.l}%`, top: `${s.t}%`, width: `${s.w}%`, gap: `${0.8 * k}cqw` }}
              >
                {badgeRow(k)}
              </span>
            );
          }
          case "grid2":
            return (
              <span key={i} className="absolute grid grid-cols-2 content-around gap-x-[2cqw]" style={box(s)}>
                {[0, 1, 2, 3].map((j) => figure(j, true, 4.4))}
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
                {[0, 1, 2, 3].map((j) => (
                  <span key={j} className={`flex items-center overflow-hidden rounded-[4px] px-[1.6cqw] ${SURFACE}`}>
                    {figure(j, rows === 1, rows === 1 ? 4 : 3)}
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
        }
      })}
    </span>
  );
}
