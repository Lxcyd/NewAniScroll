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

  // Render at 1.5× (1800×945) so the card stays crisp after Discord/X downscale
  // on hi-DPI screens, while staying well within @vercel/og (Satori) limits —
  // a heavier 2× render with a big blurred banner intermittently failed and
  // made the embed vanish. NOTE: keep the og:image:width/height meta in sync
  // with these on the page (1800×945, same 1.905:1 ratio).
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
            width={1920}
            height={1065}
            style={{
              position: "absolute",
              top: -60,
              left: -60,
              width: 1920,
              height: 1065,
              objectFit: "cover",
              filter: "blur(12px) brightness(0.4)",
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
            padding: "84px",
          }}
        >
          {/* Cover (left) */}
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt=""
              width={450}
              height={645}
              style={{
                width: 450,
                height: 645,
                objectFit: "cover",
                borderRadius: 27,
                boxShadow: "0 36px 90px rgba(0,0,0,0.6)",
              }}
            />
          ) : null}

          {/* Text column */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginLeft: cover ? 72 : 0,
              flex: 1,
              height: "100%",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 45,
                letterSpacing: 1.5,
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
                fontSize: title.length > 38 ? 81 : 99,
                lineHeight: 1.05,
                color: "#ffffff",
                fontFamily: "Outfit",
                fontWeight: 700,
                marginTop: 27,
                maxWidth: 1080,
              }}
            >
              {title}
            </div>

            {meta ? (
              <div
                style={{
                  display: "flex",
                  fontSize: 45,
                  color: "rgba(255,255,255,0.72)",
                  marginTop: 33,
                }}
              >
                {meta}
              </div>
            ) : null}

            {genres.length ? (
              <div style={{ display: "flex", marginTop: 39 }}>
                {genres.map((g: string) => (
                  <div
                    key={g}
                    style={{
                      display: "flex",
                      fontSize: 36,
                      color: "rgba(255,255,255,0.9)",
                      background: "rgba(255,255,255,0.1)",
                      border: "2px solid rgba(255,255,255,0.16)",
                      borderRadius: 999,
                      padding: "12px 30px",
                      marginRight: 21,
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
                  marginTop: 51,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    fontSize: 96,
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
                    fontSize: 39,
                    color: "rgba(255,255,255,0.55)",
                    marginLeft: 12,
                    marginBottom: 9,
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
      width: 1800,
      height: 945,
      fonts: [
        { name: "Karla", data: Karla, style: "normal" },
        { name: "Outfit", data: Outfit, style: "normal" },
      ],
    }
  );
}
