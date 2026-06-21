import { useTranslation } from "react-i18next";
import { ArrowUturnLeftIcon, InformationCircleIcon, PlayIcon } from "@heroicons/react/24/solid";
import Link from "next/link";
import type { Status } from "@/lib/list/types";
import { useTranslatedText } from "@/lib/i18n/useTranslatedText";
import styles from "./scroll.module.css";
import {
  SwipeSettings,
  STATUS_COLOR,
  STATUS_ICON,
  STATUS_LABEL_KEY,
  featherGradient,
} from "@/lib/discover/swipeSettings";

export type ScrollAnime = {
  id: number;
  title?: { romaji?: string; english?: string; native?: string };
  coverImage?: { extraLarge?: string; large?: string; color?: string };
  bannerImage?: string | null;
  description?: string | null;
  genres?: string[];
  episodes?: number | null;
  averageScore?: number | null;
  seasonYear?: number | null;
  season?: string | null;
  status?: string | null;
  format?: string | null;
};

type Props = {
  anime: ScrollAnime;
  /** translateY offset in px (= (index - currentIndex) * cardHeight). */
  translateY: number;
  cardHeight: number;
  isActive: boolean;
  /** Adds/removes the CSS transition (off while dragging / on neighbour-enter). */
  transition: boolean;
  settings: SwipeSettings;
  /** Set when this anime was already swiped — shows an Undo badge. */
  swipedStatus?: Status;
  onUndo?: (anime: ScrollAnime) => void;
  onOpenDetails: (anime: ScrollAnime) => void;
};

function titleClass(title: string): string {
  if (title.length > 50) return styles.titleVeryLong;
  if (title.length > 30) return styles.titleLong;
  return "";
}

/** One swipe-hint pill (icon + status label), ported from Index.razor. */
function Hint({
  side,
  settings,
}: {
  side: "right" | "left";
  settings: SwipeSettings;
}) {
  const { t } = useTranslation();
  const status = side === "right" ? settings.rightStatus : settings.leftStatus;
  const color = STATUS_COLOR[status];
  return (
    <div
      data-hint={side}
      className={`${styles.swipeHint} ${
        side === "right" ? styles.swipeHintRight : styles.swipeHintLeft
      }`}
      style={{ color }}
    >
      <span
        // status glyph — markup ported verbatim from the reference repo
        dangerouslySetInnerHTML={{ __html: STATUS_ICON[status] }}
        style={{ display: "inline-flex" }}
      />
      <span>{t(`discover.status.${STATUS_LABEL_KEY[status]}`)}</span>
    </div>
  );
}

export default function ScrollCard({
  anime,
  translateY,
  cardHeight,
  isActive,
  transition,
  settings,
  swipedStatus,
  onUndo,
  onOpenDetails,
}: Props) {
  const { t } = useTranslation();
  const title =
    anime.title?.english || anime.title?.romaji || anime.title?.native || "Anime";
  const cover = anime.coverImage?.extraLarge || anime.coverImage?.large || "";
  const banner = anime.bannerImage || cover;
  const seasonLabel =
    anime.season && anime.seasonYear
      ? `${anime.season.charAt(0) + anime.season.slice(1).toLowerCase()} ${anime.seasonYear}`
      : anime.seasonYear
      ? String(anime.seasonYear)
      : "";
  const rawDescription = anime.description
    ? anime.description.replace(/<[^>]+>/g, "")
    : "";
  // Translate the AniList synopsis into the active UI language (cached + can be
  // prefetched ahead of time by the page so there's no English flash).
  const description = useTranslatedText(rawDescription);

  return (
    <div
      data-card
      data-active={isActive ? "true" : undefined}
      className={`${styles.card} ${isActive ? styles.active : ""} ${
        transition ? styles.withTransition : styles.noTransition
      }`}
      style={{ transform: `translateY(${translateY}px)`, height: `${cardHeight}px` }}
    >
      <div className={styles.bgImage} style={{ backgroundImage: `url('${banner}')` }} />
      <div className={styles.gradientOverlay} />

      {/* Swipe feathers (active card only) — gradient built from status colour */}
      {isActive && (
        <>
          <div
            data-feather="right"
            className={styles.swipeFeather}
            style={{ background: featherGradient(STATUS_COLOR[settings.rightStatus], true) }}
          />
          <div
            data-feather="left"
            className={styles.swipeFeather}
            style={{ background: featherGradient(STATUS_COLOR[settings.leftStatus], false) }}
          />
        </>
      )}

      {/* Undo badge — shown when scrolling back to an already-swiped card */}
      {swipedStatus && onUndo && (
        <button
          type="button"
          className={styles.undoBadge}
          onClick={() => onUndo(anime)}
          style={{
            color: STATUS_COLOR[swipedStatus],
            borderColor: `${STATUS_COLOR[swipedStatus]}80`,
          }}
        >
          <ArrowUturnLeftIcon style={{ width: 13, height: 13 }} />
          {t("discover.undoStatus", {
            status: t(`discover.status.${STATUS_LABEL_KEY[swipedStatus]}`),
          })}
        </button>
      )}

      <div className={styles.contentWrapper}>
        <div className={styles.imageSection}>
          {isActive && (
            <>
              <Hint side="right" settings={settings} />
              <Hint side="left" settings={settings} />
            </>
          )}

          <div
            data-poster
            className={styles.animeImage}
            style={{ backgroundImage: `url('${cover}')` }}
            onClick={() => onOpenDetails(anime)}
          />
        </div>

        <div className={styles.infoSection}>
          <h1
            className={`${styles.title} ${titleClass(title)}`}
            onClick={() => onOpenDetails(anime)}
          >
            {title}
          </h1>

          {seasonLabel && (
            <div className={styles.seasonInfo}>
              {anime.status === "RELEASING" && (
                <span className={`${styles.statusDot} ${styles.releasing}`} />
              )}
              {anime.status === "NOT_YET_RELEASED" && (
                <span className={`${styles.statusDot} ${styles.upcoming}`} />
              )}
              <span>{seasonLabel}</span>
            </div>
          )}

          {anime.genres?.length ? (
            <p className={styles.genres}>{anime.genres.slice(0, 4).join(" • ")}</p>
          ) : null}

          <div className={styles.stats}>
            {anime.averageScore != null && (
              <div className={`${styles.badge} ${styles.badgeScore}`}>
                ★ {anime.averageScore}
              </div>
            )}
            {anime.episodes != null && (
              <div className={`${styles.badge} ${styles.badgeEpisodes}`}>
                {anime.episodes} EP
              </div>
            )}
          </div>

          {description && (
            <div className={styles.descriptionContainer}>
              <p className={styles.descriptionPreview}>{description}</p>
            </div>
          )}

          {/* Action row: Info + Watch */}
          <div className={styles.actions}>
            <Link
              href={`/en/anime/${anime.id}`}
              className={styles.actionInfo}
              onClick={(e) => e.stopPropagation()}
            >
              <InformationCircleIcon style={{ width: 15, height: 15 }} />
              {t("discover.info")}
            </Link>
            <Link
              href={`/en/anime/watch/${anime.id}/megaplay?id=megaplay-${anime.id}-1&num=1&info=${anime.id}&info=megaplay`}
              className={styles.actionWatch}
              onClick={(e) => e.stopPropagation()}
            >
              <PlayIcon style={{ width: 15, height: 15 }} />
              {t("discover.watch")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
