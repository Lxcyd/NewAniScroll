import { useEffect, useMemo, useRef, useState } from "react";
import type { WallDir } from "@/lib/profile/wall";

/**
 * Le mur d'animés : des colonnes d'affiches qui remplissent le fond, et qui
 * peuvent défiler — vers le haut, vers le bas, ou une sur deux à contresens.
 *
 * Il remplit son parent comme les autres fonds (PlateBackground) : le parent
 * porte le `relative` et l'`overflow-hidden`.
 *
 * TOUTE LA SÉLECTION PASSE SUR LE MUR, PAS SEULEMENT CE QUI TIENT À L'ÉCRAN.
 * La première version doublait une suite d'affiches par colonne et la faisait
 * glisser en CSS : seules ~40 à 120 affiches existaient, quand la sélection en
 * comptait 685 (15/10/2026). Mettre les 685 dans des colonnes CSS aurait fait
 * des calques de 30 000 px de haut, que le compositeur repeint par tuiles — et
 * une tuile en retard, c'est une affiche qui disparaît.
 *
 * Chaque colonne est donc une suite INFINIE d'emplacements (k ∈ ℤ, l'affiche
 * k % n de la colonne), dont seuls ceux à l'écran, plus une marge, sont
 * rendus. Une boucle d'animation pose la translation de chaque colonne
 * directement sur le DOM — pas de rendu React par image ; React ne repasse que
 * lorsqu'un emplacement entre ou sort, soit une fois toutes les quelques
 * secondes par colonne. Les emplacements gardent leur clé `k` en glissant :
 * une affiche à l'écran n'est jamais remontée, donc jamais rechargée.
 */

/** Largeur visée d'une colonne : assez pour reconnaître une affiche. */
const COL_TARGET = 150;
const GAP = 12;
/** Le rapport d'une affiche AniList (230×326 et ses multiples). */
const POSTER = 1.42;
/** Emplacements rendus au-delà de chaque bord : le temps de charger l'affiche
    avant qu'elle n'entre. */
