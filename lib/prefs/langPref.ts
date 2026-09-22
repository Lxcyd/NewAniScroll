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
import { serverPerfRankFrozen } from "@/lib/watch/serverPerf";

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

type ServerDef = { id: string; lang: Lang; speed?: number };

type PickOpts = {
  /** Serveurs confirmes disponibles pour CET episode. Omis = pas encore sonde,
   *  on repond alors au jugé (le plus rapide de la langue prioritaire). */
  confirmed?: Set<string> | null;
  /** Serveurs connus en echec — jamais proposes. */
  failed?: Set<string> | Map<string, unknown> | null;
  /**
   * Ordre de choix A L'INTERIEUR d'une langue. Par defaut le rang MESURE sur
   * cet appareil (lib/watch/serverPerf), qui retombe exactement sur le rang
   * statique `speed` de lib/servers.js tant qu'aucune mesure n'existe.
   *
   * Sur le serveur, `serverPerfRankFrozen` ne peut pas lire localStorage et rend
   * le rang statique : ce defaut est donc sans danger au SSR par construction,
   * il n'y a pas d'ordre a faire diverger entre les deux rendus.
   *
   * FIGE, comme les chips : le lecteur choisi par defaut doit etre celui que la
   * barre montre en tete, et il le serait rarement si l'un lisait un classement
   * rafraichi pendant que l'autre garde celui du chargement.
   */
  rank?: (server: ServerDef) => number;
  /**
   * Langues renvoyees en FIN d'ordre pour cet anime precis, sans etre retirees.
   *
   * Sert au verdict de doublage (cf. lib/watch/dubCatalog) : sur une serie que
   * MyDubList ne donne pas doublee, ouvrir un lecteur VF coute une dizaine de
   * secondes d'« absent » enchaines. On n'ouvre donc plus la VF d'emblee.
   *
   * RETROGRADER et non exclure, deliberement : MyDubList recense les doublages
   * officiels, et anime-sama heberge parfois une VF qui n'en est pas un —
   * mesure du 20/09/2026, 97,8 % de concordance, donc ~2 % de titres ou la
   * langue existe quand meme. Les laisser dans l'ordre les garde atteignables
   * (les sondes de fond allument leur chip) ; les retirer les rendrait
   * invisibles pour ne gagner que des invocations de sonde.
   */
  deprioriser?: Lang[] | null;
};

/**
 * Le meme ordre, les langues citees renvoyees a la fin. Aucune n'est perdue :
 * c'est ce qui distingue une retrogradation d'un filtre (cf. `deprioriser`).
 */
export function ordreDeprioriseEn(
  langs: Lang[],
  deprioriser?: Lang[] | null,
): Lang[] {
  if (!deprioriser?.length) return langs;
  const arriere = new Set(deprioriser);
  const devant = langs.filter((l) => !arriere.has(l));
  /* Si TOUT serait retrograde, on ne change rien : un ordre integralement
     renvoye a la fin est le meme ordre, et pretendre le contraire ferait croire
     a un arbitrage qui n'a pas eu lieu. */
  if (devant.length === 0) return langs;
  return [...devant, ...langs.filter((l) => arriere.has(l))];
}

/**
 * Le meilleur serveur selon l'ordre de langues : premiere langue qui a un
 * candidat utilisable, puis meilleur rang dans cette langue. `null` si rien.
 */
export function pickServerForLangs(
  order: Lang[] | null | undefined,
  { confirmed, failed, rank = serverPerfRankFrozen, deprioriser }: PickOpts = {},
): string | null {
  const langs = ordreDeprioriseEn(
    order && order.length ? order : DEFAULT_LANG_ORDER,
    deprioriser,
  );
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

