import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { HeartIcon } from "@/components/profile/HeartIcon";
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
import { CUSTOM_STATUS, EMPTY_REGISTRY, orderCustom, useListRegistry } from "@/lib/profile/listRegistry";
import type { ProfileEntry } from "@/lib/profile/types";
import { useShowAdult } from "@/lib/prefs/adultPrefs";

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
/* PLUS DE RENDU COMPLET (12/11/2026, Luc : « grosse opti ») : la transition
   ci-dessus finissait quand même par monter les 690 lignes, et changer de vue
   les démontait toutes pour en remonter 690 autres — un commit que React ne sait
   pas découper. La liste grandit maintenant par tranches, quand une sentinelle
   arrive à ~1,5 écran du bas. Changer de vue ne coûte plus que 40 lignes. */
const CHUNK = 80;

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
/* « 2 » depuis le tri « Par liste » devenu le défaut (16/11, Luc) : le tri
   retenu avant (presque toujours « Mis à jour », l'ancien défaut) l'aurait
   masqué. */
const SORT_KEY = "as-profile-list-sort2";

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
  entries: allEntries,
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
  /* LE RÉGLAGE -18 DU VISITEUR gouverne toute liste, la sienne comme celle
     d'un autre (14/11, Luc) : réglage éteint, les titres adultes n'existent
     pas ici (ni cartes, ni compteurs, ni filtres), pour que personne ne tombe
     dessus par mégarde. Éteint par défaut tant que le navigateur n'a pas lu. */
  const showAdult = useShowAdult();
  const entries = useMemo(
    () => (showAdult ? allEntries : allEntries.filter((e) => !e.isAdult)),
    [allEntries, showAdult],
  );
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const [status, setStatus] = useState(focus?.status || "all");
  const [list, setList] = useState<string>("");
  const [score, setScore] = useState<number | null>(focus?.score ?? null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  /* LE BOUTON ET LA LISTE NE CHANGENT PAS DANS LE MEME RENDU (12/11, Luc) :
     `pickedView` bouge tout de suite (carré qui glisse, squelette de la
     nouvelle vue), `view` suit en différé, interruptible. */
  const [pickedView, setView] = useState<View>("cards");
  const view = useDeferredValue(pickedView);
  const [menu, setMenu] = useState<"" | "status" | "list">("");
  /* LES MENUS STATUT / LISTES (20/11/2026, Luc) : vers le bas s'il y a la
     place sous le champ ; sinon vers le haut, si la place y est entre le champ
     et la barre de navigation fixe (64 px). Décidé au montage, avant
     l'affichage. */
  const placeMenu = (el: HTMLDivElement | null) => {
    if (!el) return;
    const field = el.parentElement?.getBoundingClientRect();
    if (!field) return;
    const h = el.offsetHeight + 12;
    const below = window.innerHeight - field.bottom >= h;
    el.classList.toggle("is-up", !below && field.top - 64 >= h);
  };
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
    // Les statuts perso du registre (`c:<nom>`), comptés sur la liste affichée.
    const ids = new Set(base.map((e) => e.mediaId));
    for (const s of reg.statuses) c[CUSTOM_STATUS + s.name] = s.ids.filter((id) => ids.has(id)).length;
    return c;
  }, [base, reg.statuses]);
  const customStatusOf = useCallback(
    (s: string | null) =>
      s && s.startsWith(CUSTOM_STATUS) ? reg.statuses.find((x) => CUSTOM_STATUS + x.name === s) ?? null : null,
    [reg.statuses],
  );
  const activeCustomStatus = customStatusOf(status);
  /* L'ordre du tri « Par liste » : celui du menu Statut, sans les statuts
     perso (une entrée n'en porte qu'un, celui d'AniList). */
  const statusOrder = useMemo(
    () => (editable ? reg.statusOrder : STATUS_ORDER).filter((s) => !s.startsWith(CUSTOM_STATUS)),
    [editable, reg.statusOrder],
  );
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
        (status === "all" ||
          (activeCustomStatus ? activeCustomStatus.ids.includes(e.mediaId) : (e.status || "PLANNING") === status)) &&
        (!activeList ||
          (activeLocal ? activeLocal.ids.includes(e.mediaId) : e.customLists?.includes(activeList))) &&
        (!q ||
          [e.title?.english, e.title?.romaji, e.title?.native, e.title?.userPreferred].some((x) =>
            x?.toLowerCase().includes(q),
          )),
    );
    return sortEntries(applyFilters(pre, filters, bounds), filters, titleOf, statusOrder);
  }, [base, status, activeCustomStatus, activeList, activeLocal, query, filters, bounds, titleOf, statusOrder]);

  /* Combien de lignes pour CETTE sélection. La clé change avec elle : une
     nouvelle sélection (ou vue) repart de quarante lignes, sans rendu de remise
     à zéro. Le titre tiré au hasard est toujours rendu, même loin. */
  const viewKey = `${status}|${activeList}|${score ?? ""}|${query}|${JSON.stringify(filters)}|${view}`;
  const [grown, setGrown] = useState<{ key: string; n: number }>({ key: "", n: FIRST_ROWS });
  const limit = grown.key === viewKey ? grown.n : FIRST_ROWS;
  const pickedAt = picked == null ? -1 : shown.findIndex((e) => e.mediaId === picked);
  const rows = useMemo(
    () => (shown.length <= limit ? shown : shown.slice(0, Math.max(limit, pickedAt + 1))),
    [shown, limit, pickedAt],
  );
  const more = rows.length < shown.length;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!more || !el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((x) => x.isIntersecting)) {
          io.disconnect();
          startTransition(() => setGrown({ key: viewKey, n: rows.length + CHUNK }));
        }
      },
      { rootMargin: "0px 0px 1500px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more, viewKey, rows.length]);

  const nFilters = activeCount(filters, bounds);

  const clearAll = () => {
    setStatus("all");
    setList("");
    setScore(null);
    setQuery("");
    changeFilters({ ...freshFilters(bounds), sort: filters.sort, desc: filters.desc });
  };

  const statusColor = useCallback(
    (s: string | null) =>
      customStatusOf(s)?.color || reg.statusColors[s || "PLANNING"] || LIST_COLORS[STATUS_TO_LIST[s || "PLANNING"]] || "#6b7280",
    [customStatusOf, reg.statusColors],
  );
  const statusName = useCallback(
    (s: string | null) => {
      const cs = customStatusOf(s);
      if (cs) return cs.name;
      const k = STATUS_KEY[s || "PLANNING"];
      return k ? t(k) : listLabel(t, STATUS_TO_LIST[s || ""] || s || "");
    },
    [customStatusOf, t],
  );

  /* LES LIGNES SONT MEMOISEES (10/11/2026) : ouvrir un menu ou changer un
     champ re-rendait les six cents lignes. Elles ne se refont plus que si la
     vue, la selection ou ce qu'elles lisent change. */
  const grouped = filters.sort === "status";
  /* Combien de titres par statut dans la sélection ENTIÈRE : l'intertitre
     donne le total même quand la liste n'a encore rendu que 40 lignes. */
  const groupCounts = useMemo(() => {
    const c: Record<string, number> = {};
    if (grouped) for (const e of shown) c[e.status || "PLANNING"] = (c[e.status || "PLANNING"] || 0) + 1;
    return c;
  }, [grouped, shown]);
  const body = useMemo(() => {
    const panel = (rows: ProfileEntry[]) => (
view === "grid" ? (
        /* Un fond translucide (teinte et flou du profil) sous TOUTE la grille,
           comme les autres surfaces (08/11, Luc) : les titres ne se lisent plus
           à même l'illustration. */
        /* 8 AFFICHES PAR LIGNE AU PLUS (20/11, Luc) : la case ne descend pas
           sous le huitième de la largeur (7 gouttières de 0,875rem retirées),
           ni sous 112 px — en dessous, la grille perd des colonnes. */
        <div className="as-stat-card grid grid-cols-[repeat(auto-fill,minmax(max(112px,calc((100%_-_7*0.875rem)/8)),1fr))] gap-3.5 rounded-2xl p-3.5 ring-1 ring-white/[0.07] sm:p-4">
          {rows.map((e) => (
            <Link
              key={e.mediaId}
              href={animeHref(e.mediaId, clickTarget)}
              className={`group flex min-w-0 flex-col gap-1.5 ${picked === e.mediaId ? "as-list-picked" : ""}`}
            >
              {/* Le cœur hors du cadre de l'affiche, qui coupe ce qui dépasse. */}
              <span className="relative block">
                <span className="relative block aspect-[2/3] overflow-hidden rounded-[10px] bg-white/10">
                  {/* Un <img> nu : `next/image` est en `unoptimized` ici, il ne
                      faisait qu'ajouter un composant par case (12/11). */}
                  {e.cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={e.cover} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
                  ) : null}
                </span>
                {e.favourite ? <HeartIcon className="absolute right-1.5 top-1.5 h-4 w-4 text-action drop-shadow" /> : null}
              </span>
              {/* Le statut à GAUCHE DU TITRE, la pastille du menu Statut à
                  l'identique (08/11, Luc). */}
              <span className="flex min-w-0 items-center gap-2" title={statusName(e.status)}>
                <span className="as-glow-dot !h-2 !w-2" style={{ ["--c" as string]: statusColor(e.status) } as React.CSSProperties} />
                <span className="as-hover-title truncate text-[13px] font-semibold">{titleOf(e)}</span>
              </span>
              {/* La note sort de l'affiche : en bas à droite, sur la ligne de la
                  méta (08/11, Luc). */}
              <span className="flex min-w-0 items-center gap-2 text-[11px] tabular-nums text-white/40">
                <span className="min-w-0 flex-1 truncate">
                  {progressText(e, t)}{e.format ? ` · ${prettyFormat(e.format)}` : ""}
                </span>
                {e.score ? <span className="shrink-0 font-bold text-as-score">★ {e.score}</span> : null}
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
              className={`as-list-row as-list-row-compact group grid grid-cols-[10px_minmax(0,1fr)_40px_96px] items-center gap-3 px-3 py-2 text-sm shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)] transition-[background-color] last:shadow-none hover:bg-white/[0.06] sm:grid-cols-[10px_minmax(0,1fr)_110px_130px_40px_110px] ${picked === e.mediaId ? "as-list-picked" : ""}`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: statusColor(e.status) }} title={statusName(e.status)} />
              <span className="as-hover-title truncate font-medium">{titleOf(e)}</span>
              <span className="hidden truncate text-xs text-white/40 sm:block">{[e.format && prettyFormat(e.format), e.year].filter(Boolean).join(" · ")}</span>
              <span className="hidden truncate text-xs text-white/40 sm:block">{e.studio ?? ""}</span>
              <span className="text-center text-xs font-bold tabular-nums text-as-score">{e.score || "–"}</span>
              <span className="truncate text-center text-xs tabular-nums text-white/50">{progressText(e, t)}</span>
            </Link>
          ))}
        </div>
      ) : (
        /* UN SEUL panneau flou pour toute la liste, comme la vue compacte, plus
           une carte par anime (12/11, Luc). Un seul `backdrop-filter` aussi. */
        <div className="as-stat-card flex flex-col overflow-hidden rounded-2xl ring-1 ring-white/[0.07]">
          {rows.map((e) => (
            <Row
              key={e.mediaId}
              entry={e}
              color={statusColor(e.status)}
              statusName={statusName(e.status)}
              href={animeHref(e.mediaId, clickTarget)}
              title={titleOf(e)}
              picked={picked === e.mediaId}
              progress={progressText(e, t)}
            />
          ))}
        </div>
      )
    );
    if (!grouped) return panel(rows);
    /* Tri « Par liste » : un intertitre par statut, puis son propre panneau
       (16/11, Luc). Les lignes arrivent déjà rangées par statut. */
    const groups: ProfileEntry[][] = [];
    for (const e of rows) {
      const last = groups[groups.length - 1];
      if (last && (last[0].status || "PLANNING") === (e.status || "PLANNING")) last.push(e);
      else groups.push([e]);
    }
    return (
      <div className="flex flex-col gap-7">
        {groups.map((g) => {
          const s = g[0].status || "PLANNING";
          return (
            <section key={s} className="flex flex-col gap-3">
              <h3 className="flex items-center gap-2.5 px-1 text-[17px] font-bold">
                <span className="as-glow-dot !h-[11px] !w-[11px]" style={{ ["--c" as string]: statusColor(s) } as React.CSSProperties} />
                {statusName(s)}
                <span className="text-[14px] font-semibold tabular-nums text-white/40">{groupCounts[s] ?? g.length}</span>
              </h3>
              {panel(g)}
            </section>
          );
        })}
      </div>
    );
  }, [view, rows, grouped, groupCounts, clickTarget, picked, titleOf, statusColor, statusName, t]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-5 py-20 text-center">
        <p className="text-lg font-bold">{t("myList.empty")}</p>
        {emptyAction}
      </div>
    );
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {editable ? (
          <button
            type="button"
            onClick={() => setManager(true)}
            aria-label={t("listMenu.manager.manage")}
            title={t("listMenu.manager.manage")}
            className="as-list-ib as-stat-card relative"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setPanel(true)}
          aria-label={t("listMenu.sortFilter")}
          title={t("listMenu.sortFilter")}
          className={`as-list-ib as-stat-card relative ${nFilters ? "is-on" : ""}`}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          {nFilters ? <span className="as-list-ib-badge">{nFilters}</span> : null}
        </button>

        <label className="as-list-field as-stat-card min-w-0 flex-[3_1_220px] cursor-text focus-within:!border-action">
          {/* La loupe pleine des autres icônes du site (20/11/2026, Luc). */}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" className="shrink-0 text-white/40"><path d="M9.5,16q-2.72,0-4.61-1.89Q3,12.23 3,9.5Q3,6.77 4.89,4.89T9.5,3t4.61,1.89T16,9.5q0,1.1-0.35,2.07T14.7,13.3l5.6,5.6q0.28,0.28 0.28,0.7q0,0.42-0.28,0.7q-0.27,0.27-0.7,0.27T18.9,20.3l-5.6-5.6q-0.75,0.6-1.72,0.95T9.5,16Zm0-2q1.88,0 3.19-1.31T14,9.5T12.69,6.31T9.5,5T6.31,6.31T5,9.5t1.31,3.19T9.5,14Z" /></svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
            placeholder={t("listMenu.search")}
            aria-label={t("listMenu.search")}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-white/35"
          />
          {/* La croix qui vide le champ, et le garde actif (12/11, Luc). */}
          {query ? (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); setQuery(""); searchRef.current?.focus(); }}
              aria-label={t("listMenu.clearSearch")}
              title={t("listMenu.clearSearch")}
              className="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          ) : null}
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
            className="inline-flex h-[42px] items-center gap-2 rounded-[12px] bg-as-score/15 px-3 text-sm font-medium text-as-score ring-1 ring-as-score/40 transition-colors hover:bg-as-score/25"
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
            className={`as-list-field as-stat-card w-full justify-between font-semibold ${status !== "all" ? "is-set is-tinted" : ""}`}
            style={status !== "all" ? ({ ["--c" as string]: statusColor(status) } as React.CSSProperties) : undefined}
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              {status !== "all" ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(status) }} /> : null}
              <span className="truncate">{status === "all" ? t("listMenu.status") : statusName(status)}</span>
            </span>
            <Chevron className="shrink-0 opacity-50" />
          </button>
          {menu === "status" ? (
            <div className="as-list-menu" ref={placeMenu}>
              <MenuItem on={status === "all"} onClick={() => { setStatus("all"); setMenu(""); }} label={t("listMenu.allStatuses")} count={base.length} />
              {(editable ? reg.statusOrder : STATUS_ORDER).filter((s) => statusCounts[s] || customStatusOf(s)).map((s) => (
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
            className={`as-list-field as-stat-card w-full justify-between font-semibold ${activeList ? "is-set is-tinted" : ""}`}
            style={activeList ? ({ ["--c" as string]: listColor(activeList) } as React.CSSProperties) : undefined}
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              {activeList ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: listColor(activeList) }} /> : null}
              <span className="truncate">{activeList || t("listMenu.lists")}</span>
            </span>
            <Chevron className="shrink-0 opacity-50" />
          </button>
          {menu === "list" ? (
            <div className="as-list-menu" ref={placeMenu}>
              <MenuItem on={!activeList} onClick={() => { setList(""); setMenu(""); }} label={t("listMenu.allEntries")} count={base.length} />
              {localLists.length || anilistLists.length ? (
                /* Dans l'ordre réglé au gestionnaire (registre `customOrder`). */
                orderCustom(
                  [
                    ...localLists.map((l) => ({ name: l.name, count: l.count })),
                    ...anilistLists.map(([n, c]) => ({ name: n, count: c })),
                  ],
                  (x) => x.name,
                  reg.customOrder,
                ).map((x) => (
                  <MenuItem key={x.name} on={activeList === x.name} onClick={() => { setList(x.name); setMenu(""); }} color={listColor(x.name)} label={x.name} count={x.count} />
                ))
              ) : (
                <p className="px-2.5 py-2 text-xs text-white/40">{t("listMenu.noCustomLists")}</p>
              )}
            </div>
          ) : null}
        </div>

        {/* Choix de vue */}
        <div role="group" aria-label={t("listMenu.view")} className="relative flex h-[42px] shrink-0 items-center gap-0.5 as-stat-card rounded-[12px] border border-white/[0.12] p-0.5">
          {/* Le carre de selection GLISSE d'une vue a l'autre, a droite ou a
              gauche selon la place de la nouvelle (10/11/2026, Luc). 38 px =
              la largeur d'un bouton (36) + l'ecart (2). */}
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-9 rounded-[9px] bg-white/[0.12] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ transform: `translateX(${VIEWS.indexOf(pickedView) * 38}px)` }}
          />
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => chooseView(v)}
              aria-pressed={pickedView === v}
              aria-label={t(`listMenu.views.${v}`)}
              title={t(`listMenu.views.${v}`)}
              className={`relative z-10 grid h-full w-9 place-items-center rounded-[9px] transition-colors ${pickedView === v ? "text-white" : "text-white/40 hover:text-white/80"}`}
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
      ) : pickedView !== view ? (
        <ListSkeleton view={pickedView} />
      ) : (
        <>
          {body}
          {more ? <div ref={sentinel} aria-hidden className="h-px" /> : null}
        </>
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

/* LES ÉPISODES COMME PARTOUT SUR LE SITE (08/11, Luc) : la règle du bloc
   « En cours de visionnage » (ListBlocks), mêmes clés de traduction —
   « ép. 6 / 12 » ; sans total, la borne est le dernier épisode SORTI suivi
   d'un « + » (« ép. 1109 / 1150+ ») ; sinon « ép. 4 ». */
/* Le tracé occupe 4→20 sur les deux axes : la boîte `4 4 16 16` le fait remplir
   sa case, comme le faisait le `redo` de Font Awesome. */
function RewatchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="4 4 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12,20q-3.35,0-5.68-2.32T4,12T6.33,6.32T12,4q1.73,0 3.3,0.71Q16.88,5.43 18,6.75V5q0-0.43 0.29-0.71T19,4t0.71,0.29T20,5v5q0,0.42-0.29,0.71T19,11H14q-0.42,0-0.71-0.29Q13,10.43 13,10q0-0.43 0.29-0.71T14,9h3.2q-0.8-1.4-2.19-2.2T12,6Q9.5,6 7.75,7.75T6,12t1.75,4.25T12,18q1.7,0 3.11-0.86q1.41-0.86 2.19-2.31q0.2-0.35 0.56-0.49t0.74-0.01q0.4,0.13 0.57,0.53T19.15,15.6q-1.03,2-2.93,3.2T12,20Z" />
    </svg>
  );
}

