import Skeleton from "react-loading-skeleton";
import Image from "next/image";
import Link from "next/link";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/router";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { Episode } from "types/api/Episode";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHideSpoilers } from "@/lib/prefs/spoilerPrefs";
import { useSyncPrefs } from "@/lib/prefs/syncPrefs";
import { peekLocalEntry, LOCAL_LIST_EVENT } from "@/lib/list/localList";
import { fixApostrophes } from "@/lib/text/apostrophes";
import {
  getAnimeProgress,
  PROGRESS_EVENT,
  ProgressEntry,
  ProgressTick,
} from "@/lib/watch/progress";
import { peekRuntime, queueRuntime } from "@/lib/watch/episodeRuntime";

type EpisodeListsProps = {
  info: AniListInfoTypes;
  map: any;
  providerId: string;
  watchId: string;
  episode: Episode[];
  track: any;
  dub: string;
};

type SeasonRow = {
  id: number;
  number: number;
  label: string;
  year: number | null;
  episodes: number | null;
  format: string | null;
};

/* Design tokens copied from components/anime/v2/styles.module.css.
 *
 * They live there scoped to the info page's `.root`, which also sets a page
 * background and a 100vh floor — not something to drag into a sidebar. So the
 * VALUES are mirrored here rather than the stylesheet imported. Keep the two in
 * step: this panel is meant to be the info page's episode list, narrower. */
const T = {
  bg2: "#161924",
  line: "#252938",
  line2: "#2f3447",
  txt0: "#f4f5f8",
  txt3: "#5e6478",
  green: "#2dd47a",
};
const ACCENT = "var(--brand-primary, #ff3b5c)";
const ACCENT_BORDER = `color-mix(in srgb, ${ACCENT} 40%, transparent)`;
const ACCENT_SOFT = `color-mix(in srgb, ${ACCENT} 12%, transparent)`;
const ACCENT_ROW = `linear-gradient(90deg, color-mix(in srgb, ${ACCENT} 6%, transparent), ${T.bg2})`;

/* The three shapes the list can take, same three as the info page's Episodes
   tab: thumbnails, one-line rows, grid of numbers. Remembered per device — a
   choice about how you read a list shouldn't reset on the next episode. */
const VIEWS = ["detailed", "compact", "grid"] as const;
type View = (typeof VIEWS)[number];
const VIEW_KEY = "aniscroll.episodeView";
// Same labels as the info page's own switch — one vocabulary for one control.
const VIEW_LABELS: Record<View, string> = {
  detailed: "anime.detailedView",
  compact: "anime.compactList",
  grid: "anime.gridOfNumbers",
};

/** Next view in the cycle, wrapping round. */
export function nextView(current: View): View {
  return VIEWS[(VIEWS.indexOf(current) + 1) % VIEWS.length];
}

