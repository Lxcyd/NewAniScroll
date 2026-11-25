import CarouselSkeleton from "@/components/home/CarouselSkeleton";
import { GridSkeleton } from "@/components/profile/TabSkeletons";
import { Bone } from "./Bone";

/*
 * Les squelettes des autres pages, calques sur leur vraie mise en page (memes
 * conteneurs, memes largeurs max, memes marges) : a l'arrivee de la page, les
 * blocs se remplissent sur place au lieu de sauter.
 */

/* ── Accueil (pages/en/index.tsx) : HeroBanner plein ecran + carrousels ── */
export function HomeSkeleton() {
  return (
    <div className="w-screen bg-primary pt-16 lg:pt-0">
      <div className="relative h-[calc(100svh-3rem)] max-h-[900px] min-h-[520px] max-lg:h-[min(74svh,620px)] max-lg:min-h-[460px] w-full overflow-hidden">
        <Bone className="absolute inset-0 !rounded-none !bg-white/[0.04]" />
        <div className="absolute inset-0 bg-gradient-to-t from-primary via-primary/30 to-transparent" />
        <div className="absolute bottom-[12%] left-[5%] flex w-[min(90%,560px)] flex-col gap-4">
          <Bone className="h-12 w-4/5" />
          <div className="flex gap-2">
            <Bone className="h-6 w-16 !rounded-full" />
            <Bone className="h-6 w-20 !rounded-full" delay={60} />
            <Bone className="h-6 w-14 !rounded-full" delay={120} />
          </div>
          <Bone className="h-3 w-full" />
          <Bone className="h-3 w-11/12" delay={60} />
          <Bone className="h-3 w-2/3" delay={120} />
          <div className="mt-2 flex gap-3">
            <Bone className="h-12 w-40 !rounded-full" />
            <Bone className="h-12 w-12 !rounded-full" delay={60} />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-4 pt-6">
        <CarouselSkeleton />
        <CarouselSkeleton />
      </div>
    </div>
  );
}

/* ── Profil (pages/en/profile/[user].tsx) : bande, identite, onglets, widgets.
      La forme varie d'un compte a l'autre (bandeau, vitrine, colonne) : on
      peint la plus courante, et le compte connecte avec son propre avatar. ── */
export function ProfileSkeleton({ name, avatar }: { name: string | null; avatar: string | null }) {
  return (
    <div className="w-full bg-primary">
      <div className="as-hero-band-slim relative w-full overflow-hidden">
        <Bone className="absolute inset-0 !rounded-none !bg-white/[0.04]" />
        <div className="absolute inset-0 bg-gradient-to-t from-primary to-transparent" />
      </div>
      <div className="mx-auto -mt-12 flex w-full max-w-screen-xl items-end gap-4 px-4 pb-5 md:gap-6 md:pb-7">
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" className="relative h-24 w-24 shrink-0 rounded-full object-cover ring-4 ring-primary md:h-32 md:w-32" />
        ) : (
          <Bone className="relative h-24 w-24 shrink-0 !rounded-full md:h-32 md:w-32" />
        )}
        <div className="flex min-w-0 flex-col gap-2 pb-2">
          {name ? (
            <div className="truncate font-outfit text-2xl font-bold text-white md:text-4xl">{name}</div>
          ) : (
            <Bone className="h-8 w-48 md:h-10" />
          )}
          <Bone className="h-4 w-32" delay={60} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-screen-xl px-4 pb-16 pt-10">
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {[96, 88, 104, 80, 92].map((w, i) => (
            <Bone key={i} className="h-10 !rounded-full" style={{ width: w }} delay={i * 50} />
          ))}
        </div>
        <GridSkeleton cards={6} />
      </div>
    </div>
  );
}

/* ── Planning (pages/en/schedule/index.tsx) : jours en texte, puis le jour,
      ses heures et leurs cartes (couverture 50×65 + deux lignes). ── */
export function ScheduleSkeleton() {
  return (
    <div className="w-screen bg-primary">
      <div className="mx-auto mt-16 flex w-full max-w-screen-2xl flex-col gap-10 lg:mt-24">
        <div className="flex gap-5 overflow-hidden px-5">
          {[44, 96, 64, 64, 90, 64, 96, 84].map((w, i) => (
            <Bone key={i} className="h-7 shrink-0" style={{ width: w }} delay={i * 50} />
          ))}
        </div>
        <div className="grid gap-5 px-5">
          <Bone className="h-7 w-32" />
          {[2, 1, 2, 1].map((cards, row) => (
            <div key={row} className="space-y-2">
              <Bone className="ml-4 h-5 w-14" delay={row * 80} />
              <div className="grid gap-5 sm:grid-cols-2 md:gap-7 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: cards }).map((_, i) => (
                  <div key={i} className="ml-4 flex overflow-hidden rounded bg-secondary/70">
                    <Bone className="h-[65px] w-[50px] shrink-0 !rounded-none" delay={row * 80} />
                    <div className="flex flex-1 flex-col justify-center gap-2 p-2">
                      <Bone className="h-3.5 w-4/5" delay={row * 80} />
                      <Bone className="h-3 w-1/2" delay={row * 80} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Recherche (pages/en/search/[...param].tsx) : filtres + grille 2:3 ── */
export function SearchSkeleton() {
  return (
    <div className="min-h-screen w-screen bg-primary py-14 lg:py-24">
      <div className="mx-auto flex max-w-screen-xl flex-col gap-3">
        {/* Libelle au-dessus de chaque filtre, comme InputSelect. */}
        <div className="my-3 flex w-full items-end gap-2 px-5 lg:gap-5 xl:px-0">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={`flex flex-1 flex-col gap-2 ${i > 0 ? "hidden lg:flex" : ""}`}>
              <Bone className="h-4 w-20" delay={i * 50} />
              <Bone className="h-9 w-full" delay={i * 50} />
            </div>
          ))}
          <Bone className="h-9 w-9 shrink-0" delay={250} />
          <Bone className="hidden h-9 w-9 shrink-0 lg:block" delay={300} />
        </div>
        <div className="grid grid-cols-2 gap-5 gap-y-10 px-5 pt-3 xxs:grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:gap-7 xl:px-0">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="w-full">
              <Bone className="w-full !rounded" style={{ aspectRatio: "5 / 7" }} delay={i * 30} />
              <Bone className="mt-4 h-5 w-3/4" delay={i * 30} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Listes (components/anime/CatalogGrid.tsx : populaires, tendances…) ── */
export function CatalogSkeleton() {
  return (
    <div className="flex min-h-screen w-screen flex-col items-center bg-primary px-2 pb-10">
      <div className="w-full px-3 pb-3 pt-5">
        <Bone className="h-7 w-48" />
      </div>
      <div className="grid max-w-6xl grid-cols-2 gap-3 pt-6 xs:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex w-[150px] flex-col items-center lg:w-[180px]">
            <div className="w-full p-2">
              <Bone className="h-[190px] w-[140px] !rounded lg:h-[230px] lg:w-[170px]" delay={i * 30} />
            </div>
            <div className="w-full px-2">
              <Bone className="h-5 w-20" delay={i * 30} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
