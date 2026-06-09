/**
 * Mobile layout for the anime info page.
 *
 * Visual reference: the standalone mockup shipped as
 * `mobile.jsx + Anime Info Mobile.html`. We keep the same vocabulary
 * (MTopBar / MHero / MTabs / MOverview / MEpisodes / MCharacters /
 * MArtworks / MRecs) but wire every section to the real props the
 * desktop `InfoPage` already receives — no separate fetch / store.
 *
 * Components are dense by design — they're all single-purpose
 * presentational pieces with no shared state beyond the parent's
 * `tab` toggle. Splitting into per-file modules would just add
 * import noise.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import {
  FanartResponse,
  SeasonInfo,
  TitleImage,
  formatAiredRange,
  LIST_COLORS,
  prettyStatus as helpersPrettyStatus,
  prettyFormat,
  prettySource,
  prettySeason,
  stripHtml,
  compactNumber,
  statusLabel as statusLabelI18n,
  countryLabel,
  listLabel,
} from "../helpers";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { genreLabel } from "@/lib/i18n/genreLabel";
import { useTranslatedText } from "@/lib/i18n/useTranslatedText";
import { translateTag } from "@/lib/i18n/animeTags";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import CharactersTab from "../CharactersTab";
import Episodes from "../Episodes";
import Artworks from "../Artworks";
import ScoresTab from "../ScoresTab";
import Related from "../Related";

type Props = {
  info: AniListInfoTypes;
  initialFanarts: FanartResponse | null;
  initialTitleImage: TitleImage | null;
  seasonInfo: SeasonInfo;
  seasonList: SeasonEntry[];
  statusLabel: string | null;
  statusResolved?: boolean;
  fav: boolean;
  progress: number;
  watchUrl?: string;
  onOpenListEditor: () => void;
  onToggleFav: () => void;
};

type TabId = "overview" | "episodes" | "scores" | "characters" | "artworks";

export default function InfoPageMobile({
  info,
  initialFanarts,
  initialTitleImage,
  seasonInfo,
  seasonList,
  statusLabel,
  statusResolved = true,
  fav,
  progress,
  watchUrl,
  onOpenListEditor,
  onToggleFav,
}: Props) {
  const titlePref = useTitlePref();
  const title = pickTitle(info.title, titlePref) || "Anime";
  const [tab, setTab] = useState<TabId>("overview");
  const scrollRef = useRef<HTMLDivElement>(null);

  const charCount = (info.characters?.edges?.length as number | undefined) || 0;
  const epCount =
    info.episodes ||
    (info.nextAiringEpisode?.episode ? info.nextAiringEpisode.episode - 1 : 0);
  const artCount = initialFanarts?.total || 0;

  return (
    <div style={S.root}>
      {/* No mobile top bar here: the shared <Navbar> (z-[9999]) already
          renders the logo / nav / avatar across the top on this page, so a
          second sticky bar only poked its back button out from behind the
          navbar logo. The shared navbar's logo is the home affordance and
          the browser/OS provides back, so the redundant bar is dropped. */}
      <div ref={scrollRef} style={S.scroller}>
        <MHero
          info={info}
          title={title}
          titleImage={initialTitleImage}
          seasonInfo={seasonInfo}
          progress={progress}
          watchUrl={watchUrl}
          statusLabel={statusLabel}
          statusResolved={statusResolved}
          fav={fav}
          onOpenListEditor={onOpenListEditor}
          onToggleFav={onToggleFav}
        />
        <MTabs
          tab={tab}
          setTab={setTab}
          counts={{
            episodes: epCount,
            characters: charCount,
            artworks: artCount,
          }}
        />
        {tab === "overview" && <MOverview info={info} seasonList={seasonList} />}
        {tab === "episodes" && (
          <div style={S.tabBox}>
            <Episodes
              info={info}
              progress={progress}
              seasonList={seasonList}
            />
          </div>
        )}
        {tab === "scores" && (
          <div style={S.tabBox}>
            <ScoresTab info={info} seasonList={seasonList} />
          </div>
        )}
        {tab === "characters" && (
          <div style={S.tabBox}>
            <CharactersTab info={info} />
          </div>
        )}
        {tab === "artworks" && (
          <div style={S.tabBox}>
            <Artworks
              fanarts={initialFanarts}
              coverFallback={
                info.coverImage?.extraLarge ||
                info.coverImage?.large ||
                null
              }
              bannerFallback={info.bannerImage || null}
            />
          </div>
        )}
        <MRecs info={info} />
        <div style={{ height: 40 }} />
      </div>
    </div>
  );
}

