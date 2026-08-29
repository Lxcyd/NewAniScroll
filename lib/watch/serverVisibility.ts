/**
 * Un chip de lecteur : visible ? grise ?
 *
 * Cette regle vivait en DEUX exemplaires — dans components/watch/primary/
 * serverSelector.js et, recopiee a la main, dans le raccourci « lecteur
 * suivant » de la page de lecture. Les deux avaient deja diverge : le selecteur
 * testait `failedServers.get?.()` en plus de `.has?.()`, pas la page. Le
 * raccourci est cense parcourir EXACTEMENT les chips affiches, donc toute
 * divergence le fait atterrir sur un lecteur invisible.
 *
 * `failedServers` est tantot un Set, tantot une Map (id -> raison) selon
 * l'appelant ; les deux repondent a `.has()`, et le `.get()` couvre le cas ou
 * une Map porterait une entree a valeur falsy.
 *
 * DEUX natures d'echec, et elles ne meritent pas le meme sort (29/08/2026) :
 *
 *   - l'absence PROUVEE — cet episode n'existe pas chez cet hote — n'a aucune
 *     raison d'occuper une place : le chip disparait ;
 *   - tout le reste (hote qui refuse, 5xx, reseau, delai) est une panne, et une
 *     panne se termine. Le chip RESTE, grise et cliquable.
 *
 * Les confondre les faisait tous disparaitre : la barre se vidait sous les
 * yeux, et un hote retabli n'etait plus atteignable — il fallait recharger.
 */

type ServerLike = { id: string; type?: string };
type FailedLike = Set<string> | Map<string, unknown> | null | undefined;

/** La raison inscrite par `markFailed` pour une absence prouvee (204/404). */
const ABSENCE_PROUVEE = "Source not found";

const raisonDe = (failedServers: FailedLike, id: string): unknown =>
  (failedServers as any)?.get?.(id);

/** L'hote a-t-il PROUVE qu'il n'a pas cet episode ? */
export function isProvenAbsent(failedServers: FailedLike, id: string): boolean {
  const raison = raisonDe(failedServers, id);
  // Un Set ne porte pas de raison : impossible de distinguer, on garde le
  // comportement prudent d'avant (masquer).
  if (raison === undefined) return !!failedServers?.has?.(id);
  return raison === ABSENCE_PROUVEE;
}

/** L'hote a-t-il echoue d'une facon qui peut se terminer ? (chip grise) */
export function isDegraded(failedServers: FailedLike, id: string): boolean {
  return !!failedServers?.has?.(id) && !isProvenAbsent(failedServers, id);
}

export function shouldShowServer(
  server: ServerLike,
  activeServer: string,
  confirmedServers?: Set<string> | null,
  failedServers?: FailedLike,
): boolean {
  // Le lecteur en cours reste visible meme en echec : le masquer laisserait
  // l'utilisateur devant un lecteur qu'aucun chip ne designe.
  if (server.id === activeServer) return true;
  if (isProvenAbsent(failedServers, server.id)) return false;
  // Une panne ne retire pas le chip — elle le grise. Y compris sur un lecteur
  // jamais confirme : proposer un essai vaut mieux qu'une barre vide.
  if (failedServers?.has?.(server.id)) return true;
  // Un iframe ne se sonde pas — on ne peut rien confirmer a son sujet.
  if (server.type === "iframe") return true;
  return !!confirmedServers?.has(server.id);
}
