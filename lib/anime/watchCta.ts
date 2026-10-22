/**
 * Le bouton « Regarder » de la fiche anime : son libelle, sa cible, et ce qu'on
 * prechauffe quand la main s'en approche.
 *
 * Partage par la fiche PC (components/anime/v2/Hero.tsx) et la fiche mobile
 * (components/anime/v2/mobile/InfoPageMobile.tsx). La version mobile avait sa
 * propre copie, qui avait derive : un anime pas encore sorti y menait a un
 * episode 1 inexistant (404), un anime termine a l'episode « progression + 1 »
 * (29 sur 28) au lieu de reprendre au debut.
 */
import type { NextRouter } from "next/router";
import type { TFunction } from "i18next";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { slugifyTitle } from "@/components/anime/v2/helpers";
import { DEFAULT_SERVER_ID } from "@/lib/servers";
import { prefetchEpisodeList } from "@/lib/watch/episodePrefetch";
import { preloadPlayerCode } from "@/lib/watch/playerCode";
import { getPlannedServer, getPrefetchedSource, sourceKey } from "@/lib/watch/sourcePrefetch";
import { preconnectOrigin } from "@/lib/watch/streamUrl";
import { warmVidmolyClient } from "@/lib/clientVidmoly";

export function parseEpNumFromWatchUrl(url?: string): number | null {
  if (!url) return null;
  const m = url.match(/[?&]num=(\d+)/);
  return m ? Number(m[1]) : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type WatchCta = {
  /** Pas encore diffuse : pas d'episode a lire, le bouton annonce la date. */
  isNotYetReleased: boolean;
  /** Termine dans la liste de l'utilisateur : on reprend a l'episode 1. */
  isCompleted: boolean;
  label: string;
  href: string;
  epNum: number;
  /** « Oct 4, 2026 » (ou « Oct 2026 », « 2026 ») pour un anime a venir. */
  comingSoonLine: string | null;
};

export function watchCta(
  info: AniListInfoTypes,
  watchUrl: string | undefined,
  statusLabel: string | null,
  t: TFunction,
): WatchCta {
  const isNotYetReleased = info.status === "NOT_YET_RELEASED";
  const isCompleted = statusLabel === "COMPLETED";
  const label = isNotYetReleased
    ? t("anime.comingSoonCta")
    : isCompleted
    ? t("anime.rewatchCta")
    : t("anime.watchNowCta");
  const epNum = isCompleted ? 1 : parseEpNumFromWatchUrl(watchUrl) ?? 1;
  // Le `?id=` est cosmetique mais nomme un hote : il vient de DEFAULT_SERVER_ID
  // (lib/prefs/clickTarget.ts), jamais ecrit en dur.
  const watchSlug = slugifyTitle(info?.title) || "watch";
  const epUn = `/en/anime/watch/${info.id}/${watchSlug}?id=${DEFAULT_SERVER_ID}-${info.id}-1&num=1`;
  const href = isNotYetReleased ? "#" : isCompleted ? epUn : watchUrl || epUn;

  let comingSoonLine: string | null = null;
  if (isNotYetReleased) {
    const airingAt = info.nextAiringEpisode?.airingAt;
    if (airingAt) {
      const d = new Date(airingAt * 1000);
      comingSoonLine = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    } else if (info.startDate?.year) {
      const sd = info.startDate;
      const month = sd.month ? MONTHS[sd.month - 1] : null;
      comingSoonLine = month ? `${month} ${sd.year}` : String(sd.year);
    }
  }
  return { isNotYetReleased, isCompleted, label, href, epNum, comingSoonLine };
}

/**
 * Prechauffe le chemin de lecture des que la main montre l'intention de
 * regarder (survol, appui) : la route, le code du lecteur, la liste des
 * episodes, et l'embed du lecteur prevu (son jeton est lie a l'IP et a
 * l'instant, celui de la page info se perime en 60 s). Rien qui coute un appel
 * a nos fonctions — cf. le commentaire d'origine dans Hero.tsx.
 */
export function warmWatchPath(
  info: AniListInfoTypes,
  cta: WatchCta,
  router: NextRouter,
): void {
  if (cta.isNotYetReleased || !info?.id) return;
  try {
    router.prefetch(cta.href);
  } catch {}
  preloadPlayerCode();
  try {
    const srv = getPlannedServer(info.id);
    if (srv) {
      const data = getPrefetchedSource(sourceKey(info.id, cta.epNum, srv, "sub"));
      const ce = data?.clientExtract;
      if (ce?.type === "vidmoly" && ce.embedUrl) {
        preconnectOrigin(ce.embedUrl);
        warmVidmolyClient(ce.embedUrl);
      }
    }
  } catch {}
  void prefetchEpisodeList(info.id, {
    releasing: (info as any)?.status === "RELEASING",
    priority: "high",
  });
}
