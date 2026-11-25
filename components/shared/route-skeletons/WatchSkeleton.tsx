import Skeleton from "react-loading-skeleton";

/* ── Page de lecture : meme grille que #default (lecteur 16/9 dont la largeur
      part de la hauteur d'ecran, liste d'episodes a droite a partir de lg). ── */
export default function WatchSkeleton({ title }: { title: string | null }) {
  return (
    <div className="mx-auto pt-16 lg:pt-20">
      <div className="lg:max-w-[calc(100%_-_2.25rem)] [--player-col:min(100%_-_26rem,(100dvh_-_143px_-_1.125rem)_*_16_/_9)] lg:grid-cols-[var(--player-col)_minmax(0,1fr)] mx-auto flex w-full flex-col lg:grid">
        <div className="w-full min-w-0">
          <div className="flex-center aspect-video w-full bg-black rounded-card ring-1 ring-white/5" />
          <div className="mt-3 px-3 lg:px-0">
            <Skeleton height={45} borderRadius={12} />
          </div>
          <div className="mt-4 px-3 lg:px-0 lg:hidden">
            {title ? (
              <div className="font-outfit text-xl font-semibold text-white line-clamp-2">{title}</div>
            ) : (
              <Skeleton width="60%" height={24} />
            )}
          </div>
        </div>
        <div className="relative pt-4 lg:pt-0 lg:pl-4 px-3 lg:px-0">
          <div className="hidden lg:block mb-3">
            {title ? (
              <div className="font-outfit text-lg font-semibold text-white line-clamp-1">{title}</div>
            ) : (
              <Skeleton width="70%" height={22} />
            )}
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="mb-2 flex gap-3">
              <Skeleton width={120} height={68} borderRadius={8} />
              <div className="flex-1">
                <Skeleton width="80%" height={14} />
                <Skeleton width="40%" height={12} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
