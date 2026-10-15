import type { CSSProperties } from "react";
import type { HeroLayout } from "@/lib/profile/dressing";

/**
 * La vignette d'un agencement dans le studio : la page entière en miniature,
 * réduite à ses formes — le fond, l'avatar, le pseudo, les chiffres, les
 * onglets, les widgets.
 *
 * Ce n'est pas un aperçu (la vraie page le montre déjà, en direct) mais un
 * plan : on y lit OÙ chaque pièce tombe, et donc à quelle hauteur commence le
 * contenu. Les positions sont en % de la vignette, calquées sur ProfileHero
 * pour un écran de 1440 px ; les tailles de texte en `cqw`, pour que le pseudo
 * garde ses proportions quelle que soit la largeur de la case.
 */

type Box = { l: number; t: number; w: number; h: number };
type Shape =
  | ({ k: "av" } & Omit<Box, "h">)
  | ({ k: "name" } & Omit<Box, "h"> & { size: number; center?: boolean })
  | ({ k: "sub" | "panel" | "wid" | "tabs" } & Box)
  | ({ k: "cards" } & Box & { rows?: number })
  | ({ k: "line" } & Box & { right?: boolean })
  | { k: "cue" };

const PLAN: Record<HeroLayout, Shape[]> = {
  band: [
    { k: "av", l: 8, t: 22, w: 16 },
    { k: "name", l: 28, t: 31, w: 60, size: 8 },
    { k: "sub", l: 28, t: 45, w: 22, h: 3.5 },
    { k: "cards", l: 8, t: 54, w: 84, h: 13 },
    { k: "tabs", l: 8, t: 71, w: 84, h: 5 },
    { k: "wid", l: 8, t: 80, w: 84, h: 30 },
  ],
  center: [
    { k: "av", l: 42, t: 8, w: 16 },
    { k: "name", l: 10, t: 36, w: 80, size: 8, center: true },
    { k: "sub", l: 39, t: 48, w: 22, h: 3.5 },
    { k: "cards", l: 8, t: 56, w: 84, h: 13 },
    { k: "tabs", l: 8, t: 73, w: 84, h: 5 },
    { k: "wid", l: 8, t: 82, w: 84, h: 30 },
  ],
  medallion: [
    { k: "av", l: 8, t: 20, w: 24 },
    { k: "name", l: 36, t: 32, w: 56, size: 8 },
    { k: "sub", l: 36, t: 46, w: 22, h: 3.5 },
    { k: "panel", l: 8, t: 60, w: 64, h: 12 },
    { k: "line", l: 12, t: 64, w: 56, h: 4 },
    { k: "tabs", l: 8, t: 77, w: 84, h: 5 },
    { k: "wid", l: 8, t: 86, w: 84, h: 30 },
  ],
  column: [
    { k: "panel", l: 4, t: 38, w: 26, h: 70 },
    { k: "av", l: 8, t: 42, w: 11 },
    { k: "name", l: 8, t: 63, w: 20, size: 4.6 },
    { k: "cards", l: 8, t: 72, w: 18, h: 24, rows: 2 },
    { k: "tabs", l: 34, t: 38, w: 62, h: 5 },
    { k: "wid", l: 34, t: 47, w: 62, h: 60 },
  ],
  showcase: [
    { k: "av", l: 8, t: 56, w: 16 },
    { k: "name", l: 28, t: 62, w: 40, size: 9.5 },
    { k: "sub", l: 28, t: 79, w: 22, h: 3.5 },
    { k: "line", l: 64, t: 70, w: 28, h: 4, right: true },
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
  name,
  fill = false,
}: {
  layout: HeroLayout;
  /** Remplit la hauteur de son parent au lieu de garder le format 16/10. */
  fill?: boolean;
  /** Le fond du brouillon, en valeur CSS `background` : on choisit sur son propre fond. */
  plate: string;
  avatar: string | null;
  name: string;
}) {
  return (
    <span
      className={`relative block w-full overflow-hidden rounded-lg bg-[#101118] ${
        fill ? "h-full" : "aspect-[16/10]"
      }`}
      style={{ containerType: "inline-size" }}
      aria-hidden
    >
      <span className="absolute inset-0" style={{ background: plate }} />
      <span className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/40 to-black/85" />
      {/* la barre de navigation, et les pastilles du fond à droite */}
      <span className="absolute inset-x-[4%] top-[5%] flex items-center gap-[3%]">
        <span className="h-[3px] w-[12%] rounded-full bg-white/85" />
        <span className="h-[2px] w-[7%] rounded-full bg-white/35" />
        <span className="h-[2px] w-[7%] rounded-full bg-white/35" />
        <span className="ml-auto h-[2px] w-[5%] rounded-full bg-white/35" />
      </span>
      <span className="absolute right-[4%] top-[12%] flex gap-[1.5cqw]">
        <span className="h-[3.4cqw] w-[14cqw] rounded-full bg-black/45 ring-1 ring-white/15" />
        <span className="h-[3.4cqw] w-[3.4cqw] rounded-full bg-black/45 ring-1 ring-white/15" />
      </span>
      {PLAN[layout].map((s, i) => {
        switch (s.k) {
          case "av":
            return (
              <span
                key={i}
                className="absolute aspect-square overflow-hidden rounded-full bg-gradient-to-br from-[#2f3b66] to-[#7f6bc4] shadow-[0_2px_6px_rgba(0,0,0,.5)] ring-[1.5px] ring-white/90"
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
                  textShadow: "0 1px 2px rgba(0,0,0,.6)",
                }}
              >
                {name}
              </span>
            );
          case "sub":
            return <span key={i} className="absolute rounded-full bg-white/30" style={at(s)} />;
          case "panel":
            return (
              <span
                key={i}
                className="absolute rounded-md bg-black/45 ring-1 ring-white/10 backdrop-blur-sm"
                style={at(s)}
              />
            );
          case "tabs":
            /* Les onglets, et le bouton « Pour toi » : c'est là que commence le
               contenu, la ligne que chaque agencement déplace. */
            return (
              <span key={i} className="absolute flex items-center justify-between" style={at(s)}>
                <span className="flex h-full w-[46%] gap-[4%] rounded-full bg-black/40 p-[0.5cqw] ring-1 ring-white/10">
                  <span className="h-full flex-1 rounded-full bg-white/85" />
                  <span className="h-full flex-1" />
                  <span className="h-full flex-1" />
                  <span className="h-full flex-1" />
                </span>
                <span className="h-full w-[16%] rounded-full bg-action" />
              </span>
            );
          case "wid":
            return (
              <span key={i} className="absolute grid grid-cols-3 gap-[3%]" style={at(s)}>
                {[0, 1, 2].map((j) => (
                  <span
                    key={j}
                    className="flex flex-col gap-[1.4cqw] rounded-[4px] bg-[#14151d]/85 p-[1.6cqw] ring-1 ring-white/10"
                  >
                    <span className="h-[1.2cqw] w-1/2 rounded-full bg-white/40" />
                    <span className="flex flex-1 gap-[1cqw]">
                      {[0, 1, 2].map((k) => (
                        <span key={k} className="flex-1 rounded-[2px] bg-white/[0.12]" />
                      ))}
                    </span>
                  </span>
                ))}
              </span>
            );
          case "cards": {
            const rows = s.rows ?? 1;
            return (
              <span
                key={i}
                className="absolute grid gap-[3%]"
                style={{ ...at(s), gridTemplateColumns: `repeat(${4 / rows}, minmax(0, 1fr))` }}
              >
                {[0, 1, 2, 3].map((j) => (
                  <span
                    key={j}
                    className="flex flex-col justify-center gap-[0.9cqw] rounded-[4px] bg-[#14151d]/80 px-[1.4cqw] ring-1 ring-white/10"
                  >
                    <span className="h-[0.9cqw] w-[55%] rounded-full bg-white/30" />
                    <span
                      className={`h-[1.8cqw] w-[40%] rounded-full ${j === 3 ? "bg-action" : "bg-white/85"}`}
                    />
                  </span>
                ))}
              </span>
            );
          }
          case "line":
            return (
              <span
                key={i}
                className={`absolute flex items-center gap-[7%] ${s.right ? "justify-end" : ""}`}
                style={at(s)}
              >
                {[0, 1, 2, 3].map((j) => (
                  <span key={j} className="flex h-full w-[18%] items-end gap-[8%]">
                    <span className={`h-full w-[60%] rounded-full ${j === 3 ? "bg-action" : "bg-white/85"}`} />
                    <span className="h-[45%] w-[40%] rounded-full bg-white/35" />
                  </span>
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
