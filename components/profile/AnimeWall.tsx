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
    /* LA HAUTEUR NE FAIT QUE MONTER, et elle part de celle de l'écran. Sur un
       téléphone ou une tablette, la barre d'adresse se replie au défilement :
       la fenêtre gagne ou perd 80 px, et chaque variation recalculait le
       nombre d'affiches par colonne et la durée de l'animation — toutes les
       colonnes sautaient et se rechargeaient, d'où les affiches qui
       « clignotaient ». Une colonne un peu trop longue ne coûte rien. */
    let measured = false;
    const fit = () => {
      const w = el.clientWidth;
      const h = Math.max(el.clientHeight, window.screen?.height || 0);
      if (!w || !h) return;
      setSize((s) => {
        const nh = Math.ceil((measured ? Math.max(s.h, h) : h) / 200) * 200;
        measured = true;
        return Math.abs(s.w - w) < 24 && nh === s.h ? s : { w, h: nh };
      });
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
          /* LES BORDS GAUCHE ET DROIT S'ÉTEIGNENT dans le fond, comme les
             carrousels du site (`.as-fade-x`) : un masque, pas un calque noir
             posé dessus — le fond de page passe au travers. La boîte déborde
             d'une demi-colonne, d'où le décalage du dégradé. */
          style={{
            gap: GAP,
            left: -COL_TARGET / 2,
            right: -COL_TARGET / 2,
            ...(() => {
              const m = `linear-gradient(90deg, transparent ${COL_TARGET / 2}px, #000 calc(${COL_TARGET / 2}px + clamp(64px, 14vw, 220px)), #000 calc(100% - ${COL_TARGET / 2}px - clamp(64px, 14vw, 220px)), transparent calc(100% - ${COL_TARGET / 2}px))`;
              return { maskImage: m, WebkitMaskImage: m };
            })(),
          }}
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
                    /* Décodage SYNCHRONE, et c'est voulu : dans un calque qui
                       bouge, une affiche décodée à part peut être effacée puis
                       redécodée par le compositeur, et se voit clignoter. */
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={j}
                      src={src}
                      alt=""
                      decoding="sync"
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
          nom et les widgets posés dessus. UNIFORME, jusqu'aux bords : il était
          assombri en périphérie (0,7) et, cumulé au voile de page, le haut et
          les côtés tombaient au noir sur des affiches sombres — le mur avait
          l'air de s'arrêter avant le bord de l'écran (15/10/2026). */}
      <div className="pointer-events-none absolute inset-0 bg-[rgba(12,13,18,.35)]" />
    </div>
  );
}
