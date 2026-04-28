import Link from "next/link";
import Image from "next/image";
import { StarIcon, TvIcon } from "@heroicons/react/24/solid";

type Anime = {
  id: number | string;
  title?: { romaji?: string; english?: string; native?: string };
  coverImage?: { extraLarge?: string; large?: string; medium?: string; color?: string } | string;
  image?: string;
  averageScore?: number;
  meanScore?: number;
  episodes?: number;
  status?: string; // RELEASING, NOT_YET_RELEASED, FINISHED, etc.
  nextAiringEpisode?: { episode?: number; timeUntilAiring?: number };
};

type Size = "sm" | "md" | "lg";

const SIZE: Record<Size, { w: string; h: string; titleSize: string }> = {
  sm: { w: "w-[120px]", h: "h-[180px]", titleSize: "text-xs" },
  md: { w: "w-[150px] lg:w-[180px]", h: "h-[225px] lg:h-[270px]", titleSize: "text-sm" },
  lg: { w: "w-[180px] lg:w-[220px]", h: "h-[270px] lg:h-[330px]", titleSize: "text-base" },
};

function getCover(anime: Anime): string | null {
  if (typeof anime.coverImage === "string") return anime.coverImage;
  if (anime.coverImage?.extraLarge) return anime.coverImage.extraLarge;
  if (anime.coverImage?.large) return anime.coverImage.large;
  return anime.image || null;
}

/**
 * AniScroll-inspired anime card.
 * - 2:3 poster with deep shadow
 * - Gold score badge top-left, navy episodes badge top-right
 * - Pulsing status dot (green releasing / red upcoming) bottom-right
 * - Title below image with 2-line clamp
 */
export default function AnimeCard({
  anime,
  href,
  size = "md",
  showTitle = true,
}: {
  anime: Anime;
  href?: string;
  size?: Size;
  showTitle?: boolean;
}) {
  const cover = getCover(anime);
  const title =
    anime.title?.english || anime.title?.romaji || anime.title?.native || "Anime";
  const score = anime.averageScore ?? anime.meanScore ?? null;
  const epCount = anime.episodes ?? null;
  const statusDot =
    anime.status === "RELEASING"
      ? "as-dot-releasing"
      : anime.status === "NOT_YET_RELEASED"
      ? "as-dot-upcoming"
      : null;

  const linkHref = href || `/en/anime/${anime.id}`;
  const { w, h, titleSize } = SIZE[size];

  const cardInner = (
    <div className={`relative shrink-0 ${w} group`}>
      <div
        className={`relative ${w} ${h} overflow-hidden rounded-poster shadow-poster bg-as-card transition-transform duration-300 ease-out group-hover:scale-[1.03]`}
      >
        {cover && (
          <Image
            src={cover}
            alt={title}
            fill
            sizes="(max-width: 1024px) 150px, 220px"
            className="object-cover"
            draggable={false}
          />
        )}

        {/* Bottom gradient for legibility */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[45%] bg-gradient-to-t from-black/85 via-black/40 to-transparent" />

        {/* Score badge */}
        {score != null && (
          <div className="absolute left-1.5 top-1.5 flex items-center gap-0.5 rounded-badge bg-as-score px-1.5 py-0.5 text-[11px] font-bold text-black shadow-md">
            <StarIcon className="h-3 w-3" />
            <span className="leading-none">{score}</span>
          </div>
        )}

        {/* Episodes badge */}
        {epCount != null && (
          <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-badge bg-as-episodes/95 px-1.5 py-0.5 text-[11px] font-bold text-white shadow-md">
            <TvIcon className="h-3 w-3" />
            <span className="leading-none">{epCount}</span>
          </div>
        )}

        {/* Status dot */}
        {statusDot && (
          <span
            className={`absolute bottom-2 right-2 h-2.5 w-2.5 rounded-full ${statusDot}`}
            aria-label={anime.status}
          />
        )}
      </div>

      {showTitle && (
        <div className={`mt-2 line-clamp-2 font-karla font-semibold text-white/90 ${titleSize}`}>
          {title}
        </div>
      )}
    </div>
  );

  return (
    <Link href={linkHref} title={title} className="outline-none">
      {cardInner}
    </Link>
  );
}
