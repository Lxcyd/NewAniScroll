import Skeleton from "react-loading-skeleton";
import Image from "next/image";
import Link from "next/link";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/router";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { Episode } from "types/api/Episode";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { useHideSpoilers } from "@/lib/prefs/spoilerPrefs";
import { useSyncPrefs } from "@/lib/prefs/syncPrefs";
import { peekLocalEntry, LOCAL_LIST_EVENT } from "@/lib/list/localList";
import { fixApostrophes } from "@/lib/text/apostrophes";

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

/* Design tokens copied from components/anime/v2/styles.module.css.
 *
 * They live there scoped to the info page's `.root`, which also sets a page
 * background and a 100vh floor — not something to drag into a sidebar. So the
 * VALUES are mirrored here rather than the stylesheet imported. Keep the two in
 * step: this panel is meant to be the info page's episode list, narrower. */
const T = {
  bg2: "#161924",
  bg3: "#1d2030",
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
  const progress = syncEnabled ? info.mediaListEntry?.progress : localProgress;
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
  const durationLabel = info?.duration
    ? t("home.minutesShort", { count: info.duration })
    : null;
  const langLabel = dub ? "Dub" : "Sub";

  function hrefFor(item: Episode) {
    return `/en/anime/watch/${info.id}/${providerId}?id=${encodeURIComponent(
      item.id,
    )}&num=${item.number}${dub ? `&dub=${dub}` : ""}`;
  }

  /* Per-episode facts shared by all three views. `barWidth` is the resume bar:
     the local watch position when we have one, else "fully watched" for
     everything at or below the list progress. */
  function factsFor(item: Episode) {
    const store = artStorage?.[item.id];
    const time = store?.timeWatched;
    const duration = store?.duration;
    let prog = (time / duration) * 100;
    if (prog > 90) prog = 100;
    const watched = progress !== undefined && progress >= item?.number;
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
      playing: item.id == watchId,
      barWidth: watched ? "100%" : store !== undefined ? `${prog}%` : "0%",
      title: hideSpoilers
        ? `${t("common.episode")} ${item?.number}`
        : fixApostrophes(mapData?.title) ||
          `${t("common.episode")} ${item?.number}`,
      pad: String(item.number).padStart(2, "0"),
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
    <div className="w-full lg:max-w-sm xl:max-w-lg lg:w-[24rem] xl:w-[32rem] shrink-0 flex flex-col gap-2">
      <div
        className="rounded-xl border"
        style={{ borderColor: T.line, background: "rgba(16,18,26,0.6)" }}
      >
        {/* ── Header: season · range · view mode ── */}
        <div
          className="flex items-center gap-2 border-b px-2.5 py-2"
          style={{ borderColor: T.line }}
        >
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
                className="cursor-pointer appearance-none rounded-lg border py-1 pl-2.5 pr-6 text-[11px] font-semibold outline-none"
                style={{ background: T.bg2, borderColor: T.line, color: T.txt0 }}
              >
                {seasons.map((s) => (
                  <option key={s.id} value={s.id} style={{ background: T.bg2 }}>
                    {t("anime.season")} {s.number}
                  </option>
                ))}
              </select>
              <ChevronDownIcon
                className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2"
                style={{ color: T.txt3 }}
              />
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

          {/* Same segmented control as the info page's Episodes tab. */}
          <div
            className="ml-auto flex shrink-0 gap-0.5 rounded-lg border p-[3px]"
            style={{ background: T.bg2, borderColor: T.line }}
          >
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => pickView(v)}
                title={t(VIEW_LABELS[v])}
                aria-label={t(VIEW_LABELS[v])}
                aria-pressed={v === view}
                className="grid h-[22px] w-[24px] place-items-center rounded-md transition-colors"
                style={{
                  background: v === view ? T.bg3 : "transparent",
                  color: v === view ? T.txt0 : T.txt3,
                }}
              >
                <ViewIcon view={v} />
              </button>
            ))}
          </div>
        </div>

        {/* ── List ── */}
        <div
          className={`scrollbar-thin scrollbar-thumb-[#313131] scrollbar-thumb-rounded-full max-h-[60vh] overflow-y-auto lg:max-h-[calc(100vh-14rem)] ${
            view === "grid"
              ? "grid grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-1.5 p-2.5"
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
                  className={`grid aspect-square place-items-center rounded-lg border text-sm font-semibold transition-all ${
                    f.playing ? "pointer-events-none" : ""
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
                  className={`flex min-h-[40px] items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                    f.playing ? "pointer-events-none" : ""
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
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  className={`flex items-center gap-3.5 rounded-[10px] border p-2.5 transition-all ${
                    f.playing ? "pointer-events-none" : ""
                  }`}
                  style={frame(f.playing)}
                >
                  <div className="relative h-[70px] w-[124px] shrink-0 overflow-hidden rounded-[7px] bg-image/40">
                    {hasArt && f.parsedImage && (
                      <Image
                        src={f.parsedImage}
                        alt=""
                        draggable={false}
                        width={248}
                        height={140}
                        className={`h-full w-full object-cover ${
                          hideSpoilers && !f.playing ? "blur-md" : ""
                        }`}
                      />
                    )}
                    {/* Scrim, so the number stays readable on a bright frame. */}
                    <div
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%]"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 100%)",
                      }}
                    />
                    <span className="absolute bottom-1.5 left-2 text-[16px] font-bold text-white/85">
                      {f.pad}
                    </span>
                    {f.playing && (
                      <div className="absolute inset-0 grid place-items-center bg-black/40">
                        <span
                          className="grid h-8 w-8 place-items-center rounded-full pl-[2px]"
                          style={{
                            background: `color-mix(in srgb, ${ACCENT} 90%, transparent)`,
                          }}
                        >
                          <svg
                            viewBox="0 0 20 20"
                            fill="#fff"
                            className="h-4 w-4"
                          >
                            <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                          </svg>
                        </span>
                      </div>
                    )}
                    <span
                      className="absolute bottom-0 left-0 h-[2px]"
                      style={{ width: f.barWidth, background: ACCENT }}
                    />
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10.5px] tracking-[0.08em]"
                        style={{ color: T.txt3 }}
                      >
                        EP {f.pad}
                      </span>
                      {f.playing ? (
                        <span
                          className="rounded-[3px] px-1.5 py-[2px] text-[9.5px] font-semibold tracking-[0.04em]"
                          style={{ color: ACCENT, background: ACCENT_SOFT }}
                        >
                          {t("player.nowPlayingShort")}
                        </span>
                      ) : f.watched ? (
                        <span
                          className="rounded-[3px] px-1.5 py-[2px] text-[9.5px] font-semibold tracking-[0.04em]"
                          style={{
                            color: T.green,
                            background: "rgba(45,212,122,0.1)",
                          }}
                        >
                          ✓
                        </span>
                      ) : null}
                    </div>
                    <div
                      className="truncate text-sm font-semibold"
                      style={{ color: T.txt0 }}
                    >
                      {f.title}
                    </div>
                    <div
                      className="flex items-center gap-2 text-[11.5px]"
                      style={{ color: T.txt3 }}
                    >
                      {durationLabel}
                      <span
                        className="h-[3px] w-[3px] rounded-full"
                        style={{ background: T.txt3 }}
                      />
                      {langLabel}
                    </div>
                  </div>

                  {/* The whole row is the link, so this reads as a label rather
                      than a second control — and it only appears where the
                      panel is wide enough not to squeeze the title. */}
                  {!f.playing && (
                    <span
                      className="hidden shrink-0 rounded-lg border px-4 py-2 text-xs font-semibold xl:block"
                      style={{
                        background: T.bg3,
                        borderColor: T.line2,
                        color: T.txt0,
                      }}
                    >
                      {f.watched ? t("anime.replay") : t("anime.play")}
                    </span>
                  )}
                </Link>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
