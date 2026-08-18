import Skeleton from "react-loading-skeleton";
import Image from "next/image";
import Link from "next/link";
import {
  Squares2X2Icon,
  Bars3Icon,
  ViewColumnsIcon,
  ChevronDownIcon,
} from "@heroicons/react/24/outline";
import { useRouter } from "next/router";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { Episode } from "types/api/Episode";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { useHideSpoilers } from "@/lib/prefs/spoilerPrefs";
import { useSyncPrefs } from "@/lib/prefs/syncPrefs";
import { peekLocalEntry, LOCAL_LIST_EVENT } from "@/lib/list/localList";

type EpisodeListsProps = {
  info: AniListInfoTypes;
  map: any;
  providerId: string;
  watchId: string;
  episode: Episode[];
  artStorage: any;
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

/* The three shapes the list can take. "compact" is the default: a full season
   fits on screen next to the player, which is what the panel is for. "cards"
   keeps the old thumbnail+synopsis rows for viewers who browse by description,
   and "grid" is for the 100+ episode entries where any row height at all makes
   the list unusable. Remembered per device — a choice about how you read a
   list shouldn't reset on the next episode. */
const VIEWS = ["compact", "cards", "grid"] as const;
type View = (typeof VIEWS)[number];
const VIEW_KEY = "aniscroll.episodeView";
const VIEW_ICONS = {
  compact: Bars3Icon,
  cards: ViewColumnsIcon,
  grid: Squares2X2Icon,
};

function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function EpisodeLists({
  info,
  map,
  providerId,
  watchId,
  episode,
  artStorage,
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
  const progress = syncEnabled
    ? info.mediaListEntry?.progress
    : localProgress;
  const hideSpoilers = useHideSpoilers();
  const { t } = useTranslation();
  const router = useRouter();

  const [view, setView] = useState<View>("compact");
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

  function hrefFor(item: Episode) {
    return `/en/anime/watch/${info.id}/${providerId}?id=${encodeURIComponent(
      item.id,
    )}&num=${item.number}${dub ? `&dub=${dub}` : ""}`;
  }

  /* Per-episode facts shared by all three views. `prog` is the resume bar:
     the local watch position when we have one, else "fully watched" for
     everything at or below the list progress. */
  function factsFor(item: Episode) {
    const store = artStorage?.[item.id];
    const time = store?.timeWatched;
    const duration = store?.duration;
    let prog = (time / duration) * 100;
    if (prog > 90) prog = 100;
    const seen = progress !== undefined && progress >= item?.number;
    const mapData = map?.find((i: any) => i.number === item.number);
    const parsedImage = mapData
      ? mapData?.img?.includes("null") || mapData?.image?.includes("null")
        ? info.coverImage?.extraLarge
        : mapData?.img || mapData?.image
      : info.coverImage?.extraLarge || null;
    return {
      mapData,
      parsedImage,
      isPlaying: item.id == watchId,
      barWidth: seen ? "100%" : store !== undefined ? `${prog}%` : "0%",
      // Only the episode on screen gets a countdown — for the others the
      // stored position is stale enough to be misleading.
      left: duration && time ? clock(duration - time) : null,
      title: hideSpoilers
        ? `${t("common.episode")} ${item?.number}`
        : mapData?.title || `${t("common.episode")} ${item?.number}`,
    };
  }

  const duration = info?.duration ? t("home.minutesShort", { count: info.duration }) : null;

  return (
    <div className="w-full lg:w-[340px] xl:w-[400px] 2xl:w-[440px] shrink-0 flex flex-col gap-2">
      {/* Next-episode shortcut. Kept above the panel rather than under it:
          the list scrolls, and a control that follows the scroll would be
          out of reach on a 100-episode entry. */}
      {track?.next && (
        <button
          type="button"
          onClick={() =>
            router.push(
              `/en/anime/watch/${info.id}/${providerId}?id=${track?.next?.id}&num=${
                track?.next?.number
              }${dub ? `&dub=${dub}` : ""}`,
            )
          }
          className="self-start px-1 text-sm font-karla font-semibold text-white/60 transition-colors hover:text-white"
        >
          {t("player.nextEpisodeBtn")} ›
        </button>
      )}

      <div className="rounded-xl bg-as-card/60 ring-1 ring-white/[0.06] overflow-hidden">
        {/* ── Header: season · range · view mode ── */}
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-white/[0.06]">
          {seasons.length > 1 && (
            <div className="relative shrink-0">
              <select
                value={info?.id}
                onChange={(e) =>
                  router.push(
                    `/en/anime/watch/${e.target.value}/${providerId}?id=${providerId}-1&num=1${
                      dub ? `&dub=${dub}` : ""
                    }`,
                  )
                }
                className="appearance-none cursor-pointer rounded-lg bg-white/[0.05] py-1 pl-2.5 pr-6 text-[11px] font-karla font-semibold text-white/80 outline-none ring-1 ring-white/[0.07] hover:bg-white/[0.09] focus:ring-action"
              >
                {seasons.map((s) => (
                  <option key={s.id} value={s.id} className="bg-secondary">
                    {t("anime.season")} {s.number}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-white/50" />
            </div>
          )}

          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-[13px] font-karla font-semibold text-white/85">
              {t("anime.episodes")}
            </span>
            {first != null && last != null && (
              <span className="text-[11px] font-karla tabular-nums text-white/30">
                {first}–{last}
              </span>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg bg-black/30 p-0.5">
            {VIEWS.map((v) => {
              const Icon = VIEW_ICONS[v];
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => pickView(v)}
                  title={t(`player.view_${v}`)}
                  aria-label={t(`player.view_${v}`)}
                  aria-pressed={v === view}
                  className={`rounded-[6px] p-1 transition-colors ${
                    v === view
                      ? "bg-white/10 text-white ring-1 ring-white/15"
                      : "text-white/30 hover:text-white/70"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>
        </div>

        {/* ── List ── */}
        <div
          className={`scrollbar-thin scrollbar-thumb-[#313131] scrollbar-thumb-rounded-full overflow-y-auto max-h-[60vh] lg:max-h-[calc(100vh-14rem)] ${
            view === "grid" ? "grid grid-cols-6 gap-1.5 p-2.5" : "flex flex-col gap-1.5 p-2"
          }`}
        >
          {!episode || episode.length === 0 ? (
            <Skeleton className="h-[110px] w-full rounded-lg" />
          ) : view === "grid" ? (
            episode.map((item) => {
              const { isPlaying } = factsFor(item);
              const seen = progress !== undefined && progress >= item?.number;
              return (
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  className={`flex aspect-square items-center justify-center rounded-md text-[12px] font-karla font-semibold tabular-nums transition-colors ${
                    isPlaying
                      ? "pointer-events-none bg-action/25 text-white ring-1 ring-action"
                      : seen
                        ? "bg-white/[0.09] text-white/70 hover:bg-white/[0.14]"
                        : "bg-white/[0.04] text-white/45 hover:bg-white/[0.09] hover:text-white"
                  }`}
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
                  className={`group flex items-center gap-3 rounded-lg p-2 transition-colors ${
                    f.isPlaying
                      ? "pointer-events-none bg-action/10 ring-1 ring-action/70"
                      : "ring-1 ring-transparent hover:bg-white/[0.05]"
                  }`}
                >
                  <div className="relative h-[59px] w-[105px] shrink-0 overflow-hidden rounded-md bg-image/40">
                    {hasArt && f.parsedImage && (
                      <Image
                        src={f.parsedImage}
                        alt=""
                        draggable={false}
                        width={240}
                        height={135}
                        className={`h-full w-full object-cover ${
                          f.isPlaying ? "brightness-[45%]" : "brightness-90"
                        } ${hideSpoilers && !f.isPlaying ? "blur-md" : ""}`}
                      />
                    )}
                    <span
                      className="absolute bottom-0 left-0 h-[2px] bg-action"
                      style={{ width: f.barWidth }}
                    />
                  </div>
                  <div className="min-w-0 grow">
                    <div
                      className={`line-clamp-2 text-sm font-karla font-semibold leading-snug ${
                        f.isPlaying ? "text-action" : "text-white/85"
                      }`}
                    >
                      <span className="tabular-nums">{item.number}</span>
                      <span className="px-1 text-white/25">·</span>
                      {f.title}
                    </div>
                    <div className="mt-1 text-[11px] font-karla text-white/35">
                      {f.isPlaying ? (
                        <span className="text-action/80">
                          {t("player.nowPlayingShort")}
                          {f.left ? ` · ${t("player.timeLeft", { time: f.left })}` : ""}
                        </span>
                      ) : (
                        duration
                      )}
                    </div>
                  </div>
                </Link>
              );
            })
          ) : (
            episode.map((item) => {
              const f = factsFor(item);
              if (!hasArt) {
                return (
                  <Link
                    key={item.id}
                    href={hrefFor(item)}
                    className={`flex-center h-[50px] rounded-lg bg-secondary transition-all duration-300 ease-out ${
                      f.isPlaying
                        ? "pointer-events-none text-[#5d5d5d] ring-1 ring-action"
                        : "cursor-pointer ring-0 ring-white hover:shadow-lg hover:ring-1"
                    }`}
                  >
                    {t("common.episode")} {item.number}
                  </Link>
                );
              }
              return (
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  className={`flex h-[110px] w-full rounded-lg bg-secondary transition-all duration-300 ease-out ${
                    f.isPlaying
                      ? "pointer-events-none ring-1 ring-action"
                      : "cursor-pointer ring-0 ring-white hover:shadow-lg hover:ring-1"
                  }`}
                >
                  <div className="relative z-40 h-[110px] w-[42%] shrink-0 overflow-hidden rounded-lg shadow-[4px_0px_5px_0px_rgba(0,0,0,0.3)]">
                    <div className="relative">
                      <Image
                        src={f.parsedImage || info?.coverImage?.extraLarge}
                        draggable={false}
                        alt="Anime Cover"
                        width={1000}
                        height={1000}
                        className={`z-30 h-[110px] rounded-lg object-cover ${
                          f.isPlaying ? "brightness-[30%]" : "brightness-75"
                        } ${hideSpoilers && !f.isPlaying ? "blur-lg" : ""}`}
                      />
                      <span
                        className="absolute bottom-0 left-0 h-[2px] bg-red-700"
                        style={{ width: f.barWidth }}
                      />
                      <span className="absolute bottom-2 left-2 font-karla text-sm font-bold text-white">
                        {t("common.episode")} {item?.number}
                      </span>
                      {f.isPlaying && (
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 scale-[1.5] transform">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            className="h-5 w-5"
                          >
                            <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                          </svg>
                        </div>
                      )}
                    </div>
                  </div>
                  <div
                    className={`flex h-full w-full select-none flex-col gap-2 overflow-x-hidden p-4 ${
                      f.isPlaying ? "text-[#7a7a7a]" : ""
                    }`}
                  >
                    <h1 className="line-clamp-1 font-karla font-bold italic">{f.title}</h1>
                    <p className="line-clamp-2 font-outfit text-xs font-extralight italic">
                      {hideSpoilers
                        ? `${t("common.episode")} ${item.number}`
                        : f.mapData?.description ||
                          `${t("common.episode")} ${item.number}`}
                    </p>
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
