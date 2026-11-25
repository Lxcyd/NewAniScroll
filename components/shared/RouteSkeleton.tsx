import { useEffect, useState } from "react";
import Router from "next/router";
import { peekPreview } from "@/lib/preview/previewStore";
import { getPrefetchedInfo } from "@/lib/watch/infoPrefetch";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useSession } from "next-auth/react";
import { installAnimeDataWarmer, warmOwnProfile } from "@/lib/navigation/warmAnimeData";
import { profileHref } from "@/lib/profile/href";
import { pickAvatar } from "@/lib/auth/avatar";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import WatchSkeleton from "./route-skeletons/WatchSkeleton";
import AnimeSkeleton, { type AnimePeek } from "./route-skeletons/AnimeSkeleton";
import {
  CatalogSkeleton,
  HomeSkeleton,
  ProfileSkeleton,
  ScheduleSkeleton,
  SearchSkeleton,
} from "./route-skeletons/PageSkeletons";

/*
 * Le squelette de navigation.
 *
 * Dans le routeur pages, une page `getServerSideProps` ne s'affiche qu'une fois
 * ses donnees arrivees : jusque-la l'ANCIENNE page reste a l'ecran, figee, avec
 * pour seul signe la barre rose. Sur un MISS (fiche jamais vue, AniList lent)
 * ca peut durer des secondes, et c'est exactement ce que le visiteur ressent
 * comme « le site est lent ».
 *
 * Ce composant couvre cette fenetre, et elle seule : il apparait pendant la
 * navigation et disparait au `routeChangeComplete`, c'est-a-dire au moment
 * precis ou la vraie page se peint. Il ne remplace rien de la page d'arrivee.
 *
 * TOUTES LES PAGES depuis le 25/11/2026 (Luc : « casi instant avec un skeleton
 * preview ») : fiche, lecture, profil, accueil, planning, recherche, listes.
 * La fiche en APERCU REMPLI (route-skeletons/AnimeSkeleton) : le gris vide du
 * 18/09 avait ete retire parce qu'il « faisait bizarre ».
 *
 * APRES 120 MS, JAMAIS AU CLIC. Un clic prechauffe (warmAnimeData, router.sdc)
 * ou servi par le cache Cloudflare se termine en quelques dizaines de ms : il
 * ne doit RIEN montrer, sinon le squelette d'une frame se lit comme un
 * clignotement. Un vrai minuteur et pas seulement un fondu CSS : ce poste est
 * en reduced-motion (memoire poste-reduced-motion), ou le fondu ne joue pas.
 *
 * Exclus : navigations shallow, lecture → lecture (changement d'episode, que
 * EpisodeTransitionOverlay couvre deja en plein ecran), et une page vers
 * elle-meme (recherche affinee, onglet de fiche) : son contenu d'avant vaut
 * mieux qu'un squelette.
 *
 * Monte aussi les prechauffages (lib/navigation/warmAnimeData.ts).
 */

const SHOW_AFTER_MS = 120;

type Target =
  | { kind: "watch"; id: number }
  | { kind: "anime"; id: number }
  | { kind: "profile"; key: string }
  | { kind: "home" }
  | { kind: "schedule" }
  | { kind: "search" }
  | { kind: "catalog"; key: string };

