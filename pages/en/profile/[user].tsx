import Head from "next/head";
import Link from "next/link";
import { useState } from "react";
import { SparklesIcon } from "@heroicons/react/24/solid";
import { useTranslation } from "react-i18next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../api/auth/[...nextauth]";

import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import QueueSection from "@/components/list/QueueSection";
import ForYouPanel from "@/components/discover/ForYouPanel";
import ProfileHero, { heroStats, type HeroBanner } from "@/components/profile/ProfileHero";
import ProfileList from "@/components/profile/ProfileList";
import BannerPicker, { type PickerAnime } from "@/components/profile/BannerPicker";

import { getUser } from "@/prisma/user";
import { findByTag } from "@/lib/auth/users";
import { pickAvatar } from "@/lib/auth/avatar";
import { getAllData } from "@/lib/auth/userData";
import {
  entriesFromAniList,
  entriesFromLocalList,
  localListFromCloudPayload,
  statsFromEntries,
} from "@/lib/profile/sources";
import { bannerCandidates, rankCandidates } from "@/lib/profile/favorite";
import { resolveFavoriteBanner, type KnownArt } from "@/lib/profile/resolve";
import type { ProfileEntry, ProfileIdentity, ProfileStats } from "@/lib/profile/types";

/**
 * A profile — the same page whether the account is AniList, AniScroll, or both.
 *
 * The URL carries `Pseudo-TAG`, the tag being the only unique half of an
 * identity. What the list is READ from depends on the account:
 *   - linked to AniList → AniList's MediaListCollection, the richer source;
 *   - AniScroll only    → the cloud backup of that account's local list.
 * Both are normalised to ProfileEntry[] before they reach a component, which is
 * what keeps the two looking identical.
 *
 * A signed-out visitor has no account and therefore no public profile: their
 * list only exists on their own device, so it lives at /en/profile/me.
 */

/** What the picker hands back and what gets stored on the account. */
type PinnedChoice = {
  url: string;
  animeId: number;
  title: string;
  source: NonNullable<HeroBanner["source"]>;
};

type Props = {
  identity: ProfileIdentity;
  stats: ProfileStats;
  entries: ProfileEntry[];
  banner: HeroBanner;
  /** Titles offered by the banner picker, favourite first. */
  topAnimes: PickerAnime[];
  /** The banner is a manual pick rather than the automatic one. */
  pinned: boolean;
  isOwner: boolean;
  /** Set when the profile is private and the viewer isn't its owner. */
  isPrivate?: boolean;
  viewedName?: string;
};

