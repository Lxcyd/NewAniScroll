import Head from "next/head";
import Link from "next/link";
import Image from "next/image";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import { useTranslation } from "react-i18next";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { listLabel, STATUS_TO_LIST, LIST_COLORS } from "@/components/anime/v2/helpers";
import { useLocalList, LocalEntry } from "@/lib/list/localList";
import { useStreak } from "@/lib/stats/streak";
import QueueSection from "@/components/list/QueueSection";

/**
 * Local "My List" — the full list experience for users who aren't signed in to
 * AniList. Reads the localStorage-backed list (lib/list/localList.ts) live and
 * groups it by status, mirroring the AniList profile page's grouped table. All
 * client-side; the list is built by the sync engine on episode finish and by
 * the import/export tools in Settings.
 */

const STATUS_ORDER = [
  "CURRENT",
  "REPEATING",
  "COMPLETED",
  "PAUSED",
  "PLANNING",
  "DROPPED",
] as const;

export default function MyListLocal() {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const entries = useLocalList();
  const { current: streak, best: bestStreak } = useStreak();
  const [filter, setFilter] = useState<string>("all");

  // Group entries by status. Entries without a status land in a fallback bucket.
  const groups = useMemo(() => {
    const byStatus: Record<string, LocalEntry[]> = {};
    for (const e of entries) {
      const key = e.status || "PLANNING";
      (byStatus[key] ||= []).push(e);
    }
    return STATUS_ORDER.map((s) => ({ status: s, entries: byStatus[s] || [] })).filter(
      (g) => g.entries.length > 0,
    );
  }, [entries]);

  const visibleGroups =
    filter === "all" ? groups : groups.filter((g) => g.status === filter);

  return (
    <>
      <Head>
        <title>{t("nav.myList")} • AniScroll</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>
      <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="min-h-screen w-full max-w-screen-lg mx-auto px-4 pt-28 pb-16"
      >
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold mb-1">{t("nav.myList")}</h1>
            <p className="text-white/50 text-sm">
              {t("myList.localDesc")}{" "}
              <Link href="/en/settings" className="text-action hover:underline">
                {t("myList.manageInSettings")}
              </Link>
            </p>
          </div>
          {streak > 0 && (
            <div
              className="shrink-0 flex items-center gap-2 rounded-xl bg-white/5 ring-1 ring-white/10 px-3 py-2"
              title={t("myList.bestStreak", { count: bestStreak })}
            >
              <span className="text-xl leading-none">🔥</span>
              <div className="leading-tight">
                <div className="text-lg font-bold">{streak}</div>
                <div className="text-[10px] uppercase tracking-wide text-white/50">
                  {t("myList.streakDays", { count: streak })}
                </div>
              </div>
            </div>
          )}
        </div>


        {/* Watch-next queue — manual, ordered, independent of list status. */}
        <QueueSection />

        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-5 py-20 text-center">
            <p className="font-bold text-lg">{t("myList.empty")}</p>
            <Link
              href="/en/search/anime"
              className="px-4 py-2 rounded-lg ring-1 ring-action text-sm hover:bg-action/10"
            >
              {t("profile.startWatching")}
            </Link>
          </div>
        ) : (
          <>
            {/* Status filter chips */}
            <div className="flex flex-wrap gap-2 mb-8">
              <button
                onClick={() => setFilter("all")}
                className={`px-3 py-1.5 rounded-full text-sm ${
                  filter === "all" ? "bg-action text-white" : "bg-white/5 text-white/70"
                }`}
              >
                {t("profile.showAll")} ({entries.length})
              </button>
              {groups.map((g) => {
                const label = STATUS_TO_LIST[g.status] || g.status;
                return (
                  <button
                    key={g.status}
                    onClick={() => setFilter(g.status)}
                    className={`px-3 py-1.5 rounded-full text-sm ${
                      filter === g.status
                        ? "bg-action text-white"
                        : "bg-white/5 text-white/70"
                    }`}
                  >
                    {listLabel(t, label)} ({g.entries.length})
                  </button>
                );
              })}
            </div>

            <div className="grid gap-10">
              {visibleGroups.map((g) => {
                const label = STATUS_TO_LIST[g.status] || g.status;
                const color = LIST_COLORS[label] || "#6b7280";
                return (
                  <section key={g.status}>
                    <h2 className="flex items-center gap-2 font-bold text-lg mb-3">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ background: color }}
                      />
                      {listLabel(t, label)}
                    </h2>
                    <div className="overflow-hidden rounded-lg bg-white/[0.03] ring-1 ring-white/5">
                      {g.entries.map((e) => (
                        <Link
                          key={e.mediaId}
                          href={`/en/anime/${e.mediaId}`}
                          className="flex items-center gap-3 px-3 py-2 hover:bg-action/10 transition-colors"
                        >
                          {e.coverImage ? (
                            <Image
                              src={e.coverImage}
                              alt=""
                              width={40}
                              height={40}
                              className="w-10 h-10 rounded-md object-cover shrink-0"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-md bg-white/10 shrink-0" />
                          )}
                          <span className="flex-1 min-w-0 text-sm font-medium truncate">
                            {pickTitle(e.title, titlePref)}
                          </span>
                          {e.score ? (
                            <span className="text-xs text-white/60 w-10 text-center shrink-0">
                              ★ {e.score}
                            </span>
                          ) : (
                            <span className="w-10 shrink-0" />
                          )}
                          <span className="text-xs text-white/60 w-16 text-right shrink-0">
                            {e.total ? `${e.progress}/${e.total}` : e.progress}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </motion.div>
      <Footer />
    </>
  );
}
