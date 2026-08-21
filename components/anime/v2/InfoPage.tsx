import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import Hero from "./Hero";
import Tabs from "./Tabs";
import Recommendations from "./Recommendations";
import { FanartsMeta, SeasonInfo, TitleImage } from "./helpers";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import type { FilmVariant } from "@/lib/anilist/resolveSeason";
import styles from "./styles.module.css";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useTranslation } from "react-i18next";

type Props = {
  info: AniListInfoTypes;
  /** Fanart COUNTS only. The rows are no longer serialised into the page —
   *  they were 24 KB of every HTML response for two tab bodies that only mount
   *  on click. useFanarts pulls them then. Null when Turso is unavailable; the
   *  page degrades to AniList-only imagery in that case. */
  fanartsMeta: FanartsMeta | null;
  /** Pre-picked hero artwork (URL + kind + cycle queue) so the <img>
   *  renders in the initial HTML and clicks can cycle through other
   *  clearart variants without a refetch. */
  initialTitleImage: TitleImage | null;
  /** Season index/total resolved at SSR via PREQUEL/SEQUEL walking. */
  seasonInfo: SeasonInfo;
  /** Ordered list of every season-like sibling, current included.
   *  Drives the season switcher in the Episodes tab. */
  seasonList: SeasonEntry[];
  /** Franchise bonus films (SIDE_STORY) for the separate Films dropdown. */
  bonusFilms?: FilmVariant[];
  statusLabel: string | null;
  /** False while a signed-in user's list status is still loading — Hero shows
   *  a loading placeholder instead of flashing "Add to list". */
  statusResolved?: boolean;
  fav: boolean;
  progress: number;
  watchUrl?: string;
  onOpenListEditor: () => void;
  onToggleFav: () => void;
};

export default function InfoPage({
  info,
  fanartsMeta,
  initialTitleImage,
  seasonInfo,
  seasonList,
  bonusFilms,
  statusLabel,
  statusResolved = true,
  fav,
  progress,
  watchUrl,
  onOpenListEditor,
  onToggleFav,
}: Props) {
  const titlePref = useTitlePref();
  const { t } = useTranslation();

  const ratingRank =
    info.rankings?.find((r) => r.type === "RATED" && r.allTime)?.rank ?? null;
  const favRank = null;

  const recs = (info.recommendations?.nodes || [])
    .map((n) => n.mediaRecommendation)
    .filter(Boolean) as NonNullable<
    NonNullable<typeof info.recommendations.nodes>[number]["mediaRecommendation"]
  >[];

  return (
    <div className={styles.root}>
      <Hero
        info={info}
        titleImage={initialTitleImage}
        seasonInfo={seasonInfo}
        watchUrl={watchUrl}
        statusLabel={statusLabel}
        statusResolved={statusResolved}
        fav={fav}
        onOpenListEditor={onOpenListEditor}
        onToggleFav={onToggleFav}
        ratingRank={ratingRank}
        favRank={favRank}
      />

      <div
        style={{
          // Voir `--page-w` dans styles.module.css : la largeur de la page,
          // definie une fois et lue ici comme dans le heros.
          maxWidth: "var(--page-w)",
          margin: "0 auto",
          padding: "0 28px 48px",
          display: "flex",
          flexDirection: "column",
          gap: 32,
        }}
      >
        <Tabs
          info={info}
          fanartsMeta={fanartsMeta}
          progress={progress}
          seasonList={seasonList}
          bonusFilms={bonusFilms}
        />
        {recs.length > 0 && (
          <Recommendations
            items={recs}
            forTitle={pickTitle(info.title, titlePref) || t("anime.thisAnime")}
          />
        )}
      </div>
    </div>
  );
}
