import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  COLS,
  GAP,
  ROW,
  SIZES,
  columnWidth,
  compact,
  pixelRect,
  readingOrder,
  reflow,
  resizeItem,
  rowCount,
  type GridItem,
} from "@/lib/profile/grid";
import { blockSize } from "@/lib/profile/blocks";

/**
 * La grille de widgets : pose, déplacement, redimensionnement.
 *
 * Le composant ne connaît AUCUN bloc — il reçoit une disposition et une
 * fonction qui peint un identifiant. Toute la géométrie vit dans
 * lib/profile/grid.ts ; ici il n'y a que le pointeur et les pixels.
 *
 * Hors mode réorganisation, rien n'est déplaçable : la poignée de l'en-tête et
 * le coin de redimensionnement ne répondent pas, et un visiteur qui n'est pas
 * le propriétaire n'entre jamais dans ce mode.
 */

export type BlockChrome = {
  title: string;
  /** Petite ligne grise à côté du titre (« 5 », « cette semaine »…). */
  meta?: string | null;
  color: string;
  body: React.ReactNode;
};

type Props = {
  layout: GridItem[];
  onLayout: (next: GridItem[]) => void;
  renderBlock: (id: string) => BlockChrome | null;
  editing: boolean;
};

type Drag = {
  id: string;
  mode: "move" | "resize";
  sx: number;
  sy: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export default function WidgetGrid({ layout, onLayout, renderBlock, editing }: Props) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<Drag | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });

  /* La largeur du conteneur EST l'unité de la grille : sans elle rien ne peut
     être placé, et elle change avec la fenêtre comme avec un panneau latéral. */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* La disposition en cours est lue dans un ref pendant un glissement : les
     handlers sont posés une fois sur window et ne doivent pas dépendre d'un
     état recréé à chaque mouvement. */
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragId(null);
    setOffset({ dx: 0, dy: 0 });
    if (d) onLayout(compact(layoutRef.current));
  }, [onLayout]);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const cw = columnWidth(width || 1);
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (d.mode === "move") {
        const nx = Math.min(COLS - d.w, Math.max(0, d.x + Math.round(dx / (cw + GAP))));
        const ny = Math.max(0, d.y + Math.round(dy / (ROW + GAP)));
        const moved = layoutRef.current.map((o) =>
          o.i === d.id ? { ...o, x: nx, y: ny } : o,
        );
        setOffset({ dx, dy });
        onLayout(compact(moved, d.id));
      } else {
        const nw = Math.min(COLS - d.x, Math.max(1, d.w + Math.round(dx / (cw + GAP))));
        const nh = Math.max(1, d.h + Math.round(dy / (ROW + GAP)));
        const cur = layoutRef.current.find((o) => o.i === d.id);
        if (!cur || (cur.w === nw && cur.h === nh)) return;
        onLayout(resizeItem(layoutRef.current, d.id, nw, nh));
      }
    },
    [onLayout, width],
  );

  useEffect(() => {
    if (!dragId) return;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [dragId, onMove, endDrag]);

  function startDrag(id: string, mode: Drag["mode"], e: React.PointerEvent) {
    if (!editing || e.button !== 0) return;
    const it = layout.find((o) => o.i === id);
    if (!it) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      id,
      mode,
      sx: e.clientX,
      sy: e.clientY,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
    };
    setOffset({ dx: 0, dy: 0 });
    setDragId(mode === "move" ? id : null);
    // Un redimensionnement n'a pas de fantôme à suivre, mais il a besoin des
    // mêmes écouteurs : on garde l'identifiant pour l'effet ci-dessus.
    if (mode === "resize") setDragId(id);
  }

  function move(id: string, dir: -1 | 1) {
    const keys = readingOrder(layout);
    const i = keys.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return;
    keys[i] = keys[j];
    keys[j] = id;
    onLayout(reflow(keys, layout, blockSize));
  }

  const rows = rowCount(layout);
  const height = Math.max(
    0,
    rows * (ROW + GAP) - GAP + (editing ? ROW * 0.5 : 0),
  );
  const dragged = dragId ? layout.find((o) => o.i === dragId) : null;

  return (
    <div ref={hostRef} className="relative w-full" style={{ height }}>
      {/* L'emplacement où le bloc tombera s'il est lâché maintenant. */}
      {dragged && dragRef.current?.mode === "move" ? (
        <div
          className="pointer-events-none absolute z-0 rounded-[20px] border-2 border-dashed border-action/50 bg-action/10 transition-[left,top] duration-150"
          style={pixelRect(dragged, width || 1)}
        />
      ) : null}

      {layout.map((it) => {
        const chrome = renderBlock(it.i);
        if (!chrome) return null;
        const rect = pixelRect(it, width || 1);
        const isDragging = dragId === it.i && dragRef.current?.mode === "move";
        return (
          <section
            key={it.i}
            className={`absolute flex flex-col overflow-hidden rounded-[20px] px-5 py-4 ring-1 ${
              editing
                ? "bg-[#13141b]/95 ring-action/40 ring-dashed"
                : "as-stat-card ring-white/10"
            } ${
              isDragging
                ? "z-30 shadow-[0_26px_60px_rgba(0,0,0,0.65)]"
                : "z-10 transition-[left,top,width,height] duration-200"
            }`}
            style={{
              left: Math.round(rect.left + (isDragging ? offset.dx : 0)),
              top: Math.round(rect.top + (isDragging ? offset.dy : 0)),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            }}
          >
            <header
              onPointerDown={(e) => startDrag(it.i, "move", e)}
              className={`mb-3 flex shrink-0 items-center justify-between gap-2 ${
                editing ? (isDragging ? "cursor-grabbing" : "cursor-grab") : ""
              }`}
              style={{ touchAction: "none" }}
            >
              <h2 className="flex min-w-0 items-center gap-2 font-outfit text-base font-bold text-white">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: chrome.color, boxShadow: `0 0 10px ${chrome.color}55` }}
                />
                <span className="truncate">{chrome.title}</span>
                {chrome.meta ? (
                  <span className="shrink-0 font-karla text-[11px] font-medium text-white/35">
                    {chrome.meta}
                  </span>
                ) : null}
              </h2>

              {editing ? (
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton label={t("profile.widgets.moveUp")} onClick={() => move(it.i, -1)}>
                    <path d="M18 15l-6-6-6 6" />
                  </IconButton>
                  <IconButton label={t("profile.widgets.moveDown")} onClick={() => move(it.i, 1)}>
                    <path d="M6 9l6 6 6-6" />
                  </IconButton>
                  <span className="flex items-center gap-[3px] rounded-[9px] bg-white/5 p-[3px] ring-1 ring-white/10">
                    {Object.entries(SIZES).map(([key, [w, h]]) => {
                      const active = it.w === w && it.h === h;
                      return (
                        <button
                          key={key}
                          type="button"
                          title={t(`profile.widgets.size.${key}`)}
                          onClick={() => onLayout(resizeItem(layout, it.i, w, h))}
                          className={`h-5 min-w-[24px] rounded-md px-[5px] font-karla text-[9px] font-bold uppercase tracking-wide transition-colors ${
                            active ? "bg-action text-white" : "text-white/45 hover:text-white"
                          }`}
                        >
                          {key}
                        </button>
                      );
                    })}
                  </span>
                  <IconButton
                    label={t("profile.widgets.remove")}
                    danger
                    onClick={() => onLayout(compact(layout.filter((o) => o.i !== it.i)))}
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </IconButton>
                </div>
              ) : null}
            </header>

            <div className="min-h-0 flex-1">{chrome.body}</div>

            {editing ? (
              <div
                onPointerDown={(e) => startDrag(it.i, "resize", e)}
                title={t("profile.widgets.resize")}
                className="absolute bottom-0 right-0 flex h-7 w-7 cursor-nwse-resize items-end justify-end p-[7px]"
                style={{ touchAction: "none" }}
              >
                <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" className="h-3 w-3 text-white/60">
                  <path d="M9.2 1v8.2H1" />
                  <path d="M9.2 5.4H5.4v3.8" />
                </svg>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex h-[26px] w-[26px] items-center justify-center rounded-lg ring-1 transition-colors ${
        danger
          ? "bg-action/15 text-white ring-action/30 hover:bg-action"
          : "bg-white/5 text-white/60 ring-white/10 hover:text-white hover:ring-white/30"
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
        {children}
      </svg>
    </button>
  );
}
