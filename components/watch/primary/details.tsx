import { CSSProperties, ReactNode } from "react";
import { useAniList } from "../../../lib/anilist/useAnilist";
import Skeleton from "react-loading-skeleton";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { SessionTypes } from "pages/en";
import Link from "next/link";
import Image from "next/image";
import { useTranslation } from "react-i18next";
import { statusLabel, parseDescription } from "@/components/anime/v2/helpers";
import Recommendations from "@/components/anime/v2/Recommendations";
import styles from "@/components/anime/v2/styles.module.css";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { genreLabel } from "@/lib/i18n/genreLabel";
import { useTranslatedText } from "@/lib/i18n/useTranslatedText";

/* Chips, copied VALUE FOR VALUE from the info page's hero (Hero.tsx
 * hStyles.genreChip / studioChip).
 *
 * They have to be inline styles, not Tailwind classes: `action` is declared in
 * tailwind.config.js as `var(--brand-primary, …)` — a complete colour, not the
 * channel triplet Tailwind needs to inject an alpha. So `bg-action/[0.12]` and
 * `border-action/[0.35]` compile to NOTHING at all, which is why these chips
 * came out as hard red outlines on no background instead of the soft tinted
 * pills the info page shows. color-mix() does the tinting instead, exactly as
 * the info page does it. */
const GENRE_CHIP: CSSProperties = {
  padding: "5px 11px",
  background: "color-mix(in srgb, var(--brand-primary, #ff3b5c) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--brand-primary, #ff3b5c) 35%, transparent)",
  borderRadius: 999,
  color: "color-mix(in srgb, var(--brand-primary, #ff7a91) 75%, #fff)",
  fontSize: 12,
  fontWeight: 600,
};

const STUDIO_CHIP: CSSProperties = {
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
};

type DetailsProps = {
  info: AniListInfoTypes;
  session: SessionTypes;
  epiNumber: number;
  description: string;
  id: string;
  onList: boolean;
  setOnList: (value: boolean) => void;
  handleOpen: () => void;
  /** Title shown at the top of the card — the page owns it because it also
   *  knows the episode being played. */
  title?: ReactNode;
  /** Secondary action buttons (party / share / report) rendered under the
   *  add-to-list CTA. The page keeps their handlers; we only place them. */
  actions?: ReactNode;
};

