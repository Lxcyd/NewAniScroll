import React, { FC } from "react";
import { getFormat } from "@/utils/getFormat";
import { StarIcon, TvIcon } from "@heroicons/react/24/solid";
import GenrePills from "@/components/shared/GenrePills";

interface Info {
  episodes?: number;
  averageScore?: number;
  meanScore?: number;
  format?: string;
  status?: string;
  genres?: string[];
  favourites?: number;
  popularity?: number;
  duration?: number;
}

interface InfoChipProps {
  info: Info;
  color?: any;
  className?: string;
}

/**
 * AniScroll-inspired info row:
 *  - Gold score badge (star)
 *  - Navy episode badge (tv)
 *  - Muted format + status chips
 *  - Pink/red genre pills below
 */
const InfoChip: FC<InfoChipProps> = ({ info, className = "" }) => {
  const score = info?.averageScore ?? info?.meanScore;

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        {score != null && (
          <span className="inline-flex items-center gap-1 rounded-badge bg-as-score px-2 py-1 text-xs font-bold text-black shadow-md">
            <StarIcon className="h-3.5 w-3.5" />
            {score}
          </span>
        )}
        {info?.episodes != null && (
          <span className="inline-flex items-center gap-1 rounded-badge bg-as-episodes px-2 py-1 text-xs font-bold text-white">
            <TvIcon className="h-3.5 w-3.5" />
            {info.episodes} EP
          </span>
        )}
        {info?.format && (
          <span className="inline-flex items-center rounded-badge bg-white/10 px-2 py-1 text-xs font-karla font-semibold text-white/80 ring-1 ring-white/10">
            {getFormat(info.format)}
          </span>
        )}
        {info?.status && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-badge px-2 py-1 text-xs font-karla font-semibold ring-1 ${
              info.status === "RELEASING"
                ? "bg-as-watching/10 text-emerald-400 ring-as-watching/40"
                : info.status === "FINISHED"
                ? "bg-as-completed/10 text-blue-400 ring-as-completed/40"
                : info.status === "NOT_YET_RELEASED"
                ? "bg-as-dropped/10 text-red-400 ring-as-dropped/40"
                : "bg-white/10 text-white/80 ring-white/10"
            }`}
          >
            {info.status === "RELEASING" && (
              <span className="h-1.5 w-1.5 rounded-full as-dot-releasing" />
            )}
            {info.status === "NOT_YET_RELEASED" && (
              <span className="h-1.5 w-1.5 rounded-full as-dot-upcoming" />
            )}
            {info.status.replace(/_/g, " ")}
          </span>
        )}
      </div>
      {info?.genres?.length ? (
        <GenrePills genres={info.genres} variant="inline" max={5} />
      ) : null}
    </div>
  );
};

export default InfoChip;
