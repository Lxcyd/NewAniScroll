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
 * UN LECTEUR QUI NE MARCHE PAS NE S'AFFICHE PAS (30/08/2026). Le 29/08 avait
 * introduit deux sorts distincts — l'absence prouvee retirait le chip, la panne
 * le laissait grise et cliquable, au motif qu'une panne se termine. A l'usage
 * la nuance ne se voit pas : cote spectateur, « Sibnet » en gris qui ne lit rien
 * est un lecteur casse, pas une invitation. On ne propose donc plus que ce dont
 * on n'a AUCUNE raison de douter.
 *
 * Ce qui rend la regle tenable, et sans quoi elle reviendrait au bug du
 * 17/08 (« sibnet s'affiche puis disparait ») : `markFailed` filtre DEJA en
 * amont. Un echec passager sur un hote CONFIRME n'entre jamais dans
 * `failedServers` — un 503 dit « je n'ai pas pu savoir », pas « ce lecteur
 * n'existe pas ». N'y figurent donc que l'absence prouvee, le `hostDown`, et
 * les echecs d'un hote qu'on n'a jamais vu marcher. Trois verdicts, aucune
 * non-connaissance : les masquer ne cache rien de recuperable.
 *
 * Deux filets subsistent : le lecteur ACTIF reste toujours visible (sinon on
 * regarderait un flux qu'aucun chip ne designe), et l'etat est remis a zero a
 * chaque changement d'episode — un hote mort sur l'episode 3 repart intact
 * sur le 4.
 */

type ServerLike = { id: string; type?: string };
type FailedLike = Set<string> | Map<string, unknown> | null | undefined;

/** La raison inscrite par `markFailed` pour une absence prouvee (204/404).
 *  Exportee, et non recopiee : depuis qu'elle DECIDE du masquage, une faute de
 *  frappe a l'un des cinq endroits ou elle etait ecrite en dur ferait
 *  reapparaitre un chip mort sans que rien ne le signale. */
export const ABSENCE_PROUVEE = "Source not found";

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

/** L'hote a-t-il echoue d'une facon qui peut se terminer ?
 *  Ne gouverne PLUS l'affichage depuis le 30/08 — tout echec masque. Reste
 *  expose pour le diagnostic et pour distinguer les verdicts dans les traces. */
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
  // Tout echec retire le chip, quelle qu'en soit la raison : ne figurent ici
  // que des verdicts, jamais un simple « je n'ai pas pu savoir » (cf. en-tete).
  if (failedServers?.has?.(server.id)) return false;
  // Un iframe ne se sonde pas — on ne peut rien confirmer a son sujet.
  if (server.type === "iframe") return true;
  return !!confirmedServers?.has(server.id);
}
