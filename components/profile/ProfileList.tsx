import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { HeartIcon } from "@heroicons/react/24/solid";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import {
  customListColor,
  listLabel,
  prettyFormat,
  STATUS_TO_LIST,
  LIST_COLORS,
} from "@/components/anime/v2/helpers";
import { scoreBucket } from "@/lib/profile/insights";
import {
  activeCount,
  applyFilters,
  boundsOf,
  freshFilters,
  sortEntries,
  SORT_KEYS,
  type ListFilters,
  type SortKey,
} from "@/lib/profile/listFilter";
import ListSortFilter, { Chevron } from "@/components/profile/ListSortFilter";
import ListManager from "@/components/profile/ListManager";
import { EMPTY_REGISTRY, useListRegistry } from "@/lib/profile/listRegistry";
import type { ProfileEntry } from "@/lib/profile/types";

/**
 * L'onglet Liste d'un profil : la BARRE UNIQUE de la version de référence
 * (08/11/2026, Luc) — tri & filtres, recherche, menus Statut et Listes, choix
 * de vue (cartes, grille, compacte) — puis la liste, triée, sans barre de
 * progression (retirée à sa demande).
 *
 * Source-agnostic on purpose — it is handed already-normalised entries
 * (lib/profile/types.ts), so the AniList profile, an AniScroll account's
 * profile and the local /me profile all render through this one component and
 * cannot drift apart.
 */

/**
 * Les lignes rendues TOUT DE SUITE ; le reste suit dans une transition.
 *
 * Mesuré au CDP sur dev (682 titres) : ouvrir l'onglet rendait les 682 lignes
 * d'un bloc, une tâche longue de ~140 ms. Le clic ne répondait donc à rien
 * pendant ce temps — la pilule des onglets ne partait qu'après — puis tout
 * arrivait d'un coup. Quarante lignes remplissent l'écran ; les autres sont
 * rendues par React en tranches qu'il interrompt pour laisser passer le reste.
 */
const FIRST_ROWS = 40;

/* L'ordre et les noms de l'éditeur de liste (components/listEditor.tsx) : le
   menu Statut doit se lire comme celui où l'on CHOISIT le statut (08/11, Luc). */
const STATUS_ORDER = ["CURRENT", "REPEATING", "COMPLETED", "PLANNING", "PAUSED", "DROPPED"];
const STATUS_KEY: Record<string, string> = {
  CURRENT: "listEditor.watching",
  REPEATING: "listEditor.repeating",
  COMPLETED: "listEditor.completed",
  PLANNING: "listEditor.planToWatch",
  PAUSED: "listEditor.paused",
  DROPPED: "listEditor.dropped",
};

type View = "cards" | "grid" | "compact";
const VIEWS: View[] = ["cards", "grid", "compact"];
/* La vue et le tri sont des préférences de l'appareil, pas du profil : on les
   retrouve d'un profil à l'autre. Lus après le montage, sans quoi le rendu
   serveur et le premier rendu client divergeraient. */
const VIEW_KEY = "as-profile-list-view";
const SORT_KEY = "as-profile-list-sort";

/**
 * SUR QUOI LA LISTE S'OUVRE, quand on n'y arrive pas par l'onglet mais par un
 * clic ailleurs — une colonne de l'histogramme des notes.
 *
 * Un objet et pas deux props : il est REJOUÉ à chaque fois que l'appelant en
 * pose un nouveau (c'est son identité qui le dit), y compris quand la note
 * demandée est la même que la précédente. Deux props séparées auraient laissé
 * un second clic sur la même colonne sans effet.
 */
export type ListFocus = { status?: string | null; score?: number | null };

