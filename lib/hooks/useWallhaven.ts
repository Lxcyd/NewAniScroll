import { useCallback, useEffect, useRef, useState } from "react";
import type { WallhavenArtwork } from "@/lib/wallhaven/artworks";

/**
 * Chargement paresseux et PAGINÉ des fonds d'écran Wallhaven.
 *
 * Même forme et mêmes deux caches que useTmdbArtworks / useFanarts — MEMO pour
 * les réponses résolues, INFLIGHT pour que deux montages du même anime
 * partagent une requête — et pour la même raison : le corps d'un onglet ne se
 * monte qu'au clic, donc c'est ici que se fait le chargement.
 *
 * CE QU'IL A EN PLUS, et pourquoi. fanart.tv et TMDB rendent tout leur
 * catalogue d'un coup parce qu'il tient en quelques dizaines d'images.
 * Wallhaven en a 1 445 pour One Piece. Aucun nombre fixe ne convenait — trop
 * bas on ampute, trop haut on paie des requêtes que personne ne regarde — donc
 * la galerie déroule : une page à l'ouverture, les suivantes à la demande.
 *
 * Le MEMO est par (anime, page) et les pages s'accumulent : revenir sur un
 * titre déjà déroulé ne recharge rien.
 */
type Page = { arts: WallhavenArtwork[]; hasMore: boolean };

const MEMO = new Map<string, Page>();
const INFLIGHT = new Map<string, Promise<Page>>();

const VIDE: Page = { arts: [], hasMore: false };
const keyOf = (animeId: number, page: number) => `${animeId}:${page}`;

async function fetchPage(animeId: number, page: number): Promise<Page> {
  const k = keyOf(animeId, page);
  const memo = MEMO.get(k);
  if (memo) return memo;
  const pending = INFLIGHT.get(k);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(`/api/v2/wallhaven?anime=${animeId}&page=${page}`);
      if (!res.ok) return VIDE;
      const json = (await res.json()) as { arts?: WallhavenArtwork[]; hasMore?: boolean };
      const out: Page = {
        arts: Array.isArray(json?.arts) ? json.arts : [],
        hasMore: !!json?.hasMore,
      };
      MEMO.set(k, out);
      return out;
    } catch {
      // Jamais mémoriser un échec — un hoquet ne doit pas figer une galerie
      // vide pour le reste de la session.
      return VIDE;
    } finally {
      INFLIGHT.delete(k);
    }
  })();

  INFLIGHT.set(k, p);
  return p;
}

export function useWallhaven(animeId: number): {
  wallpapers: WallhavenArtwork[];
  /** Une page de plus existe — de quoi afficher un « voir plus ». */
  hasMore: boolean;
  /** Une page est en vol. Sert à désarmer le bouton, pas à masquer la grille. */
  loading: boolean;
  loadMore: () => void;
} {
  const [wallpapers, setWallpapers] = useState<WallhavenArtwork[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  /* La dernière page OBTENUE, en ref : `loadMore` ne doit pas changer
     d'identité à chaque page, sinon tout consommateur qui la met en dépendance
     se réabonne à chaque clic. */
  const page = useRef(0);
  const live = useRef(animeId);

  useEffect(() => {
    live.current = animeId;
    page.current = 0;
    setWallpapers([]);
    setHasMore(false);
    if (!Number.isFinite(animeId) || animeId <= 0) return;

    let cancelled = false;
    setLoading(true);
    fetchPage(animeId, 1).then((p) => {
      if (cancelled) return;
      page.current = 1;
      setWallpapers(p.arts);
      setHasMore(p.hasMore);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [animeId]);

  const loadMore = useCallback(() => {
    const id = live.current;
    if (!Number.isFinite(id) || id <= 0) return;
    const next = page.current + 1;
    if (next < 2) return; // la première page est le travail de l'effet
    setLoading(true);
    fetchPage(id, next).then((p) => {
      /* L'anime a pu changer pendant le vol : on jette plutôt que d'ajouter
         les images d'un titre à la galerie d'un autre. */
      if (live.current !== id) return;
      page.current = next;
      setWallpapers((prev) => {
        /* Dédoublonnage par URL. Wallhaven peut servir la même image sur deux
           pages si un favori bouge entre deux requêtes — le classement se
           décale alors d'un cran et la dernière de la page N réapparaît en
           tête de la N+1. */
        const vues = new Set(prev.map((a) => a.url));
        return [...prev, ...p.arts.filter((a) => !vues.has(a.url))];
      });
      setHasMore(p.hasMore);
      setLoading(false);
    });
  }, []);

  return { wallpapers, hasMore, loading, loadMore };
}