export default function Profile({
  identity,
  stats,
  entries,
  banner: initialBanner,
  topAnimes,
  pinned: initialPinned,
  isOwner,
  isPrivate,
  viewedName,
}: Props) {
  const { t } = useTranslation();
  const [banner, setBanner] = useState<HeroBanner>(initialBanner ?? { url: null, animeId: null, title: null });
  const [pinned, setPinned] = useState(!!initialPinned);
  const [picker, setPicker] = useState(false);
  const [showForYou, setShowForYou] = useState(false);

  if (isPrivate) {
    return (
      <>
        <Head>
          <title>{viewedName ? `${viewedName} • AniScroll` : "AniScroll"}</title>
        </Head>
        <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />
        <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
          <div className="mb-5 rounded-2xl bg-white/5 p-5 ring-1 ring-white/10">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-10 w-10 text-white/50"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
              />
            </svg>
          </div>
          <h1 className="mb-2 text-2xl font-bold">{t("profile.privateTitle")}</h1>
          <p className="max-w-sm text-white/60">{t("profile.privateBody")}</p>
        </div>
      </>
    );
  }

  /** Pin a banner on the account, or drop the pin and go back to automatic. */
  async function save(choice: PinnedChoice | null) {
    if (choice) {
      setBanner({
        url: choice.url,
        animeId: choice.animeId,
        title: choice.title,
        source: choice.source,
      });
      setPinned(true);
    } else {
      setBanner(initialBanner);
      setPinned(false);
    }
    try {
      await fetch("/api/v2/account/profile-banner", {
        method: choice ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: choice ? JSON.stringify(choice) : undefined,
      });
    } catch {
      /* the plate is already swapped locally; a failed write just isn't kept */
    }
  }

  return (
    <>
      <Head>
        <title>{identity.name} • AniScroll</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>

      <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />

      <ProfileHero
        name={identity.name}
        tag={identity.tag}
        avatar={identity.avatar}
        anilistName={identity.anilistName}
        createdAt={identity.createdAt}
        banner={banner}
        stats={heroStats(t, stats)}
        isOwner={isOwner}
        onEditBanner={() => setPicker(true)}
      />

      {/* relative z-10 + opaque: the plate an illustration is worn on is a
          z-0 layer (html carries its own colour, so it cannot go negative),
          and a static block would be painted under it. The background meets
          the plate's scrim where the scrim is already solid — no seam. */}
      <div className="as-fade-in relative z-10 bg-primary">
        <div className="mx-auto w-full max-w-screen-lg px-4 pb-16 pt-10">
        {isOwner && (
          <div className="mb-6">
            <button
              type="button"
              onClick={() => setShowForYou(true)}
              className="inline-flex items-center gap-2 rounded-full bg-action px-5 py-2.5 font-karla text-sm font-bold text-white shadow-glow transition-transform hover:scale-105"
            >
              <SparklesIcon className="h-5 w-5" />
              {t("recommend.title")}
            </button>
          </div>
        )}

        {isOwner && <QueueSection />}

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

      {isOwner && (
        <>
          <ForYouPanel isVisible={showForYou} onClose={() => setShowForYou(false)} />
          <BannerPicker
            open={picker}
            onClose={() => setPicker(false)}
            animes={topAnimes}
            current={banner.url}
            pinned={pinned}
            onPick={(c) => {
              void save(c);
              setPicker(false);
            }}
            onReset={() => {
              void save(null);
              setPicker(false);
            }}
          />
        </>
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────
   Server
   ──────────────────────────────────────────────────────────────── */

const ANILIST_QUERY = `
  query ($username: String) {
    MediaListCollection(userName: $username, type: ANIME, sort: SCORE_DESC) {
      user {
        id
        name
        createdAt
        avatar { large }
        bannerImage
        statistics { anime { count episodesWatched meanScore minutesWatched } }
        favourites { anime(perPage: 50) { nodes { id } } }
      }
      lists {
        status
        name
        entries {
          mediaId
          status
          progress
          repeat
          score(format: POINT_10_DECIMAL)
          media {
            id
            title { english romaji native userPreferred }
            episodes
            meanScore
            bannerImage
            coverImage { large extraLarge }
          }
        }
      }
    }
  }
`;

async function fetchAniList(username: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch("https://graphql.anilist.co/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { username } }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.MediaListCollection ?? null;
  } catch {
    return null;
  }
}

export async function getServerSideProps(context: any) {
  const segment = String(context.query.user || "");

  /* The tag is the identity; the pseudo in front of it is decoration. A
     segment with no tag (or an unknown one) is taken as an AniList username,
     which is what every link minted before accounts existed looks like. */
  const match = /^(.*)-([0-9A-Za-z]{6})$/.exec(segment);
  const account = match ? await findByTag(match[2]).catch(() => null) : null;
  const anilistName = account ? account.anilistName : segment;

  const session = (await getServerSession(
    context.req,
    context.res,
    authOptions,
  ).catch(() => null)) as any;

  const isOwner = account
    ? session?.user?.uid === account.id
    : !!session?.user?.name &&
      String(session.user.name).toLowerCase() === String(anilistName).toLowerCase();

  const collection = anilistName ? await fetchAniList(anilistName) : null;
  if (!account && !collection?.user) return { notFound: true };

  /* Visibility. The setting lives in the legacy Prisma profile, keyed by the
     name the account signs in with. */
  const settingsKey = anilistName || account?.username || null;
  const viewed = settingsKey ? await getUser(settingsKey, false).catch(() => null) : null;
  if (viewed?.setting?.private === true && !isOwner) {
    return {
      props: {
        isPrivate: true,
        viewedName: account?.username || anilistName || segment,
      },
    };
  }

  /* ── The list ───────────────────────────────────────────────── */
  const known = new Map<number, KnownArt>();
  let entries: ProfileEntry[];
  let stats: ProfileStats;

  if (collection?.user) {
    const favIds = new Set<number>(
      (collection.user.favourites?.anime?.nodes || []).map((n: any) => n.id),
    );
    entries = entriesFromAniList(collection.lists, favIds);
    // The banner and mean score of every entry arrived with the query — keep
    // them here rather than in the props, so the chain below needs no extra
    // request and the payload stays the size of the list itself.
    for (const list of collection.lists || []) {
      for (const e of list?.entries || []) {
        const m = e.media;
        if (!m?.id || known.has(m.id)) continue;
        known.set(m.id, {
          id: m.id,
          title: m.title?.english || m.title?.romaji || m.title?.native || null,
          bannerImage: m.bannerImage ?? null,
          coverImage: m.coverImage?.extraLarge || m.coverImage?.large || null,
          meanScore: m.meanScore ?? null,
        });
      }
    }
    const anime = collection.user.statistics?.anime;
    stats = {
      count: anime?.count ?? entries.length,
      episodes: anime?.episodesWatched ?? 0,
      minutes: anime?.minutesWatched ?? null,
      // AniList's meanScore is /100 whatever the user's own scoring format;
      // the entries are POINT_10_DECIMAL, so bring it onto the same scale.
      meanScore: anime?.meanScore ? Math.round(anime.meanScore) / 10 : null,
    };
  } else {
    // AniScroll-only account: its list is the cloud backup of the local one.
    const data = account ? await getAllData(account.id).catch(() => []) : [];
    const payload = data.find((d) => d.kind === "list")?.payload;
    entries = entriesFromLocalList(localListFromCloudPayload(payload));
    stats = statsFromEntries(entries);
  }

  /* ── The plate ──────────────────────────────────────────────── */
  let pinnedBanner: {
    url: string;
    animeId: number | null;
    title: string | null;
    source?: HeroBanner["source"];
  } | null = null;
  if (account?.profileBanner) {
    try {
      const parsed = JSON.parse(account.profileBanner);
      if (parsed?.url) pinnedBanner = parsed;
    } catch {
      /* a value we can't read is the same as none */
    }
  }

  const meanScoreOf = (id: number) => known.get(id)?.meanScore ?? null;
  const resolved = pinnedBanner
    ? null
    : await resolveFavoriteBanner(bannerCandidates(entries, meanScoreOf), known);

  /* An AniList account brings its own banner. It is the plate only when there
     is no list to draw one from — an anime the viewer actually rated says more
     about them than the picture they set once — and the safety net when the
     favourite anime turns out to have no wide artwork anywhere. */
  const ownBanner: string | null = collection?.user?.bannerImage || null;

  const banner: HeroBanner = pinnedBanner
    ? {
        url: pinnedBanner.url,
        animeId: pinnedBanner.animeId ?? null,
        title: pinnedBanner.title ?? null,
      }
    : resolved?.banner.url
      ? {
          url: resolved.banner.url,
          animeId: resolved.banner.animeId,
          title: resolved.banner.title,
          source: resolved.banner.source,
          fallback: !!resolved.banner.fallback,
        }
      : { url: ownBanner, animeId: null, title: null, source: "anilist" };

  /* What the picker may offer. Only the owner ever opens it, so it is only
     computed — and only shipped — for them. */
  const topAnimes: PickerAnime[] = isOwner
    ? rankCandidates(bannerCandidates(entries, meanScoreOf))
        .slice(0, 12)
        .map((c) => {
          const entry = entries.find((e) => e.mediaId === c.mediaId)!;
          return {
            mediaId: c.mediaId,
            title:
              entry.title?.english ||
              entry.title?.romaji ||
              known.get(c.mediaId)?.title ||
              `#${c.mediaId}`,
            cover: entry.cover ?? null,
          };
        })
    : [];

  const identity: ProfileIdentity = {
    name:
      collection?.user?.name || account?.username || anilistName || segment,
    tag: account?.tag ?? null,
    avatar: account
      ? pickAvatar(account) || collection?.user?.avatar?.large || null
      : collection?.user?.avatar?.large || null,
    anilistName: collection?.user?.name ?? null,
    createdAt: account?.createdAt ?? (collection?.user?.createdAt ? collection.user.createdAt * 1000 : null),
  };

  return {
    props: {
      identity,
      stats,
      entries,
      banner,
      topAnimes,
      pinned: !!pinnedBanner,
      isOwner,
    },
  };
}
