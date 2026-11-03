import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
 * LA LARGEUR DÉCIDE DU NOMBRE DE MOIS (02/11/2026) : les cases ont une
 * taille fixe, et la carte montre les mois RÉCENTS qui tiennent, jusqu'à un
 * an. Mesuré par ResizeObserver plutôt qu'en CSS : le nombre de colonnes à
 * rendre dépend de la place.
 */

const GAP = 3;
/** Le côté d'une case, fixe : celui d'une heatmap pleine largeur sur un an. */
const CELL = 14;
/** Écart entre deux colonnes qui éclosent, en ms. */
const POP_STEP = 12;
const MONTHS_H = 14;
const ALL_WEEKS = 53;

/* Les quatre teintes, de la plus pâle à la plus franche — l'accent du site. */
/* LA COULEUR DU SITE (03/11/2026, Luc) : `--brand-primary`, celle que le
   thème choisi pose, et plus un rose écrit en dur. */
const BRAND = "var(--brand-primary, #E94560)";
const LEVELS = [
  "rgba(255,255,255,0.05)",
  `color-mix(in srgb, ${BRAND} 30%, transparent)`,
  `color-mix(in srgb, ${BRAND} 50%, transparent)`,
  `color-mix(in srgb, ${BRAND} 75%, transparent)`,
  BRAND,
];

function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

/**
 * Les dimensions. LES CASES GARDENT LEUR TAILLE, LES MOIS S'EN VONT
 * (02/11/2026, Luc) : un côté fixe (CELL, celui d'un widget pleine largeur),
 * et autant de semaines récentes que la largeur en tient, jusqu'à un an.
 */
function computeGeo(w: number, h: number, labelW: number): { cell: number; weeks: number } {
  const byH = Math.floor((h - MONTHS_H - 6 * GAP) / 7);
  const cell = Math.max(4, Math.min(CELL, byH));
  /* TOUTE LA LARGEUR EST REMPLIE (03/11/2026, Luc : « il manque des colonnes
     à gauche ») : autant de semaines qu'il en tient, sans plus arrondir au
     mois entier, qui laissait un trou entre les jours et la grille. Un mois
     coupé à gauche n'a pas d'étiquette. */
  const weeks = Math.max(1, Math.min(ALL_WEEKS, Math.floor((w - labelW + GAP) / (cell + GAP))));
  return { cell, weeks };
}

