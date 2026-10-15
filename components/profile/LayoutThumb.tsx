import type { CSSProperties } from "react";
import type { HeroLayout } from "@/lib/profile/dressing";

/**
 * La vignette d'un agencement dans le studio : la page en miniature, avec SES
 * pièces à elle — le fond du brouillon, le vrai avatar, le vrai pseudo, les
 * vrais chiffres — puis les pastilles, les onglets et les widgets tels qu'ils
 * se présentent sur la page (onglet actif rouge, « Reprendre la lecture »,
 * « Répartition par statut » et ses barres de couleur).
 *
 * Deux versions écartées le 15/10/2026 : l'une toute en barres grises (une
 * vignette de 200 px faite de barres ne se lit plus — la pilule du fond
 * passait pour un interrupteur), l'autre réduite à l'avatar, au nom et à des
 * pavés vides (lisible mais vide). Ce qui reste figuré ici l'est d'après un
 * élément reconnaissable de la vraie page, jamais d'après une forme abstraite.
 *
 * Positions en % de la vignette, tailles en `cqw` : la vignette peut changer
 * de taille avec sa ligne de menu sans que rien ne change de proportion.
 */

type Shape =
  | { k: "av"; l: number; t: number; w: number }
  | { k: "name"; l: number; t: number; w: number; size: number; center?: boolean }
  | { k: "chips"; l: number; t: number; scale?: number; center?: boolean }
  | { k: "cards"; l: number; t: number; w: number; h: number; size: number; rows?: number }
  | { k: "bar"; l: number; t: number; w: number; h: number; size: number }
  | { k: "line"; r: number; t: number; size: number }
  | { k: "tabs"; l: number; t: number; w: number }
  | { k: "panel"; l: number; t: number; w: number; h: number }
  | { k: "wid"; l: number; t: number; w: number; h: number; cols?: number }
  | { k: "cue" };

const PLAN: Record<HeroLayout, Shape[]> = {
  band: [
    { k: "av", l: 7, t: 19, w: 17 },
    { k: "name", l: 28, t: 28, w: 64, size: 8.5 },
    { k: "chips", l: 28, t: 43 },
    { k: "cards", l: 7, t: 54, w: 86, h: 14, size: 4.6 },
    { k: "tabs", l: 7, t: 72, w: 86 },
    { k: "wid", l: 7, t: 80, w: 86, h: 40 },
  ],
  center: [
    { k: "av", l: 41.5, t: 4, w: 17 },
    { k: "name", l: 7, t: 33, w: 86, size: 8.5, center: true },
    { k: "chips", l: 0, t: 45, center: true },
    { k: "cards", l: 7, t: 54, w: 86, h: 14, size: 4.6 },
    { k: "tabs", l: 7, t: 72, w: 86 },
    { k: "wid", l: 7, t: 80, w: 86, h: 40 },
  ],
  medallion: [
    { k: "av", l: 7, t: 12, w: 26 },
    { k: "name", l: 37, t: 26, w: 56, size: 8.5 },
    { k: "chips", l: 37, t: 41 },
    { k: "bar", l: 7, t: 56, w: 86, h: 12, size: 4.6 },
    { k: "tabs", l: 7, t: 72, w: 86 },
    { k: "wid", l: 7, t: 80, w: 86, h: 40 },
  ],
  column: [
    { k: "panel", l: 4, t: 12, w: 31, h: 95 },
    { k: "av", l: 7.5, t: 17, w: 12 },
    { k: "name", l: 7.5, t: 39, w: 25, size: 5.2 },
    { k: "chips", l: 7.5, t: 48, scale: 0.6 },
    { k: "cards", l: 7.5, t: 57, w: 24, h: 28, size: 3.3, rows: 2 },
    { k: "tabs", l: 39, t: 12, w: 57 },
    { k: "wid", l: 39, t: 21, w: 57, h: 90, cols: 2 },
  ],
  showcase: [
    { k: "av", l: 7, t: 58, w: 17 },
    { k: "name", l: 28, t: 63, w: 28, size: 8 },
    { k: "chips", l: 28, t: 77 },
    { k: "line", r: 6, t: 68, size: 3.6 },
    { k: "cue" },
  ],
};

const PLACEHOLDER = ["—", "—", "—", "—"];

