import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Footer from "@/components/shared/footer";
import QueueSection from "@/components/list/QueueSection";
import ProfileHero, { heroStats, type HeroBanner } from "@/components/profile/ProfileHero";
import ProfileList from "@/components/profile/ProfileList";
import BannerPicker, { type PickerAnime } from "@/components/profile/BannerPicker";

import { useLocalList } from "@/lib/list/localList";
import { useStreak } from "@/lib/stats/streak";
import { useGuestIdentity, guestTag } from "@/lib/prefs/guestIdentity";
import { entriesFromLocalEntries, statsFromEntries } from "@/lib/profile/sources";
import { rankCandidates } from "@/lib/profile/favorite";
import {
  candidatesOf,
  readPinnedBanner,
  useProfileBanner,
  writePinnedBanner,
  type ResolvedBanner,
} from "@/lib/profile/useProfileBanner";
import type { BannerOption } from "@/lib/profile/types";

/**
 * The signed-out visitor's own page — the profile shell, driven by a list that
 * only exists in this browser.
 *
 * It is not called a profile, and it has no shareable URL: a guest has no row in
 * the accounts database, so there is nothing anyone else could open. It lives at
 * /en/my-list. But it is the SAME component tree as a real profile (hero, plate,
 * favourite-anime banner, stats, grouped list), because "signed out" should mean
 * a different source of data, not a lesser page.
 */
export default function LocalProfile() {
  const { t } = useTranslation();
  const identity = useGuestIdentity();
  const raw = useLocalList();
  const { current: streak, best: bestStreak } = useStreak();
  const [picker, setPicker] = useState(false);
  const [pinned, setPinned] = useState<ResolvedBanner | null>(null);

  useEffect(() => setPinned(readPinnedBanner()), []);

  const entries = useMemo(() => entriesFromLocalEntries(raw), [raw]);
  const stats = useMemo(() => statsFromEntries(entries), [entries]);
  const auto = useProfileBanner(entries);
  const banner: HeroBanner = pinned ?? auto ?? { url: null, animeId: null, title: null };

  const topAnimes: PickerAnime[] = useMemo(
    () =>
      rankCandidates(candidatesOf(entries))
        .slice(0, 12)
        .map((c) => {
          const e = entries.find((x) => x.mediaId === c.mediaId)!;
          return {
            mediaId: c.mediaId,
            title: e.title?.english || e.title?.romaji || `#${c.mediaId}`,
            cover: e.cover ?? null,
          };
        }),
    [entries],
  );

  function pick(
    choice:
      | { url: string; animeId: number; title: string; source: BannerOption["source"] }
      | null,
  ) {
    const next: ResolvedBanner | null = choice
      ? { url: choice.url, animeId: choice.animeId, title: choice.title, source: choice.source }
      : null;
    setPinned(next);
    writePinnedBanner(next);
    setPicker(false);
  }

  // Null until the effect has read localStorage: the generated guest name must
  // not be part of the first render, or hydration mismatches.
  const name = identity ? `${t("auth.guestWord")}#${guestTag(identity)}` : "";

  return (
    <>
      <ProfileHero
        name={name || t("nav.myList")}
        tag={identity ? guestTag(identity) : null}
        avatar={null}
        banner={banner}
        stats={heroStats(t, stats)}
        isOwner
        onEditBanner={() => setPicker(true)}
        subtitle={t("profile.localOnly")}
      />

      {/* relative z-10 + veil: see the note in profile/[user].tsx. */}
      <div className="as-fade-in relative z-10 as-page-under">
        <div className="mx-auto w-full max-w-screen-lg px-4 pb-16 pt-10">
          {streak > 0 ? (
            <div
              className="mb-6 inline-flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2 ring-1 ring-white/10"
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
          ) : null}

          <QueueSection />

          <ProfileList
            entries={entries}
            emptyAction={
              <Link
                href="/en/search/anime"
                className="rounded-lg px-4 py-2 text-sm ring-1 ring-action hover:bg-action/10"
              >
                {t("profile.startWatching")}
              </Link>
            }
          />

          <p className="mt-8 text-xs text-white/40">
            {t("myList.localDesc")}{" "}
            <Link href="/en/settings" className="text-action hover:underline">
              {t("myList.manageInSettings")}
            </Link>
          </p>
        </div>
      </div>

      <div className="relative z-10 as-page-under">
        <Footer />
      </div>

      <BannerPicker
        open={picker}
        onClose={() => setPicker(false)}
        animes={topAnimes}
        current={banner.url}
        pinned={!!pinned}
        onPick={(c) => pick(c)}
        onReset={() => pick(null)}
      />
    </>
  );
}