export default function ProfileList({
  entries,
  emptyAction,
  focus,
  editable = false,
}: {
  entries: ProfileEntry[];
  /** Son propre profil : le « + » (gestionnaire de listes) et le registre de
   *  CET appareil (ordre et couleurs des statuts, listes AniScroll). Sur le
   *  profil d'un autre, le registre du visiteur n'a rien à faire. */
  editable?: boolean;
  /** Rendered under the "nothing here" message (a link to go and watch). */
  emptyAction?: React.ReactNode;
  focus?: ListFocus | null;
}) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const [status, setStatus] = useState(focus?.status || "all");
  const [list, setList] = useState<string>("");
  const [score, setScore] = useState<number | null>(focus?.score ?? null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("cards");
  const [menu, setMenu] = useState<"" | "status" | "list">("");
  const [panel, setPanel] = useState(false);
  const [manager, setManager] = useState(false);
  const liveReg = useListRegistry();
  const reg = editable ? liveReg : EMPTY_REGISTRY;
  const [picked, setPicked] = useState<number | null>(null);

  const bounds = useMemo(() => boundsOf(entries), [entries]);
  const [filters, setFilters] = useState<ListFilters>(() => freshFilters(bounds));
  /* Les bornes suivent la liste (le plus long titre fixe le max des épisodes) :
     une sélection encore pleine reste pleine. */
  const prevBounds = useRef(bounds);
  useEffect(() => {
    const prev = prevBounds.current;
    prevBounds.current = bounds;
    if (prev === bounds) return;
    setFilters((f) => ({
      ...f,
      ranges: {
        ...f.ranges,
        episodes: f.ranges.episodes[1] >= prev.episodes[1]
          ? [f.ranges.episodes[0], bounds.episodes[1]]
          : [f.ranges.episodes[0], Math.min(f.ranges.episodes[1], bounds.episodes[1])],
      },
    }));
  }, [bounds]);

  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY) as View | null;
      if (v && VIEWS.includes(v)) setView(v);
      const s = JSON.parse(localStorage.getItem(SORT_KEY) || "null");
      if (s && SORT_KEYS.includes(s.sort)) setFilters((f) => ({ ...f, sort: s.sort as SortKey, desc: !!s.desc }));
    } catch {}
  }, []);
  const chooseView = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch {}
  };
  const changeFilters = (f: ListFilters) => {
    setFilters(f);
    try { localStorage.setItem(SORT_KEY, JSON.stringify({ sort: f.sort, desc: f.desc })); } catch {}
  };

  useEffect(() => {
    if (!focus) return;
    setStatus(focus.status || "all");
    setScore(focus.score ?? null);
  }, [focus]);

  // Un clic hors des menus Statut / Listes les referme.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.("[data-list-dd]")) setMenu("");
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu("");
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const titleOf = useCallback((e: ProfileEntry) => pickTitle(e.title, titlePref), [titlePref]);

  /* LA NOTE FILTRE AVANT TOUT LE RESTE, donc les compteurs des menus et l'état
     vide décrivent tous la même sélection. Le palier vient de `scoreBucket`,
     partagé avec l'histogramme : un 6,7 tombe ici dans la colonne où il était
     dessiné là-bas. */
  const base = useMemo(
    () => (score == null ? entries : entries.filter((e) => e.score && scoreBucket(e.score) === score)),
    [entries, score],
  );

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of base) c[e.status || "PLANNING"] = (c[e.status || "PLANNING"] || 0) + 1;
    return c;
  }, [base]);
  /* Les listes perso d'AniList, lues sur les entrées. */
  const anilistLists = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of base) for (const n of e.customLists ?? []) c.set(n, (c.get(n) || 0) + 1);
    return [...c.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [base]);
  /* Les listes créées dans AniScroll (registre), dans l'ordre du gestionnaire,
     comptées sur la liste affichée. Une liste AniList du même nom l'emporte. */
  const localLists = useMemo(() => {
    const ids = new Set(base.map((e) => e.mediaId));
    return reg.lists
      .filter((l) => !anilistLists.some(([n]) => n === l.name))
      .map((l) => ({ ...l, count: l.ids.filter((id) => ids.has(id)).length }));
  }, [reg.lists, base, anilistLists]);
  const listColor = (n: string) =>
    localLists.find((l) => l.name === n)?.color || reg.anilistColors[n] || customListColor(n);

  // Une liste perso disparue (autre profil, filtre de note) ne filtre plus rien.
  const activeLocal = localLists.find((l) => l.name === list) || null;
  const activeList = list && (activeLocal || anilistLists.some(([n]) => n === list)) ? list : "";

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pre = base.filter(
      (e) =>
        (status === "all" || (e.status || "PLANNING") === status) &&
        (!activeList ||
          (activeLocal ? activeLocal.ids.includes(e.mediaId) : e.customLists?.includes(activeList))) &&
        (!q ||
          [e.title?.english, e.title?.romaji, e.title?.native, e.title?.userPreferred].some((x) =>
            x?.toLowerCase().includes(q),
          )),
    );
    return sortEntries(applyFilters(pre, filters, bounds), filters, titleOf);
  }, [base, status, activeList, activeLocal, query, filters, bounds, titleOf]);

  /* Tout est-il rendu pour CETTE sélection ? La clé change avec elle : une
     nouvelle sélection repart de quarante lignes, sans rendu de remise à zéro. */
  const viewKey = `${status}|${activeList}|${score ?? ""}|${query}|${JSON.stringify(filters)}|${view}`;
  const [fullKey, setFullKey] = useState<string | null>(null);
  const full = fullKey === viewKey;
  useEffect(() => {
    if (full) return;
    startTransition(() => setFullKey(viewKey));
  }, [full, viewKey]);
  const rows = full ? shown : shown.slice(0, FIRST_ROWS);

  const nFilters = activeCount(filters, bounds);

  const clearAll = () => {
    setStatus("all");
    setList("");
    setScore(null);
    setQuery("");
    changeFilters({ ...freshFilters(bounds), sort: filters.sort, desc: filters.desc });
  };

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-5 py-20 text-center">
        <p className="text-lg font-bold">{t("myList.empty")}</p>
        {emptyAction}
      </div>
    );
  }

  const statusColor = (s: string | null) =>
    reg.statusColors[s || "PLANNING"] || LIST_COLORS[STATUS_TO_LIST[s || "PLANNING"]] || "#6b7280";
  const statusName = (s: string | null) => {
    const k = STATUS_KEY[s || "PLANNING"];
    return k ? t(k) : listLabel(t, STATUS_TO_LIST[s || ""] || s || "");
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {editable ? (
          <button
            type="button"
            onClick={() => setManager(true)}
            aria-label={t("listMenu.manager.manage")}
            title={t("listMenu.manager.manage")}
            className="as-list-ib as-stat-card relative"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setPanel(true)}
          aria-label={t("listMenu.sortFilter")}
          title={t("listMenu.sortFilter")}
          className={`as-list-ib as-stat-card relative ${nFilters ? "is-on" : ""}`}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          {nFilters ? <span className="as-list-ib-badge">{nFilters}</span> : null}
        </button>

        <label className="as-list-field as-stat-card min-w-0 flex-[3_1_220px] cursor-text focus-within:!border-action">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 text-white/40"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("listMenu.search")}
            aria-label={t("listMenu.search")}
            className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
          />
        </label>

        {/* LA NOTE EN COURS, détachable : on arrive ici avec un filtre qu'on n'a
            pas posé sur cet onglet (l'histogramme des notes). Sans elle, une
            liste de six titres passerait pour la liste entière. En OR, la
            couleur des notes partout ailleurs. */}
        {score != null ? (
          <button
            type="button"
            onClick={() => setScore(null)}
            title={t("myList.clearScore")}
            className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-as-score/15 px-3 text-sm font-medium text-as-score ring-1 ring-as-score/40 transition-colors hover:bg-as-score/25"
          >
            <span>★ {String(score).replace(".", ",")}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" className="h-3 w-3"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
          </button>
        ) : null}

        {/* Menu Statut */}
        <div data-list-dd className="relative min-w-0 flex-[2_1_150px]">
          <button
            type="button"
            aria-expanded={menu === "status"}
            onClick={() => setMenu(menu === "status" ? "" : "status")}
            className={`as-list-field as-stat-card w-full justify-between font-semibold ${status !== "all" ? "is-set" : ""}`}
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              {status !== "all" ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(status) }} /> : null}
              <span className="truncate">{status === "all" ? t("listMenu.status") : statusName(status)}</span>
            </span>
            <Chevron className="shrink-0 opacity-50" />
          </button>
          {menu === "status" ? (
            <div className="as-list-menu">
              <MenuItem on={status === "all"} onClick={() => { setStatus("all"); setMenu(""); }} label={t("listMenu.allStatuses")} count={base.length} />
              {(editable ? reg.statusOrder : STATUS_ORDER).filter((s) => statusCounts[s]).map((s) => (
                <MenuItem key={s} on={status === s} onClick={() => { setStatus(s); setMenu(""); }} color={statusColor(s)} label={statusName(s)} count={statusCounts[s]} />
              ))}
            </div>
          ) : null}
        </div>

        {/* Menu Listes perso */}
        <div data-list-dd className="relative min-w-0 flex-[2_1_150px]">
          <button
            type="button"
            aria-expanded={menu === "list"}
            onClick={() => setMenu(menu === "list" ? "" : "list")}
            className={`as-list-field as-stat-card w-full justify-between font-semibold ${activeList ? "is-set" : ""}`}
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              {activeList ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: listColor(activeList) }} /> : null}
              <span className="truncate">{activeList || t("listMenu.lists")}</span>
            </span>
            <Chevron className="shrink-0 opacity-50" />
          </button>
          {menu === "list" ? (
            <div className="as-list-menu">
              <MenuItem on={!activeList} onClick={() => { setList(""); setMenu(""); }} label={t("listMenu.allEntries")} count={base.length} />
              {localLists.length || anilistLists.length ? (
                <>
                  {localLists.map((l) => (
                    <MenuItem key={`l:${l.name}`} on={activeList === l.name} onClick={() => { setList(l.name); setMenu(""); }} color={l.color} label={l.name} count={l.count} />
                  ))}
                  {anilistLists.map(([n, c]) => (
                    <MenuItem key={`a:${n}`} on={activeList === n} onClick={() => { setList(n); setMenu(""); }} color={listColor(n)} label={n} count={c} />
                  ))}
                </>
              ) : (
                <p className="px-2.5 py-2 text-xs text-white/40">{t("listMenu.noCustomLists")}</p>
              )}
              {editable ? (
                <button
                  type="button"
                  onClick={() => { setMenu(""); setManager(true); }}
                  className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-white/[0.06] px-2.5 py-2 text-left text-[13px] font-semibold text-action hover:bg-white/[0.05]"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  {t("listMenu.manager.manage")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Choix de vue */}
        <div role="group" aria-label={t("listMenu.view")} className="flex h-9 shrink-0 items-center gap-0.5 as-stat-card rounded-[10px] border border-white/[0.12] p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => chooseView(v)}
              aria-pressed={view === v}
              aria-label={t(`listMenu.views.${v}`)}
              title={t(`listMenu.views.${v}`)}
              className={`grid h-full w-8 place-items-center rounded-[8px] transition-colors ${view === v ? "bg-white/[0.12] text-white" : "text-white/40 hover:text-white/80"}`}
            >
              <ViewIcon v={v} />
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <p className="font-bold text-white/70">
            {score != null && base.length === 0
              ? t("myList.noneAtScore", { score: String(score).replace(".", ",") })
              : t("listMenu.nothing")}
          </p>
          <p className="text-sm text-white/40">{t("listMenu.nothingHint")}</p>
          <button type="button" onClick={clearAll} className="mt-3 rounded-lg px-4 py-2 text-sm ring-1 ring-action transition-colors hover:bg-action/10">
            {t("listMenu.clearAll")}
          </button>
        </div>
      ) : view === "grid" ? (
        /* Un fond translucide (teinte et flou du profil) sous TOUTE la grille,
           comme les autres surfaces (08/11, Luc) : les titres ne se lisent plus
           à même l'illustration. */
        <div className="as-stat-card grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3.5 rounded-2xl p-3.5 ring-1 ring-white/[0.07] sm:p-4">
          {rows.map((e) => (
            <Link
              key={e.mediaId}
              href={animeHref(e.mediaId, clickTarget)}
              className={`group flex min-w-0 flex-col gap-1.5 ${picked === e.mediaId ? "as-list-picked" : ""}`}
            >
              <span className="relative block aspect-[2/3] overflow-hidden rounded-[10px] bg-white/10">
                {e.cover ? (
                  <Image src={e.cover} alt="" fill sizes="(max-width: 640px) 33vw, 160px" className="object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
                ) : null}
                {/* La pastille de statut avec le halo des menus (as-list-dot), posée
                    sur une rondelle sombre : le halo s'y voit comme sur le fond du
                    menu. Un contour sombre autour de la pastille le recouvrait
                    (08/11, Luc : « c pas les glows de couleur »). */}
                <span className="absolute left-1 top-1 grid h-[18px] w-[18px] place-items-center rounded-full bg-black/55" title={statusName(e.status)}>
                  <span
                    className="as-list-dot !h-2 !w-2"
                    style={{ background: statusColor(e.status), ["--c" as string]: statusColor(e.status) } as React.CSSProperties}
                  />
                </span>
                {e.favourite ? <HeartIcon className="absolute right-1.5 top-1.5 h-4 w-4 text-action drop-shadow" /> : null}
                {e.score ? (
                  <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-bold text-as-score">{e.score}</span>
                ) : null}
              </span>
              <span className="truncate text-[13px] font-semibold group-hover:text-action">{titleOf(e)}</span>
              <span className="text-[11px] tabular-nums text-white/40">
                {progressText(e)}{e.format ? ` · ${prettyFormat(e.format)}` : ""}
              </span>
            </Link>
          ))}
        </div>
      ) : view === "compact" ? (
        <div className="as-stat-card overflow-hidden rounded-xl ring-1 ring-white/[0.07]">
          {rows.map((e) => (
            <Link
              key={e.mediaId}
              href={animeHref(e.mediaId, clickTarget)}
              className={`as-list-row group grid grid-cols-[10px_minmax(0,1fr)_40px_56px] items-center gap-3 border-b border-white/[0.04] px-3 py-2 text-sm transition-colors last:border-0 hover:bg-white/[0.06] sm:grid-cols-[10px_minmax(0,1fr)_110px_130px_40px_56px] ${picked === e.mediaId ? "as-list-picked" : ""}`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: statusColor(e.status) }} title={statusName(e.status)} />
              <span className="truncate font-medium group-hover:text-action">{titleOf(e)}</span>
              <span className="hidden truncate text-xs text-white/40 sm:block">{[e.format && prettyFormat(e.format), e.year].filter(Boolean).join(" · ")}</span>
              <span className="hidden truncate text-xs text-white/40 sm:block">{e.studio ?? ""}</span>
              <span className="text-right text-xs font-bold tabular-nums text-as-score">{e.score || "–"}</span>
              <span className="text-right text-xs tabular-nums text-white/50">{progressText(e)}</span>
            </Link>
          ))}
        </div>
      ) : (
        /* `as-stat-card` comme toutes les surfaces du profil : le fond sombre
           et le flou du studio. */
        <div className="flex flex-col gap-2">
          {rows.map((e) => (
            <Row
              key={e.mediaId}
              entry={e}
              color={statusColor(e.status)}
              statusName={statusName(e.status)}
              href={animeHref(e.mediaId, clickTarget)}
              title={titleOf(e)}
              picked={picked === e.mediaId}
            />
          ))}
        </div>
      )}

      {editable ? (
        <ListManager
          open={manager}
          onClose={() => setManager(false)}
          statusCounts={statusCounts}
          anilistLists={anilistLists}
          localCounts={Object.fromEntries(localLists.map((l) => [l.name, l.count]))}
        />
      ) : null}

      <ListSortFilter
        open={panel}
        onClose={() => setPanel(false)}
        entries={base}
        filters={filters}
        bounds={bounds}
        onChange={changeFilters}
        count={shown.length}
        onRandom={() => {
          if (!shown.length) { setPicked(null); return null; }
          const e = shown[Math.floor(Math.random() * shown.length)];
          setPicked(e.mediaId);
          return titleOf(e);
        }}
      />
    </>
  );
}

