import { ImageResponse } from "@vercel/og";

export const config = {
  runtime: "edge",
};

const karla = fetch(
  new URL("../../assets/Karla-MediumItalic.ttf", import.meta.url)
).then((res) => res.arrayBuffer());
const outfit = fetch(
  new URL("../../assets/Outfit-Regular.ttf", import.meta.url)
).then((res) => res.arrayBuffer());

const ACCENT_FALLBACK = "#E94560";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Render scale. The card's layout below is authored at 1× = 1200×630, the
 * canonical Open-Graph size every platform expects.
 *
 * This used to be hard-coded at 1.5× (1800×945) for extra crispness after
 * Discord/X downscale on hi-DPI screens. Measured cost of that choice: ~4.5s
 * of Active CPU per render — 23% of the whole month's Fluid CPU budget for
 * only 8 invocations in a 12h window, by far the worst per-call route on the
 * site. Satori hands off to resvg, whose rasterisation (and especially the
 * Gaussian blur on the banner) scales with pixel count, and 1.5× is 2.25× the
 * pixels.
 *
 * Bumping this back to 1.5 restores the old output in one edit — but keep the
 * og:image:width/height meta in pages/en/anime/[...id].tsx in sync, and know
 * that a 2× render was already found to fail intermittently and make the
 * embed vanish entirely.
 */
const SCALE = 1;
const CARD_W = Math.round(1200 * SCALE);
const CARD_H = Math.round(630 * SCALE);
/** Scale a 1×-authored length to the current render scale. */
const s = (n: number) => Math.round(n * SCALE);

/**
 * Dynamic Open-Graph card for an anime.
 *
 * Rendered into the `<meta og:image>` of the anime info page, so when a user
 * shares the page link on Discord / X / Slack / etc. the unfurled embed shows
 * a polished card instead of a bare URL. Layout: blurred banner background,
 * the cover image standing on the LEFT, then title + meta + genres + score on
 * the right. All inputs come from query params so the card is fully driven by
 * the page that links to it.
 *
 * Query params:
 *   title    — anime title (required-ish; falls back to "AniScroll")
 *   cover    — cover image URL (drawn on the left)
 *   banner   — banner image URL (blurred background; falls back to cover)
 *   score    — AniList averageScore 0-100 (rendered as x.x / 10)
 *   year     — release year
 *   format   — TV / MOVIE / ...
 *   episodes — episode count
 *   genres   — comma-separated genre list (first 3 shown)
 *   accent   — hex brand colour (#rrggbb), defaults to AniScroll rose
 */
