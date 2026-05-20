import { CSSProperties, useEffect, useRef, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import {
  LIST_COLORS,
  STATUS_TO_LIST,
  compactNumber,
  extractSeasonFromTitle,
  formatAiredRange,
  prettySeason,
  prettyStatus,
  SeasonInfo,
  TitleImage,
} from "./helpers";
import { toast } from "sonner";

type HeroProps = {
  info: AniListInfoTypes;
  /** Pre-picked clearart / logo. Resolved at SSR so the <img> ships with
   *  the document — no client fetch, no random pick during hydration.
   *  Carries a cycle queue when multiple clearart are available. */
  titleImage: TitleImage | null;
  /** Season position in the franchise (e.g. S2 of 3). null when the
   *  anime isn't part of a multi-season series. */
  seasonInfo?: SeasonInfo;
  /** Resume URL (computed by the parent from progress / megaplay) */
  watchUrl?: string;
  /** Current list status from AniList for the signed-in user. */
  statusLabel: string | null;
  /** True if the user has favourited this title. */
  fav: boolean;
  /** Parent opens the existing modal-based list editor. */
  onOpenListEditor: () => void;
  /** Parent toggles favourite via AniList mutation. */
  onToggleFav: () => void;
  /** Rank #N for the rating ranking (overall / season pulled from data). */
  ratingRank?: number | null;
  favRank?: number | null;
};

export default function Hero({
  info,
  titleImage,
  seasonInfo,
  watchUrl,
  statusLabel,
  fav,
  onOpenListEditor,
  onToggleFav,
  ratingRank,
  favRank,
}: HeroProps) {
  const title =
    info.title.english || info.title.romaji || info.title.native || "Untitled";
  const seasonPill = prettySeason(info);

  const studios = (info.studios?.edges || []).filter((e) => e.isMain);
  const producers = (info.studios?.edges || []).filter((e) => !e.isMain);

  const rating = info.averageScore != null ? (info.averageScore / 10).toFixed(2) : null;
  /* Episode count display logic:
     - airing with a known total           → "7/12"   (aired so far / total)
     - airing with an unknown total        → "1102+"  (open-ended series like One Piece)
     - finished / not yet aired with total → "12"     (just the number)
     - nothing known                       → "N/A"
     `nextAiringEpisode.episode` is the *next* episode to air, so episodes
     aired so far = that number - 1. */
  const airedSoFar = info.nextAiringEpisode?.episode
    ? Math.max(0, info.nextAiringEpisode.episode - 1)
    : null;
  const isAiring = info.status === "RELEASING";
  const epLabel = isAiring
    ? airedSoFar != null && info.episodes
      ? `${airedSoFar}/${info.episodes}`
      : airedSoFar != null
      ? `${airedSoFar}+`
      : info.episodes
      ? `${info.episodes}`
      : "N/A"
    : info.episodes
    ? `${info.episodes}`
    : "N/A";
  const durLabel = info.duration ? `EP · ${info.duration}min` : "EP";

  const list = (statusLabel && STATUS_TO_LIST[statusLabel]) || "Add to List";
  const listColor = LIST_COLORS[list] || "#8a8fa3";

  // Not-yet-released anime: episode 1 doesn't exist yet so a Watch
  // button would lead to a 404. Surface "Coming Soon" with the air date
  // when we have it instead, and a disabled-looking CTA pointing to a
  // "plan to watch" action.
  const isNotYetReleased = info.status === "NOT_YET_RELEASED";

  // CTA copy: "REWATCH" if the user already finished the anime,
  // "COMING SOON" if it hasn't aired, "WATCH NOW" otherwise.
  const isCompleted = statusLabel === "COMPLETED";
  const watchLabel = isNotYetReleased
    ? "COMING SOON"
    : isCompleted
    ? "REWATCH"
    : "WATCH NOW";

  // Resume target:
  //   - not yet released → no playable episode, button is a no-op link
  //     back to the same page (Hero is the entry point already; clicking
  //     just shouldn't navigate elsewhere)
  //   - completed → restart from EP 1 (rewatching means the start, not
  //     progress+1 which would be EP <total+1> and 404 anyway)
  //   - otherwise → respect the parent-computed watchUrl (progress+1)
  const epNum = isCompleted ? 1 : parseEpNumFromWatchUrl(watchUrl) ?? 1;
  const watchHref = isNotYetReleased
    ? "#"
    : isCompleted
    ? `/en/anime/watch/${info.id}/megaplay?id=megaplay-${info.id}-1&num=1`
    : watchUrl || `/en/anime/watch/${info.id}/megaplay?id=megaplay-${info.id}-1&num=1`;

  // For coming-soon anime, build a friendly air-date string from
  // nextAiringEpisode.airingAt (epoch seconds) or fall back to
  // startDate. Returns null when no date is known — the button then
  // collapses to a single large "COMING SOON" instead of showing
  // a placeholder like "TBA".
  const comingSoonLine = (() => {
    if (!isNotYetReleased) return null;
    const airingAt = info.nextAiringEpisode?.airingAt;
    if (airingAt) {
      const d = new Date(airingAt * 1000);
      const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
      return `${month} ${d.getDate()}, ${d.getFullYear()}`;
    }
    const sd = info.startDate;
    if (sd?.year) {
      const month = sd.month
        ? ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][sd.month - 1]
        : null;
      return month ? `${month} ${sd.year}` : String(sd.year);
    }
    return null;
  })();

  /* ── Clearart cycle ─────────────────────────────────────────────────
     When SSR shipped multiple clearart, expose a queue: each click on
     the title art advances to the next image (wrapping). We use a
     single <img> and animate opacity: fade out → wait for next image
     to be decoded → swap src → fade in.

     The earlier version pre-fetched only `cycleIdx + 1`, which doesn't
     help if the user clicks twice in a row before the second image is
     fully cached. We now pre-fetch the ENTIRE queue once the component
     mounts — clearart files are small enough (~50-200 KB each, browser
     deduplicates by URL) that warming the cache up-front gives us
     instant swaps for every click after that.

     We also use `img.decode()` to wait for the new image to be ready
     before fading it back in. Without that, React mounts the new src
     and React triggers `setFading(false)` on the SAME frame, but the
     browser hasn't finished decoding yet — so for ~100-300ms the
     <img> renders the PREVIOUS bitmap (still in memory) at full
     opacity, looking like the swap "didn't work". `decode()` resolves
     when the bitmap is paint-ready. */
  const cycleQueue = titleImage?.queue || [];
  const canCycle = titleImage?.kind === "clearart" && cycleQueue.length > 1;
  const [cycleIdx, setCycleIdx] = useState(0);
  const [fading, setFading] = useState(false);
  // URL currently *visible* in the DOM (may lag cycleIdx during fade).
  const [renderedUrl, setRenderedUrl] = useState<string | null>(null);
  // The mmFadeUp entrance animation is bound to a key that changes
  // every time the anime changes. Using the URL as `key` on the <img>
  // forces React to remount it, which restarts the CSS animation
  // from frame 0 — works even when the image is already cached.
  // We don't need a "firstPainted" state: the animation just plays
  // once per mount, and cycle clicks reuse the same <img> element
  // (handled by setRenderedUrl mutating `src`, not by key change).

  // Prefetch the next clearart, but ONLY after the visible one (idx 0)
  // has finished loading. Otherwise it would compete for one of the
  // browser's 6 connection slots and slow down first paint of the only
  // image the user actually sees on arrival. CF cache makes idx 2+ cheap
  // (~70ms TTFB) so on-demand at click time is fine.
  useEffect(() => {
    if (!canCycle) return;
    const first = cycleQueue[0];
    const next = cycleQueue[1];
    if (!first || !next) return;

    let cancelled = false;
    const prefetchNext = () => {
      if (cancelled) return;
      const img = new Image();
      img.src = next;
      img.decode?.().catch(() => {});
    };

    // Wait for idx 0 to be in cache. We probe by creating an Image
    // pointing at the same URL — onload fires from cache immediately
    // if idx 0 has finished, otherwise it fires when the network load
    // completes (browser dedupes the request).
    const probe = new Image();
    probe.onload = prefetchNext;
    probe.onerror = prefetchNext; // proceed anyway on error
    probe.src = first;

    return () => {
      cancelled = true;
    };
  }, [canCycle, cycleQueue]);

  // Reset the cycle whenever the anime changes. Next.js SPA-navigates
  // between info pages without remounting the Hero component, so
  // without this reset the previous anime's clearart would stick on
  // screen until the user clicked through the entire (now-stale)
  // queue. Identity test on titleImage.url is the most reliable signal
  // we have that we're looking at a different anime.
  useEffect(() => {
    if (!titleImage) {
      setRenderedUrl(null);
      setCycleIdx(0);
      setFading(false);
      return;
    }
    const firstUrl =
      titleImage.kind === "clearart" && cycleQueue.length > 0
        ? cycleQueue[0]
        : titleImage.url;
    setRenderedUrl(firstUrl);
    setCycleIdx(0);
    setFading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleImage?.url]);

  async function handleCycleClick() {
    if (!canCycle || fading) return;
    const nextIdx = (cycleIdx + 1) % cycleQueue.length;
    const nextUrl = cycleQueue[nextIdx];

    setFading(true);

    // Off-DOM decode of the next image. Resolves only when the bitmap
    // is paint-ready — guarantees the swap shows the new artwork, not
    // a stale frame. Decode in parallel with the fade-out animation so
    // they overlap.
    const decode = (async () => {
      try {
        const img = new Image();
        img.src = nextUrl;
        await img.decode?.();
      } catch {
        /* decode unsupported or failed — proceed anyway, browser will
           still render once the image loads via the <img> tag below. */
      }
    })();

    // Wait for BOTH the fade-out to complete AND the new image to be
    // decoded before swapping. Whichever is slower drives the timing.
    await Promise.all([
      new Promise<void>((r) => window.setTimeout(r, 180)),
      decode,
    ]);

    // Swap to the new image. Because it's pre-decoded, the very next
    // frame paints the new bitmap instead of a stale one.
    setCycleIdx(nextIdx);
    setRenderedUrl(nextUrl);
    // Next frame: lift the fade so opacity transitions back to 1 with
    // the new image already on screen.
    requestAnimationFrame(() => setFading(false));
  }

  const currentTitleUrl = renderedUrl;

  // Single-episode entries (movies, specials, short OVAs) don't have a
  // meaningful "EP NN" or "S<n>" — they're standalone units. Detect them
  // and collapse the button to a single big "WATCH NOW" / "REWATCH" line.
  // MOVIE format always counts; SPECIAL/OVA only when episodes ≤ 1.
  const isSingleEpisode =
    info.format === "MOVIE" ||
    ((info.format === "SPECIAL" || info.format === "OVA") &&
      (info.episodes ?? 1) <= 1);

  // Some AniList entries split a season into "cours" with separate IDs
  // (e.g. "That Time I Got Reincarnated as a Slime Season 2 Part 2").
  // AniList exposes no structured "part" field — the only signal is in
  // the title. We sniff a trailing "Part N" / "Cour N" / "Part II" and
  // append it to the season tag so the user can tell which half they're
  // on without reading the full title.
  const partSuffix = (() => {
    const candidates = [info.title.english, info.title.romaji].filter(
      Boolean
    ) as string[];
    for (const t of candidates) {
      const m = t.match(/\b(?:Part|Cour)\s+(\d+|[IVX]+)\b/i);
      if (m) return ` Part ${m[1].toUpperCase()}`;
    }
    return "";
  })();

  // Pick the most reliable season number we can get:
  //   1. Title-based extraction — works for "Season 2", "2nd Season",
  //      "S2", "II", "2期". Robust against AniList splitting cours into
  //      separate entries (a "Season 2 Part 2" entry has the number 2
  //      baked in its title, while a naive PREQUEL-walk would count
  //      Part 1 as a prior season and label it S3).
  //   2. Otherwise fall back to the SSR-computed relation walk.
  const seasonNumber =
    extractSeasonFromTitle(info.title) ?? seasonInfo?.number ?? null;

  // Append " · S<n>[ Part N]" to the episode pill when we know this anime
  // is part of a multi-season series — but only for series formats, never
  // for movies/specials that happen to be tied to a parent franchise.
  const seasonSuffix =
    !isSingleEpisode && seasonNumber != null && seasonNumber > 0
      ? ` · S${seasonNumber}${partSuffix}`
      : !isSingleEpisode && partSuffix
      ? ` ·${partSuffix}`
      : "";

  return (
    <section style={hStyles.hero}>
      {/* Entrance animation for the very first paint of the clearart.
          Subsequent cycle clicks use the opacity cross-fade above and
          skip this keyframe — we toggle the className off once the
          first paint has happened. */}
      <style>{`
        @keyframes mmFadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {/* Banner */}
      <div style={hStyles.banner}>
        {info.bannerImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={info.bannerImage} alt="" style={hStyles.bannerImg} />
        )}
        <div style={hStyles.bannerFade} />
      </div>

      <div style={hStyles.contentWrap}>
        <div style={hStyles.grid} className="anime-hero-grid">
          {/* COL 1 — cover + watch button */}
          <div style={hStyles.leftCol}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={info.coverImage.extraLarge || info.coverImage.large}
              alt={title}
              style={hStyles.cover}
            />
            <a
              href={watchHref}
              onClick={(e) => {
                /* Coming-soon button is informational only — short-
                   circuit the navigation that the "#" href would
                   otherwise trigger (which jumps to top of page). */
                if (isNotYetReleased) e.preventDefault();
              }}
              style={
                {
                  ...hStyles.watchBtn,
                  textDecoration: "none",
                  ...(isNotYetReleased ? hStyles.watchBtnDisabled : null),
                } as CSSProperties
              }
              aria-disabled={isNotYetReleased || undefined}
            >
              <div style={hStyles.watchPlay}>
                {isNotYetReleased ? (
                  /* Calendar / clock glyph instead of the play triangle */
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2}>
                    <circle cx="12" cy="12" r="9" />
                    <polyline points="12 7 12 12 15 14" />
                  </svg>
                ) : (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="white">
                    <polygon points="5 3 19 12 5 21" />
                  </svg>
                )}
              </div>
              {isNotYetReleased ? (
                /* Two layouts depending on whether we have an air date:
                   - date known → small label + date underneath
                   - date unknown → big single-line "COMING SOON"
                   (no "TBA" because that just looks like an error). */
                comingSoonLine ? (
                  <div style={{ display: "flex", flexDirection: "column", textAlign: "left" }}>
                    <div style={hStyles.watchLabel}>{watchLabel}</div>
                    <div style={hStyles.watchEp}>{comingSoonLine}</div>
                  </div>
                ) : (
                  <div style={hStyles.watchSingleLabel}>{watchLabel}</div>
                )
              ) : isSingleEpisode ? (
                /* Movies / specials with one playable unit: collapse the
                   two-line label into a single, larger "WATCH NOW" so the
                   button doesn't read as a half-empty episode picker. */
                <div style={hStyles.watchSingleLabel}>{watchLabel}</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", textAlign: "left" }}>
                  <div style={hStyles.watchLabel}>{watchLabel}</div>
                  <div style={hStyles.watchEp}>
                    EP {String(epNum).padStart(2, "0")}
                    {seasonSuffix}
                  </div>
                </div>
              )}
            </a>
          </div>

          {/* COL 2 — title art + stats + chips */}
          <div style={hStyles.centerCol}>
            {titleImage && currentTitleUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                /* `key` tied to the anime URL forces React to unmount/
                   remount this <img> whenever the anime changes, which
                   restarts the CSS `animation` from frame 0 even when
                   the image is already in browser cache (otherwise SSR
                   + cached image = onLoad fires before first paint and
                   the entrance animation is skipped entirely). For
                   cycle clicks we mutate `src` via state without
                   changing the key, so the animation does NOT replay. */
                key={titleImage.url}
                src={currentTitleUrl}
                alt={title}
                onClick={canCycle ? handleCycleClick : undefined}
                role={canCycle ? "button" : undefined}
                aria-label={canCycle ? "Show next artwork" : undefined}
                title={canCycle ? "Click for another artwork" : undefined}
                /* Only apply the edge fade to clearart (transparent
                   character cutouts that bleed off the frame). Logos
                   are stylised title typography with their own
                   intentional negative space — fading their edges
                   would chew letters. */
                style={{
                  ...(titleImage.kind === "clearart"
                    ? hStyles.titleArt
                    : hStyles.titleArtPlain),
                  cursor: canCycle ? "pointer" : undefined,
                  // Fade ramp for cycle click. Opacity drops to 0 just
                  // before the src swap, then springs back up to 1 once
                  // the new image is mounted — reads as a clean
                  // cross-fade without stacking two <img>s.
                  opacity: fading ? 0 : 1,
                  transition: "opacity 180ms ease",
                  // Entrance animation — replays on every remount
                  // (i.e. every anime change) thanks to the `key` above.
                  animation:
                    "mmFadeUp 420ms cubic-bezier(0.22, 0.61, 0.36, 1) both",
                }}
                // SSR ships this <img> in the initial HTML and a matching
                // `<link rel=preload as=image fetchpriority=high>` lives
                // in the document <head>. Mark it eager + high prio so
                // Chrome doesn't deprioritize it behind below-fold work.
                loading="eager"
                // @ts-expect-error fetchpriority is not in lib.dom yet
                fetchpriority="high"
                decoding="async"
              />
            ) : (
              <h1 style={hStyles.titleFallback}>{title}</h1>
            )}

            <div style={hStyles.statsRow}>
              {rating && (
                <>
                  <div style={hStyles.statBlock}>
                    <div style={hStyles.statTop}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="#f6c544">
                        <polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" />
                      </svg>
                      <span style={{ ...hStyles.statBig, color: "#f6c544" }} className="display">
                        {rating}
                      </span>
                      <span style={hStyles.statTiny}>/10</span>
                    </div>
                    <div style={hStyles.statLabel}>
                      {ratingRank ? `RATED #${ratingRank}` : "AVERAGE"}
                    </div>
                  </div>
                  <div style={hStyles.statSep} />
                </>
              )}
              {info.favourites != null && (
                <>
                  <div style={hStyles.statBlock}>
                    <div style={hStyles.statTop}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="#ff3b5c">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                      <span style={hStyles.statBig} className="display">
                        {info.favourites.toLocaleString()}
                      </span>
                    </div>
                    <div style={hStyles.statLabel}>
                      FAVORITES{favRank ? ` · #${favRank}` : ""}
                    </div>
                  </div>
                  <div style={hStyles.statSep} />
                </>
              )}
              <div style={hStyles.statBlock}>
                <div style={{ ...hStyles.statTop, color: "var(--txt-1)" }}>
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="m10 9 5 3-5 3z" fill="currentColor" />
                  </svg>
                  <span style={hStyles.statBig} className="display">
                    {epLabel}
                  </span>
                  <span style={hStyles.statTiny}>{durLabel}</span>
                </div>
                <div style={hStyles.statLabel}>{prettyStatus(info.status).toUpperCase()}</div>
              </div>
            </div>

            <div style={hStyles.chipsRow}>
              {(info.genres || []).slice(0, 4).map((g) => (
                <span key={g} style={hStyles.genreChip}>
                  {g}
                </span>
              ))}
              {(studios.length > 0 || producers.length > 0) && (
                <span style={{ width: 1, height: 16, background: "var(--line-2)" }} />
              )}
              {studios.slice(0, 2).map((s) => (
                <span key={s.node.id} style={hStyles.studioChip}>
                  {s.node.name}
                </span>
              ))}
              {studios.length === 0 &&
                producers.slice(0, 2).map((s) => (
                  <span key={s.node.id} style={hStyles.studioChip}>
                    {s.node.name}
                  </span>
                ))}
            </div>
          </div>

          {/* COL 3 — list status + fav + share */}
          <div style={hStyles.rightCol}>
            <div style={hStyles.actionsPanel}>
              <button
                onClick={onOpenListEditor}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "17px 20px",
                  background: `${listColor}1a`,
                  border: `1px solid ${listColor}66`,
                  borderRadius: 13,
                  color: listColor,
                  fontSize: 16,
                  fontWeight: 600,
                  width: "100%",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 5,
                    background: listColor,
                    boxShadow: `0 0 6px ${listColor}b3, 0 0 2px ${listColor}`,
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, textAlign: "left" }}>{list}</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={onToggleFav}
                  style={{
                    flex: "0 0 auto",
                    width: 56,
                    height: 56,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 11,
                    background: fav ? "rgba(255,59,92,0.08)" : "rgba(255,255,255,0.04)",
                    border: fav
                      ? "1px solid rgba(255,59,92,0.3)"
                      : "1px solid var(--line-2)",
                    color: fav ? "var(--accent)" : "var(--txt-1)",
                    cursor: "pointer",
                  }}
                  aria-label={fav ? "Remove from favourites" : "Add to favourites"}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill={fav ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    if (typeof navigator !== "undefined" && navigator.share) {
                      navigator.share({ title, url: window.location.href }).catch(() => {});
                    } else if (typeof navigator !== "undefined") {
                      navigator.clipboard?.writeText(window.location.href);
                      toast.success("Link copied");
                    }
                  }}
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 12,
                    padding: "14px 20px",
                    borderRadius: 11,
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--line-2)",
                    color: "var(--txt-0)",
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                  Share
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function parseEpNumFromWatchUrl(u: string | undefined): number | null {
  if (!u) return null;
  const m = u.match(/[?&]num=(\d+)/);
  return m ? Number(m[1]) : null;
}

