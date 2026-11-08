import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { customListColor, LIST_COLORS, STATUS_TO_LIST } from "@/components/anime/v2/helpers";
import {
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
  const [palette, setPalette] = useState<string | null>(null); // "new" | "s:<STATUS>" | "l:<name>" | "a:<name>"
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

  /* RÉORDONNER AU POINTEUR : souris et doigt pareil (le glisser-déposer HTML5
     ne marche pas au tactile). La ligne sous le pointeur prend la place. */
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: "status" | "custom"; from: number } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const startDrag = (kind: "status" | "custom", idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    listRef.current?.setPointerCapture?.(e.pointerId);
    drag.current = { kind, from: idx };
    setDragging(idx);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>("[data-row]")];
    const to = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY <= b.bottom;
    });
    if (to < 0 || to === d.from) return;
    updateListRegistry((r) => {
      if (d.kind === "status") {
        const o = r.statusOrder.slice();
        o.splice(to, 0, o.splice(d.from, 1)[0]);
        return { ...r, statusOrder: o };
      }
      // Toutes les listes perso, dans l'ordre affiché, puis le déplacement.
      const names = customRows(r).map((x) => x.name);
      names.splice(to, 0, names.splice(d.from, 1)[0]);
      return { ...r, customOrder: names };
    });
    d.from = to;
    setDragging(to);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(null);
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

  const statusColor = (s: string) => reg.statusColors[s] || LIST_COLORS[STATUS_TO_LIST[s]] || "#6b7280";
  const statusName = (s: string) =>
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

  const taken = (n: string) =>
    reg.lists.some((l) => l.name.toLowerCase() === n.toLowerCase()) ||
    anilistLists.some(([a]) => a.toLowerCase() === n.toLowerCase());
  const trimmed = name.trim();
  const clash = !!trimmed && taken(trimmed);
  const add = () => {
    if (!trimmed || clash) return;
    updateListRegistry((r) => ({ ...r, lists: r.lists.concat({ name: trimmed, color, ids: [] }) }));
    setName("");
    setColor(LIST_PALETTE[(LIST_PALETTE.indexOf(color) + 5) % LIST_PALETTE.length]);
    setPalette(null);
  };

  const pickColor = (c: string) => {
    const p = palette;
    setPalette(null);
    if (!p) return;
    if (p === "new") return setColor(c);
    const [kind, key] = [p.slice(0, 1), p.slice(2)];
    updateListRegistry((r: ListRegistry) =>
      kind === "s"
        ? { ...r, statusColors: { ...r.statusColors, [key]: c } }
        : kind === "a"
          ? { ...r, anilistColors: { ...r.anilistColors, [key]: c } }
          : { ...r, lists: r.lists.map((l) => (l.name === key ? { ...l, color: c } : l)) },
    );
  };

  const swatch = (id: string, value: string) => (
    <button
      type="button"
      className="as-lm-swatch"
      style={{ background: value }}
      aria-label={t("listMenu.manager.color")}
      title={t("listMenu.manager.color")}
      onClick={() => setPalette(palette === id ? null : id)}
    />
  );
  const paletteRow = () => (
    <div className="as-lm-palette" role="group" aria-label={t("listMenu.manager.color")}>
      {LIST_PALETTE.map((c) => (
        <button key={c} type="button" style={{ background: c }} aria-label={c} onClick={() => pickColor(c)} />
      ))}
    </div>
  );
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

        <div className="as-lm-body" ref={listRef} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          {tab === "status"
            ? reg.statusOrder.map((s, i) => (
                <div key={s}>
                  <div data-row className={`as-lm-row${dragging === i ? " is-dragging" : ""}`}>
                    {grip("status", i)}
                    {swatch(`s:${s}`, statusColor(s))}
                    <span className="as-lm-name">{statusName(s)}</span>
                    <span className="as-lm-count">{statusCounts[s] || 0}</span>
                    {lock()}
                  </div>
                  {palette === `s:${s}` ? paletteRow() : null}
                </div>
              ))
            : (
              <>
                {customRows(reg).map((row, i) => {
                  if (row.kind === "anilist") {
                    const n = row.name;
                    const c = anilistLists.find(([x]) => x === n)?.[1] ?? 0;
                    return (
                      <div key={`a:${n}`}>
                        <div data-row className={`as-lm-row${dragging === i ? " is-dragging" : ""}`}>
                          {grip("custom", i)}
                          {swatch(`a:${n}`, reg.anilistColors[n] || customListColor(n))}
                          <span className="as-lm-name">{n}</span>
                          <span className="as-lm-tag">AniList</span>
                          <span className="as-lm-count">{c}</span>
                          {lock()}
                        </div>
                        {palette === `a:${n}` ? paletteRow() : null}
                      </div>
                    );
                  }
                  const l = reg.lists.find((x) => x.name === row.name)!;
                  return (
                    <div key={`l:${l.name}`}>
                      <div data-row className={`as-lm-row${dragging === i ? " is-dragging" : ""}`}>
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
                      {palette === `l:${l.name}` ? paletteRow() : null}
                    </div>
                  );
                })}
                {!reg.lists.length && !anilistLists.length ? (
                  <p className="as-lm-empty">{t("listMenu.manager.empty")}</p>
                ) : null}
              </>
            )}
        </div>

        {tab === "custom" ? (
          <div className="as-lm-foot">
            <div className={`as-lm-new${clash ? " is-clash" : ""}`}>
              {swatch("new", color)}
              <input
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder={t("listMenu.manager.newList")}
                aria-label={t("listMenu.manager.newList")}
              />
              <button type="button" className="as-lm-add" disabled={!trimmed || clash} onClick={add} aria-label={t("listMenu.manager.add")} title={t("listMenu.manager.add")}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
            </div>
            {palette === "new" ? paletteRow() : null}
            <p className="as-lm-note">{clash ? t("listMenu.manager.exists") : t("listMenu.manager.deviceNote")}</p>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
