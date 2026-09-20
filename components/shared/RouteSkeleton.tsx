import { useEffect, useState } from "react";
import Router from "next/router";
import Skeleton from "react-loading-skeleton";
import { peekPreview } from "@/lib/preview/previewStore";
import { getPrefetchedInfo } from "@/lib/watch/infoPrefetch";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useSession } from "next-auth/react";
import { installAnimeDataWarmer, warmOwnProfile } from "@/lib/navigation/warmAnimeData";
import { profileHref } from "@/lib/profile/href";

/*
 * Le squelette de navigation.
 *
 * Dans le routeur pages, une page `getServerSideProps` ne s'affiche qu'une fois
 * ses donnees arrivees : jusque-la l'ANCIENNE page reste a l'ecran, figee, avec
 * pour seul signe la barre rose. Sur un MISS (fiche jamais vue, AniList lent)
 * ca peut durer des secondes, et c'est exactement ce que le visiteur ressent
 * comme « le site est lent ».
 *
 * Ce composant couvre cette fenetre, et elle seule : il apparait au
 * `routeChangeStart` vers une page de lecture et disparait au
 * `routeChangeComplete`, c'est-a-dire au moment precis ou la vraie page se
 * peint. Il ne remplace rien de la page d'arrivee. Le titre est pre-rempli avec
 * ce que la session sait deja de l'anime.
 *
 * PAS SUR LA FICHE ANIME (retire le 18/09/2026 a la demande de l'utilisateur :
 * « ca fait bizarre »). Elle est couverte autrement : ses donnees sont
 * prechauffees au survol et remises au routeur, le clic ne les attend plus.
 *
 * Exclus : navigations shallow, et lecture → lecture (changement d'episode, que
 * EpisodeTransitionOverlay couvre deja en plein ecran).
 *
 * Monte aussi les prechauffages (lib/navigation/warmAnimeData.ts).
 */

type Target = { kind: "watch"; id: number };

const WATCH_RE = /^\/(?:en|fr)\/anime\/watch\/(\d+)(?:[/?#]|$)/;

function parseTarget(url: string): Target | null {
  const path = url.split("?")[0].split("#")[0];
  const w = path.match(WATCH_RE);
  return w ? { kind: "watch", id: Number(w[1]) } : null;
}

function knownTitle(id: number): any {
  return peekPreview(id)?.title ?? getPrefetchedInfo(id)?.title ?? null;
}

export default function RouteSkeleton() {
  const [target, setTarget] = useState<Target | null>(null);
  const titlePref = useTitlePref();
  const { data: session } = useSession();
  const ownProfile = profileHref(session?.user);

  useEffect(() => installAnimeDataWarmer(), []);

  /* Le profil du compte connecte, prechauffe des l'ouverture du site : c'est la
     page la plus lente, et l'une des premieres ouvertes. */
  useEffect(() => {
    if (session?.user && ownProfile.startsWith("/en/profile/")) warmOwnProfile(ownProfile);
  }, [session?.user, ownProfile]);

  useEffect(() => {
    const onStart = (url: string, opts?: { shallow?: boolean }) => {
      if (opts?.shallow) return;
      const next = parseTarget(url);
      if (!next) return setTarget(null);
      // Lecture → lecture : changement d'episode, deja couvert ailleurs.
      if (parseTarget(window.location.pathname)) return;
      setTarget(next);
    };
    const onEnd = () => setTarget(null);
    Router.events.on("routeChangeStart", onStart);
    Router.events.on("routeChangeComplete", onEnd);
    Router.events.on("routeChangeError", onEnd);
    return () => {
      Router.events.off("routeChangeStart", onStart);
      Router.events.off("routeChangeComplete", onEnd);
      Router.events.off("routeChangeError", onEnd);
    };
  }, []);

  if (!target) return null;
  const known = knownTitle(target.id);
  const title = known ? pickTitle(known, titlePref) : null;

  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="as-route-skeleton"
      style={{
        position: "fixed",
        inset: 0,
        // Sous la navbar (z-[9999]) et la barre de progression, qui restent
        // visibles et identiques d'une page a l'autre ; au-dessus de tout le
        // reste de l'ancienne page.
        zIndex: 9000,
        overflow: "hidden",
        background: "#0c0d10",
      }}
    >
      <Watch title={title} />
    </div>
  );
}

/* ── Page de lecture : meme grille que #default (lecteur 16/9 dont la largeur
      part de la hauteur d'ecran, liste d'episodes a droite a partir de lg). ── */
function Watch({ title }: { title: string | null }) {
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