export default async function handler(request: any) {
  const Karla = await karla;
  const Outfit = await outfit;

  const { searchParams } = request.nextUrl;

  const rawTitle = searchParams.get("title") || "AniScroll";
  const title = rawTitle.length > 80 ? rawTitle.slice(0, 80) + "…" : rawTitle;
  // `image` kept as an alias for backwards compatibility with old links.
  const cover = searchParams.get("cover") || searchParams.get("image") || "";
  const banner = searchParams.get("banner") || cover;
  const accentParam = searchParams.get("accent") || "";
  const accent = HEX_RE.test(accentParam) ? accentParam : ACCENT_FALLBACK;

  const scoreNum = Number(searchParams.get("score"));
  const score =
    Number.isFinite(scoreNum) && scoreNum > 0
      ? (scoreNum / 10).toFixed(1)
      : null;
  const year = searchParams.get("year") || "";
  const format = searchParams.get("format") || "";
  const episodes = searchParams.get("episodes") || "";
  const genres = (searchParams.get("genres") || "")
    .split(",")
    .map((g: string) => g.trim())
    .filter(Boolean)
    .slice(0, 3);

  const meta = [year, format, episodes ? `${episodes} ep` : ""]
    .filter(Boolean)
    .join("   ·   ");

  // Layout is authored at 1× (1200×630) and multiplied through `s()` — see the
  // SCALE constant above for why, and for how to revert.
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          position: "relative",
          background: "#0b0d14",
          fontFamily: "Karla",
        }}
      >
        {/* Blurred banner background */}
        {banner ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={banner}
            alt=""
            width={s(1280)}
            height={s(710)}
            style={{
              position: "absolute",
              top: s(-40),
              left: s(-40),
              width: s(1280),
              height: s(710),
              objectFit: "cover",
              // Blur radius scales with the render, otherwise the background
              // reads as a different image at a different SCALE. This filter is
              // the single most expensive operation in the render — resvg's
              // Gaussian blur touches every pixel of a full-bleed image.
              filter: `blur(${s(8)}px) brightness(0.4)`,
            }}
          />
        ) : null}
        {/* Left→right darkening for text legibility */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            background:
              "linear-gradient(90deg, rgba(8,10,16,0.97) 0%, rgba(8,10,16,0.82) 45%, rgba(8,10,16,0.45) 100%)",
          }}
        />

        {/* Content row */}
        <div
          style={{
            display: "flex",
            position: "relative",
            width: "100%",
            height: "100%",
            alignItems: "center",
            padding: `${s(56)}px`,
          }}
        >
          {/* Cover (left) */}
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt=""
              width={s(300)}
              height={s(430)}
              style={{
                width: s(300),
                height: s(430),
                objectFit: "cover",
                borderRadius: s(18),
                boxShadow: `0 ${s(24)}px ${s(60)}px rgba(0,0,0,0.6)`,
              }}
            />
          ) : null}

          {/* Text column */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginLeft: cover ? s(48) : 0,
              flex: 1,
              height: "100%",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: s(30),
                letterSpacing: SCALE,
                fontFamily: "Outfit",
                color: accent,
                fontWeight: 700,
              }}
            >
              AniScroll
            </div>

            <div
              style={{
                display: "flex",
                fontSize: title.length > 38 ? s(54) : s(66),
                lineHeight: 1.05,
                color: "#ffffff",
                fontFamily: "Outfit",
                fontWeight: 700,
                marginTop: s(18),
                maxWidth: s(720),
              }}
            >
              {title}
            </div>

            {meta ? (
              <div
                style={{
                  display: "flex",
                  fontSize: s(30),
                  color: "rgba(255,255,255,0.72)",
                  marginTop: s(22),
                }}
              >
                {meta}
              </div>
            ) : null}

            {genres.length ? (
              <div style={{ display: "flex", marginTop: s(26) }}>
                {genres.map((g: string) => (
                  <div
                    key={g}
                    style={{
                      display: "flex",
                      fontSize: s(24),
                      color: "rgba(255,255,255,0.9)",
                      background: "rgba(255,255,255,0.1)",
                      border: `${Math.max(1, s(1.5))}px solid rgba(255,255,255,0.16)`,
                      borderRadius: 999,
                      padding: `${s(8)}px ${s(20)}px`,
                      marginRight: s(14),
                    }}
                  >
                    {g}
                  </div>
                ))}
              </div>
            ) : null}

            {score ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  marginTop: s(34),
                }}
              >
                <div
                  style={{
                    display: "flex",
                    fontSize: s(64),
                    fontFamily: "Outfit",
                    fontWeight: 700,
                    color: accent,
                    lineHeight: 1,
                  }}
                >
                  {score}
                </div>
                <div
                  style={{
                    display: "flex",
                    fontSize: s(26),
                    color: "rgba(255,255,255,0.55)",
                    marginLeft: s(8),
                    marginBottom: s(6),
                  }}
                >
                  / 10
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    ),
    {
      width: CARD_W,
      height: CARD_H,
      fonts: [
        { name: "Karla", data: Karla, style: "normal" },
        { name: "Outfit", data: Outfit, style: "normal" },
      ],
      // The card is deterministic for a given query string, so let the CDN (and
      // the sharing platform's unfurl bot) hold it: an edge HIT never re-runs
      // the ~4.6s Satori render. A day at the edge with a week of SWR keeps the
      // renderer cold for a shared link while a score/episode bump still lands
      // within a day. (This is the edge runtime, not Fluid — a correctness win,
      // not part of the Fluid CPU fix.)
      headers: {
        "Cache-Control":
          "public, no-transform, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
      },
    }
  );
}
