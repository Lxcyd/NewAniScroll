import Head from "next/head";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { useSession } from "next-auth/react";
import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import { useTranslation } from "react-i18next";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { listLabel, STATUS_TO_LIST, LIST_COLORS } from "@/components/anime/v2/helpers";
import { useLocalList, LocalEntry } from "@/lib/list/localList";
import { useStreak } from "@/lib/stats/streak";
import QueueSection from "@/components/list/QueueSection";
import LocalProfile from "@/components/profile/LocalProfile";
import { scoreBucket } from "@/lib/profile/insights";

/**
 * Local "My List" — the localStorage-backed list (lib/list/localList.ts), read
 * live and grouped by status. All client-side; the list is built by the sync
 * engine on episode finish and by the import/export tools in Settings.
 *
 * Signed OUT, this is also the visitor's own page, and it wears the full
 * profile shell (components/profile/LocalProfile.tsx): the same hero, the same
 * favourite-anime plate, the same stats as someone with an account. Not being
 * signed in changes where the list comes from, not what the page is worth.
 * Signed in, the account already has a real profile at its own URL, so this
 * stays the plain list it has always been.
 */

const STATUS_ORDER = [
  "CURRENT",
  "REPEATING",
  "COMPLETED",
  "PAUSED",
  "PLANNING",
  "DROPPED",
] as const;

export default function MyList() {
  const { data: session }: { data: any } = useSession();
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const entries = useLocalList();
  const clickTarget = useClickTarget();
  const { current: streak, best: bestStreak } = useStreak();
  const [filter, setFilter] = useState<string>("all");
  /**
   * LA NOTE SUR LAQUELLE LA PAGE EST OUVERTE, quand on y arrive depuis
   * l'histogramme du profil (`/en/my-list?score=8&list=COMPLETED`).
   *
   * Elle est dans l'URL et pas seulement dans l'état : c'est ce qui rend le lien
   * partageable, et surtout ce qui fait que le retour arrière du navigateur
   * ramène la liste entière plutôt que la même page sans son filtre.
   *
   * `router.isReady` est la condition qui compte : cette page n'a pas de rendu
   * serveur, donc `query` est vide à la première peinture et ne se remplit qu'à
   * l'hydratation. Lu trop tôt, le filtre n'existerait jamais.
   */
  const router = useRouter();
  const [score, setScore] = useState<number | null>(null);

  useEffect(() => {
    if (!router.isReady) return;
    const l = router.query.list;
    if (typeof l === "string" && l) setFilter(l.toUpperCase());
    const s = Number(router.query.score);
    setScore(Number.isFinite(s) && s > 0 && s <= 10 ? scoreBucket(s) : null);
  }, [router.isReady, router.query.list, router.query.score]);

  /** Le filtre de note s'enlève de l'URL, pas seulement de l'état. */
  function clearScore() {
    setScore(null);
    const { score: _drop, ...rest } = router.query;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, {
      shallow: true,
    });
  }

  /* Le filtre de note s'applique AVANT le groupement : les sections, les
     compteurs des pastilles et l'état vide décrivent alors tous la même
     sélection. Le palier est celui de l'histogramme (`scoreBucket`), donc un
     6,7 tombe ici dans la colonne où il était dessiné là-bas. */
  const shown = useMemo(
    () =>
      score == null
        ? entries
        : entries.filter((e) => e.score && scoreBucket(e.score) === score),
    [entries, score],
  );

  // Group entries by status. Entries without a status land in a fallback bucket.
  const groups = useMemo(() => {
    const byStatus: Record<string, LocalEntry[]> = {};
    for (const e of shown) {
      const key = e.status || "PLANNING";
      (byStatus[key] ||= []).push(e);
    }
    return STATUS_ORDER.map((s) => ({ status: s, entries: byStatus[s] || [] })).filter(
      (g) => g.entries.length > 0,
    );
  }, [shown]);

  const visibleGroups =
    filter === "all" ? groups : groups.filter((g) => g.status === filter);

  return (
    <>
      <Head>
        {/* Une seule expression : deux enfants texte se retrouvent séparés par
            un `<!-- -->` visible dans l'onglet (cf. pages/en/profile/[user]). */}
        <title>{`${t("nav.myList")} • AniScroll`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>
      <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />

      {!session?.user ? (
        <LocalProfile />
      ) : (
      <>
      <div className="as-fade-in min-h-screen w-full max-w-screen-lg mx-auto px-4 pt-28 pb-16">
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
              {/* LA NOTE EN COURS, EN PREMIÈRE PASTILLE ET DÉTACHABLE.
                  Arriver ici depuis l'histogramme du profil filtre la liste sans
                  qu'on l'ait demandé sur cette page : la pastille est ce qui le
                  DIT, et la croix ce qui le défait. Sans elle, une liste de six
                  titres passerait pour la liste entière. */}
              {score != null ? (
                <button
                  onClick={clearScore}
                  className="flex items-center gap-2 rounded-full bg-as-score/15 px-3 py-1.5 text-sm text-as-score ring-1 ring-as-score/40 transition-colors hover:bg-as-score/25"
                  title={t("myList.clearScore")}
                >
                  <span>★ {String(score).replace(".", ",")}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3 w-3">
                    <line x1="5" y1="5" x2="19" y2="19" />
                    <line x1="19" y1="5" x2="5" y2="19" />
                  </svg>
                </button>
              ) : null}
              <button
                onClick={() => setFilter("all")}
                className={`px-3 py-1.5 rounded-full text-sm ${
                  filter === "all" ? "bg-action text-white" : "bg-white/5 text-white/70"
                }`}
              >
                {t("profile.showAll")} ({shown.length})
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

            {/* Une liste bien remplie peut n'avoir aucun titre à CETTE note : le
                vide doit alors nommer son filtre, sinon il se lit comme une
                liste vide. */}
            {shown.length === 0 ? (
              <div className="flex flex-col items-center gap-4 py-16 text-center">
                <p className="text-white/60">
                  {t("myList.noneAtScore", { score: String(score).replace(".", ",") })}
                </p>
                <button
                  onClick={clearScore}
                  className="rounded-lg px-4 py-2 text-sm ring-1 ring-action hover:bg-action/10"
                >
                  {t("myList.clearScore")}
                </button>
              </div>
            ) : null}

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
                          href={animeHref(e.mediaId, clickTarget)}
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
      </div>
      <Footer />
      </>
      )}
    </>
  );
}
