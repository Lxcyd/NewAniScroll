import { ChevronLeftIcon, PlayIcon } from "@heroicons/react/24/solid";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Skeleton from "react-loading-skeleton";
import Footer from "@/components/shared/footer";
import { useSession } from "next-auth/react";
import { ChevronRightIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/router";
import { touchHistory } from "@/lib/profile/history";
import HistoryOptions from "@/components/home/historyOptions";
import Head from "next/head";
import MobileNav from "@/components/shared/MobileNav";
import { notify } from "@/lib/notifications/noticeStore";
import { useTranslation } from "react-i18next";

/* No getServerSideProps. The session was fetched server-side and passed down,
   which made this page dynamic (one serverless invocation per view) — but it is
   only ever read inside effects that run on the client anyway. useSession()
   gives the same object from the provider _app already mounts, and the page
   becomes static. */
export default function RecentlyWatched() {
  const { data: sessions } = useSession();
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [remove, setRemoved] = useState();
  const [query, setQuery] = useState("");
  const router = useRouter();

  useEffect(() => {
    setLoading(true);
    const fetchData = async () => {
      // 1. Try the Prisma-backed user profile first (when signed in).
      //    If Prisma isn't configured or the user has no rows yet, we
      //    fall through to localStorage so the page never goes blank.
      let serverList = null;
      if (sessions?.user?.name) {
        try {
          const res = await fetch(
            `/api/user/profile?name=${encodeURIComponent(sessions.user.name)}`,
            { cache: "no-store" },
          );
          if (res.ok) {
            const json = await res.json();
            serverList = Array.isArray(json?.WatchListEpisode)
              ? json.WatchListEpisode
              : null;
          }
        } catch {}
      }

      // 2. Read localStorage as a fallback / merge source so we still show
      //    anonymous watch history.
      let localList = [];
      try {
        const dat = JSON.parse(localStorage.getItem("artplayer_settings"));
        if (dat && typeof dat === "object") {
          localList = Object.keys(dat).map((key) => dat[key]);
        }
      } catch {}

      // A row is renderable when it has an identity (watchId OR aniId — many
      // localStorage rows are keyed by aniId and have no watchId) AND
      // something meaningful to display (image OR title).
      const displayable = (i) =>
        (i?.watchId || i?.aniId) &&
        (i?.image || i?.cover || i?.aniTitle || i?.title);

      // 3. Prefer the server list — but judge it on its RENDERABLE rows, not
      //    its raw length. A signed-in user can have Prisma rows that carry
      //    no image/title (created via list-sync, or by a failed episode
      //    update): the old `serverList.length > 0` test then locked us onto
      //    a list the display filter dropped entirely, rendering this page
      //    blank while the home carousel (which falls back to localStorage)
      //    showed the same history fine.
      const serverShown = (serverList || []).filter(displayable);
      const localShown = localList.filter(displayable);
      const merged = serverShown.length > 0 ? serverShown : localShown;

      // Sort most-recent-first. The server query orders by createdDate desc,
      // but rows with a null/stale createdDate land in an undefined spot, and
      // the local list comes back in Object.keys order — both produced a wrong
      // order here. Sorting client-side makes it deterministic.
      const sorted = [...merged].sort(
        (a, b) =>
          new Date(b?.createdDate || b?.createdAt || 0).getTime() -
          new Date(a?.createdDate || a?.createdAt || 0).getTime(),
      );
      setData(sorted);
      setLoading(false);
    };
    fetchData();
  }, [sessions?.user?.name, remove]);

  const removeItem = async (id, aniId) => {
    if (sessions?.user?.name) {
      // remove from database
      const res = await fetch(`/api/user/update/episode`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: sessions?.user?.name,
          id,
          aniId,
        }),
      });
      const data = await res.json();

      if (id) {
        // remove from local storage
        const artplayerSettings =
          JSON.parse(localStorage.getItem("artplayer_settings")) || {};
        if (artplayerSettings[id]) {
          delete artplayerSettings[id];
          localStorage.setItem(
            "artplayer_settings",
            JSON.stringify(artplayerSettings)
          );
          touchHistory();
        }
      }
      if (aniId) {
        const currentData =
          JSON.parse(localStorage.getItem("artplayer_settings")) || {};

        const updatedData = {};

        for (const key in currentData) {
          const item = currentData[key];
          if (item.aniId !== aniId) {
            updatedData[key] = item;
          }
        }

        localStorage.setItem("artplayer_settings", JSON.stringify(updatedData));
        touchHistory();
      }

      // update client
      setRemoved(id || aniId);

      if (data?.message === "Episode deleted") {
        notify.success(t("home.episodeRemoved"), {
          position: "bottom-right",
        });
      }
    } else {
      if (id) {
        // remove from local storage
        const artplayerSettings =
          JSON.parse(localStorage.getItem("artplayer_settings")) || {};
        if (artplayerSettings[id]) {
          delete artplayerSettings[id];
          localStorage.setItem(
            "artplayer_settings",
            JSON.stringify(artplayerSettings)
          );
          touchHistory();
        }
        setRemoved(id);
      }
      if (aniId) {
        const currentData =
          JSON.parse(localStorage.getItem("artplayer_settings")) || {};

        // Create a new object to store the updated data
        const updatedData = {};

        // Iterate through the current data and copy items with different aniId to the updated object
        for (const key in currentData) {
          const item = currentData[key];
          if (item.aniId !== aniId) {
            updatedData[key] = item;
          }
        }

        // Update localStorage with the filtered data
        localStorage.setItem("artplayer_settings", JSON.stringify(updatedData));
        touchHistory();
        setRemoved(aniId);
      }
    }
  };

  // ── Derived stats (episodes / unique anime / total watch time) ──────────
  // Computed from the same rows we render so the header summarises exactly
  // what's on screen. Watch time sums each row's `timeWatched` (seconds the
  // user actually watched of that episode), which is the honest figure — far
  // better than `episodes × duration` which over-counts skimmed episodes.
  const stats = useMemo(() => {
    const rows = data || [];
    const uniqueAnime = new Set(rows.map((i) => i.aniId).filter(Boolean));
    const totalSeconds = rows.reduce(
      (acc, i) => acc + (Number(i.timeWatched) || 0),
      0,
    );
    return {
      episodes: rows.length,
      anime: uniqueAnime.size,
      seconds: totalSeconds,
    };
  }, [data]);

  // ── Search filter ───────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const rows = data || [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((i) => {
      const a = (i.aniTitle || "").toLowerCase();
      const e = (i.title || i.anititle || "").toLowerCase();
      return a.includes(q) || e.includes(q);
    });
  }, [data, query]);

  // ── Group by recency bucket ─────────────────────────────────────────────
  const groups = useMemo(() => groupByRecency(filtered, t), [filtered, t]);

  const watchTimeLabel = formatWatchTime(stats.seconds, t);

  return (
    <>
      <Head>
        <title>AniScroll • {t("home.recentlyWatched")}</title>
      </Head>
      <MobileNav />

      <div className="min-h-screen w-full relative pb-16">
        {/* ── Hero header ───────────────────────────────────────────────── */}
        <div className="relative overflow-hidden border-b border-white/10">
          {/* Accent wash background */}
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "radial-gradient(1200px 400px at 15% -20%, color-mix(in srgb, var(--brand-primary, #E94560) 22%, transparent), transparent 70%)",
            }}
          />
          <div className="max-w-screen-2xl mx-auto px-4 md:px-8 pt-20 md:pt-24 pb-7">
            <Link
              href="/en"
              className="inline-flex gap-1.5 items-center font-karla text-sm text-gray-400 hover:text-white transition-colors mb-5"
            >
              <ChevronLeftIcon className="w-4 h-4" />
              {t("nav.home", { defaultValue: "Home" })}
            </Link>

            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
              <div>
                <h1 className="font-outfit font-extrabold text-white text-3xl md:text-5xl leading-tight">
                  {t("home.recentlyWatched")}
                </h1>
                <p className="font-karla text-gray-400 mt-2 text-sm md:text-base">
                  {t("home.historySubtitle")}
                </p>
              </div>

              {/* Stat pills */}
              <div className="flex gap-3 md:gap-4">
                <StatPill value={stats.episodes} label={t("home.statEpisodes")} />
                <StatPill value={stats.anime} label={t("home.statAnime")} />
                <StatPill value={watchTimeLabel} label={t("home.statWatchTime")} />
              </div>
            </div>

            {/* Search */}
            {(data?.length || 0) > 0 && (
              <div className="mt-7 relative max-w-md">
                <MagnifyingGlassIcon className="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("home.searchHistory")}
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-11 pr-4 py-2.5 font-karla text-sm text-white placeholder:text-gray-500 outline-none focus:border-action/60 focus:bg-white/[0.07] transition-colors"
                />
              </div>
            )}
          </div>
        </div>

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="max-w-screen-2xl mx-auto px-4 md:px-8 pt-8">
          {loading ? (
            <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 md:gap-6">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((item) => (
                <div key={item} className="flex flex-col gap-2 rounded-xl overflow-hidden">
                  <Skeleton className="w-full aspect-video rounded-xl" />
                  <Skeleton width={120} height={16} />
                </div>
              ))}
            </div>
          ) : !data || data.length === 0 ? (
            <EmptyState text={t("home.noHistory")} cta={t("nav.animeBrowse")} />
          ) : filtered.length === 0 ? (
            <EmptyState text={t("home.noSearchResults")} />
          ) : (
            <div className="flex flex-col gap-10">
              {groups.map((group) => (
                <section key={group.key}>
                  <h2 className="font-outfit font-bold text-white text-lg md:text-xl mb-4 flex items-center gap-3">
                    {group.label}
                    <span className="text-xs font-karla font-medium text-gray-500 bg-white/5 rounded-full px-2.5 py-0.5">
                      {group.items.length}
                    </span>
                  </h2>
                  <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 md:gap-6">
                    {group.items.map((i) => (
                      <HistoryCard
                        key={i.id || i.watchId || i.aniId}
                        i={i}
                        t={t}
                        router={router}
                        removeItem={removeItem}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
      <Footer />
    </>
  );
}

/* ── Stat pill ─────────────────────────────────────────────────────────── */
function StatPill({ value, label }) {
  return (
    <div className="flex flex-col items-center md:items-start bg-white/5 border border-white/10 rounded-xl px-4 md:px-5 py-2.5 min-w-[84px]">
      <span className="font-outfit font-bold text-white text-xl md:text-2xl leading-none">
        {value}
      </span>
      <span className="font-karla text-[11px] md:text-xs text-gray-400 mt-1 tracking-wide uppercase">
        {label}
      </span>
    </div>
  );
}

/* ── Empty state ───────────────────────────────────────────────────────── */
function EmptyState({ text, cta }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 gap-4">
      <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 grid place-items-center">
        <PlayIcon className="w-7 h-7 text-gray-500" />
      </div>
      <p className="text-gray-400 font-karla max-w-sm">{text}</p>
      {cta && (
        <Link
          href="/en"
          className="mt-2 inline-flex items-center gap-2 rounded-full bg-action px-5 py-2.5 font-karla font-semibold text-white text-sm hover:scale-[1.03] transition-transform"
        >
          {cta}
        </Link>
      )}
    </div>
  );
}

/* ── History card ──────────────────────────────────────────────────────── */
function HistoryCard({ i, t, router, removeItem }) {
  const time = Number(i.timeWatched) || 0;
  const duration = Number(i.duration) || 0;
  let prog = duration > 0 ? (time / duration) * 100 : 0;
  if (prog > 90) prog = 100;
  const isDone = prog >= 100;
  const remainingMin =
    duration > 0 && !isDone ? Math.max(0, Math.round((duration - time) / 60)) : 0;

  const watchHref = `/en/anime/watch/${i.aniId}/${i.provider}?id=${encodeURIComponent(
    i.watchId,
  )}&num=${i.episode}`;

  return (
    <div className="group/item flex flex-col gap-2.5">
      <div className="relative aspect-video rounded-xl overflow-hidden">
        {/* Hover actions */}
        <div className="absolute z-40 top-2 right-2 flex flex-col gap-1.5 opacity-0 group-hover/item:opacity-100 scale-90 group-hover/item:scale-100 transition-all duration-200 ease-out">
          <HistoryOptions remove={removeItem} watchId={i.watchId} aniId={i.aniId} />
          {i?.nextId && (
            <button
              type="button"
              className="group/next relative flex items-center justify-center"
              onClick={() =>
                router.push(
                  `/en/anime/watch/${i.aniId}/${i.provider}?id=${encodeURIComponent(
                    i?.nextId,
                  )}&num=${i?.nextNumber}`,
                )
              }
            >
              <ChevronRightIcon className="w-7 h-7 shrink-0 bg-black/70 backdrop-blur-sm p-1.5 rounded-full text-white hover:text-action hover:scale-105 transition-all duration-200" />
              <span className="absolute right-9 whitespace-nowrap font-karla bg-secondary shadow-2xl shadow-black py-1 px-2 text-white text-xs rounded-md opacity-0 translate-x-2 group-hover/next:opacity-100 group-hover/next:translate-x-0 transition-all duration-200">
                {t("home.playNext")}
              </span>
            </button>
          )}
        </div>

        <Link href={watchHref} className="block w-full h-full group/thumb">
          {/* Gradient scrim */}
          <div className="absolute inset-0 z-20 bg-gradient-to-t from-black/80 via-black/10 to-transparent group-hover/thumb:from-black/60 transition-all duration-300" />

          {/* Status / remaining badge */}
          <div className="absolute top-2 left-2 z-30">
            {isDone ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-black/65 backdrop-blur-sm px-2 py-1 text-[11px] font-karla font-semibold text-emerald-400">
                ✓ {t("home.completed")}
              </span>
            ) : remainingMin > 0 ? (
              <span className="inline-flex items-center rounded-md bg-black/65 backdrop-blur-sm px-2 py-1 text-[11px] font-karla font-semibold text-white/90">
                {t("home.minutesShort", { count: remainingMin })}
              </span>
            ) : null}
          </div>

          {/* Centered play-on-hover */}
          <div className="absolute inset-0 z-30 grid place-items-center opacity-0 group-hover/thumb:opacity-100 transition-opacity duration-200">
            <div className="w-12 h-12 rounded-full bg-action/90 grid place-items-center shadow-lg">
              <PlayIcon className="w-6 h-6 text-white translate-x-0.5" />
            </div>
          </div>

          {/* Episode title bottom-left */}
          <div className="absolute bottom-2.5 left-3 right-3 z-30 flex items-center gap-2">
            <h1
              className="font-semibold text-sm font-karla text-white line-clamp-1"
              title={i?.title || i.anititle}
            >
              {i?.title || i.anititle || `${t("common.episode")} ${i.episode}`}
            </h1>
          </div>

          {/* Progress bar */}
          <span
            className="absolute bottom-0 left-0 h-[3px] z-30 rounded-r-full"
            style={{ width: `${prog}%`, background: "var(--brand-primary, #E94560)" }}
          />

          {(i?.image || i?.cover) && (
            <Image
              src={i?.image || i?.cover}
              width={320}
              height={180}
              alt={i?.aniTitle || "Episode thumbnail"}
              className="absolute inset-0 h-full w-full object-cover z-10 group-hover/thumb:scale-[1.04] transition-transform duration-500"
            />
          )}
        </Link>
      </div>

      {/* Meta row under the card */}
      <div className="flex items-start justify-between gap-2">
        <Link href={watchHref} className="min-w-0 flex-1 font-karla">
          <p
            className="text-white text-sm font-medium truncate"
            title={i.aniTitle}
          >
            {i.aniTitle}
          </p>
          <p className="text-gray-400 text-xs mt-0.5">
            {t("common.episode")} {i.episode}
          </p>
        </Link>
        <Link
          href={watchHref}
          className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-white/5 hover:bg-action/15 border border-white/10 hover:border-action/40 px-2.5 py-1.5 text-xs font-karla font-semibold text-gray-200 hover:text-action transition-colors"
        >
          <PlayIcon className="w-3.5 h-3.5" />
          {t("home.resume")}
        </Link>
      </div>
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

// Sum of watched seconds → a compact "Xh Ym" / "Ym" label.
function formatWatchTime(totalSeconds, t) {
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return t("home.minutesShort", { count: mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0
    ? `${t("home.hoursShort", { count: h })} ${t("home.minutesShort", { count: m })}`
    : t("home.hoursShort", { count: h });
}

// Bucket rows into Today / Yesterday / Earlier-this-week / month / older,
// using each row's createdDate. Rows without a usable date land in "Older"
// so they still show. Returns an ordered array of non-empty groups.
function groupByRecency(rows, t) {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const dayMs = 86400000;

  const buckets = {
    today: { key: "today", label: t("home.groupToday"), items: [] },
    yesterday: { key: "yesterday", label: t("home.groupYesterday"), items: [] },
    week: { key: "week", label: t("home.groupThisWeek"), items: [] },
    month: { key: "month", label: t("home.groupThisMonth"), items: [] },
    older: { key: "older", label: t("home.groupOlder"), items: [] },
  };

  for (const i of rows) {
    const ts = new Date(i?.createdDate || i?.createdAt || 0).getTime();
    if (!ts || Number.isNaN(ts)) {
      buckets.older.items.push(i);
      continue;
    }
    if (ts >= startOfToday) buckets.today.items.push(i);
    else if (ts >= startOfToday - dayMs) buckets.yesterday.items.push(i);
    else if (ts >= startOfToday - 7 * dayMs) buckets.week.items.push(i);
    else if (ts >= startOfToday - 31 * dayMs) buckets.month.items.push(i);
    else buckets.older.items.push(i);
  }

  return [
    buckets.today,
    buckets.yesterday,
    buckets.week,
    buckets.month,
    buckets.older,
  ].filter((b) => b.items.length > 0);
}
