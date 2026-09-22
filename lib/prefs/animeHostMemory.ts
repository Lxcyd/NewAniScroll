/**
 * Le lecteur qui a REELLEMENT joue cet anime, retenu tout seul.
 *
 * A ne pas confondre avec `animeServerPref` : celui-la est une DECISION de
 * l'utilisateur (un clic dans le selecteur) et prime sur tout. Celui-ci est une
 * simple observation — « la derniere fois, c'est cet hote qui a rendu une
 * image » — et ne sert qu'a mieux parier au chargement suivant.
 *
 * Pourquoi il manquait. Rien, nulle part, ne reliait « cet anime » a « cet
 * hote » : `serverPerf` mesure les hotes GLOBALEMENT (jamais par serie),
 * `animeServerPref` attend un clic, et l'instantane de disponibilite est lu
 * APRES le premier rendu de la page de lecture. Consequence, sur les nombreuses
 * series ou frembed n'existe pas : a chaque ouverture on repartait du meme
 * classement theorique, on retentait frembed (ou voir-anime), on echouait, on
 * basculait. La panne etait donc rejouee a l'identique a chaque visite, alors
 * que la reponse etait connue depuis la premiere.
 *
 * Volontairement pauvre : un id de lecteur et une date. La disponibilite reelle
 * reste verifiee par les sondes et par la bascule — ceci ne fait que choisir par
 * quoi COMMENCER. Une entree qui se revele fausse est ecrasee des que la
 * bascule trouve mieux, et elle se perime d'elle-meme.
 */

import SERVERS from "@/lib/servers";

const KEY = "aniscroll:animeHost";
/** Plafond du nombre de series memorisees (les plus anciennes sautent). */
const MAX = 200;
/* Un mois. Les hotes vont et viennent : au-dela, mieux vaut re-observer que
   suivre un souvenir. */
const MAX_AGE_MS = 30 * 24 * 3600_000;

type Entry = { s: string; at: number };
type Store = Record<string, Entry>;

function read(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* best-effort (quota, mode prive) */
  }
}

const isKnownServer = (id: string) =>
  (SERVERS as { id: string }[]).some((s) => s.id === id);

/** Le dernier lecteur qui a joue cet anime, ou "" (inconnu, perime, retire). */
export function getAnimeHost(aniId: string | number | null | undefined): string {
  if (typeof window === "undefined" || aniId == null) return "";
  const store = read();
  const e = store[String(aniId)];
  if (!e?.s) return "";
  if (Date.now() - (e.at || 0) > MAX_AGE_MS || !isKnownServer(e.s)) {
    delete store[String(aniId)];
    write(store);
    return "";
  }
  return e.s;
}

/** Appele quand un lecteur a livre sa premiere image pour cet anime. */
export function rememberAnimeHost(
  aniId: string | number | null | undefined,
  serverId: string,
): void {
  if (typeof window === "undefined" || aniId == null || !serverId) return;
  if (!isKnownServer(serverId)) return;
  const store = read();
  const key = String(aniId);
  if (store[key]?.s === serverId) return; // rien de neuf : pas d'ecriture
  // Re-inserer en fin d'objet : l'ordre des cles JSON est l'ordre d'insertion,
  // c'est ce qui fait office d'anciennete pour l'elagage ci-dessous.
  delete store[key];
  store[key] = { s: serverId, at: Date.now() };
  const keys = Object.keys(store);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX))) {
    delete store[old];
  }
  write(store);
}
