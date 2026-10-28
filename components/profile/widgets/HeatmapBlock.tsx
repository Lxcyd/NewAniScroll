import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { dayKey, type WatchDays } from "@/lib/profile/activity";
import { useLocalDays } from "./CalendarBlock";

/**
 * LA HEATMAP DE L'ANNÉE (28/10/2026) : une colonne par semaine, une case par
 * jour, teintée selon le nombre d'épisodes vus.
 *
 * Même journal que le calendrier (`watchDays`, lib/profile/activity.ts) : chez
 * soi, cet appareil et en direct ; chez un autre, ce que sert le rendu serveur.
 *
 * LA TAILLE SUIT LA CARTE. Le côté d'une case est le plus grand qui fasse
 * tenir les 7 jours en hauteur et les 53 semaines en largeur ; trop étroite
 * pour 53 semaines à une taille lisible (8 px), la carte montre les plus
 * RÉCENTES qui tiennent. Mesuré par ResizeObserver plutôt qu'en CSS : le
 * nombre de colonnes à rendre dépend de la place.
 */

const GAP = 3;
const MIN_CELL = 8;
const MAX_CELL = 22;
const LABEL_W = 18;
const MONTHS_H = 14;
const ALL_WEEKS = 53;

/* Les quatre teintes, de la plus pâle à la plus franche — l'accent du site. */
const LEVELS = [
  "rgba(255,255,255,0.05)",
  "rgba(233,69,96,0.3)",
  "rgba(233,69,96,0.5)",
  "rgba(233,69,96,0.75)",
  "rgba(233,69,96,1)",
];

function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