/* ─── Hero ────────────────────────────────────────────────── */
function MHero({
  info,
  title,
  titleImage,
  seasonInfo,
  progress,
  watchUrl,
  statusLabel,
  statusResolved = true,
  fav,
  onOpenListEditor,
  onToggleFav,
}: {
  info: AniListInfoTypes;
  title: string;
  titleImage: TitleImage | null;
  seasonInfo: SeasonInfo;
  progress: number;
  watchUrl?: string;
  statusLabel: string | null;
  statusResolved?: boolean;
  fav: boolean;
  onOpenListEditor: () => void;
  onToggleFav: () => void;
}) {
  const { t } = useTranslation();
  const banner = info.bannerImage || info.coverImage?.extraLarge;
  const cover =
    info.coverImage?.extraLarge || info.coverImage?.large;
  const rating =
    typeof info.averageScore === "number" ? (info.averageScore / 10).toFixed(2) : "—";
  const ratingRank =
    info.rankings?.find((r) => r.type === "RATED" && r.allTime)?.rank ?? null;
  const favourites = (info as any).favourites as number | undefined;
  const genres = (info.genres || []).slice(0, 4);
  const studios = (info.studios?.edges || [])
    .filter((e: any) => e?.isMain)
    .map((e: any) => e.node?.name)
    .filter(Boolean)
    .slice(0, 2);
  const nextEp = progress + 1;
  const totalEp = info.episodes || info.nextAiringEpisode?.episode || 0;

  return (
    <section style={{ position: "relative" }}>
      <div style={{ position: "relative", height: 260, overflow: "hidden" }}>
        {banner && (
          <img
            src={banner}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center 30%",
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(10,11,16,0.15) 0%, rgba(10,11,16,0.45) 45%, rgba(10,11,16,0.85) 80%, #0a0b10 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 22,
            display: "flex",
            justifyContent: "center",
            padding: "0 24px",
          }}
        >
          {titleImage?.url ? (
            <img
              src={titleImage.url}
              alt={title}
              style={{
                maxHeight: 130,
                maxWidth: "80%",
                objectFit: "contain",
                filter: "drop-shadow(0 12px 32px rgba(0,0,0,0.75))",
              }}
            />
          ) : (
            <h1
              style={{
                fontFamily: "Outfit, sans-serif",
                fontSize: 28,
                fontWeight: 800,
                textAlign: "center",
                margin: 0,
                textShadow: "0 12px 32px rgba(0,0,0,0.75)",
              }}
            >
              {title}
            </h1>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ padding: "14px 16px 0" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <Stat
            top={
              <>
                <Star fill="#f6c544" />
                <span style={{ fontSize: 18, fontWeight: 700, color: "#f6c544" }}>{rating}</span>
                <span style={{ fontSize: 10.5, color: "#8a8fa3" }}>/10</span>
              </>
            }
            label={ratingRank ? `RATED #${ratingRank}` : "RATED"}
          />
          <Divider />
          <Stat
            top={
              <>
                <Heart fill="#ff3b5c" />
                <span style={{ fontSize: 17, fontWeight: 700 }}>
                  {compactNumber(favourites ?? null) || "—"}
                </span>
              </>
            }
            label="FAVOURITES"
          />
          <Divider />
          <Stat
            top={
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "relative", top: 1, color: "#c4c8d4" }}>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m10 9 5 3-5 3z" fill="currentColor" />
                </svg>
                <span style={{ fontSize: 16, fontWeight: 700 }}>
                  {totalEp || "?"}
                </span>
              </>
            }
            label={info.duration ? `EP · ${info.duration}min` : "EP"}
          />
        </div>

        {/* Chips — centred, with a soft fade on the right edge in case
            the row overflows so the user knows it's scrollable. */}
        <div
          className="hide-scroll"
          style={{
            display: "flex",
            justifyContent: "center",
            flexWrap: "wrap",
            gap: 5,
            overflowX: "auto",
            marginTop: 14,
          }}
        >
          {genres.map((g) => (
            <span key={g} style={S.chipPink}>
              {genreLabel(t, g)}
            </span>
          ))}
          {studios.length > 0 && genres.length > 0 && (
            <span
              style={{
                flexShrink: 0,
                width: 1,
                height: 14,
                background: "#2f3447",
                margin: "0 3px",
                alignSelf: "center",
              }}
            />
          )}
          {studios.map((s: string) => (
            <span key={s} style={S.chipBlue}>
              {s}
            </span>
          ))}
        </div>

        {/* Cover + actions */}
        <div
          style={{
            marginTop: 16,
            display: "flex",
            gap: 14,
            alignItems: "stretch",
          }}
        >
          <div
            style={{
              width: 120,
              flexShrink: 0,
              borderRadius: 11,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.1)",
              boxShadow: "0 18px 40px rgba(0,0,0,0.6)",
              aspectRatio: "3/4",
              background: "#1d2030",
            }}
          >
            {cover && (
              <img
                src={cover}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  display: "block",
                  objectFit: "cover",
                }}
              />
            )}
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {watchUrl && (
              <Link
                href={watchUrl}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 11,
                  background:
                    "linear-gradient(135deg, #ff3b5c 0%, #e8294b 100%)",
                  color: "white",
                  boxShadow:
                    "0 12px 30px -10px rgba(255,59,92,0.7), inset 0 1px 0 rgba(255,255,255,0.2)",
                  textDecoration: "none",
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.18)",
                    display: "grid",
                    placeItems: "center",
                    paddingLeft: 3,
                    flexShrink: 0,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                    <polygon points="5 3 19 12 5 21" />
                  </svg>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    minWidth: 0,
                    flex: 1,
                    gap: 2,
                  }}
                >
                  <div
                    style={{
                      fontSize: 9.5,
                      fontWeight: 700,
                      letterSpacing: "0.14em",
                      opacity: 0.9,
                    }}
                  >
                    {progress > 0 ? t("anime.resumeCta") : t("anime.watchNowCta")}
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {seasonInfo.number ? `S${seasonInfo.number} · ` : ""}EP{" "}
                    {String(nextEp).padStart(2, "0")}
                  </div>
                </div>
              </Link>
            )}
            <MActions
              statusLabel={statusLabel}
              statusResolved={statusResolved}
              fav={fav}
              onOpenListEditor={onOpenListEditor}
              onToggleFav={onToggleFav}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function MActions({
  statusLabel,
  statusResolved = true,
  fav,
  onOpenListEditor,
  onToggleFav,
}: {
  statusLabel: string | null;
  statusResolved?: boolean;
  fav: boolean;
  onOpenListEditor: () => void;
  onToggleFav: () => void;
}) {
  const { t } = useTranslation();
  // Keep the English label as the color key (LIST_COLORS), translate display.
  const label = statusLabel ? helpersPrettyStatus(statusLabel) : "Add to list";
  // Show a neutral placeholder while a signed-in user's status is still loading
  // so the button doesn't flash "Add to list" then flip to the real status.
  const labelDisplay = !statusResolved
    ? "…"
    : statusLabel
    ? statusLabelI18n(t, statusLabel)
    : t("list.addToList");
  const color = LIST_COLORS[label] || "#8a8fa3";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        onClick={onOpenListEditor}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 13px",
          background: `${color}1a`,
          border: `1px solid ${color}66`,
          borderRadius: 11,
          color,
          fontSize: 13,
          fontWeight: 600,
          minWidth: 0,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: color,
            boxShadow: `0 0 6px ${color}b3, 0 0 2px ${color}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            flex: 1,
            textAlign: "left",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {labelDisplay}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onToggleFav}
          aria-label={t("anime.favourite")}
          style={{
            width: 44,
            height: 44,
            display: "grid",
            placeItems: "center",
            borderRadius: 11,
            flexShrink: 0,
            background: fav
              ? "rgba(255,59,92,0.08)"
              : "rgba(255,255,255,0.04)",
            border: fav
              ? "1px solid rgba(255,59,92,0.3)"
              : "1px solid #2f3447",
            color: fav ? "#ff3b5c" : "#c4c8d4",
            transition:
              "background .25s ease, border-color .25s ease, color .25s ease",
          }}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill={fav ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            style={{
              // No pop animation — the favourite state is known up front, so
              // the heart appears instantly instead of animating on load.
              transition: "fill .2s ease",
            }}
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </button>
        <button
          onClick={() => {
            if (typeof navigator !== "undefined" && (navigator as any).share) {
              (navigator as any)
                .share({ title: document.title, url: location.href })
                .catch(() => {});
            } else if (typeof navigator !== "undefined" && navigator.clipboard) {
              navigator.clipboard.writeText(location.href);
            }
          }}
          style={{
            flex: 1,
            height: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            borderRadius: 11,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid #2f3447",
            color: "#f4f5f8",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          {t("anime.share")}
        </button>
      </div>
    </div>
  );
}

/* ─── Tabs ────────────────────────────────────────────────── */
function MTabs({
  tab,
  setTab,
  counts,
}: {
  tab: TabId;
  setTab: (next: TabId) => void;
  counts: { episodes: number; characters: number; artworks: number };
}) {
  const { t } = useTranslation();
  const tabs: Array<{ id: TabId; label: string; count?: number }> = [
    { id: "overview", label: t("anime.overview") },
    { id: "episodes", label: t("anime.episodes"), count: counts.episodes || undefined },
    { id: "scores", label: t("anime.scores") },
    {
      id: "characters",
      label: t("anime.characters"),
      count: counts.characters || undefined,
    },
    { id: "artworks", label: t("anime.artworks"), count: counts.artworks || undefined },
  ];
  return (
    <div
      className="hide-scroll"
      style={{
        display: "flex",
        gap: 4,
        padding: "0 16px",
        marginTop: 18,
        borderBottom: "1px solid #252938",
        overflowX: "auto",
      }}
    >
      {tabs.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "12px",
              fontSize: 13,
              fontWeight: 600,
              color: active ? "#f4f5f8" : "#8a8fa3",
              borderBottom: "2px solid",
              borderColor: active ? "#ff3b5c" : "transparent",
              marginBottom: -1,
              whiteSpace: "nowrap",
              background: "none",
              cursor: "pointer",
            }}
          >
            {t.label}
            {t.count != null && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: 4,
                  fontFamily: "ui-monospace, monospace",
                  background: active ? "rgba(255,59,92,0.12)" : "#1d2030",
                  color: active ? "#ff7a91" : "#5e6478",
                }}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Overview ────────────────────────────────────────────── */
function MOverview({
  info,
  seasonList,
}: {
  info: AniListInfoTypes;
  seasonList?: SeasonEntry[];
}) {
  const { t, i18n } = useTranslation();
  const [exp, setExp] = useState(false);
  const description = useTranslatedText(stripHtml(info.description || ""));
  const aired = formatAiredRange(info);
  const premiered = prettySeason(info);
  const studios = (info.studios?.edges || [])
    .filter((e: any) => e?.isMain)
    .map((e: any) => e.node?.name)
    .filter(Boolean)
    .join(", ");
  const producers = (info.studios?.edges || [])
    .filter((e: any) => e && !e.isMain)
    .map((e: any) => e.node?.name)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
  const details: Array<[string, string | null]> = [
    [t("anime.detailFormat"), prettyFormat(info.format || null)],
    [t("anime.detailStatus"), statusLabelI18n(t, info.status || null)],
    [t("anime.detailSource"), prettySource((info as any).source || null)],
    [t("anime.detailAired"), aired],
    [t("anime.detailPremiered"), premiered],
    [t("anime.detailStudios"), studios || null],
    [t("anime.detailProducers"), producers || null],
    [t("anime.detailCountry"), countryLabel(t, (info as any).countryOfOrigin || null)],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  const tags = (info.tags || [])
    .filter((t: any) => !t.isMediaSpoiler && !t.isGeneralSpoiler)
    .sort((a: any, b: any) => (b.rank || 0) - (a.rank || 0))
    .slice(0, 8);

  const externalLinks = (info as any).externalLinks || [];
  const trailer = info.trailer;
  const popularity = (info as any).popularity as number | undefined;
  const favourites = (info as any).favourites as number | undefined;
  const popRank =
    info.rankings?.find((r) => r.type === "POPULAR" && r.allTime)?.rank ??
    null;
  const ratingRank =
    info.rankings?.find((r) => r.type === "RATED" && r.allTime)?.rank ??
    null;
  const seasonalRank =
    info.rankings?.find((r) => r.type === "RATED" && r.season)?.rank ?? null;
  const popularityStats: Array<[string, string, string]> = [
    [t("anime.popularity"), popRank ? `#${popRank}` : compactNumber(popularity ?? null) || "—", "#ff7a91"],
    [t("anime.rating"), ratingRank ? `#${ratingRank}` : "—", "#f6c544"],
    [t("anime.seasonal"), seasonalRank ? `#${seasonalRank}` : "—", "#2dd47a"],
    [t("anime.members"), compactNumber(favourites ?? null) || "—", "#7ec8ff"],
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 26,
        padding: "20px 16px 0",
      }}
    >
      {description && (
        <section>
          <div style={S.kicker}>{t("anime.sectionSynopsis")}</div>
          <p
            style={{
              fontSize: 13.5,
              lineHeight: 1.65,
              color: "#c4c8d4",
              margin: 0,
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: exp ? "unset" : 4,
              overflow: "hidden",
            }}
          >
            {description}
          </p>
          <button
            onClick={() => setExp((e) => !e)}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#ff3b5c",
              padding: "6px 0 0",
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            {exp ? t("anime.readLess") : t("anime.readMore")}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: exp ? "rotate(180deg)" : undefined }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </section>
      )}

      {trailer?.id && trailer?.site && (
        <section>
          <div style={S.kicker}>{t("anime.sectionTrailer")}</div>
          <MTrailer trailer={trailer} bannerFallback={info.bannerImage} />
        </section>
      )}

      {/* Relations. Same component as desktop — sorting + scroll behaviour
          come from Related.tsx so changes stay in one place. The padding
          tweak below pulls the kicker back to the page edge while letting
          the cards bleed past it horizontally (which gives the "more
          content scrolls off the right" affordance for free). */}
      {(Array.isArray(info.relations?.edges) && info.relations.edges.length > 0) ||
      (seasonList && seasonList.length > 1) ? (
        <section style={{ marginLeft: -16, marginRight: -16 }}>
          <div style={{ ...S.kicker, paddingLeft: 16, paddingRight: 16 }}>
            RELATIONS
          </div>
          <div style={{ paddingLeft: 16, paddingRight: 16 }}>
            <Related
              relations={info.relations?.edges || []}
              seasonList={seasonList}
              currentId={info.id}
            />
          </div>
        </section>
      ) : null}

      <section>
        <div style={S.kicker}>{t("anime.sectionPopularity")}</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 8,
          }}
        >
          {popularityStats.map(([k, v, c]) => (
            <div
              key={k}
              style={{
                padding: "12px 14px",
                background: "#161924",
                border: "1px solid #252938",
                borderRadius: 10,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "#5e6478",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                }}
              >
                {k.toUpperCase()}
              </div>
              <div
                style={{
                  fontFamily: "Outfit, sans-serif",
                  fontSize: 22,
                  fontWeight: 700,
                  marginTop: 4,
                  letterSpacing: "-0.02em",
                  color: c,
                }}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
      </section>

      {details.length > 0 && (
        <section>
          <div style={S.kicker}>{t("anime.sectionDetails")}</div>
          <div
            style={{
              background: "#161924",
              border: "1px solid #252938",
              borderRadius: 12,
              padding: "4px 14px",
            }}
          >
            {details.map(([k, v], i) => (
              <div
                key={k}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 0",
                  borderBottom:
                    i < details.length - 1 ? "1px solid #252938" : "none",
                }}
              >
                <span style={{ fontSize: 11.5, color: "#5e6478" }}>{k}</span>
                <span
                  style={{
                    fontSize: 12.5,
                    color: "#c4c8d4",
                    fontWeight: 500,
                    textAlign: "right",
                  }}
                >
                  {v}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {tags.length > 0 && (
        <section>
          <div style={S.kicker}>{t("anime.sectionTags")}</div>
          <div
            style={{
              background: "#161924",
              border: "1px solid #252938",
              borderRadius: 12,
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {tags.map((tag: any) => (
              <div
                key={tag.name}
                style={{ display: "flex", alignItems: "center", gap: 10 }}
              >
                <span
                  style={{
                    fontSize: 11.5,
                    color: "#c4c8d4",
                    flex: "0 0 110px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {translateTag(tag.name, i18n.language)}
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 5,
                    background: "#1d2030",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${tag.rank || 0}%`,
                      background:
                        "linear-gradient(90deg, #ff3b5c, #ff7a91)",
                      borderRadius: 3,
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: 10,
                    color: "#8a8fa3",
                    minWidth: 30,
                    textAlign: "right",
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {tag.rank || 0}%
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {externalLinks.length > 0 && (
        <section>
          <div style={S.kicker}>{t("anime.sectionExternalSites")}</div>
          <div
            style={{ display: "flex", flexDirection: "column", gap: 7 }}
          >
            {externalLinks.slice(0, 6).map((s: any) => {
              const color = s.color || "#4a8fff";
              return (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "11px 13px",
                    background: "#161924",
                    border: "1px solid #252938",
                    borderRadius: 10,
                    borderLeft: `3px solid ${color}`,
                    textDecoration: "none",
                    color: "#f4f5f8",
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 7,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 13,
                      fontWeight: 700,
                      background: color + "22",
                      color,
                      flexShrink: 0,
                    }}
                  >
                    {(s.site || "?").charAt(0).toUpperCase()}
                  </div>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {s.site}
                  </span>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "#5e6478", flexShrink: 0 }}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </a>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/* ─── Trailer ─────────────────────────────────────────────── */
function MTrailer({
  trailer,
  bannerFallback,
}: {
  trailer: { id: string | null; site: string | null; thumbnail: string | null };
  bannerFallback?: string | null;
}) {
  const [playing, setPlaying] = useState(false);
  if (!trailer.id || !trailer.site) return null;
  const embed =
    trailer.site === "youtube"
      ? `https://www.youtube-nocookie.com/embed/${trailer.id}?autoplay=1`
      : trailer.site === "dailymotion"
      ? `https://www.dailymotion.com/embed/video/${trailer.id}?autoplay=1`
      : null;
  const thumb =
    trailer.thumbnail ||
    (trailer.site === "youtube"
      ? `https://i.ytimg.com/vi/${trailer.id}/hqdefault.jpg`
      : null) ||
    bannerFallback ||
    null;

  if (playing && embed) {
    return (
      <div
        style={{
          position: "relative",
          aspectRatio: "16/9",
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid #252938",
          background: "#000",
        }}
      >
        <iframe
          src={embed}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
        />
      </div>
    );
  }
  return (
    <button
      onClick={() => setPlaying(true)}
      style={{
        position: "relative",
        aspectRatio: "16/9",
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid #252938",
        background: "#000",
        padding: 0,
        cursor: "pointer",
        width: "100%",
        display: "block",
      }}
    >
      {thumb && (
        <img
          src={thumb}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          background:
            "radial-gradient(circle at center, rgba(0,0,0,0.15), rgba(0,0,0,0.55))",
        }}
      >
        <span
          style={{
            width: 54,
            height: 54,
            borderRadius: 28,
            background: "rgba(255,59,92,0.95)",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 12px 30px rgba(255,59,92,0.4)",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white" style={{ marginLeft: 2 }}>
            <polygon points="5 3 19 12 5 21" />
          </svg>
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 14,
          bottom: 12,
          right: 14,
          textAlign: "left",
        }}
      >
        <div
          style={{
            fontSize: 9,
            color: "rgba(255,255,255,0.7)",
            letterSpacing: "0.12em",
            fontWeight: 700,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          OFFICIAL TRAILER
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 3 }}>
          Watch on {trailer.site === "youtube" ? "YouTube" : trailer.site}
        </div>
      </div>
    </button>
  );
}

/* ─── Recommendations ─────────────────────────────────────── */
function MRecs({ info }: { info: AniListInfoTypes }) {
  const titlePref = useTitlePref();
  const { t } = useTranslation();
  const recs = (info.recommendations?.nodes || [])
    .map((n: any) => n.mediaRecommendation)
    .filter(Boolean)
    .slice(0, 12);
  if (!recs.length) return null;
  return (
    <section style={{ padding: "28px 0 0" }}>
      <div
        style={{
          padding: "0 16px",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={S.kicker}>{t("anime.sectionRecommendations")}</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
            {t("anime.becauseWatching", { title: pickTitle(info.title, titlePref) })}
          </div>
        </div>
      </div>
      <div
        className="hide-scroll"
        style={{
          display: "flex",
          gap: 11,
          overflowX: "auto",
          padding: "14px 16px 4px",
          // `x mandatory` made iOS Safari treat a tap as the start of a
          // scroll-snap and swallow the click on the card's <Link>, so recs
          // were untappable on mobile. `proximity` keeps a light snap without
          // stealing taps.
          scrollSnapType: "x proximity",
        }}
      >
        {recs.map((r: any) => {
          const t = pickTitle(r.title, titlePref) || "Untitled";
          const cover =
            r.coverImage?.extraLarge ||
            r.coverImage?.large ||
            r.coverImage?.medium;
          const score = typeof r.averageScore === "number"
            ? (r.averageScore / 10).toFixed(1)
            : null;
          return (
            <Link
              key={r.id}
              href={`/en/anime/${r.id}`}
              style={{
                flex: "0 0 124px",
                scrollSnapAlign: "start",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div
                style={{
                  position: "relative",
                  aspectRatio: "3/4",
                  borderRadius: 9,
                  overflow: "hidden",
                  border: "1px solid #252938",
                  background: "#1d2030",
                }}
              >
                {cover && (
                  <img
                    src={cover}
                    alt=""
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                )}
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  WebkitLineClamp: 2,
                  overflow: "hidden",
                }}
              >
                {t}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 10,
                  color: "#5e6478",
                }}
              >
                {r.seasonYear && <span>{r.seasonYear}</span>}
                {r.seasonYear && score && (
                  <span
                    style={{
                      width: 2,
                      height: 2,
                      borderRadius: 1,
                      background: "#5e6478",
                    }}
                  />
                )}
                {score && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                    <Star fill="#f6c544" size={8} />
                    {score}
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/* ─── Utility components ──────────────────────────────────── */
function Stat({ top, label }: { top: React.ReactNode; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        {top}
      </div>
      <div
        style={{
          fontSize: 9.5,
          color: "#5e6478",
          letterSpacing: "0.1em",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
    </div>
  );
}
function Divider() {
  return <div style={{ width: 1, height: 30, background: "#252938" }} />;
}
function Star({ fill = "#f6c544", size = 13 }: { fill?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      style={{ position: "relative", top: 1 }}
    >
      <polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" />
    </svg>
  );
}
function Heart({ fill = "#ff3b5c" }: { fill?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill={fill} style={{ position: "relative", top: 1 }}>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

/* ─── styles ──────────────────────────────────────────────── */
const S: Record<string, React.CSSProperties> = {
  root: {
    position: "relative",
    width: "100%",
    minHeight: "100vh",
    background: "#0a0b10",
    color: "#f4f5f8",
    display: "flex",
    flexDirection: "column",
  },
  scroller: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
    WebkitOverflowScrolling: "touch",
  },
  tabBox: {
    padding: "20px 16px 0",
  },
  kicker: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: "0.14em",
    color: "#5e6478",
    marginBottom: 10,
  },
  chipPink: {
    flexShrink: 0,
    padding: "3px 9px",
    borderRadius: 999,
    background: "rgba(255,59,92,0.12)",
    border: "1px solid rgba(255,59,92,0.35)",
    color: "#ff7a91",
    fontSize: 10.5,
    fontWeight: 600,
  },
  chipBlue: {
    flexShrink: 0,
    padding: "3px 9px",
    borderRadius: 999,
    background: "rgba(74,143,255,0.1)",
    border: "1px solid rgba(74,143,255,0.3)",
    color: "#7ec8ff",
    fontSize: 10.5,
    fontWeight: 600,
  },
};