function progressText(e: ProfileEntry, t: TFunction) {
  if (e.total) return t("profile.blocks.season.progress", { progress: e.progress, total: e.total });
  const aired = e.aired && e.aired >= e.progress ? e.aired : null;
  return aired
    ? t("profile.blocks.season.progressAiring", { progress: e.progress, aired })
    : t("profile.blocks.season.progressOpen", { progress: e.progress });
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
      style={{ ["--c" as string]: color || "#fff" } as React.CSSProperties}
    >
      <span className="as-glow-dot" style={{ ["--c" as string]: c } as React.CSSProperties} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {on ? (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-white/70" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      ) : null}
    </button>
  );
}

/* LE SQUELETTE DE LA VUE CHOISIE, le temps que React la rende en différé
   (12/11, Luc) : mêmes surfaces et mêmes hauteurs que la vraie, pour que rien
   ne saute quand elle arrive. */
function ListSkeleton({ view }: { view: View }) {
  const bar = "rounded bg-white/[0.08]";
  if (view === "grid")
    return (
      <div aria-hidden className="as-stat-card grid grid-cols-[repeat(auto-fill,minmax(max(112px,calc((100%_-_7*0.875rem)/8)),1fr))] gap-3.5 rounded-2xl p-3.5 ring-1 ring-white/[0.07] sm:p-4">
        {Array.from({ length: 24 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="aspect-[2/3] animate-pulse rounded-[10px] bg-white/[0.08]" />
            <div className={`h-3.5 w-4/5 ${bar}`} />
            <div className={`h-3 w-1/2 ${bar}`} />
          </div>
        ))}
      </div>
    );
  if (view === "compact")
    return (
      <div aria-hidden className="as-stat-card overflow-hidden rounded-xl ring-1 ring-white/[0.07]">
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className="flex h-[37px] items-center gap-3 px-3 shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)]">
            <div className="h-2 w-2 rounded-full bg-white/[0.12]" />
            <div className={`h-3 ${bar}`} style={{ width: `${30 + ((i * 37) % 35)}%` }} />
            <div className={`ml-auto h-3 w-16 ${bar}`} />
          </div>
        ))}
      </div>
    );
  return (
    <div aria-hidden className="as-stat-card flex flex-col overflow-hidden rounded-2xl ring-1 ring-white/[0.07]">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-24 items-center gap-4 py-2 pl-2 pr-4 shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)]">
          <div className="h-20 w-14 shrink-0 animate-pulse rounded-lg bg-white/[0.08]" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className={`h-4 ${bar}`} style={{ width: `${35 + ((i * 29) % 30)}%` }} />
            <div className={`h-3 w-1/4 ${bar}`} />
          </div>
          <div className="h-8 w-[5.5rem] shrink-0 rounded-lg bg-white/[0.07]" />
          <div className="h-8 w-12 shrink-0 rounded-lg bg-white/[0.07]" />
        </div>
      ))}
    </div>
  );
}

