import { useEffect, useRef, useState } from "react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import FramedAvatar from "@/components/profile/FramedAvatar";
import { AVATAR_FOCUS_Y, AVATAR_ZOOM_MAX, AVATAR_ZOOM_MIN, type AvatarCrop } from "@/lib/profile/dressing";

/**
 * LE CADRAGE DE L'AVATAR (24/10/2026, Luc) : l'image choisie se règle dans son
 * rond, telle qu'elle paraîtra sur le profil — SANS le cadre, qui cachait ce
 * qu'on cadre.
 *
 *   — glisser dans le rond déplace l'image (le point visé, en %) — la main du
 *     curseur et la phrase sous le rond le disent, sans icônes par-dessus ;
 *   — la molette ou le curseur zooment (100-400 %) ;
 *   — double-clic : recentré ;
 *   — au clavier : flèches pour cadrer, + et − pour zoomer.
 *
 * Le cadrage est en POURCENTAGES (`object-position` + `scale`) : le même à
 * toute taille d'avatar, du téléphone au médaillon (cf. `cropStyle`). La
 * taille de l'avatar, elle, se règle dans Agencement.
 */
const DEFAULT: AvatarCrop = { x: 50, y: AVATAR_FOCUS_Y, zoom: 100 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function AvatarCropper({
  src,
  name,
  crop,
  onCrop,
  t,
}: {
  src: string | null;
  name: string;
  crop: AvatarCrop | null;
  onCrop: (c: AvatarCrop | null) => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const c = crop ?? DEFAULT;
  const cur = useRef(c);
  cur.current = c;
  const set = (next: AvatarCrop) => {
    const n = {
      x: clamp(next.x, 0, 100),
      y: clamp(next.y, 0, 100),
      zoom: clamp(next.zoom, AVATAR_ZOOM_MIN, AVATAR_ZOOM_MAX),
    };
    onCrop(n.x === 50 && n.y === AVATAR_FOCUS_Y && n.zoom === 100 ? null : n);
  };
  const setRef = useRef(set);
  setRef.current = set;

  /* Le glisser : le point visé suit la main à l'envers (tirer l'image vers la
     droite montre sa gauche), plus lentement à fort zoom. */
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const stop = () => {
    drag.current = null;
    setDragging(false);
  };

  /* La molette zoome sans faire défiler le menu : l'écouteur doit être actif
     (non passif) pour pouvoir l'empêcher. */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = cur.current;
      setRef.current({ ...k, zoom: k.zoom - e.deltaY * 0.3 });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const pill =
    "flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5 font-karla text-[12px] font-bold text-white/75 ring-1 ring-white/10 transition-colors enabled:hover:bg-white/[0.1] enabled:hover:text-white disabled:opacity-40";
  const zoomPct = ((c.zoom - AVATAR_ZOOM_MIN) / (AVATAR_ZOOM_MAX - AVATAR_ZOOM_MIN)) * 100;

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-white/[0.035] px-4 py-3 ring-1 ring-white/10">
      {/* L'aperçu. */}
      <div className="flex flex-col items-center gap-2">
        <div className="relative grid h-40 w-40 place-items-center">
          <FramedAvatar src={src} name={name} crop={c} px={384} sizeClass="h-36 w-36" textClass="text-5xl" />
          <div
            ref={box}
            role="slider"
            tabIndex={0}
            aria-label={t("profile.studioAvatarCropAria")}
            aria-valuetext={`${Math.round(c.x)} %, ${Math.round(c.y)} %, ${Math.round(c.zoom)} %`}
            onPointerDown={(e) => {
              if (!src) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const r = e.currentTarget.getBoundingClientRect();
              drag.current = { px: e.clientX, py: e.clientY, x: c.x, y: c.y, size: r.width };
              setDragging(true);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const k = 140 / (cur.current.zoom / 100);
              set({
                ...cur.current,
                x: d.x - ((e.clientX - d.px) / d.size) * k,
                y: d.y - ((e.clientY - d.py) / d.size) * k,
              });
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onDoubleClick={() => onCrop(null)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 10 : 2;
              const k = cur.current;
              const m: Record<string, Partial<AvatarCrop>> = {
                ArrowLeft: { x: k.x + step },
                ArrowRight: { x: k.x - step },
                ArrowUp: { y: k.y + step },
                ArrowDown: { y: k.y - step },
                "+": { zoom: k.zoom + 10 },
                "=": { zoom: k.zoom + 10 },
                "-": { zoom: k.zoom - 10 },
              };
              if (!m[e.key]) return;
              e.preventDefault();
              set({ ...k, ...m[e.key] });
            }}
            /* La zone de prise couvre la photo et son anneau (9rem + 2 × 3 px). */
            className={`group/crop absolute left-1/2 top-1/2 h-[calc(9rem+6px)] w-[calc(9rem+6px)] -translate-x-1/2 -translate-y-1/2 touch-none select-none rounded-full outline-none ring-action/70 focus-visible:ring-2 ${
              src ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
            }`}
          >
            {/* Les tiers, pendant le glisser. */}
            <svg
              viewBox="0 0 100 100"
              aria-hidden
              className={`pointer-events-none absolute inset-[3px] h-[calc(100%-6px)] w-[calc(100%-6px)] transition-opacity duration-200 ${
                dragging ? "opacity-100" : "opacity-0"
              }`}
            >
              <defs>
                <clipPath id="as-crop-circle">
                  <circle cx="50" cy="50" r="50" />
                </clipPath>
              </defs>
              <g clipPath="url(#as-crop-circle)" stroke="white" strokeOpacity="0.6" strokeWidth="0.5">
                <line x1="33.3" y1="0" x2="33.3" y2="100" />
                <line x1="66.7" y1="0" x2="66.7" y2="100" />
                <line x1="0" y1="33.3" x2="100" y2="33.3" />
                <line x1="0" y1="66.7" x2="100" y2="66.7" />
              </g>
              <circle cx="50" cy="50" r="49.6" fill="none" stroke="white" strokeOpacity="0.8" strokeWidth="0.7" strokeDasharray="2 2" />
            </svg>
          </div>
        </div>
        <span className="text-center font-karla text-[11px] leading-snug text-white/40">
          {t("profile.studioAvatarCropHint")}
        </span>
      </div>

      {/* Le zoom. */}
      {/* Une ligne : l'intitulé (au format des titres de catégorie), le
          curseur, sa valeur, puis la remise à zéro. */}
      <div>
        <span className="flex items-center gap-3">
          <label
            htmlFor="as-avatar-zoom"
            className="shrink-0 font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/35"
          >
            {t("profile.studioAvatarZoom")}
          </label>
          <span className="as-range relative block h-4 min-w-0 flex-1">
            <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.14]" />
            <span
              className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-action"
              style={{ width: `${zoomPct}%` }}
            />
            <input
              id="as-avatar-zoom"
              type="range"
              min={AVATAR_ZOOM_MIN}
              max={AVATAR_ZOOM_MAX}
              step={1}
              value={c.zoom}
              onChange={(e) => set({ ...c, zoom: Number(e.target.value) })}
              onDoubleClick={() => set({ ...c, zoom: 100 })}
              style={{ pointerEvents: "auto" }}
              aria-label={t("profile.studioAvatarZoom")}
            />
          </span>
          <span className="w-11 shrink-0 text-right font-karla text-[12px] font-bold tabular-nums text-white/80">
            {Math.round(c.zoom)} %
          </span>
          {/* Recentrer, au bout du zoom : la remise à zéro suit le réglage. */}
          <button
            type="button"
            onClick={() => onCrop(null)}
            disabled={!crop}
            title={t("profile.studioAvatarRecenter")}
            className={pill}
          >
            <ArrowPathIcon className="h-4 w-4" strokeWidth={1.8} />
            {t("profile.studioAvatarRecenter")}
          </button>
        </span>
      </div>
    </div>
  );
}