const hStyles: Record<string, CSSProperties> = {
  /* Force the hero (and its banner) to span the full viewport width,
     and bleed one extra pixel on each side. On Windows at non-integer
     device-pixel ratios (125%/150%) a sub-pixel seam can appear
     between the navbar layer and the banner layer; the 1px bleed
     hides it without affecting the visible content. */
  hero: {
    position: "relative",
    width: "calc(100% + 2px)",
    marginLeft: -1,
    marginRight: -1,
    borderBottom: "1px solid var(--line)",
  },
  banner: {
    position: "relative",
    width: "100%",
    height: 280,
    overflow: "hidden",
  },
  bannerImg: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center 35%",
  },
  bannerFade: {
    position: "absolute",
    inset: 0,
    /* Banner-to-page fade. Three stops:
         0%   → almost transparent (let the artwork breathe at the top)
         55%  → half-opacity (the area where the title art sits)
         90%  → fully bg-0
         100% → bg-0 + 1px overshoot so the bottom-most pixel row
                matches the page background to the byte (no visible
                seam between banner and the rest of the page). */
    background:
      "linear-gradient(180deg, rgba(12,13,16,0.15) 0%, rgba(12,13,16,0.5) 55%, var(--bg-0) 90%, var(--bg-0) 100%)",
  },
  seasonPill: {
    position: "absolute",
    top: 20,
    right: 28,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    background: "rgba(10,11,16,0.65)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    border: "1px solid rgba(126,200,255,0.3)",
    borderRadius: 999,
    color: "#7ec8ff",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.08em",
  },
  contentWrap: {
    maxWidth: 1380,
    margin: "0 auto",
    padding: "0 28px 36px",
    marginTop: -160,
    position: "relative",
    zIndex: 2,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "240px minmax(0,1fr) auto",
    columnGap: 32,
    alignItems: "stretch",
  },
  leftCol: { display: "flex", flexDirection: "column", gap: 14, alignSelf: "flex-start" },
  cover: {
    width: 240,
    height: "auto",
    display: "block",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.1)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.7)",
    position: "relative",
    zIndex: 3,
  },
  watchBtn: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "15px 17px",
    background: "linear-gradient(135deg, #ff3b5c 0%, #e8294b 100%)",
    borderRadius: 12,
    color: "white",
    boxShadow:
      "0 12px 30px -10px rgba(255,59,92,0.7), inset 0 1px 0 rgba(255,255,255,0.2)",
    cursor: "pointer",
  },
  /* Coming-soon variant: cooler palette so it visually reads as
     "scheduled / informational" rather than the brand-red CTA. No glow
     shadow because there's nothing to click through to. */
  watchBtnDisabled: {
    background: "linear-gradient(135deg, #2b3147 0%, #1a1f30 100%)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
    cursor: "default",
  },
  watchPlay: {
    width: 40,
    height: 40,
    borderRadius: 11,
    background: "rgba(255,255,255,0.18)",
    display: "grid",
    placeItems: "center",
    paddingLeft: 3,
    flexShrink: 0,
  },
  watchLabel: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", opacity: 0.9 },
  watchEp: { fontSize: 14.5, fontWeight: 600 },
  /* Single-line variant for movies / one-shot specials. Larger, fills
     the visual weight that the EP+season line normally provides. */
  watchSingleLabel: {
    fontSize: 16,
    fontWeight: 700,
    letterSpacing: "0.1em",
  },
  centerCol: {
    display: "flex",
    flexDirection: "column",
    gap: 18,
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    paddingTop: 75,
    minWidth: 0,
  },
  titleArt: (() => {
    /* Subtle fade on LEFT + RIGHT + BOTTOM edges, top stays opaque.
       Implementation: three stacked CSS linear-gradient masks with
       `mask-composite: source-in` (= the spec's `intersect`, but the
       `source-in` spelling actually works on Chromium where the
       intersect keyword has been broken for years).

       Each gradient is white in the "keep" band and fades to a very
       dark grey at the cropped edge — never pure black, so the fade
       is a soft hint rather than a chunky vignette. */
    const masks = [
      // left edge fade
      "linear-gradient(to right, #222 0%, #fff 5%, #fff 100%)",
      // right edge fade
      "linear-gradient(to left, #222 0%, #fff 5%, #fff 100%)",
      // bottom edge fade (top stays opaque)
      "linear-gradient(to top, #222 0%, #fff 10%, #fff 100%)",
    ].join(", ");
    return {
      maxHeight: 300,
      maxWidth: "100%",
      width: "auto",
      objectFit: "contain",
      marginTop: -40,
      maskImage: masks,
      WebkitMaskImage: masks,
      maskSize: "100% 100%",
      WebkitMaskSize: "100% 100%",
      maskRepeat: "no-repeat",
      WebkitMaskRepeat: "no-repeat",
      maskMode: "luminance",
      WebkitMaskMode: "luminance",
      // `source-in` = paint the source only where ALL masks are
      // visible. Composite is applied between adjacent layers, so
      // with N sources we need N-1 composite ops — `source-in` for
      // all of them yields the AND of every gradient.
      maskComposite: "intersect",
      WebkitMaskComposite: "source-in",
    } as CSSProperties;
  })(),
  /* No mask: used for `logo` titleImages (stylised title typography)
     where any edge fade would chew letters. */
  titleArtPlain: {
    maxHeight: 300,
    maxWidth: "100%",
    width: "auto",
    objectFit: "contain",
    marginTop: -40,
    filter: "drop-shadow(0 14px 36px rgba(0,0,0,0.7))",
  } as CSSProperties,
  titleFallback: {
    fontSize: 56,
    fontWeight: 800,
    margin: 0,
    marginTop: -20,
    color: "var(--txt-0)",
    letterSpacing: "-0.02em",
    textShadow: "0 14px 36px rgba(0,0,0,0.7)",
    fontFamily: "Space Grotesk, Inter, sans-serif",
    maxWidth: "100%",
    lineHeight: 1.1,
  },
  statsRow: {
    display: "flex",
    alignItems: "center",
    gap: 24,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  statBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    /* Center the icon+number row over the label below it. Asymmetric
       alignment (label left-aligned under a centered icon) looks broken
       — the label has to sit under the visual centroid of the stat. */
    alignItems: "center",
    textAlign: "center",
  },
  statTop: { display: "flex", alignItems: "center", gap: 8 },
  statBig: { fontSize: 22, fontWeight: 700, color: "var(--txt-0)", lineHeight: 1 },
  statTiny: { fontSize: 11.5, color: "var(--txt-2)", fontWeight: 500 },
  statLabel: {
    fontSize: 10,
    color: "var(--txt-3)",
    letterSpacing: "0.1em",
    fontWeight: 600,
    textAlign: "center",
  },
  statSep: { width: 1, height: 40, background: "var(--line)" },
  chipsRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  genreChip: {
    padding: "5px 11px",
    background: "rgba(255,59,92,0.12)",
    border: "1px solid rgba(255,59,92,0.35)",
    borderRadius: 999,
    color: "#ff7a91",
    fontSize: 12,
    fontWeight: 600,
  },
  studioChip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 11px",
    background: "rgba(74,143,255,0.1)",
    border: "1px solid rgba(74,143,255,0.3)",
    borderRadius: 999,
    color: "#7ec8ff",
    fontSize: 12,
    fontWeight: 600,
  },
  rightCol: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignSelf: "stretch",
    paddingTop: 120,
  },
  actionsPanel: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    minWidth: 320,
    alignItems: "stretch",
    paddingTop: 24,
  },
};

// suppress unused compactNumber to keep helpers happy
void compactNumber;
void formatAiredRange;
