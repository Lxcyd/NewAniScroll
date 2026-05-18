import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import Hero from "./Hero";
import Tabs from "./Tabs";
import Recommendations from "./Recommendations";
import { FanartResponse, SeasonInfo } from "./helpers";
import styles from "./styles.module.css";

type Props = {
  info: AniListInfoTypes;
  /** Fanarts shipped inline from SSR (lib/db/fanarts.loadFanarts).
   *  Null when Turso is unavailable; the page degrades to AniList-only
   *  imagery in that case. */
  initialFanarts: FanartResponse | null;
  /** Pre-picked hero artwork (URL + kind) so the <img> renders in the
   *  initial HTML — no client fetch + JS pick before paint. */
  initialTitleImage: { url: string; kind: "clearart" | "logo" } | null;
  /** Season index/total resolved at SSR via PREQUEL/SEQUEL walking. */
  seasonInfo: SeasonInfo;
  statusLabel: string | null;
  fav: boolean;
  progress: number;
  watchUrl?: string;
  onOpenListEditor: () => void;
  onToggleFav: () => void;
};

export default function InfoPage({
  info,
  initialFanarts,
  initialTitleImage,
  seasonInfo,
  statusLabel,
  fav,
  progress,
  watchUrl,
  onOpenListEditor,
  onToggleFav,
}: Props) {
  const fanarts = initialFanarts;

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
        fav={fav}
        onOpenListEditor={onOpenListEditor}
        onToggleFav={onToggleFav}
        ratingRank={ratingRank}
        favRank={favRank}
      />

      <div
        style={{
          maxWidth: 1380,
          margin: "0 auto",
          padding: "0 28px 48px",
          display: "flex",
          flexDirection: "column",
          gap: 32,
        }}
      >
        <Tabs info={info} fanarts={fanarts} progress={progress} />
        {recs.length > 0 && (
          <Recommendations
            items={recs}
            forTitle={info.title.english || info.title.romaji || "this anime"}
          />
        )}
      </div>
    </div>
  );
}
