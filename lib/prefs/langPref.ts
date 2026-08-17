/**
 * Ordre de preference des LANGUES de lecture (local, par appareil).
 *
 * Trois familles, exactement celles que `lib/servers.js` porte dans `lang` :
 *   - "vf"    → doublage francais
 *   - "vo"    → VOSTFR (japonais, sous-titres francais)
 *   - "multi" → lecteur multi-langue (anglais par defaut, d'autres pistes
 *               de sous-titres selon l'anime)
 *
 * L'utilisateur classe ces trois familles 1-2-3 (popup au premier episode, cf.
 * components/watch/primary/LangPreferenceModal.tsx). La page de lecture s'en
 * sert pour choisir le lecteur par defaut : la famille 1 d'abord, puis 2, puis 3.
 *
 * `null` = l'utilisateur n'a jamais repondu → la page garde son comportement
 * historique (megaplay par defaut). On ne devine pas a sa place.
 *
 * Meme forme evenement/hook que les autres prefs pour que la page Reglages
 * reste vivante.
 */

import { useEffect, useState } from "react";
import SERVERS from "@/lib/servers";

export type Lang = "vf" | "vo" | "multi";

const KEY = "lang_pref_order";
const ENABLED_KEY = "lang_pref_enabled";
export const LANG_PREF_EVENT = "aniscroll:langPref:change";

/** Ordre propose par defaut dans la popup (l'utilisateur peut le remanier). */
export const DEFAULT_LANG_ORDER: Lang[] = ["vf", "vo", "multi"];

const ALL: Lang[] = ["vf", "vo", "multi"];

/** Normalise une valeur relue : les 3 langues, sans doublon, dans l'ordre lu. */
function sanitize(raw: unknown): Lang[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = raw.filter((l): l is Lang => ALL.includes(l as Lang));
  const order = Array.from(new Set(seen));
  if (order.length === 0) return null;
  // Une langue absente du stockage (ajout futur, valeur corrompue) est
  // reintroduite en queue plutot que de disparaitre du classement.
  for (const l of ALL) if (!order.includes(l)) order.push(l);
  return order;
}

/** L'ordre choisi, ou `null` si l'utilisateur n'a pas encore repondu. */
export function getLangOrder(): Lang[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    return sanitize(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function setLangOrder(order: Lang[]): void {
  if (typeof window === "undefined") return;
  const clean = sanitize(order) || DEFAULT_LANG_ORDER;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(LANG_PREF_EVENT));
}

/**
 * Interrupteur general (Reglages > Lecteur). Eteint, le classement est CONSERVE
 * mais ignore : la page de lecture retombe sur son comportement historique.
 * Absent du stockage = allume — sinon la fonctionnalite naitrait desactivee.
 */
export function isLangPrefEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setLangPrefEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (on) window.localStorage.removeItem(ENABLED_KEY);
    else window.localStorage.setItem(ENABLED_KEY, "0");
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(LANG_PREF_EVENT));
}

export function useLangPrefEnabled(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const read = () => setOn(isLangPrefEnabled());
    read();
    window.addEventListener(LANG_PREF_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(LANG_PREF_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return on;
}

/**
 * L'ordre REELLEMENT applicable : `null` si l'utilisateur n'a pas repondu OU si
 * la fonctionnalite est eteinte. C'est ce que consomme la page de lecture ;
 * `getLangOrder()` (brut) reste pour l'edition dans la popup.
 */
export function getEffectiveLangOrder(): Lang[] | null {
  return isLangPrefEnabled() ? getLangOrder() : null;
}

export function useLangOrder(): Lang[] | null {
  const [order, setOrder] = useState<Lang[] | null>(null);
  useEffect(() => {
    const read = () => setOrder(getLangOrder());
    read();
    window.addEventListener(LANG_PREF_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(LANG_PREF_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return order;
}

type ServerDef = { id: string; lang: Lang; speed?: number };

type PickOpts = {
  /** Serveurs confirmes disponibles pour CET episode. Omis = pas encore sonde,
   *  on repond alors au jugé (le plus rapide de la langue prioritaire). */
  confirmed?: Set<string> | null;
  /** Serveurs connus en echec — jamais proposes. */
  failed?: Set<string> | Map<string, unknown> | null;
  /**
   * Ordre de choix A L'INTERIEUR d'une langue. Par defaut le rang statique
   * `speed` de lib/servers.js (1 = le plus rapide), c'est-a-dire « le premier ».
   * Le jour ou on voudra « le plus rapide reellement mesure », il suffit de
   * passer une fonction qui lit `liveSpeed` du watchPageProvider — rien d'autre
   * ne bouge ici.
   */
  rank?: (server: ServerDef) => number;
};

const staticRank = (s: ServerDef) => s.speed ?? 99;

/**
 * Le meilleur serveur selon l'ordre de langues : premiere langue qui a un
 * candidat utilisable, puis meilleur rang dans cette langue. `null` si rien.
 */
export function pickServerForLangs(
  order: Lang[] | null | undefined,
  { confirmed, failed, rank = staticRank }: PickOpts = {},
): string | null {
  const langs = order && order.length ? order : DEFAULT_LANG_ORDER;
  const isFailed = (id: string) =>
    failed instanceof Map ? failed.has(id) : !!failed?.has?.(id);
  for (const lang of langs) {
    const pool = (SERVERS as ServerDef[])
      .filter((s) => s.lang === lang)
      .filter((s) => !isFailed(s.id))
      .filter((s) => !confirmed || confirmed.has(s.id));
    if (pool.length === 0) continue;
    return pool.slice().sort((a, b) => rank(a) - rank(b))[0].id;
  }
  return null;
}

/** Rang (0 = prioritaire) de la langue d'un serveur; +inf si inconnu. */
export function langRank(order: Lang[] | null | undefined, serverId: string): number {
  const langs = order && order.length ? order : DEFAULT_LANG_ORDER;
  const lang = (SERVERS as ServerDef[]).find((s) => s.id === serverId)?.lang;
  const i = lang ? langs.indexOf(lang) : -1;
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}
