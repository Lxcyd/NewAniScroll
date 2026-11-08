import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { customListColor, LIST_COLORS, STATUS_TO_LIST } from "@/components/anime/v2/helpers";
import ColorPicker from "@/components/shared/ColorPicker";
import {
  CUSTOM_STATUS,
  LIST_PALETTE,
  orderCustom,
  updateListRegistry,
  useListRegistry,
  type ListRegistry,
} from "@/lib/profile/listRegistry";

/**
 * LE GESTIONNAIRE DE LISTES — le « + » de l'onglet Liste, calqué sur le
 * CustomListManager de la référence (08/11/2026, Luc) : deux onglets Statuts /
 * Listes perso, une poignée pour réordonner, une pastille de couleur qui ouvre
 * la palette, un cadenas sur les statuts, et en pied la ligne « nouvelle
 * liste ».
 *
 * Tout s'écrit dans le registre (lib/profile/listRegistry.ts), sur l'appareil.
 * Les listes perso d'AniList s'affichent aussi, recolorables, mais ni
 * supprimables ni renommables : comme la référence, on n'écrit rien chez AniList.
 */
export default function ListManager({
  open,
  onClose,
  statusCounts,
  anilistLists,
  localCounts,
}: {
  open: boolean;
  onClose: () => void;
  statusCounts: Record<string, number>;
  /** Listes perso AniList présentes dans la liste, avec leur nombre de titres. */
  anilistLists: [string, number][];
  /** Nombre de titres de la liste affichée dans chaque liste AniScroll. */
  localCounts: Record<string, number>;
}) {
  const { t } = useTranslation();
  const reg = useListRegistry();
  const [tab, setTab] = useState<"status" | "custom">("status");
  const [name, setName] = useState("");
  const [color, setColor] = useState(LIST_PALETTE[6]);
  /* Le sélecteur ouvert : "new" | "s:<STATUS>" | "cs:<statut perso>" |
     "l:<liste>" | "a:<liste AniList>", et la pastille sous laquelle il flotte. */
  const [palette, setPaletteId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const setPalette = (id: string | null, el?: HTMLElement) => {
    setPaletteId(id);
    setAnchor(id && el ? el.getBoundingClientRect() : null);
  };
  const [confirm, setConfirm] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (palette) setPalette(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, palette]);

  /* RÉORDONNER COMME LES WIDGETS (08/11, Luc : « ça se TP au lieu de suivre le
     curseur ») : la ligne tenue SUIT le pointeur (translate), bloquée entre le
     haut de la première et le bas de la dernière ; les autres glissent pour
     lui faire de la place ; la molette pendant le geste fait défiler la liste
     et la ligne reste sous le curseur. Rien n'est écrit avant le lâcher.
     Souris et doigt pareil (Pointer Events, écoutés sur `window`). */
  const listRef = useRef<HTMLDivElement>(null);
  type Drag = {
    kind: "status" | "custom";
    from: number;
    to: number;
    dy: number;
    /** Hauteur de la ligne tenue + l'écart : le pas dont les autres glissent. */
    step: number;
  };
  const [drag, setDrag] = useState<Drag | null>(null);
  /* Une image sans transition au lâcher : l'ordre change dans le DOM au même
     moment où les décalages tombent à zéro, rien ne doit glisser. */
  const [settling, setSettling] = useState(false);
  const geo = useRef<{
    tops: number[];
    bottoms: number[];
    startY: number;
    startScroll: number;
    lastY: number;
  } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const startDrag = (kind: "status" | "custom", idx: number) => (e: React.PointerEvent) => {
    const box = listRef.current;
    if (!box) return;
    e.preventDefault();
    setPalette(null);
    const items = [...box.querySelectorAll<HTMLElement>("[data-item]")];
    const base = box.getBoundingClientRect().top - box.scrollTop;
    const tops = items.map((el) => el.getBoundingClientRect().top - base);
    const bottoms = items.map((el) => el.getBoundingClientRect().bottom - base);
    const gap = items.length > 1 ? tops[1] - bottoms[0] : 7;
    geo.current = { tops, bottoms, startY: e.clientY, startScroll: box.scrollTop, lastY: e.clientY };
    setDrag({ kind, from: idx, to: idx, dy: 0, step: bottoms[idx] - tops[idx] + gap });
  };

  useEffect(() => {
    if (!drag) return;
    const box = listRef.current;
    const update = () => {
      const d = dragRef.current;
      const g = geo.current;
      if (!d || !g || !box) return;
      const n = g.tops.length;
      let dy = g.lastY - g.startY + (box.scrollTop - g.startScroll);
      // Bloquée en haut et en bas de la liste.
      dy = Math.max(g.tops[0] - g.tops[d.from], Math.min(g.bottoms[n - 1] - g.bottoms[d.from], dy));
      /* On prend la place d'une voisine dès que le BORD de la ligne tenue passe
         sa moitié : bord bas en descendant, bord haut en remontant. Comparer
         les centres ne permettait jamais d'atteindre la dernière place, la
         ligne étant bloquée pile au centre de celle-ci (08/11, Luc). */
      const top = g.tops[d.from] + dy;
      const bottom = g.bottoms[d.from] + dy;
      let to = 0;
      for (let i = 0; i < n; i++) {
        if (i === d.from) continue;
        const mid = (g.tops[i] + g.bottoms[i]) / 2;
        if (i < d.from ? top > mid : bottom > mid) to++;
      }
      setDrag({ ...d, dy, to });
    };
    const onMove = (e: PointerEvent) => {
      if (geo.current) geo.current.lastY = e.clientY;
      update();
    };
    const onUp = () => {
      const d = dragRef.current;
      setSettling(true);
      setDrag(null);
      geo.current = null;
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
      if (!d || d.to === d.from) return;
      updateListRegistry((r) => {
        if (d.kind === "status") {
          const o = r.statusOrder.slice();
          o.splice(d.to, 0, o.splice(d.from, 1)[0]);
          return { ...r, statusOrder: o };
        }
        // Toutes les listes perso, dans l'ordre affiché, puis le déplacement.
        const names = customRows(r).map((x) => x.name);
        names.splice(d.to, 0, names.splice(d.from, 1)[0]);
        return { ...r, customOrder: names };
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    box?.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      box?.removeEventListener("scroll", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  /** Le style de la i-ème ligne pendant un geste. */
  const itemStyle = (kind: "status" | "custom", i: number): React.CSSProperties | undefined => {
    if (settling) return { transition: "none" };
    if (!drag || drag.kind !== kind) return undefined;
    if (i === drag.from) {
      return { transform: `translate3d(0, ${drag.dy}px, 0)`, transition: "none", zIndex: 2, position: "relative" };
    }
    const { from, to, step } = drag;
    const shift = from < to && i > from && i <= to ? -step : to < from && i >= to && i < from ? step : 0;
    return { transform: `translate3d(0, ${shift}px, 0)` };
  };

  /* Les listes perso dans l'ordre du gestionnaire : celles d'AniScroll et
     celles d'AniList mêlées, toutes déplaçables (08/11, Luc). */
  function customRows(r: ListRegistry) {
    const rows = [
      ...r.lists
        .filter((l) => !anilistLists.some(([n]) => n === l.name))
        .map((l) => ({ kind: "local" as const, name: l.name })),
      ...anilistLists.map(([n]) => ({ kind: "anilist" as const, name: n })),
    ];
    return orderCustom(rows, (x) => x.name, r.customOrder);
  }

  if (!open || !mounted) return null;

  const customStatus = (s: string) =>
    s.startsWith(CUSTOM_STATUS) ? reg.statuses.find((x) => CUSTOM_STATUS + x.name === s) ?? null : null;
  const statusColor = (s: string) =>
    customStatus(s)?.color || reg.statusColors[s] || LIST_COLORS[STATUS_TO_LIST[s]] || "#6b7280";
  const statusName = (s: string) =>
    customStatus(s)?.name ??
    t(
      ({
        CURRENT: "listEditor.watching",
        REPEATING: "listEditor.repeating",
        COMPLETED: "listEditor.completed",
        PLANNING: "listEditor.planToWatch",
        PAUSED: "listEditor.paused",
        DROPPED: "listEditor.dropped",
      } as Record<string, string>)[s],
    );

  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const taken = (n: string) =>
    tab === "status"
      ? reg.statusOrder.some((s) => same(statusName(s), n))
      : reg.lists.some((l) => same(l.name, n)) || anilistLists.some(([a]) => same(a, n));
  const trimmed = name.trim();
  const clash = !!trimmed && taken(trimmed);
  const add = () => {
    if (!trimmed || clash) return;
    updateListRegistry((r) =>
      tab === "status"
        ? {
            ...r,
            statuses: r.statuses.concat({ name: trimmed, color, ids: [] }),
            statusOrder: r.statusOrder.concat(CUSTOM_STATUS + trimmed),
          }
        : { ...r, lists: r.lists.concat({ name: trimmed, color, ids: [] }) },
    );
    setName("");
    setColor(LIST_PALETTE[(LIST_PALETTE.indexOf(color) + 5) % LIST_PALETTE.length]);
    setPalette(null);
  };

  /* Appliquée EN DIRECT pendant qu'on glisse dans le sélecteur : la pastille de
     la ligne change sous les yeux. Le sélecteur reste ouvert ; un clic sur la
     pastille ou Échap le referme. */
  const pickColor = (c: string) => {
    const p = palette;
    if (!p) return;
    if (p === "new") return setColor(c);
    const cut = p.indexOf(":");
    const [kind, key] = [p.slice(0, cut), p.slice(cut + 1)];
    updateListRegistry((r: ListRegistry) =>
      kind === "s"
        ? { ...r, statusColors: { ...r.statusColors, [key]: c } }
        : kind === "cs"
          ? { ...r, statuses: r.statuses.map((x) => (x.name === key ? { ...x, color: c } : x)) }
          : kind === "a"
            ? { ...r, anilistColors: { ...r.anilistColors, [key]: c } }
            : { ...r, lists: r.lists.map((l) => (l.name === key ? { ...l, color: c } : l)) },
    );
  };
  /** La couleur actuelle de ce que le sélecteur ouvert colore. */
  const colorOf = (p: string): string => {
    if (p === "new") return color;
    const cut = p.indexOf(":");
    const [kind, key] = [p.slice(0, cut), p.slice(cut + 1)];
    if (kind === "s") return statusColor(key);
    if (kind === "cs") return statusColor(CUSTOM_STATUS + key);
    if (kind === "a") return reg.anilistColors[key] || customListColor(key);
    return reg.lists.find((l) => l.name === key)?.color || color;
  };

  const swatch = (id: string, value: string) => (
    <button
      type="button"
      className="as-lm-swatch"
      style={{ background: value }}
      aria-label={t("listMenu.manager.color")}
      title={t("listMenu.manager.color")}
      onClick={(e) => setPalette(palette === id ? null : id, e.currentTarget)}
    />
  );
  /* LE SÉLECTEUR DU SITE (components/shared/ColorPicker.tsx), celui du studio
     et des réglages, porté de la référence : carré, teinte, 24 pastilles,
     HEX / RGB / HSV / HSL (08/11, Luc : « met le bon truc de couleurs »). */
  /* Il FLOTTE à côté de la pastille, à 280 px comme la référence (08/11, Luc :
     « trop gros » étalé sous la ligne). Sous la pastille s'il y a la place,
     au-dessus sinon, toujours dans l'écran. */
  const POP_W = 280;
  const POP_H = 380;
  const popover = () => {
    if (!palette || !anchor) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(12, Math.min(anchor.left, vw - POP_W - 12));
    const below = anchor.bottom + 8;
    const top = below + POP_H <= vh - 12 ? below : Math.max(12, anchor.top - 8 - POP_H);
    return (
      <>
        <div className="as-lm-pop-backdrop" onMouseDown={() => setPalette(null)} />
        <div className="as-lm-pop" style={{ left, top, width: POP_W }} role="dialog" aria-label={t("listMenu.manager.color")}>
          <ColorPicker key={palette} value={colorOf(palette)} onChange={pickColor} />
        </div>
      </>
    );
  };
  const grip = (kind: "status" | "custom", idx: number) => (
    <span
      className="as-lm-grip"
      title={t("listMenu.manager.drag")}
      onPointerDown={startDrag(kind, idx)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {[6, 12, 18].map((y) => (
          <g key={y}><circle cx="9" cy={y} r="1.5" /><circle cx="15" cy={y} r="1.5" /></g>
        ))}
      </svg>
    </span>
  );
  const lock = () => (
    <span className="as-lm-lock" title={t("listMenu.manager.locked")}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
    </span>
  );

  return createPortal(
    <div className="as-sfp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="as-sfp as-lm" role="dialog" aria-modal="true" aria-label={t("listMenu.manager.title")}>
        <div className="as-sfp-handle" />
        <div className="as-sfp-head">
          <h3>{t("listMenu.manager.title")}</h3>
          <button type="button" className="as-sfp-x" onClick={onClose} aria-label={t("listMenu.close")}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="as-lm-tabs" role="tablist">
          <span className="as-lm-slider" style={{ transform: tab === "custom" ? "translateX(100%)" : "none" }} />
          {(["status", "custom"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setPalette(null); setConfirm(null); }}>
              {t(k === "status" ? "listMenu.manager.tabStatus" : "listMenu.manager.tabCustom")}
            </button>
          ))}
        </div>

        <div className={`as-lm-body${drag ? " is-sorting" : ""}`} ref={listRef}>
          {tab === "status"
            ? reg.statusOrder.map((s, i) => {
                const cs = customStatus(s);
                return (
                <div key={s} data-item className="as-lm-item" style={itemStyle("status", i)}>
                  <div data-row className={`as-lm-row${drag?.kind === "status" && drag.from === i ? " is-dragging" : ""}`}>
                    {grip("status", i)}
                    {swatch(cs ? `cs:${cs.name}` : `s:${s}`, statusColor(s))}
                    <span className="as-lm-name">{statusName(s)}</span>
                    <span className="as-lm-count">{statusCounts[s] || 0}</span>
                    {!cs ? lock() : confirm === s ? (
                      <span className="as-lm-confirm">
                        <button
                          type="button"
                          className="is-danger"
                          onClick={() => {
                            updateListRegistry((r) => ({
                              ...r,
                              statuses: r.statuses.filter((x) => x.name !== cs.name),
                              statusOrder: r.statusOrder.filter((x) => x !== s),
                            }));
                            setConfirm(null);
                          }}
                        >
                          {t("listMenu.manager.yes")}
                        </button>
                        <button type="button" onClick={() => setConfirm(null)}>{t("listMenu.manager.no")}</button>
                      </span>
                    ) : (
                      <button type="button" className="as-lm-del" aria-label={`${t("listMenu.manager.yes")} ${cs.name}`} title={t("listMenu.manager.yes")} onClick={() => setConfirm(s)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                      </button>
                    )}
                  </div>
                                  </div>
                );
              })
            : (
              <>
                {customRows(reg).map((row, i) => {
                  if (row.kind === "anilist") {
                    const n = row.name;
                    const c = anilistLists.find(([x]) => x === n)?.[1] ?? 0;
                    return (
                      <div key={`a:${n}`} data-item className="as-lm-item" style={itemStyle("custom", i)}>
                        <div data-row className={`as-lm-row${drag?.kind === "custom" && drag.from === i ? " is-dragging" : ""}`}>
                          {grip("custom", i)}
                          {swatch(`a:${n}`, reg.anilistColors[n] || customListColor(n))}
                          <span className="as-lm-name">{n}</span>
                          <span className="as-lm-tag">AniList</span>
                          <span className="as-lm-count">{c}</span>
                          {lock()}
                        </div>
                                              </div>
                    );
                  }
                  const l = reg.lists.find((x) => x.name === row.name)!;
                  return (
                    <div key={`l:${l.name}`} data-item className="as-lm-item" style={itemStyle("custom", i)}>
                      <div data-row className={`as-lm-row${drag?.kind === "custom" && drag.from === i ? " is-dragging" : ""}`}>
                        {grip("custom", i)}
                        {swatch(`l:${l.name}`, l.color)}
                        <span className="as-lm-name">{l.name}</span>
                        <span className="as-lm-count">{localCounts[l.name] || 0}</span>
                        {confirm === l.name ? (
                          <span className="as-lm-confirm">
                            <button type="button" className="is-danger" onClick={() => { updateListRegistry((r) => ({ ...r, lists: r.lists.filter((x) => x.name !== l.name) })); setConfirm(null); }}>
                              {t("listMenu.manager.yes")}
                            </button>
                            <button type="button" onClick={() => setConfirm(null)}>{t("listMenu.manager.no")}</button>
                          </span>
                        ) : (
                          <button type="button" className="as-lm-del" aria-label={`${t("listMenu.manager.yes")} ${l.name}`} title={t("listMenu.manager.yes")} onClick={() => setConfirm(l.name)}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                          </button>
                        )}
                      </div>
                                          </div>
                  );
                })}
                {!reg.lists.length && !anilistLists.length ? (
                  <p className="as-lm-empty">{t("listMenu.manager.empty")}</p>
                ) : null}
              </>
            )}
        </div>

        {/* La ligne « nouveau statut » / « nouvelle liste », sur les deux onglets
            comme la référence. */}
        <div className="as-lm-foot">
            <div className={`as-lm-new${clash ? " is-clash" : ""}`}>
              {swatch("new", color)}
              <input
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder={t(tab === "status" ? "listMenu.manager.newStatus" : "listMenu.manager.newList")}
                aria-label={t(tab === "status" ? "listMenu.manager.newStatus" : "listMenu.manager.newList")}
              />
              <button type="button" className="as-lm-add" disabled={!trimmed || clash} onClick={add} aria-label={t("listMenu.manager.add")} title={t("listMenu.manager.add")}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
            </div>
            <p className="as-lm-note">{clash ? t("listMenu.manager.exists") : t("listMenu.manager.deviceNote")}</p>
          </div>
      </div>
      {popover()}
    </div>,
    document.body,
  );
}
