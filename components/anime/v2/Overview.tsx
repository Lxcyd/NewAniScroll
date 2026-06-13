import { CSSProperties, useEffect, useMemo, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import {
  formatAiredRange,
  parseDescription,
  prettyFormat,
  prettySeason,
  prettySource,
  statusLabel as statusLabelI18n,
  countryLabel,
  capitalize,
} from "./helpers";
import Related from "./Related";
import styles from "./styles.module.css";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useTranslatedText } from "@/lib/i18n/useTranslatedText";
import { translateTag } from "@/lib/i18n/animeTags";
import { hexToCssFilter } from "@/lib/color/hexToCssFilter";

type Props = {
  info: AniListInfoTypes;
  /** Optional — full TV/ONA season chain resolved server-side. When
   *  provided, Relations renders every season AniList only exposes via
   *  multi-hop prequel/sequel walks (e.g. DanMachi S3 / S4 / S5 from
   *  S1's page). Without it, Relations falls back to the direct edges
   *  on `info.relations`. */
  seasonList?: import("@/lib/anilist/seasonChain").SeasonEntry[];
};

export default function Overview({ info, seasonList }: Props) {
  const titlePref = useTitlePref();
  const { t, i18n } = useTranslation();
  const [spoilers, setSpoilers] = useState(false);

  const details = useMemo(() => buildDetails(info, t), [info, t]);
  const allTags = info.tags || [];
  const visibleTags = useMemo(() => {
    const spoilerTags = allTags
      .filter((t) => t.isMediaSpoiler || t.isGeneralSpoiler)
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    const regularTags = allTags
      .filter((t) => !t.isMediaSpoiler && !t.isGeneralSpoiler)
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    return spoilers ? [...spoilerTags, ...regularTags] : regularTags;
  }, [allTags, spoilers]);

  const sites = useMemo(() => buildSites(info), [info]);
  const popularity = useMemo(() => buildPopularity(info, t), [info, t]);

  const { text: synopsisRaw, source: synopsisSource } = useMemo(
    () => parseDescription(info.description),
    [info.description]
  );
  // Auto-translate the AniList synopsis into the active UI language (cached
  // server-side). Falls back to the English original while loading / on error.
  const synopsis = useTranslatedText(synopsisRaw);

  const trailerUrl =
    info.trailer && info.trailer.site === "youtube" && info.trailer.id
      ? `https://www.youtube.com/watch?v=${info.trailer.id}`
      : info.trailer && info.trailer.site === "dailymotion" && info.trailer.id
      ? `https://www.dailymotion.com/video/${info.trailer.id}`
      : null;

  return (
    <div style={tStyles.overviewWrap}>
      {/* Synopsis */}
      <section>
        <div style={tStyles.secKicker}>{t("anime.sectionSynopsis")}</div>
        {synopsis ? (
          <p style={tStyles.synopsisText}>{synopsis}</p>
        ) : (
          <p style={tStyles.synopsisText}>{t("anime.noSynopsis")}</p>
        )}
        <div style={tStyles.synopsisSrc}>
          {/* Use the source AniList embeds in the description (Crunchyroll,
              Kodansha USA, MAL, …) when present — that's the true upstream
              attribution. Fall back to AniList itself when none was given. */}
          <em>{t("anime.source")}: {synopsisSource || "AniList"}</em>
        </div>
      </section>

      {/* V12 grid */}
      <div
        className={styles.responsiveGrid}
        style={{
          display: "grid",
          gridTemplateColumns: "320px minmax(0,1fr)",
          gridTemplateRows: "auto auto",
          columnGap: 28,
          rowGap: 18,
          alignItems: "stretch",
        }}
      >
        {/* Row 1 col 1 — Details */}
        <div
          style={{
            gridColumn: 1,
            gridRow: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <section
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              paddingBottom: 6,
            }}
          >
            <div style={tStyles.secKicker}>{t("anime.sectionDetails")}</div>
            <div
              style={{
                ...tStyles.detailsCard,
                flex: 1,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "8px 16px",
                  fontSize: 12.5,
                  flex: 1,
                  alignContent: "space-between",
                }}
              >
                {details.map(([k, v]) => (
                  <span key={k} style={{ display: "contents" }}>
                    <div style={tStyles.detailKey}>{k}</div>
                    <div style={tStyles.detailVal}>{v}</div>
                  </span>
                ))}
              </div>
            </div>
          </section>
        </div>

        {/* Row 1 col 2 — Relations. Mirrors the Details column's flex
            structure (kicker + flex:1 card) so both sections share the
            same top/bottom baseline within row 1. The inner wrapper
            stretches its content to the full available height — Related
            uses that to size its cards to match the Details card.
            We mirror Details' exact paddingBottom so the cards' bottom
            edge lines up to the pixel with the Details card's bottom. */}
        <div
          style={{
            gridColumn: 2,
            gridRow: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <section
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              paddingBottom: 6,
            }}
          >
            <div style={tStyles.secKicker}>{t("anime.sectionRelations")}</div>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
              }}
            >
              <Related
                relations={info.relations?.edges || []}
                seasonList={seasonList}
                currentId={info.id}
              />
            </div>
          </section>
        </div>

        {/* Row 2 col 1 — Tags + External Sites (absolutely positioned trick
             so the sidebar height tracks the main column). */}
        <div
          style={{
            gridColumn: 1,
            gridRow: 2,
            minWidth: 0,
            position: "relative",
            minHeight: 420,
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            {/* Tags */}
            <section
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div style={{ ...tStyles.secKicker, marginBottom: 0 }}>{t("anime.sectionTags")}</div>
                {allTags.some((t) => t.isMediaSpoiler || t.isGeneralSpoiler) && (
                  <button
                    onClick={() => setSpoilers((s) => !s)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 9px",
                      borderRadius: 6,
                      background: spoilers
                        ? "rgba(255,59,92,0.12)"
                        : "var(--bg-2)",
                      border: spoilers
                        ? "1px solid rgba(255,59,92,0.4)"
                        : "1px solid var(--line)",
                      color: spoilers ? "var(--accent)" : "var(--txt-2)",
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      cursor: "pointer",
                    }}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      {spoilers ? (
                        <>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      ) : (
                        <>
                          <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </>
                      )}
                    </svg>
                    {spoilers ? t("anime.hideSpoilers") : t("anime.showSpoilers")}
                  </button>
                )}
              </div>
              <div
                className={styles.customScroll}
                style={{
                  ...tStyles.detailsCard,
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                }}
              >
                {visibleTags.length === 0 ? (
                  <div style={{ color: "var(--txt-3)", fontSize: 12 }}>
                    {t("anime.noTags")}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {visibleTags.map((tag) => {
                      const v = tag.rank ?? 0;
                      const isSpoiler = tag.isMediaSpoiler || tag.isGeneralSpoiler;
                      return (
                        <div
                          key={tag.id}
                          style={{ display: "flex", alignItems: "center", gap: 10 }}
                          title={tag.description || undefined}
                        >
                          <span
                            style={{
                              fontSize: 12,
                              color: isSpoiler ? "var(--accent)" : "var(--txt-1)",
                              flex: "0 0 145px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {translateTag(tag.name, i18n.language)}
                          </span>
                          <div style={tStyles.tagBar}>
                            <div style={{ ...tStyles.tagFill, width: v + "%" }} />
                          </div>
                          <span className="mono" style={tStyles.tagPct}>
                            {v}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* External Sites */}
            <section
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={tStyles.secKicker}>{t("anime.sectionExternalSites")}</div>
              <div
                className={styles.customScroll}
                style={{
                  ...tStyles.detailsCard,
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                }}
              >
                {sites.length === 0 ? (
                  <div style={{ color: "var(--txt-3)", fontSize: 12 }}>
                    No external sites.
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr" }}>
                    {sites.map((s) => (
                      <a
                        key={s.id}
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className={styles.siteBtn}
                        style={{
                          ...tStyles.siteBtn,
                          borderLeft: `3px solid ${s.color}`,
                          textDecoration: "none",
                        }}
                      >
                        <SiteLogo site={s} />
                        <span style={tStyles.siteName}>{s.name}</span>
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          style={{ color: "var(--txt-3)", marginLeft: "auto" }}
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>

        {/* Row 2 col 2 — Trailer + Popularity */}
        <div
          style={{
            gridColumn: 2,
            gridRow: 2,
            display: "flex",
            flexDirection: "column",
            gap: 28,
            minWidth: 0,
          }}
        >
          {/* Trailer section — completely hidden when the show has no
              trailer (one-piece, older series, music videos with no MV, etc).
              Showing a "No trailer available" placeholder was wasted real
              estate and looked like a broken player. When this section
              disappears the column's flex layout pulls POPULARITY up on its
              own, which matches the mobile layout's behaviour. */}
          {trailerUrl && (
            <section>
              {/* Mirror the TAGS header EXACTLY — same flex wrapper, same
                  children shape, same box metrics — wrapped in
                  visibility:hidden so the trailer's top edge lines up
                  pixel-for-pixel with the tags card's top edge.
                  Only emit the placeholder when the TAGS side actually
                  shows the spoilers toggle, otherwise we'd add height
                  here that the other column doesn't have. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div style={{ ...tStyles.secKicker, marginBottom: 0 }}>{t("anime.sectionTrailer")}</div>
                {allTags.some((t) => t.isMediaSpoiler || t.isGeneralSpoiler) && (
                  <span
                    aria-hidden
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 9px",
                      borderRadius: 6,
                      border: "1px solid transparent",
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      visibility: "hidden",
                      pointerEvents: "none",
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" />
                    Show Spoilers
                  </span>
                )}
              </div>
              <a
                href={trailerUrl}
                target="_blank"
                rel="noreferrer"
                style={{ ...tStyles.mainPlayer, textDecoration: "none" } as CSSProperties}
              >
                {info.trailer?.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={info.trailer.thumbnail}
                    alt=""
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <div style={tStyles.playerBg} />
                )}
                <div style={tStyles.playerOverlay}>
                  <div style={tStyles.bigPlay}>
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="white"
                      style={{ marginLeft: 3 }}
                    >
                      <polygon points="5 3 19 12 5 21" />
                    </svg>
                  </div>
                </div>
                <div style={tStyles.playerInfo}>
                  <span className="mono" style={tStyles.playerKind}>
                    OFFICIAL TRAILER
                  </span>
                  <div style={tStyles.playerTitle}>
                    {pickTitle(info.title, titlePref)}
                  </div>
                  <div style={tStyles.playerMeta}>
                    {capitalize(info.trailer?.site || "")}
                  </div>
                </div>
              </a>
            </section>
          )}

          <section>
            <div style={tStyles.secKicker}>{t("anime.sectionPopularity")}</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 10,
              }}
            >
              {popularity.map(([k, v, c]) => (
                <div key={k} style={tStyles.statBox}>
                  <div style={tStyles.statBoxK}>{k}</div>
                  <div
                    className="display"
                    style={{ ...tStyles.statBoxV, color: c as string }}
                  >
                    {v}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function buildDetails(
  info: AniListInfoTypes,
  t: TFunction
): Array<[string, string]> {
  const studios = (info.studios?.edges || []).filter((e) => e.isMain).map((e) => e.node.name);
  const producers = (info.studios?.edges || [])
    .filter((e) => !e.isMain)
    .map((e) => e.node.name);
  const aired = formatAiredRange(info);
  const premiered = prettySeason(info);
  const na = t("status.na");
  return [
    [t("anime.detailFormat"), prettyFormat(info.format)],
    [t("anime.detailStatus"), statusLabelI18n(t, info.status)],
    [t("anime.detailSource"), prettySource(info.source)],
    [t("anime.detailAired"), aired || na],
    [t("anime.detailPremiered"), premiered || na],
    [t("anime.detailEpisodes"), info.episodes ? String(info.episodes) : na],
    [t("anime.detailDuration"), info.duration ? t("anime.minutes", { count: info.duration }) : na],
    [t("anime.detailStudios"), studios.length > 0 ? studios.join(", ") : na],
    [t("anime.detailProducers"), producers.length > 0 ? producers.slice(0, 2).join(", ") : na],
    [t("anime.detailCountry"), countryLabel(t, info.countryOfOrigin)],
  ];
}

type SiteRow = {
  id: string;
  name: string;
  url: string;
  color: string;
  initial: string;
  icon?: string | null;
  /** True when `icon` is a white/monochrome glyph that should be recoloured to
   *  the brand colour (AniList's external-link icons). Full-colour icons
   *  (favicons, our canonical AniList/MAL logos) set this false. */
  monochrome?: boolean;
};

function buildSites(info: AniListInfoTypes): SiteRow[] {
  const out: SiteRow[] = [];

  // Always-on canonical entries.
  out.push({
    id: "anilist",
    name: "AniList",
    url: info.siteUrl || `https://anilist.co/anime/${info.id}`,
    color: "#3577ff",
    initial: "A",
    icon: "https://anilist.co/img/icons/icon.svg",
  });
  if (info.idMal) {
    out.push({
      id: "mal",
      name: "MyAnimeList",
      url: `https://myanimelist.net/anime/${info.idMal}`,
      color: "#2e51a2",
      initial: "M",
      icon: "https://cdn.myanimelist.net/images/favicon.ico",
    });
  }

  // AniList-provided external links (streaming, official, social, etc.).
  // Pre-existing entries are not duplicated. AniList supplies an `icon`
  // logo URL for most known sites; we fall back to a Google-favicon lookup
  // (then to the coloured letter) when it doesn't.
  for (const link of info.externalLinks || []) {
    if (!link.url) continue;
    const id = `ext-${link.id}`;
    if (out.find((s) => s.id === id)) continue;
    out.push({
      id,
      name: link.site,
      url: link.url,
      color: link.color || colorBySite(link.site),
      initial: (link.site[0] || "?").toUpperCase(),
      // AniList serves these icons as monochrome grey+alpha PNGs — recolour them
      // to the brand colour. When AniList gives no icon we render a play glyph
      // (no favicon lookup; matches the reference project's behaviour).
      icon: link.icon || null,
      monochrome: !!link.icon,
    });
  }
  return out;
}

// Sites whose AniList icon is a FULL-COLOUR logo we must not recolour — tinting
// these to a single brand colour would destroy their multi-colour branding.
// Verbatim from the reference project's _colorfulIconSites + _neverRecolorSites
// (AnimeDetailPopup.razor), matched case-insensitively.
const COLORFUL_ICON_SITES = new Set(
  [
    "Alpha Manga", "AlphaPolis", "Asacomi", "Bandai Channel", "Carlsen Manga!",
    "Ciao Plus", "Disney Plus", "Disney+", "Dongman Manhua", "FEEL web",
    "Flower Comics", "Gau Gau", "Ichijin Plus", "Kana", "Kanmanhua",
    "Manga UP!", "MangaPlaza", "Manman Manhua", "Nico Nico Seiga", "ONO",
    "Piccoma", "Pixiv Comic", "Pixiv", "Pocket Magazine", "Renta!",
    "Rimacomi Plus", "SORAJIMA TOON", "Star+", "SuBLime", "Takecomic",
    "Tencent Comics", "Viki", "WeComics", "Weekly CoroCoro Comic", "Yanmaga",
    "Yawaraka Spirits", "Young Animal",
  ].map((s) => s.toLowerCase()),
);

/**
 * Site logo badge.
 *
 * AniList serves a (mostly white, monochrome) `icon` for known external links.
 * Following the reference project's logic, we recolour that monochrome icon to
 * the site's brand colour with a CSS mask — so a white-on-white logo becomes a
 * crisp brand-coloured glyph — UNLESS the icon is one of the inherently
 * full-colour ones (COLORFUL_ICON_SITES), which render unchanged. When there's
 * no icon (or it fails to load) we fall back to a brand-coloured play-button
 * SVG rather than a bare letter.
 */
function SiteLogo({ site }: { site: SiteRow }) {
  const [failed, setFailed] = useState(false);
  const color = site.color || "#7ec8ff";
  const hasIcon = !!site.icon && !failed;
  // Recolour only monochrome AniList glyphs, and only when we have a usable
  // brand colour (non-black hex) — never the inherently full-colour brands
  // (Disney+, Viki, …). Mirrors the reference's shouldRecolor guard
  // (brandColor non-empty, != #000000, starts with #).
  const usableColor =
    typeof color === "string" && color.startsWith("#") && color !== "#000000";
  const recolor =
    !!site.monochrome &&
    usableColor &&
    !COLORFUL_ICON_SITES.has(site.name.toLowerCase());
  // White→brand-colour CSS filter. Computed ONLY after mount: the SPSA solver
  // in hexToCssFilter isn't guaranteed bit-identical between the server and
  // client bundles, so emitting the filter in the SSR markup risked a tiny
  // value drift (7440% vs 7305%) → React hydration mismatch (#418/#423/#425).
  // Rendering null on the server + first client render and applying the filter
  // in an effect sidesteps it entirely; the recolour just lands one frame
  // later, which is imperceptible for a 20px link glyph.
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => {
    setFilter(recolor ? hexToCssFilter(color) : null);
  }, [recolor, color]);

  return (
    <div
      style={{
        ...tStyles.siteLogo,
        background: color + "22",
        color,
        overflow: "hidden",
      }}
    >
      {hasIcon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={site.icon as string}
          alt=""
          width={20}
          height={20}
          loading="lazy"
          style={{
            width: 20,
            height: 20,
            objectFit: "contain",
            borderRadius: 4,
            ...(filter ? { filter } : null),
          }}
          onError={() => setFailed(true)}
        />
      ) : (
        <PlayBadge color={color} />
      )}
    </div>
  );
}

/** Brand-coloured play-button glyph — the icon fallback used when a site has
 *  no usable logo (matches the reference project's SVG fallback). */
function PlayBadge({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="20" height="20" rx="4" />
      <polygon points="10,8 16,12 10,16" fill={color} stroke="none" />
    </svg>
  );
}

function colorBySite(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("twitter") || n.includes("x")) return "#1da1f2";
  if (n.includes("reddit")) return "#ff4500";
  if (n.includes("wikipedia")) return "#a0a0a0";
  if (n.includes("crunchyroll")) return "#f47521";
  if (n.includes("netflix")) return "#e50914";
  if (n.includes("hidive")) return "#00aeef";
  if (n.includes("hulu")) return "#1ce783";
  if (n.includes("youtube")) return "#ff0000";
  if (n.includes("official")) return "#ff3b5c";
  return "#7ec8ff";
}

function buildPopularity(
  info: AniListInfoTypes,
  t: TFunction
): Array<[string, string, string]> {
  const find = (pred: (r: any) => boolean) =>
    info.rankings?.find(pred)?.rank ?? null;
  const popular = find((r) => r.type === "POPULAR" && r.allTime);
  const rated = find((r) => r.type === "RATED" && r.allTime);
  const seasonal = find((r) => r.type === "POPULAR" && r.season);
  const members = info.popularity;
  const na = t("status.na");
  return [
    [t("anime.popularity"), popular ? `#${popular}` : na, "#ff7a91"],
    [t("anime.rating"), rated ? `#${rated}` : na, "#f6c544"],
    [t("anime.seasonal"), seasonal ? `#${seasonal}` : na, "#2dd47a"],
    [
      t("anime.members"),
      members != null
        ? members >= 1000
          ? (members / 1000).toFixed(0) + "K"
          : String(members)
        : na,
      "#7ec8ff",
    ],
  ];
}

const tStyles: Record<string, CSSProperties> = {
  overviewWrap: { display: "flex", flexDirection: "column", gap: 28 },
  detailsCard: {
    padding: 16,
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 12,
  },
  detailKey: { color: "var(--txt-3)", fontSize: 11.5, letterSpacing: "0.04em" },
  detailVal: { color: "var(--txt-1)", fontWeight: 500, textAlign: "right" },
  secKicker: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.14em",
    color: "var(--txt-3)",
    marginBottom: 12,
  },
  synopsisText: {
    fontSize: 14,
    color: "var(--txt-1)",
    lineHeight: 1.65,
    margin: 0,
    textWrap: "pretty",
  } as CSSProperties,
  synopsisSrc: { fontSize: 11, color: "var(--txt-3)", marginTop: 10 },
  tagBar: {
    flex: 1,
    height: 6,
    background: "var(--bg-3)",
    borderRadius: 3,
    overflow: "hidden",
  },
  tagFill: {
    height: "100%",
    background: "linear-gradient(90deg, var(--accent), #ff7a91)",
    borderRadius: 3,
  },
  tagPct: {
    fontSize: 10.5,
    color: "var(--txt-2)",
    minWidth: 32,
    textAlign: "right",
  },
  siteBtn: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 9,
    color: "var(--txt-0)",
    cursor: "pointer",
  },
  siteLogo: {
    width: 32,
    height: 32,
    borderRadius: 7,
    display: "grid",
    placeItems: "center",
    fontSize: 14,
    fontWeight: 700,
    flexShrink: 0,
  },
  siteName: { fontSize: 13.5, fontWeight: 600, color: "var(--txt-0)" },
  mainPlayer: {
    position: "relative",
    aspectRatio: "16/9",
    borderRadius: 12,
    overflow: "hidden",
    border: "1px solid var(--line)",
    display: "block",
    color: "inherit",
  },
  playerBg: {
    position: "absolute",
    inset: 0,
    background: "linear-gradient(135deg, #0a0a2a, #1a0a3a, #2a1a3a)",
  },
  playerOverlay: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background:
      "radial-gradient(circle at center, rgba(0,0,0,0.2), rgba(0,0,0,0.6))",
  },
  bigPlay: {
    width: 64,
    height: 64,
    borderRadius: 32,
    background: "rgba(255,59,92,0.95)",
    display: "grid",
    placeItems: "center",
    boxShadow: "0 12px 30px rgba(255,59,92,0.4)",
  },
  playerInfo: {
    position: "absolute",
    left: 16,
    bottom: 16,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  playerKind: {
    fontSize: 10,
    color: "rgba(255,255,255,0.7)",
    letterSpacing: "0.12em",
    fontWeight: 700,
  },
  playerTitle: { fontSize: 16, fontWeight: 600, color: "white" },
  playerMeta: { fontSize: 11.5, color: "rgba(255,255,255,0.6)" },
  statBox: {
    padding: "14px 16px",
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 10,
  },
  statBoxK: {
    fontSize: 10.5,
    color: "var(--txt-3)",
    letterSpacing: "0.1em",
    fontWeight: 600,
  },
  statBoxV: { fontSize: 26, fontWeight: 700, marginTop: 4, letterSpacing: "-0.02em" },
};
