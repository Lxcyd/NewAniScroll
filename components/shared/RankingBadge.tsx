import { HeartIcon } from "@heroicons/react/24/solid";

/**
 * Gradient pill like "#49 Popular All Time" — used on anime detail hero.
 */
export default function RankingBadge({
  rank,
  label,
}: {
  rank: number;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-gradient-to-r from-rose-600 to-pink-600 px-3 py-1 text-xs font-bold text-white shadow-glow">
      <HeartIcon className="h-3.5 w-3.5" />
      #{rank} {label}
    </span>
  );
}
