import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useSheetPresence } from "./useSheetPresence";
import { countryLabel, prettyFormat, prettySource, statusLabel } from "@/components/anime/v2/helpers";
import {
  AIR_STATUSES,
  COUNTRIES,
  FORMATS,
  SEASONS,
  SORT_KEYS,
  SOURCES,
  activeCount,
  applyFilters,
  freshFilters,
  rangeIsFull,
  valueCounts,
  type Bounds,
  type ListFilters,
  type RangeKey,
  type SetKey,
} from "@/lib/profile/listFilter";
import type { ProfileEntry } from "@/lib/profile/types";
import { useShowAdult } from "@/lib/prefs/adultPrefs";
import CATALOG from "@/lib/data/anilistCatalog.json";

/* LE CATALOGUE D'ANILIST pour les onglets « Tous les genres / tags / studios »
   (12/11, Luc : « il doit avoir tous les tags anilist »). Figé par
   tools/anilist/catalog.mjs : 19 genres, 430 tags, 1066 studios d'animation.
   Les tags adultes (67) et le genre Hentai n'y sont que si le réglage -18 est
   allumé, comme partout ailleurs sur le site. */
type DdScope = "list" | "anilist";


function anilistCatalog(k: SetKey, adult: boolean): string[] | null {
  if (k === "genres") return CATALOG.genres.filter((g) => adult || g !== "Hentai");
  if (k === "tags") return CATALOG.tags.filter((x) => adult || !x.isAdult).map((x) => x.name);
  if (k === "studio") return CATALOG.studios;
  return null;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
  pool,
  onRandom,
}: {
  open: boolean;
  onClose: () => void;
  entries: ProfileEntry[];
  filters: ListFilters;
  bounds: Bounds;
  onChange: (f: ListFilters) => void;
  /** La sélection courante (statut, liste, recherche) avant tri & filtres. */
  pool: ProfileEntry[];
  /** Applique `f`, tire un titre parmi ses résultats ; son nom, ou null s'il n'y en a aucun. */
  onRandom: (f: ListFilters) => string | null;
}) {
  const { t } = useTranslation();
  /* UN BROUILLON (20/11/2026, Luc : « ne l'applique pas sur la page derrière,
     attends le bouton Voir N résultats ») : repris des filtres appliqués à
     chaque ouverture, rendu à la liste seulement par ce bouton. Fermer
     autrement (croix, Échap, clic dehors) l'abandonne. */
  const [draft, setDraft] = useState(filters);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(filters);
  }
  const [pillsOpen, setPillsOpen] = useState(false);
  const [pillsHidden, setPillsHidden] = useState(0);
  const pillsRef = useRef<HTMLDivElement>(null);
  const pillOrder = useRef<string[]>([]);
  /* PLUSIEURS DÉPLIANTS OUVERTS À LA FOIS (20/11/2026, Luc) : chacun garde
     son ouverture, sa recherche et son onglet. */
  /* `"leaving"` : le dépliant joue son animation de fermeture, encore monté. */
  const [openDd, setOpenDd] = useState<Partial<Record<SetKey, true | "leaving">>>({});
  const ddTimers = useRef<Partial<Record<SetKey, ReturnType<typeof setTimeout>>>>({});
  useEffect(() => () => Object.values(ddTimers.current).forEach((id) => clearTimeout(id)), []);
  const toggleDd = (k: SetKey) => {
    clearTimeout(ddTimers.current[k]);
    if (openDd[k] === true) {
      setOpenDd((o) => ({ ...o, [k]: "leaving" }));
      ddTimers.current[k] = setTimeout(() => setOpenDd((o) => {
        const n = { ...o };
        delete n[k];
        return n;
      }), 220);
    } else {
      setOpenDd((o) => ({ ...o, [k]: true }));
    }
  };
  const [ddScopes, setDdScopes] = useState<Partial<Record<SetKey, DdScope>>>({});
  const showAdult = useShowAdult();
  const [ddQueries, setDdQueries] = useState<Partial<Record<SetKey, string>>>({});
  const [pick, setPick] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sortOpen) return;
    const away = (e: MouseEvent) => !sortRef.current?.contains(e.target as Node) && setSortOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [sortOpen]);
  const sortOpenRef = useRef(sortOpen);
  sortOpenRef.current = sortOpen;

  /* `onClose` change à chaque rendu du parent : en dépendance, le tirage au
     hasard (qui fait rendre le parent) relançait cet effet, et `setPick(null)`
     effaçait le titre tiré aussitôt affiché (20/11/2026, Luc : « le bouton
     random ne marche pas »). Remis à zéro à l'OUVERTURE seulement. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    setPick(null);
    setSortOpen(false);
    // Échap ferme d'abord le menu de tri, puis le panneau.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (sortOpenRef.current) setSortOpen(false);
      else onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /* C'est <html> qui défile, pas <body> (cf. ListManager, 20/11/2026) ; la
     largeur de la barre disparue est rendue en marge. Tenu jusqu'à la fin de
     l'animation de fermeture (`shown`), sinon la page bouge pendant. */
  const { shown, closing } = useSheetPresence(open);
  useEffect(() => {
    if (!shown) return;
    const html = document.documentElement;
    const bar = window.innerWidth - html.clientWidth;
    const prev = [html.style.overflow, html.style.paddingRight];
    html.style.overflow = "hidden";
    if (bar > 0) html.style.paddingRight = `${bar}px`;
    return () => {
      [html.style.overflow, html.style.paddingRight] = prev;
    };
  }, [shown]);

  /* Combien de filtres actifs tiennent sur la ligne : on cache le surplus par
     la fin jusqu'à ce que « Voir plus » rentre sur la première ligne. */
  const draftKey = JSON.stringify(draft);
  useIsoLayoutEffect(() => {
    const box = pillsRef.current;
    if (!box) return;
    /* Dépliée, la rangée AGRANDIT l'en-tête vers le bas (20/11, Luc) : la
       hauteur du cadre passe de 28 px à celle du contenu, en transition CSS. */
    const wrap = box.parentElement as HTMLElement;
    const measure = () => {
      const kids = Array.from(box.querySelectorAll<HTMLElement>(".as-sfp-chip"));
      const more = box.querySelector<HTMLElement>(".as-sfp-more");
      if (!more) return;
      kids.forEach((k) => (k.style.display = ""));
      more.style.display = "none";
      const top = kids[0]?.offsetTop ?? 0;
      const wraps = kids.length > 1 && kids[kids.length - 1].offsetTop !== top;
      if (!wraps) {
        wrap.style.height = "";
        setPillsHidden(0);
        if (pillsOpen) setPillsOpen(false);
        return;
      }
      more.style.display = "";
      if (pillsOpen) {
        wrap.style.height = `${Math.min(box.scrollHeight, 160)}px`;
        return setPillsHidden(0);
      }
      wrap.style.height = "";
      let n = 0;
      for (let i = kids.length - 1; i > 0 && more.offsetTop !== top; i--, n++) kids[i].style.display = "none";
      setPillsHidden(n);
    };
    measure();
    // Re-mesure à un changement de LARGEUR seulement (la hauteur, c'est nous).
    let lastW = box.clientWidth;
    const ro = new ResizeObserver(() => {
      if (box.clientWidth === lastW) return;
      lastW = box.clientWidth;
      measure();
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [shown, mounted, pillsOpen, draftKey]);

  if (!shown || !mounted) return null;

  const f = draft;
  const set = (patch: Partial<ListFilters>) => {
    setPick(null);
    setDraft({ ...f, ...patch });
  };
  const count = applyFilters(pool, f, bounds).length;
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

  /* LES COMPTES D'UNE SECTION : ceux de toute la liste (`whole`, pour savoir
     quelles valeurs existent) et ceux que donnerait chaque valeur avec TOUS
     LES AUTRES filtres appliqués (`facet`), le sien exclu. */
  const wholeCache = new Map<SetKey, Map<string, number>>();
  const whole = (k: SetKey) => {
    let m = wholeCache.get(k);
    if (!m) wholeCache.set(k, (m = valueCounts(entries, k)));
    return m;
  };
  const facet = (k: SetKey) => valueCounts(applyFilters(entries, { ...f, sets: { ...f.sets, [k]: [] } }, bounds), k);

  /* Les tuiles (Format, Saison) : icône, nom, nombre de titres. Une valeur
     absente de toute la liste n'a pas de tuile ; présente mais à zéro avec les
     autres filtres, elle est en pointillés (et reste cliquable). */
  /* Tuiles de LARGEUR FIXE (14/11, Luc) : un panneau plus large en met plus
     par ligne au lieu de les étirer. */
  const tiles = (k: SetKey, values: string[], label: (v: string) => React.ReactNode, icons: Record<string, string>) => {
    const n = facet(k);
    return (
      <div className="as-sfp-tiles">
        {values.filter((v) => whole(k).has(v)).map((v) => {
          const on = f.sets[k].includes(v);
          const c = n.get(v) || 0;
          return (
            <button key={v} type="button" aria-pressed={on} onClick={() => toggle(k, v)} className={`as-sfp-tile${on ? " is-on" : ""}${!on && !c ? " is-zero" : ""}`}>
              {icons[v] ? <Icon d={icons[v]} size={21} /> : null}
              <span className="as-sfp-tile-l">{label(v)}</span>
              <span className="as-sfp-tile-n">{t("listMenu.titles", { count: c })}</span>
            </button>
          );
        })}
      </div>
    );
  };

  const slider = ({ k, label, step = 1, hist }: { k: RangeKey; label: string; step?: number; hist?: boolean }) => {
    const [lo, hi] = bounds[k];
    const [a, b] = f.ranges[k];
    const span = hi - lo || 1;
    const full = rangeIsFull(f, bounds, k);
    /* L'histogramme de l'année (gardé de la maquette) : une barre par année de
       la liste, la plage choisie en rose. */
    let bars: { y: number; n: number }[] = [];
    if (hist) {
      const m = new Map<number, number>();
      for (const e of entries) if (e.year) m.set(e.year, (m.get(e.year) || 0) + 1);
      for (let y = lo; y <= hi; y++) bars.push({ y, n: m.get(y) || 0 });
    }
    const top = Math.max(1, ...bars.map((x) => x.n));
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
        extra={<span className={full ? "as-sfp-rv" : "as-sfp-rv is-set"}>{full ? t("listMenu.all") : `${a} – ${b}`}</span>}
      >
        {hist ? (
          <div className="as-sfp-hist" aria-hidden="true">
            {bars.map((x) => (
              <span
                key={x.y}
                title={`${x.y} : ${x.n}`}
                className={x.y >= a && x.y <= b ? "is-in" : ""}
                style={{ height: `${Math.max(x.n ? 8 : 3, Math.round((x.n / top) * 100))}%` }}
              />
            ))}
          </div>
        ) : null}
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

  /* LES DÉPLIANTS GENRES / STUDIO / TAGS, au dessin de la référence (12/11,
     Luc) : en-tête teinté une fois ouvert, deux onglets, une recherche, des
     puces qui défilent dans une boîte bornée.

     LES TOTAUX : l'en-tête montre le nombre de puces cochées (rose) s'il y en
     a, sinon le nombre de valeurs de la liste (gris), jamais tronqué (la
     référence affichait un « 588… » coupé). Chaque puce dit combien de tes
     titres la portent. Une puce cochée reste affichée même à zéro, pour
     pouvoir la décocher. */
  const dropdown = ({ k, label, icon }: { k: SetKey; label: string; icon: React.ReactNode }) => {
    const whole = valueCounts(entries, k);
    if (!whole.size) return null;
    const isOpen = openDd[k] === true;
    const shown = !!openDd[k];
    const ddScope = ddScopes[k] || "list";
    const ddQuery = ddQueries[k] || "";
    const setDdScope = (s: DdScope) => setDdScopes((o) => ({ ...o, [k]: s }));
    const setDdQuery = (q: string) => setDdQueries((o) => ({ ...o, [k]: q }));
    const sel = f.sets[k];
    const head = sel.length ? (
      <span className="as-sfp-ddb">{sel.length}</span>
    ) : (
      <span className="as-sfp-ddn">{whole.size}</span>
    );
    let panel: React.ReactNode = null;
    if (shown) {
      /* DEUX ONGLETS (12/11, Luc) : « Tags dans la liste » (ce que porte au
         moins un de tes titres) et « Tous les tags » (le catalogue AniList,
         ceux que tu n'as jamais vus à 0). Pareil pour les genres et les
         studios. Chaque puce compte tes titres. */
      const cat = anilistCatalog(k, showAdult);
      const catalog = cat ? new Map(cat.map((v) => [v, whole.get(v) || 0])) : null;
      if (catalog) for (const [v, n] of whole) if (!catalog.has(v)) catalog.set(v, n);
      const scope: DdScope = catalog ? ddScope : "list";
      const src = scope === "anilist" && catalog ? catalog : new Map(whole);
      for (const v of sel) if (!src.has(v)) src.set(v, 0);
      const q = ddQuery.trim().toLowerCase();
      const values = [...src.entries()]
        .filter(([v]) => !q || v.toLowerCase().includes(q))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      panel = (
        <div className="as-sfp-ddp">
          {catalog ? (
            <div className="as-sfp-ddt" role="tablist">
              {(["list", "anilist"] as const).map((s) => (
                <button key={s} type="button" role="tab" aria-selected={scope === s} className={scope === s ? "is-on" : ""} onClick={() => setDdScope(s)}>
                  {t(`listMenu.scope.${k}.${s}`)}
                  <span>{(s === "anilist" ? catalog : whole).size}</span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="as-sfp-dds-search">
            <Icon d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5" size={14} />
            <input value={ddQuery} onChange={(e) => setDdQuery(e.target.value)} placeholder={t("listMenu.searchIn", { what: label })} />
            {ddQuery ? (
              <button type="button" onClick={() => setDdQuery("")} aria-label={t("listMenu.clearSearch")}>
                <Icon d="M18 6 6 18M6 6l12 12" size={12} />
              </button>
            ) : null}
          </label>
          <div className="as-sfp-ddscroll">
            {values.length ? (
              <div className="as-sfp-chips">
                {values.map(([v, n]) => (
                  <Chip key={v} on={sel.includes(v)} zero={!n} onClick={() => toggle(k, v)}>
                    {v}
                    <span className="as-sfp-chipn">{n}</span>
                  </Chip>
                ))}
              </div>
            ) : (
              <p className="as-sfp-ddempty">{t("listMenu.nothing")}</p>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className={`as-sfp-sec is-tight${isOpen ? " is-open" : ""}`}>
        <button
          type="button"
          className="as-sfp-dd"
          aria-expanded={isOpen}
          onClick={() => { toggleDd(k); if (!isOpen) setDdQuery(""); }}
        >
          <span className="as-sfp-ddl">
            {icon}
            {label}
          </span>
          <span className="as-sfp-ddl">
            {head}
            <Chevron className="as-sfp-chev" />
          </span>
        </button>
        {panel ? (
          /* Ouverture / fermeture en hauteur (grille 0fr → 1fr) et fondu. */
          <div className={`as-sfp-ddwrap${isOpen ? "" : " is-leaving"}`}>
            <div>{panel}</div>
          </div>
        ) : null}
      </div>
    );
  };

  /* LES FILTRES ACTIFS en bandeau sous l'en-tête (14/11, Luc) : une sélection
     dans un dépliant fermé (Tags, Studio) ne se voyait plus. Une puce par
     valeur, une par curseur resserré (« Ma note ≥ 7 »), une pour le contenu ;
     un clic l'enlève. */
  const setLabel: Record<SetKey, (v: string) => string> = {
    air: (v) => statusLabel(t, v),
    format: (v) => prettyFormat(v),
    season: (v) => t(`listMenu.seasons.${v}`),
    source: (v) => prettySource(v),
    country: (v) => countryLabel(t, v),
    genres: (v) => v,
    studio: (v) => v,
    tags: (v) => v,
  };
  const rangeLabel: Record<RangeKey, string> = { year: t("listMenu.year"), score: t("listMenu.myScore"), episodes: t("listMenu.episodes") };
  const pills: { key: string; label: string; off: () => void }[] = [];
  for (const k of ["format", "season", "air", "genres", "tags", "studio", "source", "country"] as SetKey[]) {
    for (const v of f.sets[k]) pills.push({ key: `${k}:${v}`, label: setLabel[k](v), off: () => toggle(k, v) });
  }
  for (const k of ["year", "score", "episodes"] as RangeKey[]) {
    if (rangeIsFull(f, bounds, k)) continue;
    const [lo, hi] = bounds[k];
    const [a, b] = f.ranges[k];
    const txt = b >= hi ? `≥ ${a}` : a <= lo ? `≤ ${b}` : `${a} – ${b}`;
    pills.push({ key: k, label: `${rangeLabel[k]} ${txt}`, off: () => set({ ranges: { ...f.ranges, [k]: [lo, hi] } }) });
  }
  if (f.adult) pills.push({ key: "adult", label: t(f.adult === "no" ? "listMenu.nonAdult" : "listMenu.adultOnly"), off: () => set({ adult: "" }) });
  /* DANS L'ORDRE D'AJOUT (20/11/2026, Luc : « ça se décale ») : un nouveau
     filtre va au bout de la rangée au lieu de s'intercaler et de pousser les
     autres (ONA entrait avant Printemps). */
  const keys = pills.map((p) => p.key);
  const order = pillOrder.current.filter((k) => keys.includes(k)).concat(keys.filter((k) => !pillOrder.current.includes(k)));
  pillOrder.current = order;
  pills.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  return createPortal(
    <div className={`as-sfp-overlay${closing ? " is-closing" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="as-sfp" role="dialog" aria-modal="true" aria-label={t("listMenu.sortFilter")}>
        <div className="as-sfp-head has-pills">
          <div className="as-sfp-hl">
            <h3>{t("listMenu.sortFilter")}</h3>
            {active ? <span className="as-sfp-badge">{active}</span> : null}
          </div>
          {/* LES FILTRES ACTIFS DANS L'EN-TÊTE, à droite du titre (20/11/2026,
              Luc) : une ligne qui ne pousse rien ; le surplus derrière « Voir
              plus », qui agrandit l'en-tête vers le bas. */}
          <div className="as-sfp-activewrap">
            <div ref={pillsRef} className={`as-sfp-active${pillsOpen ? " is-open" : ""}`}>
              {pills.map((p) => (
                <button key={p.key} type="button" className="as-sfp-chip is-on" onClick={p.off} aria-label={`${p.label} ✕`}>
                  {p.label}
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              ))}
              <button type="button" className="as-sfp-more" style={{ display: "none" }} onClick={() => setPillsOpen((o) => !o)}>
                {pillsOpen ? t("listMenu.showLess") : t("listMenu.showMore", { count: pillsHidden })}
              </button>
            </div>
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


        {/* UNE COLONNE (14/11/2026, Luc) : d'abord ce qu'on choisit par type,
            en tuiles, puis les chiffres (curseurs) et les longues listes
            (dépliants). Les deux colonnes du 12/11 ne s'équilibraient pas. */}
        <div className="as-sfp-body">
          <div className="as-sfp-cols">
            <div className="as-sfp-col">
              <Section label={t("listMenu.sortBy")}>
                <div className="as-sfp-sort">
                  {/* Menu MAISON, pas un <select> : la liste native s'ouvrait
                      en bleu système, hors du style du panneau (14/11, Luc). */}
                  <div className="as-sfp-sortdd" ref={sortRef}>
                    <button
                      type="button"
                      className="as-sfp-select"
                      aria-haspopup="listbox"
                      aria-expanded={sortOpen}
                      aria-label={t("listMenu.sortBy")}
                      onClick={() => setSortOpen((o) => !o)}
                    >
                      <span>{t(`listMenu.sort.${f.sort}`)}</span>
                      <Chevron className="as-sfp-chev" />
                    </button>
                    {sortOpen ? (
                      <div className="as-list-menu" role="listbox">
                        {SORT_KEYS.map((k) => (
                          <button
                            key={k}
                            type="button"
                            role="option"
                            aria-selected={f.sort === k}
                            className={`as-list-opt${f.sort === k ? " is-on" : ""}`}
                            onClick={() => {
                              setSortOpen(false);
                              set({ sort: k, desc: k !== "title" });
                            }}
                          >
                            {t(`listMenu.sort.${k}`)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button type="button" className="as-sfp-dir" onClick={() => set({ desc: !f.desc })}>
                    <Icon d={f.desc ? "M12 5v14M6 13l6 6 6-6" : "M12 19V5M6 11l6-6 6 6"} size={14} />
                    {t(f.desc ? "listMenu.descending" : "listMenu.ascending")}
                  </button>
                </div>
              </Section>
              {has("format") ? (
                <Section label={t("listMenu.format")}>
                  {tiles("format", FORMATS, (v) => prettyFormat(v), FORMAT_ICON)}
                </Section>
              ) : null}
              {has("season") ? (
                <Section label={t("listMenu.season")}>
                  {tiles("season", SEASONS, (v) => t(`listMenu.seasons.${v}`), SEASON_ICON)}
                </Section>
              ) : null}
              {has("air") ? (
                <Section label={t("listMenu.airStatus")}>
                  <div className="as-sfp-airs">
                    {(() => {
                      const n = facet("air");
                      return AIR_STATUSES.filter((v) => whole("air").has(v)).map((v) => {
                        const on = f.sets.air.includes(v);
                        return (
                          <button key={v} type="button" aria-pressed={on} onClick={() => toggle("air", v)} className={`as-sfp-air${on ? " is-on" : ""}${!on && !n.get(v) ? " is-zero" : ""}`}>
                            <span className="as-sfp-dot" style={{ ["--c" as string]: AIR_COLOR[v] || "#9ca3af" } as React.CSSProperties} />
                            <span className="as-sfp-air-l">{statusLabel(t, v)}</span>
                            <span className="as-sfp-tile-n">{n.get(v) || 0}</span>
                          </button>
                        );
                      });
                    })()}
                  </div>
                </Section>
              ) : null}
            </div>

            <div className="as-sfp-col">
              {/* LES CURSEURS DANS UN BLOC UNIQUE SEGMENTÉ (20/11, Luc, style B
                  de la maquette) : une surface, un trait entre les catégories. */}
              <div className="as-sfp-ranges">
                {hasYear ? slider({ k: "year", label: t("listMenu.year"), hist: true }) : null}
                {slider({ k: "score", label: t("listMenu.myScore"), step: 0.5 })}
                {hasTotal ? slider({ k: "episodes", label: t("listMenu.episodes") }) : null}
              </div>
              <div className="as-sfp-dds">
                {dropdown({ k: "genres", label: t("listMenu.genres"), icon: <Icon d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /> })}
                {dropdown({ k: "studio", label: t("listMenu.studio"), icon: <Icon d="M2 3h20v14H2zM8 21h8M12 17v4" /> })}
                {dropdown({ k: "tags", label: t("listMenu.tags"), icon: <Icon d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01" /> })}
              </div>
              {/* Source, Pays, Contenu : les moins utilisés, tout à la fin (14/11, Luc). */}
              {has("source") ? (<Section label={t("listMenu.source")}>{chips("source", SOURCES, (v) => prettySource(v))}</Section>) : null}
              {has("country") ? (<Section label={t("listMenu.country")}>{chips("country", COUNTRIES, (v) => (<><span className="as-sfp-cc">{v}</span>{countryLabel(t, v)}</>))}</Section>) : null}
              {/* Contenu n'existe que réglage -18 allumé ET un titre adulte dans
                  la liste : éteint, ProfileList les a déjà tous retirés. */}
              {showAdult && entries.some((e) => e.isAdult) ? (
                <Section label={t("listMenu.content")}>
                  <div className="as-sfp-pair">
                    <button type="button" aria-pressed={f.adult === "no"} className={`as-sfp-air${f.adult === "no" ? " is-on" : ""}`} onClick={() => set({ adult: f.adult === "no" ? "" : "no" })}>{t("listMenu.nonAdult")}</button>
                    <button type="button" aria-pressed={f.adult === "yes"} className={`as-sfp-air${f.adult === "yes" ? " is-on" : ""}`} onClick={() => set({ adult: f.adult === "yes" ? "" : "yes" })}>{t("listMenu.adultOnly")}</button>
                  </div>
                </Section>
              ) : null}
            </div>
          </div>
        </div>

        {pick ? <div className="as-sfp-pick" aria-live="polite">{pick}</div> : null}
        <div className="as-sfp-foot">
          <button
            type="button"
            className="as-sfp-rand"
            aria-label={t("listMenu.random")}
            title={t("listMenu.random")}
            onClick={() => {
              /* Un titre tiré : le panneau se ferme et la liste va dessus
                 (20/11/2026, Luc). Aucun : le message reste dans le panneau. */
              const name = onRandom(f);
              if (name) onClose();
              else setPick(t("listMenu.randomNone"));
              /* Le badge « Au hasard » : jusqu'ici aucun bouton ne le levait. */
              if (name) void import("@/lib/badges/facts").then((f) => f.recordFlag("random")).catch(() => {});
            }}
          >
            {/* L'icône « mélanger » pleine fournie par Luc (20/11/2026). */}
            <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" aria-hidden="true">
              <path d="M15,20q-0.42,0-0.71-0.29Q14,19.43 14,19t0.29-0.71T15,18h1.6l-2.48-2.47q-0.3-0.3-0.29-0.71t0.31-0.71t0.71-0.3t0.71,0.3L18,16.55V15q0-0.43 0.29-0.71T19,14t0.71,0.29T20,15v4q0,0.43-0.29,0.71T19,20H15ZM4.3,19.7Q4.03,19.43 4.03,19T4.3,18.3L16.6,6H15q-0.42,0-0.71-0.29Q14,5.43 14,5t0.29-0.71T15,4h4q0.43,0 0.71,0.29T20,5V9q0,0.42-0.29,0.71T19,10T18.29,9.71T18,9V7.4L5.7,19.7Q5.43,19.98 5,19.98q-0.42,0-0.7-0.28ZM4.28,5.7Q4,5.43 4,5T4.28,4.3T4.96,4.02T5.68,4.3l4.2,4.18q0.28,0.28 0.29,0.69T9.88,9.88q-0.27,0.27-0.7,0.27T8.48,9.88L4.28,5.7Z" />
            </svg>
          </button>
          <button type="button" className="as-sfp-apply" onClick={() => { onChange(f); onClose(); }}>
            {t("listMenu.show")} <span className="as-sfp-count">{count}</span> {t("listMenu.results", { count })}
            <span className="as-sfp-of">{t("listMenu.outOf", { total: entries.length })}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* Les icônes des tuiles (traits 24×24, même famille que celles du panneau). */
const FORMAT_ICON: Record<string, string> = {
  TV: "M3 7h18v12H3zM8 3l4 4 4-4",
  /* La pellicule fournie par Luc (14/11) : tracé PLEIN, comme le clap. */
  TV_SHORT: "M6,19v1q0,0.43-0.29,0.71T5,21q-0.42,0-0.71-0.29Q4,20.43 4,20V4Q4,3.57 4.29,3.29T5,3T5.71,3.29T6,4V5H8V4Q8,3.57 8.29,3.29Q8.58,3 9,3h6q0.43,0 0.71,0.29T16,4V5h2V4q0-0.43 0.29-0.71T19,3t0.71,0.29T20,4V20q0,0.43-0.29,0.71T19,21t-0.71-0.29Q18,20.43 18,20V19H16v1q0,0.43-0.29,0.71T15,21H9q-0.42,0-0.71-0.29Q8,20.43 8,20V19H6Zm0-2H8V15H6v2Zm0-4H8V11H6v2ZM6,9H8V7H6V9Zm10,8h2V15H16v2Zm0-4h2V11H16v2Zm0-4h2V7H16V9ZM10,19h4V5H10V19ZM10,5h4H10Z",
  /* Le clap fourni par Luc (14/11) : un tracé PLEIN, pas un trait. */
  MOVIE: "M4,4L5.63,7.25Q5.8,7.6 6.13,7.8T6.83,8Q7.58,8 7.98,7.36q0.4-0.64 0.05-1.31L7,4H9l1.63,3.25Q10.8,7.6 11.13,7.8T11.83,8q0.75,0 1.15-0.64q0.4-0.64 0.05-1.31L12,4h2l1.63,3.25Q15.8,7.6 16.13,7.8T16.83,8q0.75,0 1.15-0.64q0.4-0.64 0.05-1.31L17,4h3q0.83,0 1.41,0.59Q22,5.18 22,6V18q0,0.82-0.59,1.41T20,20H4q-0.82,0-1.41-0.59T2,18V6Q2,5.18 2.59,4.59T4,4Zm0,6v8H20V10H4Zm0,0v8V10Z",
  OVA: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  ONA: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  SPECIAL: "m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z",
  MUSIC: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
};
const SEASON_ICON: Record<string, string> = {
  WINTER: "M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9",
  SPRING: "M12 22V12M12 12C12 7 8 4 4 4c0 5 3 8 8 8zM12 12c0-5 4-8 8-8 0 5-3 8-8 8z",
  SUMMER: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  FALL: "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10zM2 21c0-3 1.9-5.4 5.2-6",
};
/* La pastille lumineuse de la diffusion : vert en cours, gris terminé… */
const AIR_COLOR: Record<string, string> = {
  RELEASING: "#22c55e",
  FINISHED: "#9ca3af",
  NOT_YET_RELEASED: "#ef4444",
  CANCELLED: "#ef4444",
  HIATUS: "#60a5fa",
};

function Chip({ on, zero, onClick, children }: { on: boolean; zero?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`as-sfp-chip${on ? " is-on" : ""}${zero && !on ? " is-zero" : ""}`}>
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

/* Les icônes au tracé plein (le reste est dessiné au trait). */
const FILLED_ICONS = new Set([FORMAT_ICON.MOVIE, FORMAT_ICON.TV_SHORT]);

function Icon({ d, size = 13 }: { d: string; size?: number }) {
  if (FILLED_ICONS.has(d)) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
        <path d={d} />
      </svg>
    );
  }
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
