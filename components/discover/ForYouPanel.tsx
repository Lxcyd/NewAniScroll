import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useSession } from "next-auth/react";
import {
  XMarkIcon,
  SparklesIcon,
  ArrowPathIcon,
  StarIcon,
  TvIcon,
  InformationCircleIcon,
  PlayIcon,
} from "@heroicons/react/24/solid";
import { getUserList } from "@/lib/anilist/userListCache";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useTranslatedText, prefetchTranslations } from "@/lib/i18n/useTranslatedText";
import type { Recommendation, RecommendMode } from "@/lib/recommend/types";
import type { ListEntry } from "@/lib/recommend/types";
import { reasonsToProse } from "./recReasons";
import styles from "./forYou.module.css";

type Props = {
  isVisible: boolean;
  onClose: () => void;
};

/** Build the minimal ListEntry[] the API needs from the cached AniList list. */
function toListEntries(map: Map<number, any>): ListEntry[] {
  return Array.from(map.values()).map((e) => ({
    mediaId: e.mediaId,
    status: e.status,
    score: e.score,
    progress: e.progress,
    repeat: e.repeat,
    startedAt: e.startedAt,
    completedAt: e.completedAt,
  }));
}

export default function ForYouPanel({ isVisible, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const { data: session }: any = useSession();
  const clickTarget = useClickTarget();

  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<RecommendMode>("all");
  const [loading, setLoading] = useState(false);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Regenerate state: every shown id (across batches) + the round counter, so
  // each "regenerate" asks the API for 10 fresh ones it hasn't returned before.
  const shownRef = useRef<number[]>([]);
  const roundRef = useRef(0);

  useEffect(() => setMounted(true), []);

  const load = useCallback(
    async (m: RecommendMode, regenerate = false) => {
      if (!session?.user?.name || !session?.user?.token) {
        setError("signin");
        return;
      }
      setLoading(true);
      setError(null);
      if (!regenerate) {
        // Fresh open / mode switch → reset the seen-history.
        shownRef.current = [];
        roundRef.current = 0;
      } else {
        roundRef.current += 1;
      }
      try {
        const listMap = await getUserList(session.user.name, session.user.token);
        const list = toListEntries(listMap);
        if (list.length === 0) {
          setError("empty");
          setRecs([]);
          return;
        }
        const res = await fetch("/api/v2/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            list,
            mode: m,
            exclude: shownRef.current,
            round: roundRef.current,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const batch: Recommendation[] = json?.recommendations || [];
        if (batch.length === 0) {
          // Nothing new left to show.
          setError(regenerate ? "noMore" : "none");
          if (!regenerate) setRecs([]);
          return;
        }
        shownRef.current = [...shownRef.current, ...batch.map((r) => r.anime.id)];
        // Warm the translation cache for every synopsis in the batch so each
        // card renders translated instantly (no English flash on reroll).
        prefetchTranslations(
          batch.map((r) => r.anime.description?.replace(/<[^>]+>/g, "")),
          i18n.language || "en",
        );
        setRecs(batch);
        setIdx(0);
      } catch (e) {
        console.error(e);
        setError("failed");
      } finally {
        setLoading(false);
      }
    },
    [session, i18n.language],
  );

  // Load on open (and when the mode toggles).
  useEffect(() => {
    if (isVisible) load(mode);
  }, [isVisible, mode, load]);

  const reroll = () => {
    setIdx((i) => Math.min(i + 1, recs.length - 1));
  };

  const regenerate = () => load(mode, true);

  // At the last card of the batch → offer regenerate instead of reroll.
  const atEnd = idx >= recs.length - 1;

  if (!isVisible || !mounted) return null;

  const current = recs[idx];

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.screen} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <SparklesIcon className="h-5 w-5 text-as-accent" />
            <span>{t("recommend.title")}</span>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Mode toggle */}
        <div className={styles.modeRow}>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === "all" ? styles.modeActive : ""}`}
            onClick={() => setMode("all")}
          >
            {t("recommend.modeAll")}
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === "planning" ? styles.modeActive : ""}`}
            onClick={() => setMode("planning")}
          >
            {t("recommend.modePlanning")}
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {loading && (
            <div className={styles.center}>
              <div className={styles.spinner} />
              <p className={styles.muted}>{t("recommend.analyzing")}</p>
            </div>
          )}

          {!loading && error && (
            <div className={styles.center}>
              <p className={styles.muted}>
                {error === "signin"
                  ? t("recommend.signInHint")
                  : error === "empty"
                  ? t("recommend.emptyList")
                  : error === "none"
                  ? t("recommend.noResults")
                  : error === "noMore"
                  ? t("recommend.noMore")
                  : t("recommend.failed")}
              </p>
              {error === "noMore" && (
                <button
                  type="button"
                  className={styles.rerollBtn}
                  onClick={() => {
                    // Start over from a clean slate.
                    shownRef.current = [];
                    roundRef.current = 0;
                    load(mode);
                  }}
                >
                  <ArrowPathIcon className="h-4 w-4" />
                  {t("recommend.startOver")}
                </button>
              )}
            </div>
          )}

          {!loading && !error && current && (
            <RecCard rec={current} clickTarget={clickTarget} onClose={onClose} />
          )}
        </div>

        {/* Footer */}
        {!loading && !error && recs.length > 0 && (
          <div className={styles.footer}>
            <span className={styles.counter}>
              {idx + 1} / {recs.length}
            </span>
            {atEnd ? (
              <button
                type="button"
                className={styles.regenBtn}
                onClick={regenerate}
              >
                <ArrowPathIcon className="h-4 w-4" />
                {t("recommend.regenerate")}
              </button>
            ) : (
              <button type="button" className={styles.rerollBtn} onClick={reroll}>
                <ArrowPathIcon className="h-4 w-4" />
                {t("recommend.another")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function RecCard({
  rec,
  clickTarget,
  onClose,
}: {
  rec: Recommendation;
  clickTarget: "info" | "watch";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const a = rec.anime;
  const title =
    a.title.english || a.title.romaji || a.title.userPreferred || a.title.native || "Anime";
  const cover = a.coverImage?.extraLarge || a.coverImage?.large || "";
  const banner = a.bannerImage || cover;
  const reasons = reasonsToProse(rec.reasons, t);
  const desc = useTranslatedText(
    a.description ? a.description.replace(/<[^>]+>/g, "") : "",
  );

  const fmtLabel = a.format
    ? a.format.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : null;
  const seasonLabel =
    a.season && a.seasonYear
      ? `${a.season.charAt(0)}${a.season.slice(1).toLowerCase()} ${a.seasonYear}`
      : a.seasonYear
      ? String(a.seasonYear)
      : null;
  const metaBits = [fmtLabel, seasonLabel, a.studios?.[0]].filter(Boolean) as string[];
  const topTags = (a.tags || [])
    .filter((x) => !x.isMediaSpoiler && x.rank >= 60)
    .slice(0, 5);

  return (
    <div className={styles.card}>
      {banner && (
        <div
          className={styles.cardBanner}
          style={{ backgroundImage: `url('${banner}')` }}
        />
      )}
      <div className={styles.cardInner}>
        {cover && (
          <div className={styles.poster}>
            <Image src={cover} alt={title} width={180} height={256} className={styles.posterImg} />
          </div>
        )}
        <div className={styles.cardInfo}>
          <h3 className={styles.cardTitle}>{title}</h3>

          {metaBits.length > 0 && (
            <div className={styles.metaLine}>
              {metaBits.map((b, i) => (
                <span key={b} className="inline-flex items-center gap-1.5">
                  {i > 0 && <span className={styles.metaDot}>•</span>}
                  {b}
                </span>
              ))}
            </div>
          )}

          <div className={styles.cardStats}>
            {a.averageScore != null && (
              <span className={styles.statScore}>
                <StarIcon className="h-3.5 w-3.5" /> {a.averageScore}
              </span>
            )}
            {a.episodes != null && (
              <span className={styles.statEp}>
                <TvIcon className="h-3.5 w-3.5" /> {a.episodes} EP
              </span>
            )}
            {a.genres?.slice(0, 3).map((g) => (
              <span key={g} className={styles.statGenre}>
                {g}
              </span>
            ))}
          </div>

          {/* Why this rec — the heart of the panel */}
          {reasons.length > 0 && (
            <ul className={styles.reasons}>
              {reasons.slice(0, 4).map((r, i) => (
                <li key={i} className={styles.reason}>
                  <SparklesIcon className="h-3 w-3 shrink-0 text-as-accent" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )}

          {topTags.length > 0 && (
            <div className={styles.tagRow}>
              {topTags.map((tg) => (
                <span key={tg.name} className={styles.tagChip}>
                  {tg.name}
                </span>
              ))}
            </div>
          )}

          {desc && <p className={styles.cardDesc}>{desc}</p>}

          <div className={styles.cardActions}>
            <Link
              href={`/en/anime/${a.id}`}
              onClick={onClose}
              className={styles.actionInfo}
            >
              <InformationCircleIcon className="h-4 w-4" />
              {t("discover.info")}
            </Link>
            <Link
              href={animeHref(a.id, clickTarget)}
              onClick={onClose}
              className={styles.actionWatch}
            >
              <PlayIcon className="h-4 w-4" />
              {t("discover.watch")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
