/**
 * LES SQUELETTES DES ONGLETS DU PROFIL (21/11/2026, Luc : « fait un skeleton
 * preview […] pour que quand on switch de menu ce soit fluide »).
 *
 * Affichés le temps de la PREMIÈRE ouverture d'un onglet (code pas encore
 * chargé, ou premier rendu en cours en arrière-plan) ; ensuite l'onglet reste
 * monté et revient instantanément (pages/en/profile/[user].tsx). Mêmes cartes
 * que le vrai contenu (`as-stat-card`, donc le même flou sur l'illustration) et
 * la même pulsation que le squelette des amis (ProfileFriends).
 */

const Bone = ({ className = "", delay = 0 }: { className?: string; delay?: number }) => (
  <div className={`animate-pulse rounded-lg bg-white/[0.07] ${className}`} style={delay ? { animationDelay: `${delay}ms` } : undefined} />
);

const Card = ({ className = "", children }: { className?: string; children?: React.ReactNode }) => (
  <div className={`as-stat-card rounded-2xl ring-1 ring-white/[0.07] ${className}`}>{children}</div>
);

/** Ma liste : la barre d'outils, un intertitre, des lignes. */
export function ListSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Card className="h-[42px] w-[42px] !rounded-[12px]" />
        <Card className="h-[42px] w-[42px] !rounded-[12px]" />
        <Card className="h-[42px] min-w-[180px] flex-[3_1_220px] !rounded-[12px]" />
        <Card className="h-[42px] min-w-[150px] flex-[2_1_150px] !rounded-[12px]" />
        <Card className="h-[42px] min-w-[150px] flex-[2_1_150px] !rounded-[12px]" />
        <Card className="h-[42px] w-[118px] !rounded-[12px]" />
      </div>
      <div className="flex items-center gap-2.5 px-1">
        <Bone className="h-[11px] w-[11px] !rounded-full" />
        <Bone className="h-4 w-24" />
      </div>
      <Card className="overflow-hidden">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-4 py-2 pl-2 pr-4 shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)] last:shadow-none">
            <Bone className="h-20 w-14 shrink-0" delay={i * 60} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Bone className="h-4 w-1/2 max-w-[320px]" delay={i * 60} />
              <Bone className="h-3.5 w-1/3 max-w-[200px]" delay={i * 60} />
            </div>
            <Bone className="h-8 w-[5.5rem] shrink-0" delay={i * 60} />
            <Bone className="h-8 w-12 shrink-0 max-sm:hidden" delay={i * 60} />
          </div>
        ))}
      </Card>
    </div>
  );
}

/** Aperçu et Statistiques : une grille de cartes de widgets. */
export function GridSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div aria-hidden className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: cards }, (_, i) => (
        <Card key={i} className={`flex flex-col gap-3 p-5 ${i % 3 === 0 ? "h-[300px]" : "h-[240px]"}`}>
          <Bone className="h-4 w-32" delay={i * 70} />
          <Bone className="w-full flex-1" delay={i * 70} />
        </Card>
      ))}
    </div>
  );
}

/** Badges : l'en-tête et ses filtres, puis des lignes de badges. */
export function BadgesSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-2 p-4">
        <Bone className="h-5 w-40" />
        <div className="ml-auto flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Bone key={i} className="h-8 w-20 !rounded-full" delay={i * 60} />
          ))}
        </div>
      </Card>
      <Bone className="ml-1 h-4 w-28" />
      <div className="grid gap-2.5 md:grid-cols-2">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <Card key={i} className="flex items-center gap-4 p-3">
            <Bone className="h-14 w-14 shrink-0 !rounded-full" delay={i * 60} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Bone className="h-4 w-1/2" delay={i * 60} />
              <Bone className="h-3 w-3/4" delay={i * 60} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** Badges, au changement de vue (24/11/2026, Luc) : la forme de la vue
 *  CHOISIE, le temps qu'elle se rende — mêmes hauteurs que ses vraies lignes
 *  (les `contain-intrinsic-size` de `.as-badge-row`, globals.css). */
export function BadgeViewSkeleton({ view }: { view: "cards" | "grid" | "compact" }) {
  const head = (
    <Card className="flex items-center gap-3 !rounded-lg py-2.5 pl-3 pr-4">
      <Bone className="h-5 w-36" />
      <Bone className="h-3 w-48 max-sm:hidden" />
    </Card>
  );
  const body =
    view === "grid" ? (
      <Card className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 p-2.5 sm:p-3">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-[223px] flex-col items-center gap-2 rounded-xl p-2.5 ring-1 ring-white/[.06]">
            <Bone className="h-[84px] w-[84px] !rounded-full" delay={i * 50} />
            <Bone className="h-3.5 w-3/4" delay={i * 50} />
            <Bone className="h-3 w-1/2" delay={i * 50} />
            <Bone className="mt-auto h-1.5 w-full" delay={i * 50} />
          </div>
        ))}
      </Card>
    ) : view === "compact" ? (
      <Card className="overflow-hidden !rounded-xl">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="flex h-[60px] items-center gap-3 px-3 shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)] last:shadow-none">
            <Bone className="h-12 w-12 shrink-0 !rounded-full" delay={i * 50} />
            <Bone className="h-3.5 w-40" delay={i * 50} />
            <Bone className="ml-auto h-1.5 w-1/4" delay={i * 50} />
          </div>
        ))}
      </Card>
    ) : (
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: 5 }, (_, i) => (
          <Card key={i} className="flex h-[118px] items-center gap-4 !rounded-xl p-3">
            <Bone className="h-[100px] w-[100px] shrink-0 !rounded-full" delay={i * 60} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Bone className="h-4 w-1/3" delay={i * 60} />
              <Bone className="h-3 w-2/3" delay={i * 60} />
              <Bone className="mt-1 h-1.5 w-full" delay={i * 60} />
            </div>
          </Card>
        ))}
      </div>
    );
  return (
    <div aria-hidden className="flex min-w-0 flex-col gap-3">
      {head}
      {body}
    </div>
  );
}

/** Amis : la grille de cartes (même forme que le chargement de ProfileFriends). */
export function FriendsSkeleton() {
  return (
    <div aria-hidden className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-[72px] animate-pulse rounded-2xl bg-white/[0.05]" style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  );
}
