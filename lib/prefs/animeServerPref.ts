/**
 * Lecteur retenu POUR UN ANIME donne (local, par appareil).
 *
 * Quand on change de lecteur pendant un episode, ce choix devient l'exception
 * de CETTE serie : on la rouvre sur le meme lecteur, tant qu'il reste
 * disponible. C'est le cas d'usage evident — telle serie se regarde en VF,
 * telle autre en VOSTFR — et l'ordre de preference global (lib/prefs/langPref)
 * continue de decider partout ailleurs.
 *
 * Priorite a la resolution, du plus precis au plus general :
 *   1. ce module (exception pour cet anime, posee par un clic)
 *   2. `preferred_server` (serveur epingle dans les Reglages)
 *   3. l'ordre de preference des langues
 *   4. le comportement historique (megaplay)
 *
 * « Tant qu'il est disponible » n'est pas gere ici : l'exception est appliquee
 * comme une preference ordinaire par la page de lecture, donc si le lecteur
 * echoue pour cet episode, le filet de securite habituel prend le relais (et
 * suit l'ordre des langues). On NE supprime PAS l'entree pour autant : un hote
 * peut manquer un episode et revenir au suivant.
 *
 * Un id de serveur retire est ignore et purge, comme dans serverPref.ts — les
 * ids de lib/servers.js bougent souvent, et une valeur morte relue telle quelle
 * coute un aller-retour perdu a chaque chargement.
 */

import SERVERS from "@/lib/servers";
import { readStore, writeStore, putRecent } from "./animeKeyedStore";

const KEY = "aniscroll:animeServer";
/** Plafond du nombre de series memorisees (les plus anciennes sautent). */
const MAX = 200;

type Store = Record<string, string>;

const read = (): Store => readStore<string>(KEY);
const write = (store: Store): void => writeStore(KEY, store);

const trouve = (id: string) =>
  (SERVERS as { id: string; lecteurExterne?: boolean }[]).find((s) => s.id === id);

/** Le lecteur retenu pour cet anime, ou "" si aucun (ou s'il a ete retire). */
export function getAnimeServer(aniId: string | number | null | undefined): string {
  if (typeof window === "undefined" || aniId == null) return "";
  const store = read();
  const id = store[String(aniId)];
  if (!id) return "";
  const def = trouve(id);
  /* Un lecteur EXTERNE (megaplay) epingle est purge a la LECTURE, et pas
     seulement empeche a l'ecriture. `handleServerChange` ne l'epingle plus,
     mais les entrees deja posees survivraient dans le localStorage de chaque
     visiteur : la serie continuerait de s'ouvrir sur une interface etrangere
     alors que nos propres lecteurs la servent, et personne ne devinerait qu'il
     faut aller cliquer ailleurs pour s'en defaire. Corriger a l'ecriture seule
     aurait laisse le defaut en place chez ceux qui l'avaient deja rencontre —
     c'est-a-dire exactement ceux qui s'en plaignaient. */
  if (def && !def.lecteurExterne) return id;
  delete store[String(aniId)];
  write(store);
  return "";
}

/** Retient (ou remplace) le lecteur de cet anime. */
export function setAnimeServer(
  aniId: string | number | null | undefined,
  serverId: string,
): void {
  if (typeof window === "undefined" || aniId == null || !serverId) return;
  const store = read();
  const key = String(aniId);
  putRecent(store, key, serverId, MAX);
  write(store);
}

