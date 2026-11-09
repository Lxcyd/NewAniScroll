import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { countryLabel, prettyFormat, prettySource, statusLabel } from "@/components/anime/v2/helpers";
import {
  AIR_STATUSES,
  COUNTRIES,
  FORMATS,
  SEASONS,
  SORT_KEYS,
  SOURCES,
  activeCount,
  freshFilters,
  presentValues,
  rangeIsFull,
  type Bounds,
  type ListFilters,
  type RangeKey,
  type SetKey,
} from "@/lib/profile/listFilter";
import type { ProfileEntry } from "@/lib/profile/types";

/**
 * LE PANNEAU « SORT & FILTER » de l'onglet Liste, calqué section par section
 * sur la version de référence (08/11/2026, Luc : « inspire-toi beaucoup plus de
 * l'autre ») : tri, diffusion, format, saison, trois curseurs doubles, Genres /
 * Studio / Tags repliables, source, pays, contenu ; en pied, le tirage au
 * hasard et « Show N results ».
 *
 * Une section dont AUCUN titre ne porte la donnée est cachée : une liste locale
 * n'a ni saison ni source, et des puces qui vident la liste à chaque clic
 * seraient un piège. Rendu dans un portail : le profil vit dans une scène
 * transformée, sous laquelle un `position: fixed` ne couvrirait pas l'écran.
 */
