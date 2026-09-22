/**
 * Prechauffe les donnees d'une page `getServerSideProps` AVANT le clic.
 *
 * Le routeur pages de Next ne precharge jamais les donnees d'une page
 * `getServerSideProps` (`router.prefetch` ne tire que son JS). Un clic attend
 * donc toujours `/_next/data/<build>/…json`. On le demande plus tot, et on remet
 * la reponse au routeur (cf. handToRouter) : le clic ne fait alors plus aucun
 * aller-retour.
 *
 * Trois familles de pages en profitent :
 *
 *  - LA FICHE ANIME, quand un survol devient une INTENTION : 150 ms immobile sur
 *    la carte (un balayage de carrousel ne declenche rien), ou `pointerdown`
 *    (tactile, et souris juste avant le clic). Un survol volontaire sur un titre
 *    froid = une invocation, d'ou le seuil ;
 *  - LE PROFIL DU COMPTE CONNECTE, des l'ouverture du site (cf. warmOwnProfile),
 *    et a nouveau au survol de son lien si la copie a expire. C'est la page la
 *    plus lente du site (liste AniList entiere, plusieurs secondes sur un MISS) ;
 *  - LES PAGES DU MENU rendues par le serveur (accueil, planning, recherche), au
 *    survol ou a l'appui de leur lien.
 *
 * Rien en mode economie de donnees. La fiche seulement quand la carte mene a la
 * FICHE (preference de clic par defaut) : la page de lecture porte un `?id=` qui
 * entre en collision avec ses parametres de route, son URL de donnees n'est pas
 * reconstructible a coup sur.
 */
import { PREVIEW_ATTR } from "@/lib/preview/anchor";
import { getClickTarget } from "@/lib/prefs/clickTarget";

const HOVER_INTENT_MS = 150;

/* Combien de temps une reponse prechauffee attend le clic. Au-dela, on la
   rend : la page serait servie telle qu'elle etait au prechauffage. La fiche
   suit le max-age du SSR ; le profil, la fraicheur de sa liste cote serveur
   (FRAIS_MS de pages/en/profile/[user].tsx) — le clic n'y verrait rien de plus
   ancien que ce que le serveur aurait lui-meme servi. */
const ANIME_HOLD_MS = 60_000;
const PROFILE_HOLD_MS = 5 * 60_000;

/** Les requetes en vol, par URL de donnees : jamais deux fois la meme. */
const inflight = new Set<string>();

/* La condition `has` du rewrite mobile de next.config.js, a l'identique. */
const MOBILE_UA =
  /^.*(Android|android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini).*$/;

/**
 * L'URL de donnees que le routeur demandera pour cette page.
 *
 * Meme calcul que lui (router.js → pageLoader.getDataHref, `skipInterpolation`,
 * la query de la route serialisee par URLSearchParams) : c'est la seule facon de
 * garantir la meme URL, donc la meme entree de cache.
 */
function dataHref(route: string, query: string, asPath: string): string | null {
  const w = window as any;
  const buildId: string | undefined = w.__NEXT_DATA__?.buildId;
  if (!buildId) return null;
  const search = query ? `?${query}` : "";
  const loader = w.next?.router?.pageLoader;
  if (loader?.getDataHref) {
    try {
      return loader.getDataHref({
        href: `${route}${search}`,
        asPath,
        skipInterpolation: true,
      });
    } catch {
      /* repli ci-dessous */
    }
  }
  return `/_next/data/${buildId}${asPath}.json${search}`;
}

function routerCache(): Record<string, unknown> | null {
  const sdc = (window as any).next?.router?.sdc;
  return sdc && typeof sdc === "object" ? sdc : null;
}

function isHeld(href: string): boolean {
  const sdc = routerCache();
  return !!sdc && sdc[new URL(href, window.location.href).href] !== undefined;
}

function warm(href: string, holdMs: number): void {
  if ((navigator as any).connection?.saveData) return;
  if (inflight.has(href) || isHeld(href)) return;
  inflight.add(href);
  // Memes options que fetchRetry() de Next : credentials + x-nextjs-data.
  fetch(href, {
    credentials: "same-origin",
    headers: { "x-nextjs-data": "1" },
  })
    .then(async (r) => {
      if (!r.ok) return r.body?.cancel?.(); // un 5xx ne bloque pas un nouvel essai
      const text = await r.text();
      handToRouter(href, r, text, holdMs);
    })
    .catch(() => {})
    .finally(() => inflight.delete(href));
}

