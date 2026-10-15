import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { WallDir } from "@/lib/profile/wall";

/**
 * Le mur d'animés : des colonnes d'affiches qui remplissent le fond, et qui
 * peuvent défiler — vers le haut, vers le bas, ou une sur deux à contresens.
 *
 * Il remplit son parent comme les autres fonds (PlateBackground) : le parent
 * porte le `relative` et l'`overflow-hidden`.
 *
 * LE DÉFILEMENT EST UNE ANIMATION CSS, PAS UNE BOUCLE JS. Chaque colonne porte
 * sa suite d'affiches DEUX FOIS, et glisse d'exactement la moitié de sa hauteur
 * (`as-wall-scroll`, globals.css) : la fin est identique au début, la reprise
 * ne se voit pas. Le navigateur la compose sur le GPU, la page n'est jamais
 * re-rendue pour un pixel de défilement.
 *
 * La géométrie (nombre de colonnes, affiches par colonne) se mesure sur la
 * boîte réelle : une valeur par défaut tient le rendu serveur, puis la mesure
 * la remplace — le mur n'a pas de sens imprimé, il n'y a donc rien à hydrater
 * au pixel près.
 */

/** Largeur visée d'une colonne : assez pour reconnaître une affiche. */
const COL_TARGET = 150;
const GAP = 12;
/** Le rapport d'une affiche AniList (230×326 et ses multiples). */
const POSTER = 1.42;

export default function AnimeWall({
  covers,
  anim,
  dir,
  speed,
}: {
  covers: string[];
  anim: boolean;
  dir: WallDir;
  /** px par seconde. */
  speed: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1440, h: 900 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w && h) setSize((s) => (Math.abs(s.w - w) < 8 && Math.abs(s.h - h) < 8 ? s : { w, h }));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);

  const n = covers.length;
  const cols = Math.max(3, Math.min(14, Math.round(size.w / COL_TARGET)));
  /* Les colonnes débordent d'une demi-colonne de chaque côté : un mur coupé
     net au bord de l'écran se lit comme un cadre, pas comme un mur. */
  const colW = (size.w + COL_TARGET - GAP * (cols - 1)) / cols;
  const itemH = colW * POSTER;
  /* Une colonne doit couvrir l'écran, plus une affiche pour la reprise. */
  const perCol = Math.max(2, Math.ceil(size.h / (itemH + GAP)) + 1);
  const half = perCol * (itemH + GAP);

  return (
    <div ref={box} className="absolute inset-0 overflow-hidden bg-[#0c0d12]" aria-hidden>
      {n > 0 ? (
        <div
          className="absolute inset-y-0 flex"
          style={{ gap: GAP, left: -COL_TARGET / 2, right: -COL_TARGET / 2 }}
        >
          {Array.from({ length: cols }, (_, c) => {
            /* Les affiches tournent d'une colonne à l'autre (c, c+cols, …) : deux
               voisines ne commencent jamais par la même. */
            const items = Array.from({ length: perCol }, (_, j) => covers[(c + j * cols) % n]);
            const reverse = dir === "down" || (dir === "alt" && c % 2 === 1);
            /* Chaque colonne a SA vitesse, à ±15 % : à vitesse égale le mur
               glisse d'un bloc, comme un seul calque, et le relief disparaît. */
            const v = speed * (0.85 + ((c * 37) % 31) / 100);
            const duration = half / Math.max(1, v);
            const style: CSSProperties = anim
              ? {
                  /* En pixels, pas en `-50 %` : la piste compte un écart de
                     moins qu'elle n'a d'affiches, et la moitié en pourcentage
                     tombait un demi-écart à côté — un sursaut à chaque tour. */
                  ["--wall-half" as string]: `${half.toFixed(2)}px`,
                  animationDuration: `${duration.toFixed(2)}s`,
                  animationDirection: reverse ? "reverse" : "normal",
                  /* Un départ décalé par colonne : sinon toutes les rangées
                     sont alignées au premier rendu. */
                  animationDelay: `${(-duration * ((c * 0.618) % 1)).toFixed(2)}s`,
                }
              : { transform: `translateY(${-((c % 2) * (itemH + GAP)) / 2}px)` };
            return (
              <div key={c} className="relative min-w-0 flex-1">
                <div className={`flex flex-col ${anim ? "as-wall-scroll" : ""}`} style={{ gap: GAP, ...style }}>
                  {[...items, ...(anim ? items : [])].map((src, j) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={j}
                      src={src}
                      alt=""
                      decoding="async"
                      draggable={false}
                      className="w-full shrink-0 rounded-lg object-cover shadow-[0_8px_24px_rgba(0,0,0,.45)]"
                      style={{ height: itemH }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {/* Le voile du mur : des affiches pleine intensité se battent avec le
          nom et les widgets posés dessus. Plus sombre aux bords. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 40%, rgba(12,13,18,.35) 0%, rgba(12,13,18,.7) 100%)",
        }}
      />
    </div>
  );
}