export function HeatmapBlock({
  served,
  editing = false,
  streak = true,
}: {
  served?: WatchDays | null;
  /** Mode réorganisation : la légende descend sous la roue et le moins. */
  editing?: boolean;
  /** Réglage « Afficher les séries » : jours d'affilée et record. */
  streak?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const local = useLocalDays(served == null);
  const days = served ?? local;

  const boxRef = useRef<HTMLDivElement>(null);

  const [tip, setTip] = useState<{ x: number; y: number; date: string; eps: string } | null>(null);

  /* Ancrée à la fenêtre, la bulle ne suivrait pas la page qui défile : on la
     retire au premier défilement. */
  const tipOn = tip != null;
  useEffect(() => {
    if (!tipOn) return;
    const off = () => setTip(null);
    window.addEventListener("scroll", off, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", off, { capture: true });
  }, [tipOn]);

  const locale = i18n.language || "fr";

  /* REMONTER LE TEMPS (03/11/2026, Luc) : des flèches à côté de la légende
     reculent ou avancent d'autant de semaines que la carte en montre — un
     an pleine largeur, quelques mois rétrécie. `back` = semaines de recul
     depuis celle d'aujourd'hui. */
  const [back, setBack] = useState(0);

  /* Les séries de jours regardés, sur tout l'historique (pas seulement la
     période affichée). Celle en cours tient tant que la veille compte :
     aujourd'hui n'est pas encore fini. */
  const runs = useMemo(() => {
    if (!days) return { now: 0, best: 0 };
    const keys = Object.keys(days).filter((k) => days[k]?.n).sort();
    let best = 0;
    let run = 0;
    let prev = "";
    const next = (k: string) => {
      const [y, m, d] = k.split("-").map(Number);
      return dayKey(new Date(y, m - 1, d + 1).getTime());
    };
    for (const k of keys) {
      run = prev && next(prev) === k ? run + 1 : 1;
      if (run > best) best = run;
      prev = k;
    }
    const today = dayKey(Date.now());
    const now = new Date();
    const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime());
    return { now: prev === today || prev === yesterday ? run : 0, best };
  }, [days]);
  const firstDay = useMemo(() => {
    if (!days) return null;
    let min: string | null = null;
    for (const k in days) if (days[k]?.n && (min == null || k < min)) min = k;
    return min;
  }, [days]);

  /* LES NOMS DE JOURS ABRÉGÉS (03/11/2026, Luc) : leur colonne prend la
     largeur du plus long (« mer. », « Wed »). */
  const dayNames = useMemo(
    () =>
      Array.from({ length: 7 }, (_, r) =>
        new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 1 + r)),
      ),
    [locale],
  );
  const labelW = Math.max(...dayNames.map((n) => n.length)) * 5 + 8;

  /* UN RENDU PAR SEMAINE GAGNÉE OU PERDUE, PAS PAR PIXEL (02/11/2026, Luc :
     « laggy quand on modifie vite la taille »). Le ResizeObserver calcule la
     géométrie lui-même et ne la range que si elle change : redimensionner
     d'un pixel ne redessine plus les 371 cases. */
  const [geo, setGeo] = useState<{ cell: number; weeks: number } | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const g = computeGeo(e.contentRect.width, e.contentRect.height, labelW);
      setGeo((p) => (p && p.cell === g.cell && p.weeks === g.weeks ? p : g));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [days != null, labelW]);

  /* LA GRILLE EST TOUJOURS L'ANNÉE ENTIÈRE (02/11/2026, Luc : « pas fluide
     du tout »). Les 53 semaines restent montées ; la largeur ne fait
     qu'allumer ou éteindre des colonnes (as-heat-off), par TRANSITION CSS. Une
     transition repart de l'état où elle en est quand le geste change d'avis ;
     des cases créées et détruites à chaque mois gagné ou perdu relançaient
     leurs animations de zéro, et disparaissaient sèchement. */
  const grid = useMemo(() => {
    if (!days) return null;
    const today = new Date();
    const todayKey = dayKey(today.getTime());
    const start = mondayOf(today);
    start.setDate(start.getDate() - (ALL_WEEKS - 1 + back) * 7);
    const cols: { key: string; date: Date; n: number; future: boolean }[][] = [];
    const months: { col: number; end: number; label: string; key: string }[] = [];
    /* Noms de mois ABRÉGÉS, centrés sur leurs semaines (03/11/2026, Luc). */
    const fmtMonth = new Intl.DateTimeFormat(locale, { month: "short" });
    let max = 1;
    for (let c = 0; c < ALL_WEEKS; c++) {
      const col = [];
      for (let r = 0; r < 7; r++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + c * 7 + r);
        const key = dayKey(date.getTime());
        const n = days[key]?.n ?? 0;
        if (n > max) max = n;
        col.push({ key, date, n, future: key > todayKey });
        /* L'étiquette d'un mois se pose sur la semaine qui contient son 1er. */
        if (date.getDate() === 1) {
          /* Majuscule posée ici : `capitalize` ne prenait que sur certains mois. */
          const name = fmtMonth.format(date);
          months.push({
            col: c,
            end: ALL_WEEKS,
            label: name.charAt(0).toUpperCase() + name.slice(1),
            key: `${date.getFullYear()}-${date.getMonth()}`,
          });
        }
      }
      cols.push(col);
    }
    /* Un mois s'étend jusqu'à la semaine qui porte le 1er du suivant. */
    months.forEach((m, i) => {
      if (months[i + 1]) m.end = months[i + 1].col;
    });
    return { cols, months, max, todayKey };
  }, [days, locale, back]);

  /* ÉCLOSION COLONNE PAR COLONNE, PAR UN SÉQUENCEUR (03/11/2026, Luc : « des
     blocs qui apparaissent avant d'autres dans le mauvais ordre »). Des délais
     CSS posés par case ne suivaient pas un geste qui change d'avis : une
     transition déjà partie garde son délai. Ici une frontière (`shown`) avance
     d'UNE colonne par pas vers la cible, en allumant (vers les plus anciennes)
     ou en éteignant (la plus ancienne d'abord) ; la cible qui change en route
     reprend depuis la frontière du moment. La classe est posée sur la colonne
     directement, sans rendu React. */
  const firstOn = geo ? ALL_WEEKS - geo.weeks : ALL_WEEKS;
  const firstOnRef = useRef(firstOn);
  firstOnRef.current = firstOn;
  /* Le fondu d'entrée se cale sur la première largeur, une fois pour toutes :
     un délai d'animation qui change la rejoue. */
  const mountFirst = useRef<number | null>(null);
  if (geo && mountFirst.current == null) mountFirst.current = firstOn;
  const colEls = useRef<(HTMLElement | null)[]>([]);
  const monthEls = useRef<(HTMLElement | null)[]>([]);
  const shown = useRef<number | null>(null);
  const hasGeo = geo != null && grid != null;
  useLayoutEffect(() => {
    if (!hasGeo) return;
    const set = (c: number, on: boolean) => {
      colEls.current[c]?.classList.toggle("as-heat-off", !on);
      monthEls.current[c]?.classList.toggle("as-heat-off", !on);
    };
    if (shown.current == null) {
      for (let c = 0; c < ALL_WEEKS; c++) set(c, c >= firstOn);
      shown.current = firstOn;
      return;
    }
    /* Cadencé par image, pas par setTimeout (bridé à 4 ms et plus) : à chaque
       image, autant de colonnes que le temps écoulé en autorise. */
    /* REPLIER EST IMMÉDIAT (03/11/2026, Luc : « la colonne de gauche et le
       mois restent trop longtemps ») : ce qui sort est déjà hors de la
       grille, coupé par son bord ; l'éteindre colonne par colonne ne faisait
       qu'attendre la dernière. */
    if (shown.current < firstOn) {
      for (let c = shown.current; c < firstOn; c++) set(c, false);
      shown.current = firstOn;
      return;
    }
    let id = 0;
    let last = performance.now();
    let debt = 0;
    const step = (now: number) => {
      debt += now - last;
      last = now;
      while (shown.current! > firstOn) {
        const s = shown.current!;
        /* En retard sur le geste, l'éclosion accélère : un pas d'autant plus
           court qu'il reste de colonnes à rattraper. */
        const cost = POP_STEP * Math.min(1, 4 / (s - firstOn));
        if (debt < cost) break;
        debt -= cost;
        set(s - 1, true);
        shown.current = s - 1;
      }
      if (shown.current !== firstOn) id = requestAnimationFrame(step);
    };
    debt = POP_STEP; // la première colonne part tout de suite
    step(last);
    return () => cancelAnimationFrame(id);
  }, [firstOn, hasGeo]);

  const level = (n: number, max: number) => (n <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((4 * n) / max))));
  const fmtDay = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    [locale],
  );

  /* LES CASES, MÉMORISÉES : l'infobulle (un rendu par case survolée) ne les
     redessine pas. Placées une fois pour toutes dans une grille d'un an ;
     seules leur classe (allumée / éteinte) et leur délai changent. */
  const pitch = geo ? geo.cell + GAP : 0;
  const fullW = geo ? labelW + ALL_WEEKS * pitch - GAP : 0;
  const cells = useMemo(() => {
    if (!grid || !geo) return null;
    const first = mountFirst.current ?? 0;
    return grid.cols.map((col, c) => (
      /* Une colonne = une semaine : c'est elle que le séquenceur allume. Sa
         classe ne change jamais côté React, qui n'écrase donc pas la sienne. */
      <span
        key={c}
        ref={(el) => {
          colEls.current[c] = el;
        }}
        className="as-heat-col absolute top-0"
        style={{ left: labelW + c * pitch, width: geo.cell, height: "100%" }}
      >
        {col.map((d, r) =>
          d.future ? null : (
            <span
              key={d.key}
              className="as-heat-cell absolute left-0 rounded-[3px]"
              style={{
                top: MONTHS_H + r * pitch,
                width: geo.cell,
                height: geo.cell,
                background: LEVELS[level(d.n, grid.max)],
                animationDelay: `${Math.max(0, Math.min(c - first, 60)) * 8}ms`,
              }}
              onMouseEnter={(e) => {
                /* Coordonnées DANS LA FENÊTRE : la bulle est portée par le
                   `body` et ne s'arrête qu'aux bords de l'écran. */
                const cell = e.currentTarget.getBoundingClientRect();
                setTip({
                  x: cell.left + cell.width / 2,
                  y: cell.top,
                  date: fmtDay.format(d.date),
                  eps: d.n ? t("profile.blocks.heatmap.episodes", { count: d.n }) : t("profile.blocks.heatmap.nothing"),
                });
              }}
            />
          ),
        )}
      </span>
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, geo, labelW, fmtDay, t]);

  /* Reculer n'a de sens que s'il reste des journées regardées avant la
     première semaine affichée. */
  const shownFrom = mondayOf(new Date());
  shownFrom.setDate(shownFrom.getDate() - (back + (geo?.weeks ?? ALL_WEEKS) - 1) * 7);
  const canBack = firstDay != null && firstDay < dayKey(shownFrom.getTime());
  /* L'ANNÉE, dans le coin de l'en-tête (03/11/2026, Luc : « mets l'année
     ailleurs » — collée aux noms de mois, elle les décalait) : « 2025 – 2026 »
     quand la période affichée chevauche deux années. */
  const shownTo = mondayOf(new Date());
  shownTo.setDate(shownTo.getDate() - back * 7 + 6);
  const y0 = shownFrom.getFullYear();
  const y1 = Math.min(shownTo.getFullYear(), new Date().getFullYear());
  const years = y0 === y1 ? String(y1) : `${y0} – ${y1}`;

  if (!days) return <div className="h-full" />;

  return (
    /* TOUTE LA PLACE À LA GRILLE (02/11/2026, Luc) : plus de ligne de bilan
       (épisodes, jours actifs, record), et la légende monte dans le coin de
       l'en-tête de la carte, comme les flèches de la vitrine (`endRoom`,
       ProfileOverview). En réorganisation, 6 px plus bas, sous la roue. */
    <div className="as-heat relative flex h-full min-h-0 flex-col">
      <div
        className={`absolute ${editing ? "-top-[32px]" : "-top-[38px]"} right-0 z-10 flex h-[26px] items-center`}
        /* Hauteur FIXE, celle de la pastille de série : sans elle, la ligne
           rapetissait et la légende remontait (03/11/2026, Luc). */
      >
        <span className="mr-3 whitespace-nowrap font-outfit text-[12px] font-bold tabular-nums text-white/70">{years}</span>
        {streak && runs.now > 0 ? (
          /* LA SÉRIE (03/11/2026, Luc, réglage « Afficher les séries ») : la
             pastille à flamme de « Vu récemment », au même dessin (noir
             translucide, cf. DeviceBlocks). La phrase entière et le record
             sont dans le `title`. */
          <span
            className="as-heat-streak flex items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1 ring-1 ring-black/20"
            title={`${t("profile.blocks.heatmap.streak", { count: runs.now })} · ${t("profile.blocks.heatmap.record", { count: runs.best })}`}
          >
            <span aria-hidden className="text-[15px] leading-none">
              🔥
            </span>
            <span className="font-outfit text-[13px] font-bold leading-none text-white">{runs.now}</span>
          </span>
        ) : null}
        <span className="as-heat-legend flex shrink-0 items-center gap-1 whitespace-nowrap font-karla text-[10px] text-txt">
          <span>{t("profile.blocks.heatmap.less")}</span>
          {LEVELS.map((c, i) => (
            <span key={i} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />
          ))}
          <span>{t("profile.blocks.heatmap.more")}</span>
        </span>
        {/* Les flèches de la vitrine, au même endroit (coin de l'en-tête) et
            au même dessin. En réorganisation, elles reprennent la main
            (`!pointer-events-auto`) et arrêtent le pointeur, sinon cliquer
            attraperait la carte. Pas de recul avant la première journée
            regardée, pas d'avance au-delà d'aujourd'hui : la flèche qui ne
            mène nulle part reste affichée mais grisée et inerte (03/11/2026,
            Luc : « pas cliquable au lieu de pas l'afficher »). */}
        <span className="ml-3 flex gap-1.5">
          {[-1, 1].map((dir) => {
            const step = geo?.weeks ?? ALL_WEEKS;
            const off = dir < 0 ? !canBack : back === 0;
            return (
              <button
                key={dir}
                type="button"
                disabled={off}
                onClick={() => setBack((b) => Math.max(0, b - dir * step))}
                onPointerDown={editing ? (e) => e.stopPropagation() : undefined}
                aria-label={t(dir < 0 ? "anime.prev" : "anime.next")}
                style={off ? { opacity: 0.35 } : undefined}
                className={`flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.06] text-white/60 ring-1 ring-white/10 transition-[color,background-color,opacity] !pointer-events-auto ${
                  off ? "cursor-default" : "hover:bg-white/[0.12] hover:text-white"
                }`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3">
                  <polyline points={dir < 0 ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
                </svg>
              </button>
            );
          })}
        </span>
      </div>

      <div ref={boxRef} className="relative min-h-0 flex-1">
        {grid && geo ? (
          /* CENTRÉE QUAND L'ANNÉE ENTIÈRE TIENT (03/11/2026, Luc) : le bloc
             prend alors sa largeur exacte au milieu de la carte. Sinon il
             occupe toute la largeur ; le reste fait moins d'une colonne. */
          <div
            className="absolute inset-y-0 left-1/2 -translate-x-1/2"
            style={{ width: geo.weeks === ALL_WEEKS ? labelW + ALL_WEEKS * pitch - GAP : "100%" }}
          >
          {/* RIEN NE GLISSE (03/11/2026, Luc : « les jours font droite
              gauche »). Centrée, la grille avançait avec la carte puis
              reculait d'un demi-mois à chaque mois gagné : des dents de scie.
              Les jours restent au bord gauche de la carte, la grille d'un an
              colle au bord droit (aujourd'hui) ; seules les colonnes
              s'allument ou s'éteignent. */}
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2"
            style={{ width: labelW, height: MONTHS_H + 7 * geo.cell + 6 * GAP }}
          >
            {[0, 1, 2, 3, 4, 5, 6].map((r) => (
              <span
                key={r}
                className="absolute left-0 font-karla text-[9px] leading-none text-txt"
                /* Le corps suit le pas des lignes pour qu'ils ne se
                   chevauchent pas quand les cases rétrécissent. */
                style={{
                  top: MONTHS_H + r * pitch + geo.cell / 2,
                  fontSize: Math.min(9, pitch - 1),
                  transform: "translateY(-50%)",
                }}
              >
                {/* Abrégés (03/11/2026, Luc). Majuscule posée ici :
                    `capitalize` ne prenait que sur lundi. */}
                {dayNames[r].charAt(0).toUpperCase() + dayNames[r].slice(1)}
              </span>
            ))}
          </span>
          {/* RIEN SOUS LES JOURS (03/11/2026, Luc) : une colonne qui
              s'éteint pendant un rétrécissement rapide est coupée net au
              bord de la grille, au lieu de passer sous leurs noms. Seul le
              bord gauche coupe (l'infobulle et le survol débordent ailleurs). */}
          <div
            className="absolute inset-y-0 right-0"
            style={{ left: labelW - 2, clipPath: "inset(-200px -200px -200px 0)" }}
          >
          <div
            className="as-heat-grid absolute right-0 top-1/2 -translate-y-1/2"
            style={{ width: fullW, height: MONTHS_H + 7 * geo.cell + 6 * GAP }}
            onMouseLeave={() => setTip(null)}
          >
            {/* Les mois, centrés sur leurs semaines ; allumés avec leur
                première semaine par le séquenceur. */}
            {grid.months.map((m) => {
              const half = Math.ceil(m.label.length * 2.75);
              const center = labelW + ((m.col + m.end - 1) / 2) * pitch + geo.cell / 2;
              return (
                <span
                  key={m.key}
                  ref={(el) => {
                    monthEls.current[m.col] = el;
                  }}
                  className="as-heat-month absolute top-0 -translate-x-1/2 whitespace-nowrap font-karla text-[10px] leading-none text-txt"
                  /* Le dernier mois ne dépasse pas la grille : son nom recule
                     jusqu'à tenir (≈ 5,5 px par lettre à 10 px). */
                  style={{ left: Math.min(center, fullW - half) }}
                >
                  {m.label}
                </span>
              );
            })}
            {cells}
            {tip
              ? /* SORT DU WIDGET (03/11/2026, Luc) : portée par le `body`,
                   comme la bulle de « Vus par année de sortie », elle passe
                   par-dessus le bord de la carte et ses voisines, bornée aux
                   seuls bords de la fenêtre.
                   L'APPARITION est la sienne aussi : `as-preview-root`, sur une
                   boîte intérieure, car le placement occupe déjà le
                   `transform` de celle du dehors. Sans clé : le geste joue à
                   l'arrivée sur la grille, pas à chaque case. */
                createPortal(
                  <span
                    className="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-full"
                    style={{
                      left: Math.min(Math.max(tip.x, 98), window.innerWidth - 98),
                      top: tip.y - 6,
                    }}
                  >
                    <span className="as-preview-root block whitespace-nowrap rounded-lg bg-[rgba(10,10,16,0.92)] px-2 py-1 text-center ring-1 ring-white/10 font-karla text-[11px] leading-snug text-white shadow-lg">
                      {/* Deux lignes (02/11/2026, Luc) : la date, puis la quantité. */}
                      <span className="block first-letter:uppercase">{tip.date}</span>
                      <span className="block font-bold text-white/70">{tip.eps}</span>
                    </span>
                  </span>,
                  document.body,
                )
              : null}
          </div>
          </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