export default function ListSortFilter({
  open,
  onClose,
  entries,
  filters,
  bounds,
  onChange,
  count,
  onRandom,
}: {
  open: boolean;
  onClose: () => void;
  entries: ProfileEntry[];
  filters: ListFilters;
  bounds: Bounds;
  onChange: (f: ListFilters) => void;
  count: number;
  /** Tire un titre parmi les résultats ; renvoie son nom, ou null s'il n'y en a aucun. */
  onRandom: () => string | null;
}) {
  const { t } = useTranslation();
  const [openDd, setOpenDd] = useState<SetKey | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    setPick(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const f = filters;
  const set = (patch: Partial<ListFilters>) => {
    setPick(null);
    onChange({ ...f, ...patch });
  };
  const toggle = (k: SetKey, v: string) => {
    const cur = f.sets[k];
    set({ sets: { ...f.sets, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : cur.concat(v) } });
  };
  const has = (k: SetKey) => entries.some((e) => {
    switch (k) {
      case "air": return !!e.airStatus;
      case "format": return !!e.format;
      case "season": return !!e.season;
      case "source": return !!e.source;
      case "country": return !!e.country;
      default: return true;
    }
  });
  const active = activeCount(f, bounds);
  const hasYear = entries.some((e) => e.year);
  const hasTotal = entries.some((e) => e.total);

  const chips = (k: SetKey, values: string[], label: (v: string) => React.ReactNode) => (
    <div className="as-sfp-chips">
      {values.map((v) => (
        <Chip key={v} on={f.sets[k].includes(v)} onClick={() => toggle(k, v)}>{label(v)}</Chip>
      ))}
    </div>
  );

  const slider = ({ k, label, step = 1, allBadge }: { k: RangeKey; label: string; step?: number; allBadge?: boolean }) => {
    const [lo, hi] = bounds[k];
    const [a, b] = f.ranges[k];
    const span = hi - lo || 1;
    const setAt = (i: 0 | 1, raw: number) => {
      if (Number.isNaN(raw)) return;
      let v = Math.min(hi, Math.max(lo, raw));
      v = i === 0 ? Math.min(v, b) : Math.max(v, a);
      const next: [number, number] = i === 0 ? [v, b] : [a, v];
      set({ ranges: { ...f.ranges, [k]: next } });
    };
    return (
      <Section
        label={label}
        extra={allBadge && rangeIsFull(f, bounds, k) ? <span className="as-sfp-all">{t("listMenu.all")}</span> : null}
      >
        <div className="as-sfp-dual">
          <NumBox value={a} onCommit={(v) => setAt(0, v)} label={`${label} min`} />
          <div className="as-sfp-slider">
            <div className="as-sfp-track" />
            <div
              className="as-sfp-fill"
              style={{
                left: `calc(11px + (100% - 22px) * ${(a - lo) / span})`,
                right: `calc(11px + (100% - 22px) * ${(hi - b) / span})`,
              }}
            />
            {[0, 1].map((i) => (
              <input
                key={i}
                type="range"
                className="as-sfp-range"
                min={lo}
                max={hi}
                step={step}
                value={i ? b : a}
                aria-label={`${label} ${i ? "max" : "min"}`}
                onChange={(e) => setAt(i as 0 | 1, Number(e.target.value))}
              />
            ))}
          </div>
          <NumBox value={b} onCommit={(v) => setAt(1, v)} label={`${label} max`} />
        </div>
      </Section>
    );
  };

  const dropdown = ({ k, label, icon }: { k: SetKey; label: string; icon: React.ReactNode }) => {
    const values = presentValues(entries, k);
    if (!values.length) return null;
    const isOpen = openDd === k;
    const n = f.sets[k].length;
    return (
      <div className="as-sfp-sec is-tight">
        <button type="button" className="as-sfp-dd" aria-expanded={isOpen} onClick={() => setOpenDd(isOpen ? null : k)}>
          <span className="as-sfp-ddl">
            {icon}
            {label}
            {n ? <span className="as-sfp-ddb">{n}</span> : null}
          </span>
          <Chevron className="as-sfp-chev" />
        </button>
        {isOpen ? <div className="as-sfp-ddp">{chips(k, values, (v) => v)}</div> : null}
      </div>
    );
  };

  return createPortal(
    <div className="as-sfp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="as-sfp" role="dialog" aria-modal="true" aria-label={t("listMenu.sortFilter")}>
        <div className="as-sfp-handle" />
        <div className="as-sfp-head">
          <div className="as-sfp-hl">
            <h3>{t("listMenu.sortFilter")}</h3>
            {active ? <span className="as-sfp-badge">{active}</span> : null}
          </div>
          <div className="as-sfp-hl">
            <button type="button" className="as-sfp-reset" onClick={() => set({ ...freshFilters(bounds), sort: f.sort, desc: f.desc })}>
              {t("listMenu.reset")}
            </button>
            <button type="button" className="as-sfp-x" onClick={onClose} aria-label={t("listMenu.close")}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        <div className="as-sfp-body">
          <Section label={t("listMenu.sortBy")}>
            <div className="as-sfp-chips">
              {SORT_KEYS.map((k) => {
                const on = f.sort === k;
                return (
                  <Chip
                    key={k}
                    on={on}
                    onClick={() => set(on ? { desc: !f.desc } : { sort: k, desc: k !== "title" })}
                  >
                    {t(`listMenu.sort.${k}`)}
                    {on ? <span className="as-sfp-arrow">{f.desc ? "↓" : "↑"}</span> : null}
                  </Chip>
                );
              })}
            </div>
          </Section>
          {has("air") ? (<><div className="as-sfp-div" /><Section label={t("listMenu.airStatus")}>{chips("air", AIR_STATUSES, (v) => statusLabel(t, v))}</Section></>) : null}
          {has("format") ? (<><div className="as-sfp-div" /><Section label={t("listMenu.format")}>{chips("format", FORMATS, (v) => prettyFormat(v))}</Section></>) : null}
          {has("season") ? (<><div className="as-sfp-div" /><Section label={t("listMenu.season")}>{chips("season", SEASONS, (v) => t(`listMenu.seasons.${v}`))}</Section></>) : null}
          {hasYear ? (<><div className="as-sfp-div" />{slider({ k: "year", label: t("listMenu.year"), allBadge: true })}</>) : null}
          <div className="as-sfp-div" />
          {slider({ k: "score", label: t("listMenu.myScore"), step: 0.5 })}
          {hasTotal ? (<><div className="as-sfp-div" />{slider({ k: "episodes", label: t("listMenu.episodes") })}</>) : null}

          <div className="as-sfp-dds">
            {dropdown({ k: "genres", label: t("listMenu.genres"), icon: <Icon d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /> })}
            {dropdown({ k: "studio", label: t("listMenu.studio"), icon: <Icon d="M2 3h20v14H2zM8 21h8M12 17v4" /> })}
            {dropdown({ k: "tags", label: t("listMenu.tags"), icon: <Icon d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01" /> })}
          </div>

          {has("source") ? (<Section label={t("listMenu.source")}>{chips("source", SOURCES, (v) => prettySource(v))}</Section>) : null}
          {has("country") ? (<><div className="as-sfp-div" /><Section label={t("listMenu.country")}>{chips("country", COUNTRIES, (v) => (<><span className="as-sfp-cc">{v}</span>{countryLabel(t, v)}</>))}</Section></>) : null}
          <div className="as-sfp-div" />
          <Section label={t("listMenu.content")}>
            <div className="as-sfp-chips">
              <Chip on={f.adult === "no"} onClick={() => set({ adult: f.adult === "no" ? "" : "no" })}>{t("listMenu.nonAdult")}</Chip>
              <Chip on={f.adult === "yes"} onClick={() => set({ adult: f.adult === "yes" ? "" : "yes" })}>{t("listMenu.adultOnly")}</Chip>
            </div>
          </Section>
        </div>

        {pick ? <div className="as-sfp-pick" aria-live="polite">{pick}</div> : null}
        <div className="as-sfp-foot">
          <button
            type="button"
            className="as-sfp-rand"
            aria-label={t("listMenu.random")}
            title={t("listMenu.random")}
            onClick={() => {
              const name = onRandom();
              setPick(name ? t("listMenu.randomPick", { title: name }) : t("listMenu.randomNone"));
              /* Le badge « Au hasard » : jusqu'ici aucun bouton ne le levait. */
              if (name) void import("@/lib/badges/facts").then((f) => f.recordFlag("random")).catch(() => {});
            }}
          >
            <Icon d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" size={18} />
          </button>
          <button type="button" className="as-sfp-apply" onClick={onClose}>
            {t("listMenu.show")} <span className="as-sfp-count">{count}</span> {t("listMenu.results", { count })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`as-sfp-chip${on ? " is-on" : ""}`}>
      {children}
    </button>
  );
}

function Section({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="as-sfp-sec">
      <div className="as-sfp-label">{label}{extra}</div>
      {children}
    </div>
  );
}

/** Une case chiffrée : on tape librement, la valeur ne s'applique qu'à la sortie. */
function NumBox({ value, onCommit, label }: { value: number; onCommit: (v: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      className="as-sfp-num"
      inputMode="decimal"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(parseFloat(draft.replace(",", ".")))}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Icon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