/** Les couleurs du widget « Répartition par statut », dans son ordre. */
const STATUS_BARS: [string, number][] = [
  ["#34d399", 42],
  ["#60a5fa", 6],
  ["#3b82f6", 70],
  ["#a855f7", 100],
  ["#fb923c", 34],
  ["#ef4444", 6],
];

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

  /* Les widgets, chacun d'après le vrai : une couverture avec son bouton de
     lecture, des barres de statut, une rangée d'affiches. */
  const widget = (j: number) => {
    const head = <span className="h-[1.2cqw] w-[45%] shrink-0 rounded-full bg-white/45" />;
    const kind = j % 3;
    return (
      <span
        key={j}
        className="flex min-w-0 flex-col gap-[1.6cqw] overflow-hidden rounded-[4px] bg-[#14151d]/85 p-[1.8cqw] ring-1 ring-white/10"
      >
        {head}
        {kind === 0 ? (
          <span className="flex gap-[1.6cqw]">
            <span className="relative grid aspect-[4/3] w-[48%] shrink-0 place-items-center rounded-[2px] bg-gradient-to-br from-[#f2c46d] via-[#e0705a] to-[#6b2154]">
              <span className="h-[3cqw] w-[3cqw] rounded-full bg-action" />
            </span>
            <span className="flex flex-1 flex-col gap-[1cqw] pt-[0.4cqw]">
              <span className="h-[1.2cqw] w-full rounded-full bg-white/70" />
              <span className="h-[1.2cqw] w-[70%] rounded-full bg-white/70" />
              <span className="mt-auto h-[2.2cqw] w-[60%] rounded-full bg-action" />
            </span>
          </span>
        ) : kind === 1 ? (
          <span className="flex flex-col gap-[1.1cqw]">
            {STATUS_BARS.map(([c, w]) => (
              <span key={c} className="flex items-center gap-[1cqw]">
                <span className="h-[1cqw] w-[1cqw] shrink-0 rounded-full" style={{ background: c }} />
                <span className="h-[0.9cqw] rounded-full" style={{ background: c, width: `${w * 0.8}%` }} />
              </span>
            ))}
          </span>
        ) : (
          <span className="grid grid-cols-3 gap-[1cqw]">
            {["#57c3e8,#1b3b6e", "#c39bff,#3b1f6e", "#9be29b,#1f5a46"].map((g) => (
              <span
                key={g}
                className="aspect-[2/3] rounded-[2px]"
                style={{ background: `linear-gradient(160deg, ${g})` }}
              />
            ))}
          </span>
        )}
      </span>
    );
  };

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
          case "chips": {
            /* #tag puis AniList, comme sous le vrai pseudo. */
            const k = s.scale ?? 1;
            return (
              <span
                key={i}
                className={`absolute flex ${s.center ? "inset-x-0 justify-center" : ""}`}
                style={{ left: s.center ? undefined : `${s.l}%`, top: `${s.t}%`, gap: `${k}cqw` }}
              >
                <span
                  className="rounded-[2px] bg-black/55 ring-1 ring-white/10"
                  style={{ width: `${9 * k}cqw`, height: `${2.6 * k}cqw` }}
                />
                <span
                  className="rounded-[2px] bg-[#02a9ff]/35 ring-1 ring-[#02a9ff]/45"
                  style={{ width: `${13 * k}cqw`, height: `${2.6 * k}cqw` }}
                />
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
                {figures.map((v, j) => (
                  <span
                    key={j}
                    className="flex flex-col justify-center gap-[0.8cqw] overflow-hidden rounded-[4px] bg-[#14151d]/85 px-[1.6cqw] ring-1 ring-white/10"
                  >
                    {rows === 1 ? <span className="h-[0.8cqw] w-[50%] rounded-full bg-white/30" /> : null}
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
                className="absolute flex items-baseline gap-[2.4cqw]"
                style={{ right: `${s.r}%`, top: `${s.t}%`, textShadow: "0 1px 3px rgba(0,0,0,.7)" }}
              >
                {figures.map((v, j) => num(v, j, s.size))}
              </span>
            );
          case "tabs":
            /* Aperçu (actif, rouge), Ma liste, Statistiques, Badges — et
               « Pour toi » au bout. */
            return (
              <span
                key={i}
                className="absolute flex items-center justify-between"
                style={{ left: `${s.l}%`, top: `${s.t}%`, width: `${s.w}%`, height: "3.4cqw" }}
              >
                <span className="flex h-full items-center gap-[1.4cqw] rounded-full bg-black/45 pr-[1.6cqw] ring-1 ring-white/10">
                  <span className="h-full w-[8cqw] rounded-full bg-action" />
                  <span className="h-[0.9cqw] w-[5cqw] rounded-full bg-white/55" />
                  <span className="h-[0.9cqw] w-[6cqw] rounded-full bg-white/55" />
                  <span className="h-[0.9cqw] w-[4cqw] rounded-full bg-white/55" />
                </span>
                <span className="h-full w-[9cqw] rounded-full bg-action" />
              </span>
            );
          case "panel":
            return (
              <span key={i} className="absolute rounded-md bg-black/50 ring-1 ring-white/10" style={box(s)} />
            );
          case "wid":
            return (
              <span
                key={i}
                className="absolute grid items-start gap-[2.5%]"
                style={{ ...box(s), gridTemplateColumns: `repeat(${s.cols ?? 3}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: s.cols ?? 3 }, (_, j) => widget(j))}
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
