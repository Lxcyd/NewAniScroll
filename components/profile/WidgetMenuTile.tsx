import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { pixelRect } from "@/lib/profile/grid";
import type { WidgetPreview } from "@/lib/profile/widgetBridge";

/**
 * UNE CASE DU MENU WIDGETS DU STUDIO (07/11/2026, Luc) : l'aperçu du widget,
 * dessiné par la grille elle-même (même titre, même contenu), réduit dans une
 * case 1×2. Un clic l'ajoute à la fin du profil, sauf s'il y est déjà.
 */

/** La largeur de grille à laquelle l'aperçu est dessiné avant réduction. */
const NOMINAL = 1100;

/** L'ombre de la case verrouillée arrive en fondu, avec le flou du menu
    (08/11/2026, Luc). Hors composant : passée en `ref`, elle ne joue qu'au
    montage. */
function fadeIn(el: HTMLElement | null) {
  el?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: "ease-out" });
}

/* LE WIDGET TEL QU'IL EST (08/11/2026, Luc : « affiche exactement le widget,
   et comme il est carré laisse des gaps à droite et à gauche ») : dessiné à sa
   taille sur le profil (cases × largeur de la grille), puis réduit pour tenir
   ENTIER dans la case, centré. Un widget carré laisse donc des marges sur les
   côtés au lieu d'être étiré au format de la case. */
function MiniWidget({ preview }: { preview: WidgetPreview }) {
  const { chrome, w, h, gridW } = preview;
  const r = pixelRect({ i: "", x: 0, y: 0, w, h }, gridW || NOMINAL);
  const box = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      if (!el.clientWidth || !r.width || !r.height) return;
      setS(Math.min(el.clientWidth / r.width, el.clientHeight / r.height));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [r.width, r.height]);
  return (
    <div ref={box} className="pointer-events-none relative h-full w-full select-none" aria-hidden>
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: r.width,
          height: r.height,
          transform: `translate(-50%, -50%) scale(${s})`,
          visibility: s ? undefined : "hidden",
        }}
      >
        {/* La même carte que la grille (WidgetGrid) : `as-widget` en fait un
            conteneur de requête, le contenu se met donc en page pour SA taille. */}
        <section className="as-widget as-stat-card flex h-full w-full flex-col overflow-hidden rounded-[20px] px-5 py-4 outline outline-1 outline-offset-[-1px] outline-white/10">
          <header className="relative z-[1] mb-3 flex shrink-0 items-center">
            <h2 className="as-widget-head flex min-w-0 flex-1 items-center gap-2 font-outfit text-lg font-bold text-white">
              <span className="min-w-0 truncate">{chrome.title}</span>
            </h2>
          </header>
          <div className="min-h-0 flex-1 [&_*]:pointer-events-none">{chrome.body}</div>
        </section>
      </div>
    </div>
  );
}

export default function WidgetMenuTile({
  id,
  label,
  desc,
  on,
  disabled,
  shaded = false,
  preview,
  onAdd,
  badge,
}: {
  id: string;
  label: string;
  desc: string;
  on: boolean;
  disabled: boolean;
  /** L'ombre du menu verrouillé ; elle survit à `disabled` le temps de
      s'effacer en fondu. */
  shaded?: boolean;
  preview: ((id: string) => WidgetPreview | null) | null;
  /** Ajoute le widget à la fin du profil (ou y descend s'il y est déjà). */
  onAdd: () => void;
  /** Le « + » ou la coche du coin. */
  badge: React.ReactNode;
}) {
  const tile = useRef<HTMLButtonElement>(null);
  /* L'aperçu ne se dessine qu'une fois la case vue : dix-huit widgets vivants
     d'un coup, c'est autant de contenus calculés pour rien. */
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = tile.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setSeen(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const shown = seen && preview ? preview(id) : null;

  return (
    <button
      ref={tile}
      type="button"
      /* Déjà sur le profil : la case ne se reclique pas (07/11/2026, Luc). */
      disabled={disabled || on}
      aria-pressed={on}
      onClick={onAdd}
      /* `group/tile` et pas `group` : le contenu des widgets (cartes du Bingo,
         jours du calendrier) a ses propres `group-hover`, que le survol de la
         case déclenchait tous à la fois (08/11/2026, Luc). */
      className={`group/tile relative block w-full min-w-0 cursor-pointer overflow-hidden rounded-xl text-left transition-[color,background-color,box-shadow] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-default ${
        /* Verrouillé (autre onglet que l'Aperçu), la case garde son visuel :
           le menu la floute et la grise par-dessus. */
        on
          ? /* Le rose en valeur directe : `ring-action/45` (couleur du thème
               + opacité) retombait sur le bleu par défaut du ring. */
            `bg-action/10 opacity-60 ring-2 ${disabled ? "ring-[rgba(233,69,96,0.55)]" : "ring-action"}`
            /* (l'atténuation suit `disabled` : elle a sa propre transition) */
          : "bg-white/[0.03] ring-1 ring-white/10"
      }`}
    >
      {/* L'aperçu, au format 2:1. */}
      <span className="relative block aspect-[2/1] p-2">
        {shown ? <MiniWidget preview={shown} /> : null}
        {/* AUCUN SURVOL DANS L'APERÇU (08/11/2026, Luc) : un voile au-dessus
            reçoit le pointeur. `pointer-events: none` sur le contenu ne
            suffisait pas : un élément du widget marqué `pointer-events-auto`
            le rétablit pour lui, et son survol s'animait. */}
        <span className="absolute inset-0 z-[5]" aria-hidden />

        <span className="absolute right-2 top-2 z-10">{badge}</span>
      </span>
      {/* LA LÉGENDE SOUS L'APERÇU (08/11/2026, Luc, proposition 1) : le nom
          et la phrase du widget, hors de l'aperçu pour ne rien en cacher. */}
      <span className="flex flex-col gap-0.5 px-3 pb-3 pt-1">
        <span className="font-outfit text-sm font-bold text-white">{label}</span>
        <span className="font-karla text-xs leading-snug text-white/60">{desc}</span>
      </span>
      {/* VERROUILLÉE (autre onglet que l'Aperçu) : la case s'assombrit
          elle-même, rognée à son arrondi, l'ombre ne déborde pas sur la
          colonne. Le flou, lui, vient du voile du menu (BannerStudio).
          (08/11/2026, Luc). Au-dessus du « + » et de la coche. */}
      {shaded ? (
        <span ref={fadeIn} data-widgets-veil className="absolute inset-0 z-20 bg-[#101116]/[0.82]" aria-hidden />
      ) : null}
    </button>
  );
}