export default function Details({
  info,
  session,
  epiNumber,
  description,
  id,
  onList,
  setOnList,
  handleOpen,
  title,
  actions,
}: DetailsProps) {
  const { markPlanning } = useAniList(session);
  const { t, i18n } = useTranslation();
  const titlePref = useTitlePref();

  // Same treatment as the info page's Overview: strip the "(Source: …)" tail
  // out of the body and show it as an attribution line, rather than leaving
  // it mid-paragraph.
  const parsed = parseDescription(description);
  // Auto-translate the synopsis into the active UI language (server-cached).
  const localizedDesc = useTranslatedText(parsed.text);

  // AniList lists recommendations as edges around a nullable media node.
  const recs = ((info?.recommendations?.nodes || [])
    .map((n: any) => n?.mediaRecommendation)
    .filter(Boolean) as any[]) || [];

  function handlePlan() {
    if (onList === false) {
      markPlanning(info.id);
      setOnList(true);
    }
  }

  // (The effect that used to reset the "Read more" fold on episode change is
  // gone with the fold itself — there is no expansion state left to reset.)

  // "#278" — AniList's all-time RATED position. Only shown when AniList
  // actually ranks the entry; a computed rank would be a fabrication.
  const rank = info?.rankings?.find(
    (r: any) => r.type === "RATED" && r.allTime,
  )?.rank;
  const score = info?.averageScore ? (info.averageScore / 10).toFixed(2) : null;
  const studio = info?.studios?.edges?.[0]?.node?.name;

  // Episode count, read exactly as the info page reads it: while a show is
  // AIRING the total alone would overstate what you can actually watch, so it
  // becomes "aired/total". `nextAiringEpisode.episode` is the NEXT one to air.
  const airedSoFar = info?.nextAiringEpisode?.episode
    ? Math.max(0, info.nextAiringEpisode.episode - 1)
    : null;
  const epLabel =
    info?.status === "RELEASING"
      ? airedSoFar != null && info?.episodes
        ? `${airedSoFar}/${info.episodes}`
        : airedSoFar != null
          ? `${airedSoFar}+`
          : info?.episodes
            ? `${info.episodes}`
            : "N/A"
      : info?.episodes
        ? `${info.episodes}`
        : "N/A";
  const durLabel = info?.duration ? `EP · ${info.duration}min` : "EP";

  return (
    // `relative z-10`: the player's ambient glow is a positioned layer that
    // overflows well past the player box. A non-positioned sibling paints
    // UNDER it, which is what veiled the add-to-list button — the glow was
    // literally on top of it. Giving the card its own positioned layer puts
    // the light back where it belongs, behind the controls.
    // `font-karla` : rien ici ne declarait de famille, donc tout ce que j'ai
    // repris de la page d'info (stats, pastilles, synopsis, boutons) tombait
    // sur la sans-serif systeme — visiblement etrangere au reste du site, qui
    // est en Karla. La page d'info a son propre Inter parce qu'elle porte ses
    // tokens ; ici c'est la police du site qui fait foi.
    <div className="relative z-10 flex flex-col gap-4 font-karla">
      {/* Wraps rather than squeezes. With a fixed three-column row the stat
          blocks (whose width is their content) ran straight under the action
          buttons as soon as the window narrowed. Now the action column drops
          to its own line before anything overlaps. */}
      <div className="flex flex-wrap gap-5">
        {/* The box carries the size, not the <Image>. next/image renders an
            <img> with width=1000, so without a sized parent it stretches to
            the row's full width — object-cover then shows a wide band of the
            portrait cover (it reads as a banner) and the blown-up flex item
            pushes the rest of the card over the episode column. */}
        <div className="h-[190px] w-[132px] shrink-0 overflow-hidden rounded-poster shadow-poster">
          {info ? (
            <Link href={`/en/anime/${info.id}`}>
              <Image
                src={info.coverImage.extraLarge}
                alt="Anime Cover"
                width={1000}
                height={1000}
                className="h-[190px] w-[132px] object-cover duration-300 ease-out hover:scale-[1.03]"
              />
            </Link>
          ) : (
            <Skeleton height={190} width={132} />
          )}
        </div>

        <div className="flex min-w-0 grow basis-[300px] flex-col gap-3">
          {title}

          {/* Stat blocks, identical to the info page's hero (Hero.tsx): same
              icons, same metric, same caption underneath. The previous version
              invented its own row — a chevron for POPULARITY where the info
              page shows a heart for FAVOURITES — so the same anime reported two
              different numbers depending on the page you were on. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            {score && (
              <>
                <div className="flex flex-col items-center text-center">
                  <div className="flex items-center gap-2">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="#f6c544">
                      <polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" />
                    </svg>
                    <span className="text-[22px] font-bold leading-none text-[#f6c544]">
                      {score}
                    </span>
                    <span className="text-[11.5px] font-medium text-[#8a8fa3]">/10</span>
                  </div>
                  <div className="mt-1.5 text-[10px] font-semibold tracking-[0.1em] text-[#5e6478]">
                    {rank ? t("anime.rated", { rank }) : t("anime.average")}
                  </div>
                </div>
                <div className="h-10 w-px bg-[#252938]" />
              </>
            )}

            {info?.favourites != null && (
              <>
                <div className="flex flex-col items-center text-center">
                  <div className="flex items-center gap-2">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="#ff3b5c">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                    {/* Formatted against the ACTIVE UI language, never the
                        ambient one — see the long note in Hero.tsx: a bare
                        toLocaleString() makes Node and a French browser
                        disagree and costs a full hydration re-render. */}
                    <span className="text-[22px] font-bold leading-none text-[#f4f5f8]">
                      {info.favourites.toLocaleString(i18n.language)}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[10px] font-semibold tracking-[0.1em] text-[#5e6478]">
                    FAVORITES
                  </div>
                </div>
                <div className="h-10 w-px bg-[#252938]" />
              </>
            )}

            <div className="flex flex-col items-center text-center">
              <div className="flex items-center gap-2 text-[#c4c8d4]">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m10 9 5 3-5 3z" fill="currentColor" />
                </svg>
                <span className="text-[22px] font-bold leading-none text-[#f4f5f8]">
                  {epLabel}
                </span>
                <span className="text-[11.5px] font-medium text-[#8a8fa3]">{durLabel}</span>
              </div>
              {info?.status && (
                <div className="mt-1.5 text-[10px] font-semibold tracking-[0.1em] text-[#5e6478]">
                  {statusLabel(t, info.status).toUpperCase()}
                </div>
              )}
            </div>
          </div>

          {/* Same chip vocabulary as the info page's hero: brand-tinted pills
              for genres, then a hairline, then the studio in blue. The order
              matters — the studio is the aside, not the headline. */}
          <div className="flex flex-wrap items-center gap-2">
            {info?.genres?.slice(0, 4).map((item, index) => (
              <span key={index} style={GENRE_CHIP}>
                {genreLabel(t, item)}
              </span>
            ))}
            {studio && (
              <>
                <span className="h-4 w-px bg-[#2f3447]" />
                <span style={STUDIO_CHIP}>{studio}</span>
              </>
            )}
          </div>
        </div>

        {/* Action column — the add-to-list CTA is the one thing a viewer is
            here to do besides watching, so it gets the full-width button. */}
        <div className="flex shrink-0 grow basis-[210px] flex-col gap-2 lg:grow-0 lg:basis-[210px]">
          <button
            type="button"
            onClick={() => (session ? handlePlan() : handleOpen())}
            className={`w-full rounded-[11px] px-5 py-3.5 text-[15px] font-semibold transition-colors ${
              onList
                ? "border border-[#2f3447] bg-white/[0.04] text-[#c4c8d4]"
                : "border border-action bg-action text-white hover:brightness-110"
            }`}
          >
            {onList ? t("anime.inYourList") : `+ ${t("anime.addToList")}`}
          </button>
          {actions}
        </div>
      </div>

      {/* Synopsis — info-page typography (14px / 1.65, --txt-1) on the same
          panel treatment as the rest of the card. Shown WHOLE: there is no
          "read more" fold. The page is already scrolled past the player by
          anyone reading this far, and a fold on a paragraph of four lines
          bought nothing but a click. */}
      <div className="rounded-xl bg-as-card/60 ring-1 ring-white/[0.06]">
        {info && (
          <div className="p-5">
            <p
              className="m-0 text-sm leading-[1.65] text-[#c4c8d4]"
              style={{ textWrap: "pretty" } as any}
              dangerouslySetInnerHTML={{ __html: localizedDesc }}
            />
            {parsed.source && (
              <div className="mt-2.5 text-[11px] text-[#5e6478]">
                <em>
                  {t("anime.source")} · {parsed.source}
                </em>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recommendations — the info page's own carousel, not a copy of it.
          It reads the v2 design tokens, which live scoped to that page's
          `.root`; `styles.tokens` carries them WITHOUT the page furniture
          (background, 100vh floor), so the rail renders here identically. */}
      {recs.length > 0 && (
        <div className={`min-w-0 ${styles.tokens}`}>
          <Recommendations
            items={recs}
            forTitle={pickTitle(info.title, titlePref) || t("anime.thisAnime")}
          />
        </div>
      )}
      {/* Comments removed — Disqus showed a hard-to-debug "moderator" error
          for visitors and added a third-party tracker we don't need. */}
    </div>
  );
}