export function HeatmapBlock({ served }: { served?: WatchDays | null }) {
  const { t, i18n } = useTranslation();
  const local = useLocalDays(served == null);
  const days = served ?? local;

  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setBox((b) => (b && b.w === Math.round(r.width) && b.h === Math.round(r.height) ? b : { w: Math.round(r.width), h: Math.round(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [days != null]);

  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  const locale = i18n.language || "fr";

  /* Les dimensions : côté de case et nombre de semaines. */
  const geo = useMemo(() => {
    if (!box) return null;
    const byH = Math.floor((box.h - MONTHS_H - 6 * GAP) / 7);
    const byW = Math.floor((box.w - LABEL_W - (ALL_WEEKS - 1) * GAP) / ALL_WEEKS);
    let cell = Math.min(MAX_CELL, byH, byW);
    let weeks = ALL_WEEKS;
    if (cell < MIN_CELL) {
      cell = Math.max(MIN_CELL, Math.min(MAX_CELL, byH));
      weeks = Math.max(4, Math.floor((box.w - LABEL_W + GAP) / (cell + GAP)));
      weeks = Math.min(ALL_WEEKS, weeks);
    }
    return { cell, weeks };
  }, [box]);

  /* La grille : semaines × jours, de la plus ancienne à celle d'aujourd'hui. */
  const grid = useMemo(() => {
    if (!geo || !days) return null;
    const today = new Date();
    const todayKey = dayKey(today.getTime());
    const start = mondayOf(today);
    start.setDate(start.getDate() - (geo.weeks - 1) * 7);
    const cols: { key: string; date: Date; n: number; future: boolean }[][] = [];
    const months: { col: number; label: string }[] = [];
    const fmtMonth = new Intl.DateTimeFormat(locale, { month: "short" });
    let max = 1;
    for (let c = 0; c < geo.weeks; c++) {
      const col = [];
      for (let r = 0; r < 7; r++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + c * 7 + r);
        const key = dayKey(date.getTime());
        const n = days[key]?.n ?? 0;
        if (n > max) max = n;
        col.push({ key, date, n, future: key > todayKey });
        /* L'étiquette d'un mois se pose sur la semaine qui contient son 1er. */
        if (date.getDate() === 1) {
          months.push({ col: c, label: fmtMonth.format(date).replace(".", "") });
        }
      }
      cols.push(col);
    }

    /* Le bilan, sur la période affichée. */
    let episodes = 0;
    let active = 0;
    let best = 0;
    let run = 0;
    for (const col of cols) {
      for (const d of col) {
        if (d.future) continue;
        if (d.n > 0) {
          episodes += d.n;
          active++;
          run++;
          best = Math.max(best, run);
        } else run = 0;
      }
    }
    return { cols, months, max, todayKey, episodes, active, best };
  }, [geo, days, locale]);

  const level = (n: number, max: number) => (n <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((4 * n) / max))));
  const fmtDay = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    [locale],
  );
  /* Lundi, mercredi, vendredi : une étiquette sur deux, comme partout. */
  const weekday = (r: number) =>
    new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 1 + r)).replace(".", "");

  if (!days) return <div className="h-full" />;

  return (
    <div className="as-heat flex h-full min-h-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-3">
        <p className="min-w-0 truncate font-karla text-[11px] text-white/50">
          {grid && grid.active
            ? [
                t("profile.blocks.heatmap.episodes", { count: grid.episodes }),
                t("profile.blocks.heatmap.activeDays", { count: grid.active }),
                t("profile.blocks.heatmap.best", { count: grid.best }),
              ].join(" · ")
            : grid
              ? t("profile.blocks.heatmap.none")
              : " "}
        </p>
        <div className="as-heat-legend ml-auto flex shrink-0 items-center gap-1 font-karla text-[10px] text-white/40">
          <span>{t("profile.blocks.heatmap.less")}</span>
          {LEVELS.map((c, i) => (
            <span key={i} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />
          ))}
          <span>{t("profile.blocks.heatmap.more")}</span>
        </div>
      </div>

      <div ref={boxRef} className="relative min-h-0 flex-1">
        {grid && geo ? (
          <div
            className="absolute inset-0 m-auto"
            style={{
              width: LABEL_W + geo.weeks * geo.cell + (geo.weeks - 1) * GAP,
              height: MONTHS_H + 7 * geo.cell + 6 * GAP,
            }}
            onMouseLeave={() => setTip(null)}
          >
            {/* Les mois, au-dessus de leur première semaine. */}
            {grid.months.map((m) => (
              <span
                key={`${m.col}-${m.label}`}
                className="absolute top-0 whitespace-nowrap font-karla text-[10px] capitalize leading-none text-white/40"
                style={{ left: LABEL_W + m.col * (geo.cell + GAP) }}
              >
                {m.label}
              </span>
            ))}
            {[0, 2, 4].map((r) => (
              <span
                key={r}
                className="absolute left-0 font-karla text-[9px] capitalize leading-none text-white/35"
                style={{ top: MONTHS_H + r * (geo.cell + GAP) + geo.cell / 2 - 4 }}
              >
                {weekday(r).slice(0, 3)}
              </span>
            ))}
            {grid.cols.map((col, c) =>
              col.map((d, r) =>
                d.future ? null : (
                  <span
                    key={d.key}
                    className={`as-heat-cell absolute rounded-[3px]${d.key === grid.todayKey ? " ring-1 ring-white/70" : ""}`}
                    style={{
                      left: LABEL_W + c * (geo.cell + GAP),
                      top: MONTHS_H + r * (geo.cell + GAP),
                      width: geo.cell,
                      height: geo.cell,
                      background: LEVELS[level(d.n, grid.max)],
                      animationDelay: `${Math.min(c, 60) * 8}ms`,
                    }}
                    onMouseEnter={(e) => {
                      const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                      const cell = e.currentTarget.getBoundingClientRect();
                      /* Bornée pour ne pas sortir de la carte, qui coupe à son bord. */
                      setTip({
                        x: Math.min(box.width - 90, Math.max(90, cell.left - box.left + cell.width / 2)),
                        y: cell.top - box.top,
                        text: t("profile.blocks.heatmap.tip", {
                          date: fmtDay.format(d.date),
                          episodes: d.n
                            ? t("profile.blocks.heatmap.episodes", { count: d.n })
                            : t("profile.blocks.heatmap.nothing"),
                        }),
                      });
                    }}
                  />
                ),
              ),
            )}
            {tip ? (
              <span
                className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-[rgba(10,10,16,0.92)] px-2 py-1 ring-1 ring-white/10 font-karla text-[11px] text-white shadow-lg"
                style={{ left: tip.x, top: tip.y - 6 }}
              >
                {tip.text}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