function progressText(e: ProfileEntry) {
  return e.total ? `${e.progress}/${e.total}` : String(e.progress);
}

/* Une option des menus Statut / Listes, comme `.lf-dd-option` de la référence
   (08/11, Luc) : pastille LUMINEUSE (halo qui PULSE, `pulse-green` de la
   référence), coche à droite pour
   la sélection, pas de compteur. */
function MenuItem({
  on,
  onClick,
  label,
  color,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  color?: string;
}) {
  const c = color || "rgba(255,255,255,.6)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`as-list-opt${on ? " is-on" : ""}`}
    >
      <span className="as-list-dot" style={{ background: c, ["--c" as string]: c } as React.CSSProperties} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {on ? (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-white/70" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      ) : null}
    </button>
  );
}

function ViewIcon({ v }: { v: View }) {
  const p =
    v === "cards"
      ? <><rect x="3" y="4" width="18" height="6" rx="1" /><rect x="3" y="14" width="18" height="6" rx="1" /></>
      : v === "grid"
        ? <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>
        : <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />;
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {p}
    </svg>
  );
}

function Row({
  entry,
  color,
  statusName,
  href,
  title,
  picked,
}: {
  entry: ProfileEntry;
  color: string;
  statusName: string;
  href: string;
  title: string;
  picked: boolean;
}) {
  const sub = [entry.format && prettyFormat(entry.format), entry.year, entry.studio].filter(Boolean).join(" · ");
  return (
    <Link
      href={href}
      /* `as-list-row` : une ligne hors de l'écran n'est ni mise en page ni
         peinte (cf. globals.css). */
      /* Plus grande depuis le 08/11 (Luc) : affiche 56×80, titre en 16 px. */
      className={`as-list-row as-stat-card group flex items-center gap-4 rounded-2xl py-2 pl-2 pr-4 ring-1 ring-white/[0.07] transition-colors hover:bg-white/[0.06] ${picked ? "as-list-picked" : ""}`}
    >
      {entry.cover ? (
        <Image src={entry.cover} alt="" width={56} height={80} className="h-20 w-14 shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="h-20 w-14 shrink-0 rounded-lg bg-white/10" />
      )}

      {/* Disposition n° 02 de l'artefact des lignes, retenue par Luc le 08/11 :
          le statut passe SOUS le titre, en pastille, devant la méta — sans le
          liseré coloré à gauche. La droite ne garde que les chiffres. */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold group-hover:text-action">{title}</p>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <span
            className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold"
            style={{ color, background: `${color}24`, boxShadow: `inset 0 0 0 1px ${color}66` }}
          >
            {statusName}
          </span>
          {sub ? <span className="truncate text-[13px] text-white/40">{sub}</span> : null}
        </div>
      </div>
      {entry.repeat ? (
        <span className="shrink-0 text-xs text-white/35" title={`×${entry.repeat}`}>↻{entry.repeat}</span>
      ) : null}
      {entry.favourite ? <HeartIcon className="h-5 w-5 shrink-0 text-action" /> : null}
      {/* Les épisodes dans une case, centrés, jumelle neutre de celle de la note (08/11, Luc). */}
      <span className="w-16 shrink-0 rounded-lg bg-white/[0.07] py-1.5 text-center text-sm font-semibold tabular-nums text-white/75 ring-1 ring-white/[0.08]">
        {progressText(entry)}
      </span>
      {entry.score ? (
        <span className="w-12 shrink-0 rounded-lg bg-as-score/10 py-1.5 text-center text-sm font-bold text-as-score">{entry.score}</span>
      ) : (
        <span className="w-12 shrink-0" />
      )}
    </Link>
  );
}
