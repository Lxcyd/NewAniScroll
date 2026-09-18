/**
 * Prechauffe les donnees de la fiche anime quand un survol devient une INTENTION.
 *
 * Le routeur pages de Next ne precharge jamais les donnees d'une page
 * `getServerSideProps` (`router.prefetch` ne tire que son JS). Un clic sur une
 * carte attend donc toujours `/_next/data/<build>/en/anime/<id>.json`. Si on le
 * demande AVANT le clic, deux choses jouent :
 *
 *  - le navigateur garde la reponse 60 s (`Cache-Control: public, max-age=60`
 *    pose par le SSR) : la requete du routeur, meme URL, memes en-tetes, sort
 *    alors du cache HTTP sans aller-retour ;
 *  - a defaut, le CDN l'a (s-maxage 6 h) : c'est un HIT au lieu d'un MISS.
 *
 * Le cout : sur un titre froid, un survol volontaire = une invocation. D'ou le
 * seuil : 150 ms immobile sur la carte (un balayage de carrousel ne declenche
 * rien), ou `pointerdown` (tactile, et souris juste avant le clic). Une fois par
 * id et par session. Rien en mode economie de donnees.
 *
 * Seulement quand la carte mene a la FICHE (preference de clic par defaut) : la
 * page de lecture porte un `?id=` qui entre en collision avec ses parametres de
 * route, l'URL de donnees n'est pas reconstructible a coup sur.
 */
import { PREVIEW_ATTR } from "@/lib/preview/anchor";
import { getClickTarget } from "@/lib/prefs/clickTarget";

const HOVER_INTENT_MS = 150;
const warmed = new Set<number>();

function dataHrefFor(id: number): string | null {
  const w = window as any;
  const buildId: string | undefined = w.__NEXT_DATA__?.buildId;
  if (!buildId) return null;
  // Meme calcul que le routeur (router.js → pageLoader.getDataHref) : c'est la
  // seule facon de garantir la meme URL, donc la meme entree de cache.
  // Sur mobile, le rewrite UA de next.config.js ajoute `__m=1` AVANT les
  // parametres de route (resolve-rewrites, puis le matcher de route) : meme
  // ordre ici, sinon on chaufferait une autre entree de cache.
  const q = MOBILE_UA.test(navigator.userAgent) ? `__m=1&id=${id}` : `id=${id}`;
  const loader = w.next?.router?.pageLoader;
  if (loader?.getDataHref) {
    try {
      return loader.getDataHref({
        href: `/en/anime/[...id]?${q}`,
        asPath: `/en/anime/${id}`,
      });
    } catch {
      /* repli ci-dessous */
    }
  }
  return `/_next/data/${buildId}/en/anime/${id}.json?${q}`;
}

/* La condition `has` du rewrite mobile de next.config.js, a l'identique. */
const MOBILE_UA =
  /^.*(Android|android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini).*$/;

function currentAnimeId(): number | null {
  const m = window.location.pathname.match(/^\/(?:en|fr)\/anime\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function warmAnimeData(id: number): void {
  if (!Number.isFinite(id) || id <= 0 || warmed.has(id)) return;
  if ((navigator as any).connection?.saveData) return;
  if (getClickTarget() !== "info") return;
  if (currentAnimeId() === id) return;
  const href = dataHrefFor(id);
  if (!href) return;
  warmed.add(id);
  // Memes options que fetchRetry() de Next : credentials + x-nextjs-data.
  fetch(href, {
    credentials: "same-origin",
    headers: { "x-nextjs-data": "1" },
  })
    .then((r) => {
      if (!r.ok) warmed.delete(id); // un 5xx ne doit pas bloquer un nouvel essai
      return r.body?.cancel?.();
    })
    .catch(() => warmed.delete(id));
}

function anchorId(target: EventTarget | null): { el: Element; id: number } | null {
  const el = (target as Element | null)?.closest?.(`[${PREVIEW_ATTR}]`);
  if (!el) return null;
  const id = Number(el.getAttribute(PREVIEW_ATTR));
  return Number.isFinite(id) && id > 0 ? { el, id } : null;
}

/** Ecouteurs delegues sur le document ; renvoie leur nettoyage. */
export function installAnimeDataWarmer(): () => void {
  let timer: number | null = null;
  let current: Element | null = null;

  const clear = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = null;
    current = null;
  };

  const onOver = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return; // le tactile passe par pointerdown
    const hit = anchorId(e.target);
    if (!hit || hit.el === current) return;
    clear();
    current = hit.el;
    timer = window.setTimeout(() => warmAnimeData(hit.id), HOVER_INTENT_MS);
  };
  const onOut = (e: PointerEvent) => {
    if (!current) return;
    const to = e.relatedTarget as Node | null;
    if (to && current.contains(to)) return;
    clear();
  };
  const onDown = (e: PointerEvent) => {
    const hit = anchorId(e.target);
    if (hit) warmAnimeData(hit.id);
  };

  document.addEventListener("pointerover", onOver, { passive: true });
  document.addEventListener("pointerout", onOut, { passive: true });
  document.addEventListener("pointerdown", onDown, { passive: true });
  return () => {
    clear();
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("pointerout", onOut);
    document.removeEventListener("pointerdown", onDown);
  };
}