const MARGE = 2;

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
       chaque variation recalculait la géométrie, et toutes les colonnes
       sautaient. Une colonne un peu trop longue ne coûte rien. */
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
  const step = itemH + GAP;
  const visibles = Math.ceil(size.h / step) + 1;

  /* Les affiches de chaque colonne : une sur `cols` (c, c+cols, …), donc deux
     voisines ne se suivent jamais. Avec peu d'affiches, chaque colonne reprend
     toute la sélection, décalée — sinon certaines colonnes seraient vides. */
  const parColonne = useMemo(
    () =>
      Array.from({ length: cols }, (_, c) => {
        if (n === 0) return [];
        if (n < cols * 3) return covers.map((_, i) => covers[(i + c * 3) % n]);
        return covers.filter((_, i) => i % cols === c);
      }),
    [covers, cols, n],
  );

  /* Le mouvement de chaque colonne, en px par seconde, signé : positif, le
     contenu monte. Chaque colonne a SA vitesse, à ±15 % : à vitesse égale le
     mur glisse d'un bloc, comme un seul calque, et le relief disparaît. Un
     départ décalé par colonne, sinon toutes les rangées sont alignées. */
  const mouvement = useMemo(
    () =>
      Array.from({ length: cols }, (_, c) => {
        const reverse = dir === "down" || (dir === "alt" && c % 2 === 1);
        /* À CONTRESENS, LA VITESSE EST DIVISÉE PAR DEUX : deux colonnes
           voisines qui se croisent se déplacent l'une par rapport à l'autre au
           double de leur vitesse, et l'œil lit cet écart — à 18 px/s, le mur
           paraissait deux fois plus rapide qu'en sens unique (15/10/2026). */
        const v = speed * (dir === "alt" ? 0.5 : 1) * (0.85 + ((c * 37) % 31) / 100);
        return { v: reverse ? -v : v, phase: ((c * 0.618) % 1) * step * 3 };
      }),
    [cols, dir, speed, step],
  );

  /* Le premier emplacement rendu de chaque colonne. */
  const [debuts, setDebuts] = useState<number[]>([]);
  const pistes = useRef<Array<HTMLDivElement | null>>([]);
  const debutsRef = useRef<number[]>([]);
  /* La position de chaque colonne, INTÉGRÉE image par image : changer la
     vitesse ou le sens dans le studio repart de là où le mur en est, au lieu
     de le faire sauter (une position calculée depuis l'heure de départ
     bondissait à chaque cran du curseur). Repartie de zéro quand le nombre de
     colonnes change — la géométrie n'est alors plus la même. */
  const offs = useRef<number[]>([]);
  useEffect(() => {
    offs.current = mouvement.map((m) => m.phase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, step]);

  useEffect(() => {
    if (n === 0) return;
    let raf = 0;
    let last: number | null = null;
    const dpr = window.devicePixelRatio || 1;
    const pose = (now: number) => {
      /* Un onglet en arrière-plan ne reçoit plus d'images : au retour, l'écart
         est plafonné, le mur reprend sans rattraper la minute perdue. */
      const dt = last == null || !anim ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      let change = false;
      const next = debutsRef.current.slice();
      for (let c = 0; c < cols; c++) {
        if (offs.current[c] == null) offs.current[c] = mouvement[c].phase;
        offs.current[c] += mouvement[c].v * dt;
        const off = offs.current[c];
        const el = pistes.current[c];
        /* CALÉE SUR LES PIXELS DE L'ÉCRAN, jamais entre deux. À 18 px/s la
           colonne avance de ~0,3 px par image : posée à une fraction de pixel,
           chaque arête nette — le passage d'une affiche à l'interstice sombre
           qui la suit — était ré-échantillonnée autrement à chaque image et
           oscillait. Invisible à l'œil nu, mais le flou des widgets
           (`backdrop-filter`) l'amplifiait en clignotement entre deux affiches
           (constaté le 16/10/2026 : disparaît avec le flou à 0, ou le mur
           figé). Un pas d'un pixel physique ne ré-échantillonne rien. */
        if (el) el.style.transform = `translate3d(0, ${-Math.round(off * dpr) / dpr}px, 0)`;
        const k = Math.floor(off / step) - MARGE;
        if (next[c] !== k) {
          next[c] = k;
          change = true;
        }
      }
      if (change) {
        debutsRef.current = next;
        setDebuts(next);
      }
      if (anim) raf = requestAnimationFrame(pose);
    };
    raf = requestAnimationFrame(pose);
    return () => cancelAnimationFrame(raf);
  }, [anim, cols, mouvement, step, n]);

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
          {parColonne.map((items, c) => {
            const debut = debuts[c];
            const len = items.length;
            return (
              <div key={c} className="relative min-w-0 flex-1">
                <div
                  ref={(el) => {
                    pistes.current[c] = el;
                  }}
                  className="as-wall-track absolute inset-x-0 top-0"
                >
                  {debut == null || len === 0
                    ? null
                    : Array.from({ length: visibles + 2 * MARGE }, (_, j) => {
                        const k = debut + j;
                        const src = items[((k % len) + len) % len];
                        return (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={k}
                            src={src}
                            alt=""
                            decoding="async"
                            draggable={false}
                            className="absolute inset-x-0 w-full rounded-lg object-cover shadow-[0_8px_24px_rgba(0,0,0,.45)]"
                            style={{ top: k * step, height: itemH }}
                          />
                        );
                      })}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {/* Le voile du mur : des affiches pleine intensité se battent avec le
          nom et les widgets posés dessus. UNIFORME, jusqu'aux bords : assombri
          en périphérie, il faisait tomber le haut et les côtés au noir. */}
      <div className="pointer-events-none absolute inset-0 bg-[rgba(12,13,18,.35)]" />
    </div>
  );
}
