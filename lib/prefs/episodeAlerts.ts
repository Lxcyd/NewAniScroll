/**
 * « Prevenez-moi quand l'episode sort » — le suivi pose depuis la page de
 * lecture, par le bouton de la barre du prochain episode.
 *
 * POURQUOI UN STORE A PART, et pas un ajout a la liste de visionnage. La
 * notification « nouvel episode » existait deja, mais elle ne regarde que les
 * entrees CURRENT de la liste locale (lib/notifications/computeNotifications).
 * Passer par elle voudrait dire ajouter l'anime a la liste au clic — or cette
 * liste se SYNCHRONISE avec AniList (lib/prefs/syncPrefs). Un bouton de rappel
 * ne doit pas ecrire dans le compte de quelqu'un ; il ne promet qu'une chose,
 * et il ne doit faire que celle-la.
 *
 * Ce qu'il fait, tout entier : retenir un identifiant SUR CET APPAREIL. Rien
 * n'est envoye, il n'y a ni abonnement ni service worker (cf. l'en-tete de
 * computeNotifications). L'episode sort pendant que la machine est eteinte ?
 * Il ne se passe rien, et rien ne se perd non plus : la cloche de la navbar
 * compare la progression a la diffusion au moment ou l'on revient, donc
 * l'information attend. Le prix de cette simplicite est dit sans detour — qui
 * n'ouvre jamais le site n'apprend rien.
 *
 * Meme forme que lib/prefs/notifPrefs.ts : une cle, un CustomEvent pour que
 * l'onglet courant se mette a jour, un hook qui rend la valeur vivante.
 */

import { useCallback, useEffect, useState } from "react";

export type EpisodeAlert = {
  mediaId: number;
  /** Retenu au moment du clic : la cloche affiche la ligne sans avoir a
   *  redemander a AniList ce que la page avait deja sous la main. */
  title?: { english?: string | null; romaji?: string | null; native?: string | null } | null;
  coverImage?: string | null;
  /** Episode attendu au moment du clic. Sert de plancher : on ne signale que
   *  ce qui sort APRES la demande, pas les episodes deja diffuses. */
  fromEpisode: number;
  addedAt: number;
};

const KEY = "aniscroll:episodeAlerts";
export const EPISODE_ALERTS_EVENT = "aniscroll:episodeAlerts:change";
/* Plafond : le suivi est un geste leger, on en pose plus qu'on n'en retire.
   Les plus anciens partent en premier — l'ordre des cles fait l'anciennete. */
const MAX_ALERTS = 200;

export function getEpisodeAlerts(): Record<string, EpisodeAlert> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, EpisodeAlert>) : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, EpisodeAlert>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* stockage refuse (navigation privee, quota) — le suivi ne tient pas */
  }
  window.dispatchEvent(new CustomEvent(EPISODE_ALERTS_EVENT));
}

export function isEpisodeAlertOn(mediaId: number): boolean {
  return Boolean(getEpisodeAlerts()[String(mediaId)]);
}

export function addEpisodeAlert(alert: EpisodeAlert): void {
  const all = getEpisodeAlerts();
  delete all[String(alert.mediaId)]; // reinsere en queue
  all[String(alert.mediaId)] = alert;
  const cles = Object.keys(all);
  for (const vieille of cles.slice(0, Math.max(0, cles.length - MAX_ALERTS)))
    delete all[vieille];
  write(all);
}

export function removeEpisodeAlert(mediaId: number): void {
  const all = getEpisodeAlerts();
  if (!all[String(mediaId)]) return;
  delete all[String(mediaId)];
  write(all);
}

/** Le suivi de CET anime, vivant : suit les changements des autres onglets
 *  (`storage`) comme ceux de celui-ci (CustomEvent). */
export function useEpisodeAlert(mediaId: number | null | undefined): {
  actif: boolean;
  bascule: (alert: Omit<EpisodeAlert, "addedAt">) => void;
} {
  const [actif, setActif] = useState(false);
  useEffect(() => {
    if (!mediaId) return;
    const lis = () => setActif(isEpisodeAlertOn(mediaId));
    lis();
    window.addEventListener(EPISODE_ALERTS_EVENT, lis);
    window.addEventListener("storage", lis);
    return () => {
      window.removeEventListener(EPISODE_ALERTS_EVENT, lis);
      window.removeEventListener("storage", lis);
    };
  }, [mediaId]);

  const bascule = useCallback(
    (alert: Omit<EpisodeAlert, "addedAt">) => {
      if (!mediaId) return;
      if (isEpisodeAlertOn(mediaId)) removeEpisodeAlert(mediaId);
      else addEpisodeAlert({ ...alert, addedAt: Date.now() });
    },
    [mediaId],
  );

  return { actif, bascule };
}
