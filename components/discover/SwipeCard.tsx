import Image from "next/image";
import Link from "next/link";
import { motion, useMotionValue, useTransform, PanInfo } from "framer-motion";
import { StarIcon, TvIcon, PlayIcon, InformationCircleIcon } from "@heroicons/react/24/solid";
import GenrePills from "@/components/shared/GenrePills";

export type SwipeAnime = {
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
  duration?: number | null;
};

type Props = {
  anime: SwipeAnime;
  isTop: boolean;
  onSwipe: (direction: "left" | "right") => void;
};

const SWIPE_THRESHOLD = 140; // pixels of drag to trigger a swipe

export default function SwipeCard({ anime, isTop, onSwipe }: Props) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-250, 0, 250], [-18, 0, 18]);
  const opacityRight = useTransform(x, [0, 60, 160], [0, 0.35, 0.85]);
  const opacityLeft = useTransform(x, [-160, -60, 0], [0.85, 0.35, 0]);

  const handleDragEnd = (_e: any, info: PanInfo) => {
    if (info.offset.x > SWIPE_THRESHOLD || info.velocity.x > 500) {
      onSwipe("right");
    } else if (info.offset.x < -SWIPE_THRESHOLD || info.velocity.x < -500) {
      onSwipe("left");
    }
  };

  const title =
    anime.title?.english || anime.title?.romaji || anime.title?.native || "Anime";
  const cover = anime.coverImage?.extraLarge || anime.coverImage?.large;
  const banner = anime.bannerImage || cover;
  const year = anime.seasonYear;
  const seasonLabel =
    anime.season && year
      ? `${anime.season.charAt(0) + anime.season.slice(1).toLowerCase()} ${year}`
      : year
      ? String(year)
      : "";

  return (
    <motion.div
      className={`absolute inset-0 flex items-center justify-center ${
        isTop ? "cursor-grab active:cursor-grabbing" : "pointer-events-none"
      }`}
      style={{ x: isTop ? x : 0, rotate: isTop ? rotate : 0, zIndex: isTop ? 10 : 1 }}
      drag={isTop ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.85}
      onDragEnd={handleDragEnd}
      initial={{ scale: isTop ? 1 : 0.95, opacity: isTop ? 1 : 0.6 }}
      animate={{ scale: isTop ? 1 : 0.95, opacity: isTop ? 1 : 0.6 }}
      transition={{ type: "spring", stiffness: 260, damping: 24 }}
    >
      <div className="relative h-full w-full max-w-md overflow-hidden rounded-card bg-as-card shadow-poster ring-1 ring-white/5">
        {/* Background banner */}
        {banner && (
          <Image
            src={banner}
            alt={title}
            fill
            sizes="(max-width: 768px) 100vw, 500px"
            priority={isTop}
            className="object-cover opacity-40 blur-sm"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 to-black/30" />

        {/* Swipe feather overlays */}
        {isTop && (
          <>
            <motion.div
              className="as-feather-right pointer-events-none absolute inset-0"
              style={{ opacity: opacityRight }}
            />
            <motion.div
              className="as-feather-left pointer-events-none absolute inset-0"
              style={{ opacity: opacityLeft }}
            />
            <motion.div
              className="pointer-events-none absolute left-6 top-6 rotate-[-18deg] rounded-lg border-2 border-red-500 px-4 py-2 font-karla text-xl font-extrabold uppercase tracking-widest text-red-400"
              style={{ opacity: opacityLeft }}
            >
              Pass
            </motion.div>
            <motion.div
              className="pointer-events-none absolute right-6 top-6 rotate-[18deg] rounded-lg border-2 border-emerald-500 px-4 py-2 font-karla text-xl font-extrabold uppercase tracking-widest text-emerald-400"
              style={{ opacity: opacityRight }}
            >
              Plan
            </motion.div>
          </>
        )}

        {/* Foreground content */}
        <div className="relative z-10 flex h-full flex-col items-center justify-end gap-4 px-6 pb-8 pt-8 text-white">
          {/* Poster */}
          {cover && (
            <div className="relative h-[340px] w-[230px] overflow-hidden rounded-poster shadow-poster">
              <Image
                src={cover}
                alt={title}
                fill
                sizes="230px"
                draggable={false}
                priority={isTop}
                className="object-cover"
              />
            </div>
          )}

          {/* Title + year */}
          <div className="w-full text-center">
            <h2 className="font-outfit text-2xl font-extrabold leading-tight line-clamp-2">
              {title}
            </h2>
            {seasonLabel && (
              <p className="mt-1 font-karla text-xs uppercase tracking-wider text-white/60">
                {seasonLabel}
              </p>
            )}
          </div>

          {/* Genres */}
          {anime.genres?.length ? (
            <GenrePills genres={anime.genres} variant="inline" max={4} />
          ) : null}

          {/* Stats row */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {anime.averageScore != null && (
              <span className="inline-flex items-center gap-1 rounded-badge bg-as-score px-2 py-1 text-xs font-bold text-black">
                <StarIcon className="h-3.5 w-3.5" />
                {anime.averageScore}
              </span>
            )}
            {anime.episodes != null && (
              <span className="inline-flex items-center gap-1 rounded-badge bg-as-episodes px-2 py-1 text-xs font-bold text-white">
                <TvIcon className="h-3.5 w-3.5" />
                {anime.episodes} EP
              </span>
            )}
          </div>

          {/* Description (truncated) */}
          {anime.description && (
            <p
              className="max-h-[84px] overflow-hidden text-center font-karla text-xs leading-relaxed text-white/70"
              dangerouslySetInnerHTML={{
                __html:
                  anime.description.length > 240
                    ? anime.description.slice(0, 240).replace(/<[^>]+>/g, "") + "…"
                    : anime.description.replace(/<[^>]+>/g, ""),
              }}
            />
          )}

          {/* Action row */}
          <div className="flex w-full items-center justify-center gap-3 pt-2">
            <Link
              href={`/en/anime/${anime.id}`}
              className="inline-flex items-center gap-1.5 rounded-pill bg-white/10 px-4 py-2 text-xs font-karla font-semibold text-white ring-1 ring-white/10 transition-colors hover:bg-white/20"
            >
              <InformationCircleIcon className="h-4 w-4" />
              Info
            </Link>
            <Link
              href={`/en/anime/watch/${anime.id}/megaplay?id=megaplay-${anime.id}-1&num=1&info=${anime.id}&info=megaplay`}
              className="inline-flex items-center gap-1.5 rounded-pill bg-as-accent px-4 py-2 text-xs font-karla font-bold text-white shadow-glow transition-transform hover:scale-105"
            >
              <PlayIcon className="h-4 w-4" />
              Watch Now
            </Link>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
