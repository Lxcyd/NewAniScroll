import { useCallback, useEffect, useRef, useState } from "react";
import type { WallhavenArtwork, Facette } from "@/lib/wallhaven/artworks";

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
 * Wallhaven en a 864 pour One Piece. Aucun nombre fixe ne convenait — trop bas
 * on ampute, trop haut on charge ce que personne ne regarde — donc la galerie
 * déroule : une page à l'ouverture, les suivantes à la demande.
 *
 * Le MEMO est par (anime, facette, page) et les pages s'accumulent : revenir
 * sur un titre déjà déroulé ne recharge rien, et changer de facette puis
 * revenir non plus.
 */
type Page = {
  arts: WallhavenArtwork[];
  hasMore: boolean;
  total: number;
  facettes: Record<Facette, number>;
};

const MEMO = new Map<string, Page>();
const INFLIGHT = new Map<string, Promise<Page>>();

const FACETTES_VIDES: Record<Facette, number> = {
  tout: 0, illustration: 0, capture: 0, personnage: 0, paysage: 0,
};
const VIDE: Page = { arts: [], hasMore: false, total: 0, facettes: FACETTES_VIDES };
const keyOf = (animeId: number, facette: Facette, page: number) =>
  `${animeId}:${facette}:${page}`;

async function fetchPage(
  animeId: number,
  facette: Facette,
  page: number,
): Promise<Page> {
  const k = keyOf(animeId, facette, page);
  const memo = MEMO.get(k);
  if (memo) return memo;
  const pending = INFLIGHT.get(k);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(
        `/api/v2/wallhaven?anime=${animeId}&page=${page}&facette=${facette}`,
      );
      if (!res.ok) return VIDE;
      const json = (await res.json()) as Partial<Page>;
      const out: Page = {
        arts: Array.isArray(json?.arts) ? json.arts : [],
        hasMore: !!json?.hasMore,
        total: Number(json?.total) || 0,
        facettes: json?.facettes ?? FACETTES_VIDES,
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
  /** Le total pour ce titre sous la facette courante. */
  total: number;
  /** Combien d'images derrière chaque facette — pour ne proposer que les
   *  boutons qui mènent quelque part. */
  facettes: Record<Facette, number>;
  facette: Facette;
  setFacette: (f: Facette) => void;
} {
  const [wallpapers, setWallpapers] = useState<WallhavenArtwork[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [facette, setFacette] = useState<Facette>("tout");
  /* Les décomptes portent sur le TITRE, pas sur la facette courante : ils ne
     doivent donc pas être écrasés quand on filtre, sinon les boutons
     disparaîtraient dès le premier clic. Seule la page 1 de « tout » les
     rapporte. */
  const [facettes, setFacettes] = useState<Record<Facette, number>>(FACETTES_VIDES);
  /* La dernière page OBTENUE, en ref : `loadMore` ne doit pas changer
     d'identité à chaque page, sinon tout consommateur qui la met en dépendance
     se réabonne à chaque clic. */
  const page = useRef(0);
  const live = useRef(animeId);
  const facetteLive = useRef<Facette>("tout");

  /* Changer d'anime remet la facette à zéro : « Paysage » n'a aucune raison de
     rester armé quand on passe à un titre qui n'en a pas. */
  useEffect(() => {
    setFacette("tout");
    setFacettes(FACETTES_VIDES);
  }, [animeId]);

  useEffect(() => {
    live.current = animeId;
    facetteLive.current = facette;
    page.current = 0;
    setWallpapers([]);
    setHasMore(false);
    setTotal(0);
    if (!Number.isFinite(animeId) || animeId <= 0) return;

    let cancelled = false;
    setLoading(true);
    fetchPage(animeId, facette, 1).then((p) => {
      if (cancelled) return;
      page.current = 1;
      setWallpapers(p.arts);
      setHasMore(p.hasMore);
      setTotal(p.total);
      /* Les décomptes ne sont renvoyés que par la page 1 ; sur une facette
         filtrée ils valent zéro et ne doivent pas écraser les vrais. */
      if (p.facettes.tout > 0) setFacettes(p.facettes);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [animeId, facette]);

  const loadMore = useCallback(() => {
    const id = live.current;
    const f = facetteLive.current;
    if (!Number.isFinite(id) || id <= 0) return;
    const next = page.current + 1;
    if (next < 2) return; // la première page est le travail de l'effet
    setLoading(true);
    fetchPage(id, f, next).then((p) => {
      /* L'anime ou la facette ont pu changer pendant le vol : on jette plutôt
         que d'ajouter les images d'un titre à la galerie d'un autre. */
      if (live.current !== id || facetteLive.current !== f) return;
      page.current = next;
      setWallpapers((prev) => {
        /* Dédoublonnage par URL, gardé : le classement se fait sur un score
           dérivé de `favorites`, et une écriture du moissonneur quotidien entre
           deux pages peut décaler le rang d'un cran — la dernière de la page N
           réapparaîtrait alors en tête de la N+1. */
        const vues = new Set(prev.map((a) => a.url));
        return [...prev, ...p.arts.filter((a) => !vues.has(a.url))];
      });
      setHasMore(p.hasMore);
      setLoading(false);
    });
  }, []);

  return {
    wallpapers, hasMore, loading, loadMore,
    total, facettes, facette, setFacette,
  };
}