function ViewIcon({ v }: { v: View }) {
  const p =
    v === "cards"
      /* Deux rectangles bien séparés (20/11/2026, Luc). */
      ? <><rect x="3" y="3" width="18" height="6" rx="1" /><rect x="3" y="15" width="18" height="6" rx="1" /></>
      : v === "grid"
        ? <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>
        : <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />;
  return (
    // La liste, un peu plus épaisse (20/11/2026, Luc).
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={v === "compact" ? 2.6 : 2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
  progress,
}: {
  entry: ProfileEntry;
  color: string;
  statusName: string;
  href: string;
  title: string;
  picked: boolean;
  progress: string;
}) {
  const sub = [entry.format && prettyFormat(entry.format), entry.year, entry.studio].filter(Boolean).join(" · ");
  return (
    <Link
      href={href}
      /* `as-list-row` : une ligne hors de l'écran n'est ni mise en page ni
         peinte (cf. globals.css). */
      /* Plus grande depuis le 08/11 (Luc) : affiche 56×80, titre en 16 px. */
      className={`as-list-row group flex items-center gap-4 py-2 pl-2 pr-4 shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)] transition-colors last:shadow-none hover:bg-white/[0.06] ${picked ? "as-list-picked" : ""}`}
    >
      {entry.cover ? (
        /* L'affiche « large » d'AniList (230 px) reduite a 56 px sortait floue et
           crenelee (12/11, Luc) : la « medium » (100 px) en 1x, la large en 2x. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={entry.cover.replace("/cover/large/", "/cover/medium/")}
          srcSet={entry.cover.includes("/cover/large/") ? `${entry.cover.replace("/cover/large/", "/cover/medium/")} 1x, ${entry.cover} 2x` : undefined}
          alt=""
          width={56}
          height={80}
          loading="lazy"
          decoding="async"
          className="h-20 w-14 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <div className="h-20 w-14 shrink-0 rounded-lg bg-white/10" />
      )}

      {/* Disposition n° 02 de l'artefact des lignes, retenue par Luc le 08/11 :
          le statut passe SOUS le titre, en pastille, devant la méta — sans le
          liseré coloré à gauche. La droite ne garde que les chiffres. */}
      <div className="min-w-0 flex-1">
        <p className="as-hover-title truncate text-base font-semibold">{title}</p>
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
        /* L'icone des revisionnages choisie par Luc le 15/11 (remplace `redo` de Font Awesome). */
        /* A l'echelle de la case des episodes (text-sm, 32 px de haut), 12/11 Luc. */
        <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold tabular-nums text-white/75" title={`×${entry.repeat}`}>
          <RewatchIcon className="h-3.5 w-3.5" />
          {entry.repeat}
        </span>
      ) : null}
      {entry.favourite ? <HeartIcon className="h-[18px] w-[18px] shrink-0 text-action" /> : null}
      {/* Les épisodes dans une case, centrés, jumelle neutre de celle de la note (08/11, Luc). */}
      <span className="min-w-[5.5rem] shrink-0 whitespace-nowrap rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-center text-sm font-semibold tabular-nums text-white/75 ring-1 ring-white/[0.08]">
        {progress}
      </span>
      {entry.score ? (
        <span className="w-12 shrink-0 rounded-lg bg-as-score/10 py-1.5 text-center text-sm font-bold text-as-score">{entry.score}</span>
      ) : (
        <span className="w-12 shrink-0" />
      )}
    </Link>
  );
}