function ViewIcon({ view }: { view: View }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
  } as const;
  if (view === "detailed") {
    // Picture glyph — this is the mode that shows the thumbnails.
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
        <path d="m4 18 5-5 4 4 3-3 4 4" />
      </svg>
    );
  }
  if (view === "compact") {
    return (
      <svg {...common}>
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** Duree exacte, en m:ss — c'est la duree que le LECTEUR a mesuree. */
function mmss(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* Ces deux composants s'abonnent EUX-MEMES aux remontees du lecteur et
   ecrivent dans le DOM par une ref, sans passer par un state. C'est
   deliberé : le lecteur emet toutes les 3 s, et faire re-rendre la liste
   entiere a ce rythme se paie cher des qu'un anime compte plusieurs
   centaines d'episodes. Ici seul l'episode en cours ecoute, et il ne touche
   que ses deux noeuds. */

/** Barre de progression posee sur la vignette : elle avance PENDANT la
 *  lecture, et se remplit quand l'episode est fini. */
function ProgressBar({
  aniId,
  episode,
  live,
  width,
}: {
  aniId: number | string;
  episode: number;
  live: boolean;
  width: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!live) return;
    const onTick = (e: Event) => {
      const d = (e as CustomEvent<ProgressTick>).detail;
      if (!d || String(d.aniId) !== String(aniId)) return;
      if (Number(d.episode) !== Number(episode)) return;
      if (!ref.current || !(d.duration > 0)) return;
      ref.current.style.width = `${Math.min(100, (d.time / d.duration) * 100)}%`;
    };
    window.addEventListener(PROGRESS_EVENT, onTick);
    return () => window.removeEventListener(PROGRESS_EVENT, onTick);
  }, [aniId, episode, live]);
  return (
    <span
      ref={ref}
      className="absolute bottom-0 left-0 h-[3px]"
      style={{
        width,
        background: ACCENT,
        // Les remontees arrivent par paliers de 3 s ; la transition rattrape
        // l'intervalle, sinon la barre sauterait au lieu d'avancer.
        transition: "width 1s linear",
      }}
    />
  );
}

/**
 * Duree de l'episode, par ordre de fiabilite :
 *
 *   1. l'episode EN COURS la tient du lecteur lui-meme, en direct ;
 *   2. un episode deja ouvert sur cet appareil l'a laissee dans le store de
 *      reprise ;
 *   3. les autres la demandent a AniSkip, directement depuis le navigateur —
 *      et seulement une fois la ligne A L'ECRAN (cf. lib/watch/episodeRuntime) ;
 *   4. a defaut, la moyenne annoncee par AniList, precedee d'un "~" pour ne
 *      pas faire passer une estimation pour la duree du fichier.
 */
function Runtime({
  aniId,
  episode,
  malId,
  live,
  known,
  estimate,
}: {
  aniId: number | string;
  episode: number;
  malId?: number | string | null;
  live: boolean;
  known: number | null;
  estimate: string | null;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [exact, setExact] = useState<number | null>(known);

  // 1. Le lecteur, pour l'episode en cours.
  useEffect(() => {
    if (!live) return;
    const onTick = (e: Event) => {
      const d = (e as CustomEvent<ProgressTick>).detail;
      if (!d || String(d.aniId) !== String(aniId)) return;
      if (Number(d.episode) !== Number(episode)) return;
      if (!(d.duration > 0)) return;
      setExact((prev) => (prev === d.duration ? prev : d.duration));
    };
    window.addEventListener(PROGRESS_EVENT, onTick);
    return () => window.removeEventListener(PROGRESS_EVENT, onTick);
  }, [aniId, episode, live]);

  // 3. AniSkip, differé jusqu'a ce que la ligne soit reellement a l'ecran.
  useEffect(() => {
    if (live || exact != null || malId == null || !ref.current) return;
    const cached = peekRuntime({ malId, episode });
    if (cached != null) {
      setExact(cached);
      return;
    }
    const el = ref.current;
    const ac = new AbortController();
    let done = false;
    const io = new IntersectionObserver((entries) => {
      if (done || !entries.some((en) => en.isIntersecting)) return;
      done = true;
      io.disconnect();
      queueRuntime({ malId, episode }, ac.signal).then(
        (s) => s != null && setExact(s),
      );
    });
    io.observe(el);
    return () => {
      io.disconnect();
      ac.abort();
    };
  }, [episode, malId, live, exact]);

  const text = exact != null ? mmss(exact) : estimate;
  if (!text) return null;
  return (
    <p
      ref={ref}
      className="flex items-center gap-1.5 font-outfit text-xs font-light tabular-nums"
      style={{ color: live ? undefined : T.txt3 }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="shrink-0"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      {text}
    </p>
  );
}

export default function EpisodeLists({
  info,
  map,
  providerId,
  watchId,
  episode,
  track,
  dub,
}: EpisodeListsProps) {
  // Watched-episode count for the "seen" bar. Source of truth must match the
  // rest of the app: the LOCAL list when sync is off / guest (the editor and
  // Hero read it there), and only fall back to AniList's mediaListEntry when
  // sync is ON. Reading AniList directly regardless of sync (the old behaviour)
  // painted every episode "watched" for a user whose AniList said COMPLETED
  // even though they never enabled sync and the site shows nothing.
  const syncEnabled = useSyncPrefs().enabled;
  const [localProgress, setLocalProgress] = useState<number | undefined>(
    undefined,
  );
  useEffect(() => {
    const aniId = Number(info?.id);
    if (!Number.isFinite(aniId)) return;
    const read = () => setLocalProgress(peekLocalEntry(aniId)?.progress);
    read();
    window.addEventListener(LOCAL_LIST_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(LOCAL_LIST_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [info?.id]);
  const progress = syncEnabled ? info.mediaListEntry?.progress : localProgress;

  /* Positions sauvegardees de CET anime (lib/watch/progress.ts), une lecture
     pour toute la liste. Elles portent aussi la duree reelle mesuree par le
     lecteur, episode par episode. On relit au changement d'episode : celui
     qu'on vient de quitter a sa position fraiche, et l'episode en cours, lui,
     avance en direct via <ProgressBar live>. */
  const [saved, setSaved] = useState<Record<string, ProgressEntry>>({});
  useEffect(() => {
    if (info?.id == null) return;
    setSaved(getAnimeProgress(info.id));
  }, [info?.id, watchId]);
  const hideSpoilers = useHideSpoilers();
  const { t } = useTranslation();
  const router = useRouter();

  const [view, setView] = useState<View>("detailed");
  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_KEY) as View | null;
    if (saved && VIEWS.includes(saved)) setView(saved);
  }, []);
  function pickView(next: View) {
    setView(next);
    window.localStorage.setItem(VIEW_KEY, next);
  }

  /* Season siblings, fetched after mount from the edge-cached route rather
     than resolved in the page's SSR — see /api/v2/seasons/[id]. A franchise
     with a single season returns one row (or none), and the picker hides. */
  const [seasons, setSeasons] = useState<SeasonRow[]>([]);
  useEffect(() => {
    const aniId = Number(info?.id);
    if (!Number.isFinite(aniId)) return;
    let alive = true;
    fetch(`/api/v2/seasons/${aniId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => alive && setSeasons(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [info?.id]);

  /* Menu de saisons maison plutot qu'un <select> natif : la liste porte un
     libelle ("Season 2 Part 2") et un sous-titre, et deux cours d'une meme
     saison partagent le meme `number` — "Saison 2" deux fois dans le natif.
     Meme rendu que le SeasonPicker de la page d'info. */
  const [seasonOpen, setSeasonOpen] = useState(false);
  const activeSeason = seasons.find((s) => String(s.id) === String(info?.id));
  useEffect(() => {
    if (!seasonOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSeasonOpen(false);
    const onClick = () => setSeasonOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [seasonOpen]);

  // Titles/images live in `map` (the provider's episode metadata); a run
  // without usable art falls back to number-only rows, as before.
  const hasArt = useMemo(
    () =>
      !!map?.some(
        (item: any) =>
          (item?.img || item?.image) &&
          !item?.img?.includes("https://s4.anilist.co/"),
      ),
    [map],
  );

  const first = episode?.[0]?.number;
  const last = episode?.[episode.length - 1]?.number;
  /* Largeur du numero : autant de chiffres que le plus grand numero de la
     liste. 12 episodes donnent "01", 1120 donnent "0001" — les numeros
     restent alignes en colonne quelle que soit la longueur de la serie. */
  const padTo = String(last ?? episode?.length ?? 1).length;

  /* L'episode en cours se reconnait a son NUMERO. `watchId` ne peut plus servir
     a ça : c'est devenu la cle de la liste de visionnage (`{aniId}-{num}`),
     alors que les lignes portent l'id du fournisseur ("animesama-ansembed-1").
     La comparaison echouait donc a tous les coups — plus de liseré, plus de
     vignette assombrie, et surtout plus rien pour designer la ligne qui doit
     suivre la lecture en direct. Le repli sur `watchId` reste pour le cas ou la
     navigation n'est pas encore resolue. */
  const playingNumber = Number(track?.playing?.number);

  function hrefFor(item: Episode) {
    return `/en/anime/watch/${info.id}/${providerId}?id=${encodeURIComponent(
      item.id,
    )}&num=${item.number}${dub ? `&dub=${dub}` : ""}`;
  }

  /* Per-episode facts shared by all three views. `barWidth` is the resume bar:
     the local watch position when we have one, else "fully watched" for
     everything at or below the list progress. */
  function factsFor(item: Episode) {
    /* La position vient de `aniscroll:progress`, la meme que celle qui fait
       reprendre la lecture. L'ancienne source (`artStorage[item.id]`) ne
       pouvait rien rendre : ce store est indexe par ID D'ANIME, jamais par id
       d'episode, donc la recherche echouait a tous les coups et la barre ne
       bougeait que pour les episodes deja comptes comme vus. */
    const store = saved[String(item.number)];
    const watched = progress !== undefined && progress >= item?.number;
    const prog =
      store && store.duration > 0
        ? Math.min(100, (store.time / store.duration) * 100)
        : 0;
    const mapData = map?.find((i: any) => i.number === item.number);
    const parsedImage = mapData
      ? mapData?.img?.includes("null") || mapData?.image?.includes("null")
        ? info.coverImage?.extraLarge
        : mapData?.img || mapData?.image
      : info.coverImage?.extraLarge || null;
    return {
      mapData,
      parsedImage,
      watched,
      playing: Number.isFinite(playingNumber)
        ? item.number === playingNumber
        : item.id == watchId,
      // Fini = pleine. Un episode compte pour vu soit parce que la liste le
      // dit, soit parce que la position sauvegardee est arrivee au bout (le
      // lecteur ecrit time = duration a la fin de l'episode).
      barWidth: watched || prog >= 99.5 ? "100%" : `${prog}%`,
      title: hideSpoilers
        ? `${t("common.episode")} ${item?.number}`
        : fixApostrophes(mapData?.title) ||
          `${t("common.episode")} ${item?.number}`,
      pad: String(item.number).padStart(padTo, "0"),
      /* Duree deja mesuree par le lecteur sur cet appareil, s'il y en a une ;
         <Runtime> se charge d'aller chercher les autres. Le "~" de l'estimation
         AniList evite de faire passer une moyenne de serie pour la duree du
         fichier. */
      known: store && store.duration > 0 ? store.duration : null,
      estimate: info?.duration
        ? `~${t("home.minutesShort", { count: info.duration })}`
        : null,
    };
  }

  /* One row's frame — the accent-tinted gradient + border the info page gives
     the episode you're on, plain surface otherwise. */
  function frame(playing: boolean) {
    return {
      borderColor: playing ? ACCENT_BORDER : T.line,
      background: playing ? ACCENT_ROW : T.bg2,
    };
  }

  return (
    /* `lg:h-full` + the flex chain below: the card stretches to whatever the
       page gives this column, and the scroll area — not the card — absorbs the
       overflow. `min-h-0` at each level because a flex item won't shrink below
       its content otherwise, which would push the scrollbar out of view. */
    <div className="w-full lg:h-full lg:max-w-sm xl:max-w-lg lg:w-[24rem] xl:w-[32rem] shrink-0 flex flex-col gap-2">
      <div
        className="rounded-xl border lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
        style={{ borderColor: T.line, background: "rgba(16,18,26,0.6)" }}
      >
        {/* ── Header: season · range · view mode ── */}
        <div
          className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2"
          style={{ borderColor: T.line }}
        >
          {seasons.length > 1 && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSeasonOpen((o) => !o);
                }}
                className="flex items-center gap-1.5 rounded-lg border py-1 pl-2.5 pr-2 text-[11px] font-semibold outline-none"
                style={{ background: T.bg2, borderColor: T.line, color: T.txt0 }}
              >
                <span className="max-w-[150px] truncate">
                  {activeSeason?.label || `${t("anime.season")} ${activeSeason?.number ?? 1}`}
                </span>
                <ChevronDownIcon
                  className="h-3 w-3 shrink-0 transition-transform"
                  style={{
                    color: T.txt3,
                    transform: seasonOpen ? "rotate(180deg)" : "none",
                  }}
                />
              </button>
              {seasonOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 top-[calc(100%+6px)] z-30 max-h-[320px] min-w-[220px] overflow-y-auto rounded-xl border p-1 shadow-2xl"
                  style={{ background: T.bg2, borderColor: T.line2 }}
                >
                  {seasons.map((s) => {
                    const rowActive = String(s.id) === String(info?.id);
                    // Meme sous-titre que la page d'info : annee · nb d'episodes,
                    // repli sur le format quand ni l'un ni l'autre n'est connu.
                    const sub =
                      [s.year, s.episodes ? `${s.episodes} EP` : null]
                        .filter(Boolean)
                        .join(" · ") || (s.format ?? "");
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setSeasonOpen(false);
                          if (rowActive) return;
                          router.push(
                            `/en/anime/watch/${s.id}/${providerId}?id=${providerId}-1&num=1${
                              dub ? `&dub=${dub}` : ""
                            }`,
                          );
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
                        style={{
                          background: rowActive ? ACCENT_SOFT : "transparent",
                          color: rowActive ? ACCENT : T.txt0,
                        }}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-[12.5px] font-semibold">
                            {s.label || `${t("anime.season")} ${s.number}`}
                          </span>
                          {sub && (
                            <span
                              className="text-[10.5px]"
                              style={{ color: T.txt3 }}
                            >
                              {sub}
                            </span>
                          )}
                        </span>
                        {rowActive && (
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            className="ml-auto shrink-0"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-[13px] font-semibold" style={{ color: T.txt0 }}>
              {t("anime.episodes")}
            </span>
            {first != null && last != null && (
              <span
                className="text-[11px] tabular-nums"
                style={{ color: T.txt3 }}
              >
                {first}–{last}
              </span>
            )}
          </div>

          {/* One button that cycles the three views, same control as the info
              page. The icon shows the view you are IN, and the label names it
              plus the action — a bare "next" icon would leave you guessing
              what you are looking at. */}
          <button
            type="button"
            onClick={() => pickView(nextView(view))}
            title={`${t(VIEW_LABELS[view])} · ${t("anime.changeView")}`}
            aria-label={`${t(VIEW_LABELS[view])} · ${t("anime.changeView")}`}
            className="ml-auto grid h-[26px] w-[28px] shrink-0 place-items-center rounded-lg border transition-colors"
            style={{ background: T.bg2, borderColor: T.line, color: T.txt0 }}
          >
            <ViewIcon view={view} />
          </button>
        </div>

        {/* ── List ── */}
        <div
          className={`scrollbar-thin scrollbar-thumb-[#313131] scrollbar-thumb-rounded-full max-h-[60vh] overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1 ${
            view === "grid"
              ? /* content-start : le conteneur est `flex-1` donc plus haut que
                   ses lignes ; sans ca `align-content: stretch` etire les rangees
                   et laisse un trou beant entre l'ep 8 et l'ep 9. */
                "grid content-start grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-1.5 p-2.5"
              : view === "compact"
                ? "flex flex-col gap-1 p-2"
                : "flex flex-col gap-2 p-2"
          }`}
        >
          {!episode || episode.length === 0 ? (
            <Skeleton className="h-[86px] w-full rounded-[10px]" />
          ) : view === "grid" ? (
            episode.map((item) => {
              const f = factsFor(item);
              return (
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  title={f.title}
                  className={`grid aspect-square place-items-center rounded-lg border text-sm font-semibold transition-all duration-300 ease-out ${
                    f.playing
                      ? "pointer-events-none"
                      : "hover:scale-[1.06] hover:shadow-lg hover:ring-1 hover:ring-white"
                  }`}
                  style={{
                    borderColor: f.playing ? ACCENT_BORDER : T.line,
                    background: f.playing
                      ? ACCENT_SOFT
                      : f.watched
                        ? "rgba(45,212,122,0.06)"
                        : T.bg2,
                    color: f.playing
                      ? ACCENT
                      : f.watched
                        ? T.green
                        : T.txt0,
                  }}
                >
                  {item.number}
                </Link>
              );
            })
          ) : view === "compact" ? (
            episode.map((item) => {
              const f = factsFor(item);
              return (
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  title={f.title}
                  className={`flex min-h-[40px] items-center gap-3 rounded-lg border px-3 py-2.5 transition-all duration-300 ease-out ${
                    f.playing
                      ? "pointer-events-none"
                      : "hover:scale-[1.02] hover:shadow-lg hover:ring-1 hover:ring-white"
                  }`}
                  style={frame(f.playing)}
                >
                  <span
                    className="w-7 shrink-0 text-right text-[11px] tabular-nums tracking-[0.08em]"
                    style={{ color: T.txt3 }}
                  >
                    {f.pad}
                  </span>
                  <span
                    className="flex-1 truncate text-[13px] font-medium"
                    style={{ color: T.txt0 }}
                  >
                    {f.title}
                  </span>
                  {f.playing ? (
                    <span
                      className="shrink-0 text-xs font-semibold"
                      style={{ color: ACCENT }}
                    >
                      ●
                    </span>
                  ) : f.watched ? (
                    <span
                      className="shrink-0 text-xs font-semibold"
                      style={{ color: T.green }}
                    >
                      ✓
                    </span>
                  ) : null}
                </Link>
              );
            })
          ) : (
            episode.map((item) => {
              const f = factsFor(item);
              return (
                /* Carte reprise TELLE QUELLE de la prod : vignette large a
                   gauche, titre en gras italique, resume en dessous. Et son
                   survol, qui manquait ici : la carte grossit d'un poil, prend
                   un liseré blanc et une ombre — c'est ce mouvement qui dit
                   qu'une ligne est cliquable, l'episode en cours (liseré
                   accent) etant justement le seul a ne pas l'etre. */
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  /* Pas de `scale-100` au repos : une transform, meme neutre,
                     compose l'element sur sa propre couche, et Chrome rogne
                     alors les coins arrondis sans anticrenelage — d'ou les
                     bords en escalier. La carte reste donc sans transform tant
                     qu'on ne la survole pas. */
                  className={`bg-secondary flex h-[110px] w-full rounded-lg transition-all duration-300 ease-out ${
                    f.playing
                      ? "pointer-events-none ring-1 ring-action"
                      : "cursor-pointer ring-0 ring-white hover:scale-[1.02] hover:shadow-lg hover:ring-1"
                  }`}
                >
                  <div className="relative h-[110px] w-[43%] shrink-0 overflow-hidden rounded-lg shadow-[4px_0px_5px_0px_rgba(0,0,0,0.3)] lg:w-[42%]">
                    {hasArt && f.parsedImage && (
                      <Image
                        src={f.parsedImage}
                        alt=""
                        draggable={false}
                        width={496}
                        height={280}
                        /* L'arrondi est porte par l'image ELLE-MEME, pas
                           seulement par le `overflow-hidden` du cadre : le
                           filtre `brightness` promeut l'image sur sa propre
                           couche, et le rognage du parent y perd son
                           anticrenelage. Arrondie a la source, elle sort
                           nette. */
                        className={`h-[110px] w-full rounded-lg object-cover ${
                          f.playing ? "brightness-[30%]" : "brightness-75"
                        } ${hideSpoilers && !f.playing ? "blur-lg" : ""}`}
                      />
                    )}
                    {/* Voile bas, pour que le numero tienne aussi sur une
                        image claire. */}
                    <div
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%]"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 100%)",
                      }}
                    />
                    <ProgressBar
                      aniId={info.id}
                      episode={item.number}
                      live={f.playing}
                      width={f.barWidth}
                    />
                    <span className="absolute bottom-2 left-2 font-karla text-[17px] font-bold leading-none text-white/90">
                      {f.pad}
                    </span>
                    {f.playing && (
                      <div className="absolute inset-0 grid place-items-center">
                        <svg
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="h-5 w-5 scale-[1.5]"
                        >
                          <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                        </svg>
                      </div>
                    )}
                  </div>

                  <div
                    className={`flex h-full w-full select-none flex-col gap-2 overflow-x-hidden p-4 ${
                      f.playing ? "text-[#7a7a7a]" : ""
                    }`}
                  >
                    <h1 className="line-clamp-1 font-karla font-bold italic">
                      {f.title}
                    </h1>
                    {/* La duree remplace le resume : "Episode 1" sous un titre
                        qui dit deja l'episode ne servait a rien. */}
                    <Runtime
                      aniId={info.id}
                      episode={item.number}
                      malId={info?.idMal ?? null}
                      live={f.playing}
                      known={f.known}
                      estimate={f.estimate}
                    />
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