export function warmAnimeData(id: number): void {
  if (!Number.isFinite(id) || id <= 0) return;
  if (getClickTarget() !== "info") return;
  if (currentAnimeId() === id) return;
  // Sur mobile, le rewrite UA de next.config.js ajoute `__m=1` AVANT les
  // parametres de route (resolve-rewrites, puis le matcher de route) : meme
  // ordre ici, sinon on chaufferait une autre entree de cache.
  const q = MOBILE_UA.test(navigator.userAgent) ? `__m=1&id=${id}` : `id=${id}`;
  const href = dataHref("/en/anime/[...id]", q, `/en/anime/${id}`);
  if (href) warm(href, ANIME_HOLD_MS);
}

/**
 * Le profil a `path` (`/en/profile/<pseudo>-<tag>`, tel que profileHref le
 * construit). Sans effet sur tout autre chemin, et depuis le profil lui-meme.
 */
export function warmProfileData(path: string): void {
  const m = path.split(/[?#]/)[0].match(/^\/en\/profile\/([^/]+)$/);
  if (!m || m[1] === "me") return;
  const asPath = `/en/profile/${m[1]}`;
  if (window.location.pathname === asPath) return;
  let user: string;
  try {
    user = decodeURIComponent(m[1]);
  } catch {
    return;
  }
  const q = new URLSearchParams({ user }).toString();
  const href = dataHref("/en/profile/[user]", q, asPath);
  if (href) warm(href, PROFILE_HOLD_MS);
}

/**
 * Les pages du menu rendues par le serveur : accueil, planning, recherche.
 * Leur rendu est deja cache au bord ; le prechauffage retire l'aller-retour
 * restant, et le MISS quand le cache vient d'etre vide (deploiement).
 * `null` pour tout autre chemin.
 */
function menuRoute(path: string): { route: string; query: string; asPath: string } | null {
  const [beforeHash] = path.split("#");
  const [rawPath, rawQuery = ""] = beforeHash.split("?");
  const p = rawPath.replace(/\/+$/, "") || "/";
  // Le routeur fusionne la query du lien PUIS les parametres de route
  // (Object.assign) : meme ordre ici. Seule la recherche en porte une.
  const own = new URLSearchParams(rawQuery);
  if (p === "/en" || p === "/en/schedule") {
    return rawQuery ? null : { route: p, query: "", asPath: p };
  }
  const s = p.match(/^\/en\/search\/(.+)$/);
  if (s && !own.has("param")) {
    try {
      for (const seg of s[1].split("/")) own.append("param", decodeURIComponent(seg));
    } catch {
      return null;
    }
    return { route: "/en/search/[...param]", query: own.toString(), asPath: p };
  }
  return null;
}

export function warmMenuPage(path: string): void {
  const r = menuRoute(path);
  if (!r || window.location.pathname.replace(/\/+$/, "") === r.asPath) return;
  const href = dataHref(r.route, r.query, r.asPath);
  if (href) warm(href, ANIME_HOLD_MS);
}

/**
 * Le profil du compte connecte, des que le navigateur souffle apres
 * l'ouverture du site : le premier clic sur « Profil » ne fait plus attendre la
 * liste. Le survol du lien prend le relais si la copie a expire entre-temps.
 *
 * Une fois toutes les 5 min par ONGLET, plus une fois par chargement : le
 * drapeau en memoire repartait a zero a chaque chargement complet, et le SSR du
 * profil n'est pas cache au bord — chaque rechargement coutait une invocation
 * (et, passe 5 min, un aller-retour AniList + un SET Upstash de plusieurs
 * centaines de Ko). La memoire reste le garde principal ; sessionStorage peut
 * manquer (navigation privee), on retombe alors sur l'ancien comportement.
 */
const OWN_PROFILE_WARM_KEY = "as:warm:ownProfile";
const OWN_PROFILE_WARM_MS = 5 * 60 * 1000;
let ownProfileWarmed = false;
export function warmOwnProfile(path: string): void {
  if (ownProfileWarmed) return;
  ownProfileWarmed = true;
  try {
    const last = Number(sessionStorage.getItem(OWN_PROFILE_WARM_KEY)) || 0;
    if (Date.now() - last < OWN_PROFILE_WARM_MS) return;
    sessionStorage.setItem(OWN_PROFILE_WARM_KEY, String(Date.now()));
  } catch {
    /* stockage indisponible : on prechauffe comme avant */
  }
  const go = () => {
    const w = window as any;
    try {
      w.next?.router?.prefetch?.(path); // le JS de la page, s'il n'est pas deja la
    } catch {
      /* rien : ce n'est qu'une avance */
    }
    warmProfileData(path);
  };
  if (typeof (window as any).requestIdleCallback === "function") {
    (window as any).requestIdleCallback(go, { timeout: 4000 });
  } else {
    window.setTimeout(go, 1500);
  }
}

function currentAnimeId(): number | null {
  const m = window.location.pathname.match(/^\/(?:en|fr)\/anime\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Depose la reponse dans le cache de donnees du routeur (`router.sdc`).
 *
 * Le cache HTTP du navigateur ne suffit PAS, mesure le 18/09 : le `max-age=60`
 * du SSR se compte depuis la generation au bord, et Vercel renvoie `Age` —
 * une fiche restee plus d'une minute au CDN arrive deja perimee, et le clic
 * repart sur le reseau (un HIT, ~100 ms, pas zero). Le profil, lui, n'est
 * jamais cachable (il depend de la session).
 *
 * `fetchNextData` (next/dist/shared/lib/router/router.js) lit
 * `inflightCache[cacheKey]` AVANT tout fetch, et pour une page SSP efface
 * l'entree apres usage. On y place donc exactement ce qu'il y aurait mis
 * lui-meme ({ dataHref, json, response, text, cacheKey }). Interne a Next 14 :
 * si la structure n'est pas la, on ne fait rien et le clic retombe sur le
 * chemin normal.
 */
function handToRouter(href: string, response: Response, text: string, holdMs: number) {
  const sdc = routerCache();
  if (!sdc) return;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  const cacheKey = new URL(href, window.location.href).href;
  if (sdc[cacheKey] !== undefined) return; // le routeur a deja la sienne
  const entry = Promise.resolve({ dataHref: href, json, response, text, cacheKey });
  sdc[cacheKey] = entry;
  window.setTimeout(() => {
    if (sdc[cacheKey] === entry) delete sdc[cacheKey];
  }, holdMs);
}

function anchorId(target: EventTarget | null): { el: Element; id: number } | null {
  const el = (target as Element | null)?.closest?.(`[${PREVIEW_ATTR}]`);
  if (!el) return null;
  const id = Number(el.getAttribute(PREVIEW_ATTR));
  return Number.isFinite(id) && id > 0 ? { el, id } : null;
}

/** Un lien interne vers une page qu'on sait prechauffer : un profil (navbar,
 *  barre mobile, carte d'un membre…) ou une page du menu. */
function warmableLink(target: EventTarget | null): { el: Element; path: string } | null {
  const el = (target as Element | null)?.closest?.('a[href^="/en"]:not([target="_blank"])');
  if (!el) return null;
  const path = el.getAttribute("href") || "";
  if (path.startsWith("/en/profile/") || menuRoute(path)) return { el, path };
  return null;
}

function warmLink(path: string): void {
  if (path.startsWith("/en/profile/")) warmProfileData(path);
  else warmMenuPage(path);
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
    const prof = hit ? null : warmableLink(e.target);
    const el = hit?.el ?? prof?.el;
    if (!el || el === current) return;
    clear();
    current = el;
    timer = window.setTimeout(
      () => (hit ? warmAnimeData(hit.id) : warmLink(prof!.path)),
      HOVER_INTENT_MS,
    );
  };
  const onOut = (e: PointerEvent) => {
    if (!current) return;
    const to = e.relatedTarget as Node | null;
    if (to && current.contains(to)) return;
    clear();
  };
  const onDown = (e: PointerEvent) => {
    const hit = anchorId(e.target);
    if (hit) return warmAnimeData(hit.id);
    const link = warmableLink(e.target);
    if (link) warmLink(link.path);
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
