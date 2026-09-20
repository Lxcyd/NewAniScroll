/**
 * "When I click an anime, where do I land?" preference (local, per-device).
 *
 * Same pattern as the other prefs (lib/prefs/syncPrefs.ts): one localStorage
 * key, a CustomEvent for same-tab notification, and a hook returning the live
 * value.
 *
 *   - "info"  (default) → the anime info page (/en/anime/{id}).
 *   - "watch"           → straight into episode 1 via the site-default player.
 *
 * A "watch" link needs a provider + episode (unlike the info page), so we build
 * the same minimal URL the home page / swipe deck already use for "jump
 * straight in" — voir `watchHref` plus bas, la SEULE fabrique de ces liens.
 */

import { useEffect, useState } from "react";
import { peekLocalEntry } from "@/lib/list/localList";
import { DEFAULT_SERVER_ID } from "@/lib/servers";

export type ClickTarget = "info" | "watch";

export const DEFAULT_CLICK_TARGET: ClickTarget = "info";

const KEY = "aniscroll:clickTarget";
export const CLICK_TARGET_EVENT = "aniscroll:clickTarget:change";

export function getClickTarget(): ClickTarget {
  if (typeof window === "undefined") return DEFAULT_CLICK_TARGET;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === "watch" || raw === "info" ? raw : DEFAULT_CLICK_TARGET;
  } catch {
    return DEFAULT_CLICK_TARGET;
  }
}

export function setClickTarget(next: ClickTarget): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(CLICK_TARGET_EVENT));
}

/**
 * Pick which episode a "watch" link should open. If the user has local
 * progress on this anime we resume at the NEXT unwatched episode (progress + 1),
 * capped to `total` when known; a fully-watched anime restarts at 1 (rewatch).
 * No progress → episode 1.
 */
function resumeEpisode(id: number | string): number {
  const n = Number(id);
  if (!Number.isFinite(n)) return 1;
  const entry = peekLocalEntry(n);
  const progress = entry?.progress ?? 0;
  if (progress <= 0) return 1;
  const total = entry?.total ?? null;
  // Finished (or beyond) → rewatch from the start.
  if (total != null && progress >= total) return 1;
  return progress + 1;
}

/**
 * Le lien « ouvrir cet anime dans le lecteur », fabrique a UN SEUL endroit.
 *
 * Le `?id=` est un identifiant d'episode purement cosmetique : la page de
 * lecture derive sa vraie cle de l'anime et du numero, et choisit son lecteur
 * d'apres les preferences, jamais d'apres l'URL. Mais il porte un nom d'hote,
 * et ce nom etait ecrit en dur — `megaplay`, retire de lib/servers.js le
 * 08/09/2026 — dans QUATRE fichiers (ici, ScrollCard, episodeLists, Hero).
 * Resultat : des liens qui annoncaient un lecteur mort, et l'impression, tres
 * raisonnable, que le site essayait de l'ouvrir. Il tire desormais son nom de
 * `DEFAULT_SERVER_ID`, donc il ne peut plus designer un hote qui n'existe pas.
 *
 * Le second segment du chemin est decoratif de la meme facon (la page ne le
 * lit pas) ; on y met le meme nom, faute de slug de titre sous la main.
 */
export function watchHref(id: number | string, ep: number = 1): string {
  return `/en/anime/watch/${id}/${DEFAULT_SERVER_ID}?id=${DEFAULT_SERVER_ID}-${id}-${ep}&num=${ep}`;
}

/** The href an anime card/poster should link to, honouring the preference. */
export function animeHref(id: number | string, target?: ClickTarget): string {
  const t = target ?? getClickTarget();
  if (t === "watch") return watchHref(id, resumeEpisode(id));
  return `/en/anime/${id}`;
}

export function useClickTarget(): ClickTarget {
  const [target, setTarget] = useState<ClickTarget>(DEFAULT_CLICK_TARGET);
  useEffect(() => {
    const read = () => setTarget(getClickTarget());
    read();
    window.addEventListener(CLICK_TARGET_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(CLICK_TARGET_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return target;
}
