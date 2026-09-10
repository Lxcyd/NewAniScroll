import { useEffect, useState } from "react";
import type { WallhavenArtwork } from "@/lib/wallhaven/artworks";

/**
 * Chargement paresseux des fonds d'écran Wallhaven.
 *
 * Même forme et mêmes deux caches que useTmdbArtworks / useFanarts — MEMO pour
 * les réponses résolues, INFLIGHT pour que deux montages du même anime
 * partagent une requête — et pour la même raison : le corps d'un onglet ne se
 * monte qu'au clic, donc c'est ici que se fait le chargement.
 *
 * Séparé de useTmdbArtworks plutôt que fondu dedans : les deux points d'entrée
 * n'ont pas le même profil de coût, et la galerie a intérêt à peindre ce
 * qu'elle a dès qu'elle l'a plutôt qu'à attendre la plus lente des sources.
 */
const MEMO = new Map<number, WallhavenArtwork[]>();
const INFLIGHT = new Map<number, Promise<WallhavenArtwork[]>>();

async function fetchWallhaven(animeId: number): Promise<WallhavenArtwork[]> {
  const memo = MEMO.get(animeId);
  if (memo) return memo;
  const pending = INFLIGHT.get(animeId);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(`/api/v2/wallhaven?anime=${animeId}`);
      if (!res.ok) return [];
      const json = (await res.json()) as { arts?: WallhavenArtwork[] };
      const arts = Array.isArray(json?.arts) ? json.arts : [];
      MEMO.set(animeId, arts);
      return arts;
    } catch {
      // Jamais mémoriser un échec — un hoquet ne doit pas figer une galerie
      // vide pour le reste de la session.
      return [];
    } finally {
      INFLIGHT.delete(animeId);
    }
  })();

  INFLIGHT.set(animeId, p);
  return p;
}

export function useWallhaven(animeId: number): { wallpapers: WallhavenArtwork[] } {
  const [wallpapers, setWallpapers] = useState<WallhavenArtwork[]>(
    () => MEMO.get(animeId) ?? [],
  );

  useEffect(() => {
    let cancelled = false;
    if (!Number.isFinite(animeId) || animeId <= 0) return;
    fetchWallhaven(animeId).then((arts) => {
      if (!cancelled) setWallpapers(arts);
    });
    return () => {
      cancelled = true;
    };
  }, [animeId]);

  return { wallpapers };
}
