import type { CSSProperties } from "react";
import type { HeroLayout } from "@/lib/profile/dressing";

/**
 * La vignette d'un agencement dans le studio : la page entière en miniature,
 * réduite à ses formes — le fond, l'avatar, le nom, les chiffres, les widgets.
 *
 * Ce n'est pas un aperçu (la vraie page le montre déjà, en direct) mais un
 * plan : on y lit OÙ chaque pièce tombe, et donc à quelle hauteur commence le
 * contenu. Les positions sont en % de la vignette, calquées sur ProfileHero
 * pour un écran de 1440 px.
 */

type Box = { l: number; t: number; w: number; h: number };
type Shape =
  | ({ k: "av" } & Omit<Box, "h">)
  | ({ k: "name" | "sub" | "panel" | "wid" } & Box)
  | ({ k: "cards" } & Box & { n: number; rows?: number })
  | ({ k: "line" } & Box & { right?: boolean })
  | { k: "cue" };

const PLAN: Record<HeroLayout, Shape[]> = {
  band: [
    { k: "av", l: 8, t: 26, w: 16 },
    { k: "name", l: 28, t: 34, w: 30, h: 7 },
    { k: "sub", l: 28, t: 45, w: 20, h: 4 },
    { k: "cards", l: 8, t: 58, w: 84, h: 12, n: 4 },
    { k: "wid", l: 8, t: 76, w: 84, h: 30 },
  ],
  center: [
    { k: "av", l: 42, t: 10, w: 16 },
    { k: "name", l: 35, t: 39, w: 30, h: 7 },
    { k: "sub", l: 40, t: 50, w: 20, h: 4 },
    { k: "cards", l: 8, t: 60, w: 84, h: 12, n: 4 },
    { k: "wid", l: 8, t: 78, w: 84, h: 30 },
  ],
  medallion: [
    { k: "av", l: 8, t: 28, w: 24 },
    { k: "name", l: 36, t: 40, w: 30, h: 7 },
    { k: "sub", l: 36, t: 51, w: 20, h: 4 },
    { k: "line", l: 8, t: 70, w: 56, h: 4 },
    { k: "wid", l: 8, t: 80, w: 84, h: 30 },
  ],
  column: [
    { k: "panel", l: 4, t: 40, w: 26, h: 70 },
    { k: "av", l: 8, t: 45, w: 11 },
    { k: "name", l: 8, t: 66, w: 18, h: 5 },
    { k: "cards", l: 8, t: 76, w: 18, h: 22, n: 4, rows: 2 },
    { k: "wid", l: 34, t: 40, w: 62, h: 70 },
  ],
  showcase: [
    { k: "av", l: 8, t: 62, w: 16 },
    { k: "name", l: 28, t: 68, w: 34, h: 8 },
    { k: "sub", l: 28, t: 80, w: 20, h: 4 },
    { k: "line", l: 64, t: 73, w: 28, h: 4, right: true },
    { k: "cue" },
  ],
};

const at = (b: Box): CSSProperties => ({
  left: `${b.l}%`,
  top: `${b.t}%`,
  width: `${b.w}%`,
  height: `${b.h}%`,
});

export default function LayoutThumb({
  layout,
  plate,
  avatar,
}: {
  layout: HeroLayout;
  /** Le fond du brouillon, en valeur CSS `background` : on choisit sur son propre fond. */
  plate: string;
  avatar: string | null;
}) {
  return (
    <span
      className="relative block aspect-[16/10] w-full overflow-hidden rounded-lg bg-[#101118]"
      aria-hidden
    >
      <span className="absolute inset-0" style={{ background: plate }} />
      <span className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/40 to-black/85" />
      {/* la barre de navigation */}
      <span className="absolute inset-x-[4%] top-[5%] flex items-center gap-[3%]">
        <span className="h-[3px] w-[12%] rounded-full bg-white/80" />
        <span className="h-[2px] w-[7%] rounded-full bg-white/35" />
        <span className="h-[2px] w-[7%] rounded-full bg-white/35" />
      </span>
      {PLAN[layout].map((s, i) => {
        switch (s.k) {
          case "av":
            return (
              <span
                key={i}
                className="absolute aspect-square overflow-hidden rounded-full bg-gradient-to-br from-[#2f3b66] to-[#7f6bc4] ring-[1.5px] ring-white/90"
                style={{ left: `${s.l}%`, top: `${s.t}%`, width: `${s.w}%` }}
              >
                {avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatar} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : null}
              </span>
            );
          case "name":
            return <span key={i} className="absolute rounded-sm bg-white/90" style={at(s)} />;
          case "sub":
            return <span key={i} className="absolute rounded-sm bg-white/30" style={at(s)} />;
          case "panel":
            return (
              <span key={i} className="absolute rounded-md bg-white/[0.07] ring-1 ring-white/10" style={at(s)} />
            );
          case "wid":
            return (
              <span key={i} className="absolute grid grid-cols-3 gap-[4%]" style={at(s)}>
                {[0, 1, 2].map((j) => (
                  <span key={j} className="rounded-[3px] bg-white/[0.09] ring-1 ring-white/10" />
                ))}
              </span>
            );
          case "cards":
            return (
              <span
                key={i}
                className="absolute grid gap-[3%]"
                style={{
                  ...at(s),
                  gridTemplateColumns: `repeat(${s.n / (s.rows ?? 1)}, minmax(0, 1fr))`,
                }}
              >
                {Array.from({ length: s.n }, (_, j) => (
                  <span
                    key={j}
                    className={`rounded-[3px] ring-1 ring-white/10 ${
                      j === s.n - 1 ? "bg-action/50" : "bg-white/[0.12]"
                    }`}
                  />
                ))}
              </span>
            );
          case "line":
            return (
              <span
                key={i}
                className={`absolute flex gap-[8%] ${s.right ? "justify-end" : ""}`}
                style={at(s)}
              >
                {[0, 1, 2, 3].map((j) => (
                  <span
                    key={j}
                    className={`h-full w-[18%] rounded-sm ${j === 3 ? "bg-action" : "bg-white/70"}`}
                  />
                ))}
              </span>
            );
          case "cue":
            return (
              <span
                key={i}
                className="absolute bottom-[5%] left-1/2 h-[7%] w-[4.4%] -translate-x-1/2 rotate-45 border-b-[1.5px] border-r-[1.5px] border-white/70"
              />
            );
        }
      })}
    </span>
  );
}