const WATCH_RE = /^\/(?:en|fr)\/anime\/watch\/(\d+)(?:[/?#]|$)/;
const ANIME_RE = /^\/(?:en|fr)\/anime\/(\d+)(?:\/|$)/;
const PROFILE_RE = /^\/(?:en|fr)\/(?:profile\/([^/]+)|my-list)\/?$/;
const HOME_RE = /^\/(?:(?:en|fr)\/?)?$/;
const SCHEDULE_RE = /^\/(?:en|fr)\/schedule\/?$/;
const SEARCH_RE = /^\/(?:en|fr)\/search(?:\/|$)/;
const CATALOG_RE = /^\/(?:en|fr)\/anime\/(popular|trending|recent|recently-watched)\/?$/;

function parseTarget(url: string): Target | null {
  const path = url.split("?")[0].split("#")[0];
  let m: RegExpMatchArray | null;
  if ((m = path.match(WATCH_RE))) return { kind: "watch", id: Number(m[1]) };
  if ((m = path.match(ANIME_RE))) return { kind: "anime", id: Number(m[1]) };
  if ((m = path.match(CATALOG_RE))) return { kind: "catalog", key: m[1] };
  if ((m = path.match(PROFILE_RE))) return { kind: "profile", key: m[1] ?? "my-list" };
  if (HOME_RE.test(path)) return { kind: "home" };
  if (SCHEDULE_RE.test(path)) return { kind: "schedule" };
  if (SEARCH_RE.test(path)) return { kind: "search" };
  return null;
}

function samePage(a: Target, b: Target): boolean {
  if (a.kind !== b.kind) return false;
  if ("id" in a && "id" in b) return a.id === b.id;
  if ("key" in a && "key" in b) return a.key === b.key;
  return true;
}

/* ── Ce que la session sait d'un anime avant sa fiche ── */

/* La carte TOUCHEE : sur mobile il n'y a pas de survol, donc pas d'apercu en
   cache. L'image de la carte (deja affichee, donc deja en cache) et son `alt`
   suffisent a remplir la couverture et le titre. Une seule entree : seul le
   dernier clic compte. */
let lastTouched: { id: number; cover: string | null; title: string | null } | null = null;

function rememberTouchedCard(e: PointerEvent) {
  const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link) return;
  const m = new URL(link.href, location.href).pathname.match(ANIME_RE);
  if (!m) return;
  const img = link.querySelector("img") as HTMLImageElement | null;
  lastTouched = {
    id: Number(m[1]),
    cover: img?.currentSrc || img?.src || null,
    title: img?.alt?.trim() || link.getAttribute("title") || null,
  };
}

function animePeek(id: number, titlePref: any): AnimePeek {
  const p = peekPreview(id);
  const info = getPrefetchedInfo(id);
  const touched = lastTouched?.id === id ? lastTouched : null;
  const titleObj = p?.title ?? info?.title ?? null;
  return {
    title: (titleObj && pickTitle(titleObj, titlePref)) || touched?.title || null,
    banner: p?.bannerImage ?? info?.bannerImage ?? null,
    cover:
      p?.coverImage?.large ??
      info?.coverImage?.extraLarge ??
      info?.coverImage?.large ??
      touched?.cover ??
      null,
    genres: p?.genres ?? info?.genres ?? [],
  };
}

export default function RouteSkeleton() {
  const [target, setTarget] = useState<Target | null>(null);
  const titlePref = useTitlePref();
  const mobile = useIsMobile();
  const { data: session } = useSession();
  const ownProfile = profileHref(session?.user);

  useEffect(() => installAnimeDataWarmer(), []);

  useEffect(() => {
    document.addEventListener("pointerdown", rememberTouchedCard, { capture: true, passive: true });
    return () => document.removeEventListener("pointerdown", rememberTouchedCard, { capture: true });
  }, []);

  /* Le profil du compte connecte, prechauffe des l'ouverture du site : c'est la
     page la plus lente, et l'une des premieres ouvertes. */
  useEffect(() => {
    if (session?.user && ownProfile.startsWith("/en/profile/")) warmOwnProfile(ownProfile);
  }, [session?.user, ownProfile]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const onStart = (url: string, opts?: { shallow?: boolean }) => {
      clear();
      setTarget(null);
      if (opts?.shallow) return;
      const next = parseTarget(url);
      if (!next) return;
      const here = parseTarget(window.location.pathname);
      // Lecture → lecture : changement d'episode, deja couvert ailleurs.
      if (here?.kind === "watch" && next.kind === "watch") return;
      // Une page vers elle-meme : son contenu d'avant reste a l'ecran.
      if (here && samePage(here, next)) return;
      if (next.kind === "search" && here?.kind === "search") return;
      timer = setTimeout(() => setTarget(next), SHOW_AFTER_MS);
    };
    const onEnd = () => {
      clear();
      setTarget(null);
    };
    Router.events.on("routeChangeStart", onStart);
    Router.events.on("routeChangeComplete", onEnd);
    Router.events.on("routeChangeError", onEnd);
    return () => {
      clear();
      Router.events.off("routeChangeStart", onStart);
      Router.events.off("routeChangeComplete", onEnd);
      Router.events.off("routeChangeError", onEnd);
    };
  }, []);

  if (!target) return null;

  let body: React.ReactNode;
  switch (target.kind) {
    case "watch": {
      const known = peekPreview(target.id)?.title ?? getPrefetchedInfo(target.id)?.title ?? null;
      body = <WatchSkeleton title={known ? pickTitle(known, titlePref) : null} />;
      break;
    }
    case "anime":
      body = <AnimeSkeleton peek={animePeek(target.id, titlePref)} mobile={mobile} />;
      break;
    case "profile": {
      const own =
        !!session?.user &&
        (target.key === "my-list" || `/en/profile/${target.key}` === ownProfile);
      body = (
        <ProfileSkeleton
          name={own ? session?.user?.name ?? null : null}
          avatar={own ? pickAvatar(session?.user) : null}
        />
      );
      break;
    }
    case "home":
      body = <HomeSkeleton />;
      break;
    case "schedule":
      body = <ScheduleSkeleton />;
      break;
    case "search":
      body = <SearchSkeleton />;
      break;
    case "catalog":
      body = <CatalogSkeleton />;
      break;
  }

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
      {body}
    </div>
  );
}
