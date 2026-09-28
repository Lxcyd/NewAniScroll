/**
 * Les episodes que les LECTEURS ont deja, meme quand AniList les annonce a venir.
 *
 * La liste d'episodes s'arrete a `nextAiringEpisode - 1` : c'est le calendrier
 * de la diffusion japonaise. Or une plateforme peut publier avant — cas signale
 * le 28/09/2026 : Steel Ball Run ep 2 en ligne sur anime-sama (sortie Netflix)
 * alors qu'AniList le disait « dans 3 j ». Le site cachait un episode jouable.
 *
 * Deux preuves, aucune requete en plus :
 *   - une source RESOLUE pour l'episode N prouve que N existe ;
 *   - la route source signale `nextAired` quand le panneau anime-sama qu'elle
 *     vient de lire porte deja l'entree suivante (cf. pages/api/v2/source).
 *
 * En memoire, par onglet : c'est un complement au calendrier, pas un etat a
 * conserver.
 */

const connus = new Map<string, number>(); // aniId → plus grand episode prouve
const abonnes = new Set<() => void>();

export function noteSourceResolved(aniId: number | string, episode: number | string, data: any): void {
  const n = Number(episode);
  if (!Number.isFinite(n) || n <= 0) return;
  const prouve = data?.nextAired === true ? n + 1 : n;
  const k = String(aniId);
  if ((connus.get(k) || 0) >= prouve) return;
  connus.set(k, prouve);
  abonnes.forEach((f) => f());
}

/** Plus grand numero d'episode dont un lecteur a prouve l'existence (0 = aucun). */
export function airedAhead(aniId: number | string | null | undefined): number {
  if (aniId == null) return 0;
  return connus.get(String(aniId)) || 0;
}

export function subscribeAiredAhead(f: () => void): () => void {
  abonnes.add(f);
  return () => {
    abonnes.delete(f);
  };
}
