/**
 * Un chip de lecteur est-il visible ?
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
 */

type ServerLike = { id: string; type?: string };

export function shouldShowServer(
  server: ServerLike,
  activeServer: string,
  confirmedServers?: Set<string> | null,
  failedServers?: Set<string> | Map<string, unknown> | null,
): boolean {
  // Le lecteur en cours reste visible meme en echec : le masquer laisserait
  // l'utilisateur devant un lecteur qu'aucun chip ne designe.
  if (server.id === activeServer) return true;
  if (failedServers?.has?.(server.id) || (failedServers as any)?.get?.(server.id)) {
    return false;
  }
  // Un iframe ne se sonde pas — on ne peut rien confirmer a son sujet.
  if (server.type === "iframe") return true;
  return !!confirmedServers?.has(server.id);
}
