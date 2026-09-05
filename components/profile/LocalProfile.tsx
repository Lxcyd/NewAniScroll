import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Footer from "@/components/shared/footer";
import QueueSection from "@/components/list/QueueSection";
import ProfileHero, { heroStats, type HeroBanner } from "@/components/profile/ProfileHero";
import ProfileList, { type ListFocus } from "@/components/profile/ProfileList";
import ProfileTabs from "@/components/profile/ProfileTabs";
import ProfileOverview from "@/components/profile/ProfileOverview";
import ProfileStatsPanel from "@/components/profile/ProfileStats";
import BannerStudio, { type StudioAnime } from "@/components/profile/BannerStudio";

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
} from "@/lib/profile/useProfileBanner";
import type { Dressing } from "@/lib/profile/dressing";

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
  const [pinned, setPinned] = useState<Dressing | null>(null);
  const [tab, setTab] = useState("overview");
  /* Une note cliquee dans l'histogramme ouvre l'onglet de la liste, filtre
     dessus -- comme sur un vrai profil (cf. pages/en/profile/[user].tsx). Sans
     le defilement : cette page-ci n'a pas d'en-tete a rattraper. */
  const [listFocus, setListFocus] = useState<ListFocus | null>(null);

  useEffect(() => setPinned(readPinnedBanner()), []);

  const entries = useMemo(() => entriesFromLocalEntries(raw), [raw]);
  const stats = useMemo(() => statsFromEntries(entries), [entries]);
  const auto = useProfileBanner(entries);
  const banner: HeroBanner = pinned ?? auto ?? { url: null, animeId: null, title: null };

  /* Les douze meilleurs candidats à la bannière EN TÊTE, puis toute la liste.
     Le classement sert à choisir une illustration, et douze suffisent pour ça ;
     la recherche musique, elle, doit pouvoir atteindre n'importe quel titre de
     la liste, sans quoi chercher un anime au-delà des douze ne renvoie rien. */
  const topAnimes: StudioAnime[] = useMemo(() => {
    const classes = rankCandidates(candidatesOf(entries))
      .slice(0, 12)
      .map((c) => c.mediaId);
    const rang = new Map(classes.map((id, i) => [id, i]));
    return entries
      .slice()
      .sort(
        (a, b) =>
          (rang.get(a.mediaId) ?? Infinity) - (rang.get(b.mediaId) ?? Infinity),
      )
      .map((e) => ({
        mediaId: e.mediaId,
        title: e.title?.english || e.title?.romaji || `#${e.mediaId}`,
        cover: e.cover ?? null,
      }));
  }, [entries]);

  function pick(next: Dressing | null) {
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

      {/* relative z-10, and no veil over it: see the note in profile/[user].tsx. */}
      <div className="as-fade-in relative z-10">
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

          <div className="mb-6">
            <ProfileTabs
              tabs={[
                { key: "overview", label: t("profile.tabs.overview") },
                { key: "list", label: t("profile.tabs.list"), count: entries.length },
                { key: "stats", label: t("profile.tabs.stats") },
              ]}
              active={tab}
              onChange={setTab}
            />
          </div>

          {/* La même grille que sur un vrai profil : « déconnecté » doit
              changer la SOURCE des données, pas la page (cf. l'en-tête). Un
              visiteur sans compte est propriétaire de sa page, donc il peut la
              réorganiser — sa disposition vit sur l'appareil, et rejoindra le
              compte le jour où il en crée un (cf. lib/prefs/profileLayout.ts). */}
          {tab === "overview" ? (
            <ProfileOverview
              entries={entries}
              characters={[]}
              isOwner
              onPickScore={(score, completedOnly) => {
                setListFocus({ status: completedOnly ? "COMPLETED" : "all", score });
                setTab("list");
              }}
            />
          ) : null}

          {tab === "stats" ? <ProfileStatsPanel entries={entries} /> : null}

          {tab === "list" ? (
            <>
              <QueueSection />
              <ProfileList
                entries={entries}
                focus={listFocus}
                emptyAction={
                  <Link
                    href="/en/search/anime"
                    className="rounded-lg px-4 py-2 text-sm ring-1 ring-action hover:bg-action/10"
                  >
                    {t("profile.startWatching")}
                  </Link>
                }
              />
            </>
          ) : null}

          <p className="mt-8 text-xs text-white/40">
            {t("myList.localDesc")}{" "}
            <Link href="/en/settings" className="text-action hover:underline">
              {t("myList.manageInSettings")}
            </Link>
          </p>
        </div>
      </div>

      <div className="relative z-10">
        <Footer />
      </div>

      <BannerStudio
        open={picker}
        onClose={() => setPicker(false)}
        animes={topAnimes}
        value={pinned}
        auto={{
          url: auto?.url ?? null,
          source: auto?.source ?? null,
          title: auto?.title ?? null,
        }}
        identity={{ name: name || t("nav.myList"), avatar: null }}
        stats={heroStats(t, stats)}
        onApply={pick}
      />
    </>
  );
}
