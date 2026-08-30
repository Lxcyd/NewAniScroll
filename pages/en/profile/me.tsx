import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";

import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import QueueSection from "@/components/list/QueueSection";
import ProfileHero, { heroStats, type HeroBanner } from "@/components/profile/ProfileHero";
import ProfileList from "@/components/profile/ProfileList";
import BannerPicker, { type PickerAnime } from "@/components/profile/BannerPicker";

import { useLocalList } from "@/lib/list/localList";
import { useGuestIdentity, guestTag } from "@/lib/prefs/guestIdentity";
import { entriesFromLocalEntries, statsFromEntries } from "@/lib/profile/sources";
import { rankCandidates } from "@/lib/profile/favorite";
import { profileHref } from "@/lib/profile/href";
import {
  candidatesOf,
  readPinnedBanner,
  useProfileBanner,
  writePinnedBanner,
  type ResolvedBanner,
} from "@/lib/profile/useProfileBanner";
import type { BannerOption } from "@/lib/profile/types";

/**
 * The profile of a signed-out visitor.
 *
 * It has its own route because it cannot have a URL anyone else could open: a
 * guest has no row in the accounts database, and the list being shown lives in
 * this browser's localStorage and is never uploaded. So everything here is
 * client-side, down to the banner (lib/profile/useProfileBanner.ts) — the page
 * renders the same shell as a public profile, from a source only this device
 * can read.
 *
 * Someone signed in has a real, shareable profile: they are sent to it.
 */
export default function MyOwnProfile() {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: session }: { data: any } = useSession();
  const identity = useGuestIdentity();
  const raw = useLocalList();
  const [picker, setPicker] = useState(false);
  const [pinned, setPinned] = useState<ResolvedBanner | null>(null);

  // A signed-in visitor owns a real, shareable profile — this page is not it.
  useEffect(() => {
    if (!session?.user) return;
    const target = profileHref(session.user);
    if (target !== "/en/profile/me") router.replace(target);
  }, [session, router]);

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
      ? {
          url: choice.url,
          animeId: choice.animeId,
          title: choice.title,
          source: choice.source,
        }
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
      <Head>
        <title>{t("profile.myProfile")} • AniScroll</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>

      <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />

      <ProfileHero
        name={name || t("profile.myProfile")}
        tag={identity ? guestTag(identity) : null}
        avatar={null}
        banner={banner}
        stats={heroStats(t, stats)}
        isOwner
        onEditBanner={() => setPicker(true)}
        subtitle={t("profile.localOnly")}
      />

      {/* relative z-10 + opaque: see the note in [user].tsx. */}
      <div className="as-fade-in relative z-10 bg-primary">
        <div className="mx-auto w-full max-w-screen-lg px-4 pb-16 pt-10">
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
        </div>
      </div>

      <div className="relative z-10 bg-primary">
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
