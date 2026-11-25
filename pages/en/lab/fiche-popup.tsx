/**
 * ESSAI (25/11/2026, Luc) : LA FICHE ANIME EN POP-UP, comme free.cine-track.
 *
 *   /fr/lab/fiche-popup
 *
 * Un clic sur une carte n'ouvre pas une nouvelle page : la VRAIE fiche (le même
 * composant que /fr/anime/<id>, les mêmes données) s'affiche par-dessus la
 * grille, qui reste en place. L'URL devient celle de la fiche (partageable,
 * rechargeable), et Retour / Échap / clic à côté la referment.
 *
 * TOUT EST DANS CE FICHIER. Le supprimer retire l'essai : aucun autre fichier
 * du site n'en dépend.
 *
 * Comment : le code de la fiche est demandé au chargeur de pages de Next
 * (`pageLoader.loadPage`, le même morceau que la navigation normale : rien
 * n'est téléchargé deux fois) ; ses données, à la même URL que la navigation
 * normale (`/_next/data/...`), donc au même cache Cloudflare. Les deux partent
 * au survol de la carte (150 ms immobile) ou à l'appui du doigt.
 */
import Head from "next/head";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";

import { Navbar } from "@/components/shared/NavBar";
import { coverUrl } from "@/lib/images/cover";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";

const ROUTE = "/en/anime/[...id]";
const MOBILE_UA = /^.*(Android|android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini).*$/;

type Card = { id: number; title: any; coverImage: any; status?: string };
type Loaded = { Page: ComponentType<any>; props: any };

/* ── Chargement ─────────────────────────────────────────────────────── */

function nextRouter(): any {
  return (window as any).next?.router;
}

/** Le code de la fiche, et ses feuilles de style (en production, Next ne les
    pose qu'au changement de page : on les pose nous-mêmes, au même format). */
let pagePromise: Promise<ComponentType<any>> | null = null;
function loadFichePage(): Promise<ComponentType<any>> {
  if (!pagePromise) {
    const p: Promise<ComponentType<any>> = nextRouter()
      .pageLoader.loadPage(ROUTE)
      .then((r: any) => {
        for (const s of r.styleSheets || []) {
          if (document.querySelector(`style[data-n-href="${s.href}"], link[href="${s.href}"]`)) continue;
          const el = document.createElement("style");
          el.setAttribute("data-n-href", s.href);
          el.appendChild(document.createTextNode(s.text));
          document.head.appendChild(el);
        }
        return r.page as ComponentType<any>;
      });
    p.catch(() => (pagePromise = null));
    pagePromise = p;
    return p;
  }
  return pagePromise;
}

/** Même URL de données que la navigation normale (cf. lib/navigation/warmAnimeData.ts). */
function dataHref(id: number): string {
  const q = MOBILE_UA.test(navigator.userAgent) ? `__m=1&id=${id}` : `id=${id}`;
  const loader = nextRouter()?.pageLoader;
  try {
    return loader.getDataHref({ href: `${ROUTE}?${q}`, asPath: `/en/anime/${id}`, skipInterpolation: true });
  } catch {
    return `/_next/data/${(window as any).__NEXT_DATA__.buildId}/en/anime/${id}.json?${q}`;
  }
}

const dataCache = new Map<number, Promise<any>>();
function loadFicheData(id: number): Promise<any> {
  let p = dataCache.get(id);
  if (!p) {
    p = fetch(dataHref(id), { credentials: "same-origin", headers: { "x-nextjs-data": "1" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (!j?.pageProps || j.pageProps.__N_REDIRECT || j.notFound) throw new Error("redirection");
        return j.pageProps;
      });
    p.catch(() => dataCache.delete(id));
    dataCache.set(id, p);
    // Une minute, comme le cache du SSR : au-delà la fiche serait périmée.
    setTimeout(() => dataCache.get(id) === p && dataCache.delete(id), 60_000);
  }
  return p;
}

function warm(id: number) {
  loadFichePage().catch(() => {});
  loadFicheData(id).catch(() => {});
}

/* ── La page ────────────────────────────────────────────────────────── */

export default function FichePopupLab() {
  const pref = useTitlePref();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const pushed = useRef(false);
  const sheet = useRef<HTMLDivElement>(null);
  const hover = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/v2/catalog/trending?page=1")
      .then((r) => r.json())
      .then((j) => setCards(j?.media || []))
      .catch(() => setCards([]));
    // Le code de la fiche, dès que le navigateur souffle.
    const idle = (window as any).requestIdleCallback || ((f: () => void) => setTimeout(f, 1500));
    idle(() => loadFichePage().catch(() => {}));
  }, []);

  const open = useCallback((id: number) => {
    const t0 = performance.now();
    setOpenId(id);
    setLoaded(null);
    setError(null);
    setMs(null);
    /* L'URL de la fiche, avec un état que le routeur de Next comprend : un
       Retour plus tard depuis une AUTRE page y ramène la vraie fiche. */
    const prefix = window.location.pathname.startsWith("/fr/") ? "/fr" : "/en";
    window.history.pushState(
      { __N: true, url: `${ROUTE}?id=${id}`, as: `/en/anime/${id}`, options: {}, key: Math.random().toString(36).slice(2, 10) },
      "",
      `${prefix}/anime/${id}`,
    );
    pushed.current = true;
    document.documentElement.style.overflow = "hidden";
    Promise.all([loadFichePage(), loadFicheData(id)])
      .then(([Page, props]) => {
        setLoaded({ Page, props });
        setMs(Math.round(performance.now() - t0));
      })
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  const finish = useCallback(() => {
    setOpenId(null);
    setLoaded(null);
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }, []);

  /** Fermer = revenir dans l'historique : l'URL redevient celle de la grille. */
  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else finish();
  }, [finish]);

  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname.includes("/lab/fiche-popup")) {
        pushed.current = false;
        finish();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openId != null && !document.querySelector("[role=dialog]:not(.lab-fiche-sheet)")) close();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
    };
  }, [openId, close, finish]);

  /* En quittant la page de test fiche ouverte (un lien de la fiche) : rien ne
     doit rester bloqué. */
  useEffect(() => () => {
    document.documentElement.style.overflow = "";
  }, []);

  // Entrée de la feuille : Web Animations, sans `transform` résiduel (il
  // casserait les éléments `fixed` de la fiche : lightbox, menus).
  useEffect(() => {
    if (openId == null) return;
    sheet.current?.animate(
      [
        { opacity: 0, transform: "translateY(24px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
    sheet.current?.scrollTo(0, 0);
  }, [openId]);

  const Page = loaded?.Page;

  return (
    <>
      <Head>
        <title>Essai — fiche en pop-up • AniScroll</title>
        <meta name="robots" content="noindex" />
      </Head>
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 pb-16 pt-24">
        <h1 className="font-outfit text-2xl font-bold text-white">Essai : la fiche en pop-up</h1>
        <p className="mt-1 font-karla text-sm text-white/60">
          Clique une carte : la vraie fiche s&apos;ouvre par-dessus. Retour, Échap ou clic à côté pour la fermer.
          Page de test, non référencée.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {(cards ?? Array.from({ length: 12 }, () => null)).map((c, i) =>
            c ? (
              <a
                key={c.id}
                href={`/en/anime/${c.id}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  open(c.id);
                }}
                onPointerEnter={(e) => {
                  if (e.pointerType !== "mouse") return;
                  hover.current = window.setTimeout(() => warm(c.id), 150);
                }}
                onPointerLeave={() => hover.current != null && clearTimeout(hover.current)}
                onPointerDown={() => warm(c.id)}
                className="group block"
              >
                <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-white/5">
                  <Image
                    src={coverUrl(c.coverImage, "card") || ""}
                    alt=""
                    fill
                    sizes="200px"
                    className="object-cover transition-transform duration-200 group-hover:scale-105"
                  />
                </div>
                <p className="mt-2 line-clamp-2 font-karla text-sm font-bold text-white">{pickTitle(c.title, pref)}</p>
              </a>
            ) : (
              <div key={i} className="aspect-[2/3] animate-pulse rounded-xl bg-white/5" />
            ),
          )}
        </div>
      </main>

      {openId != null && (
        <div
          className="lab-fiche fixed inset-0 z-[10000] bg-black/70 backdrop-blur-sm"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <div
            ref={sheet}
            role="dialog"
            aria-modal="true"
            className="lab-fiche-sheet absolute inset-0 overflow-y-auto overscroll-contain bg-primary md:inset-x-[4vw] md:bottom-0 md:top-6 md:rounded-t-3xl md:shadow-[0_-20px_60px_rgba(0,0,0,.6)]"
          >
            <button
              type="button"
              onClick={close}
              aria-label="Fermer"
              className="sticky top-3 z-[10001] float-right mr-3 mt-3 grid h-10 w-10 place-items-center rounded-full bg-black/60 text-xl text-white ring-1 ring-white/20 backdrop-blur hover:bg-action"
            >
              ✕
            </button>
            {ms != null && (
              <span className="sticky top-4 z-[10001] float-right mr-2 mt-4 rounded-full bg-black/60 px-3 py-1 font-karla text-xs text-white/70">
                ouverte en {ms} ms
              </span>
            )}
            {Page && loaded ? (
              <Page key={openId} {...loaded.props} />
            ) : error ? (
              <div className="grid h-full place-items-center p-10 text-center font-karla text-white/70">
                <div>
                  <p>La fiche n&apos;a pas pu s&apos;ouvrir ici ({error}).</p>
                  <a className="mt-3 inline-block text-action underline" href={`/en/anime/${openId}`}>
                    Ouvrir la page normale
                  </a>
                </div>
              </div>
            ) : (
              <div className="p-6">
                <div className="h-[45vh] animate-pulse rounded-2xl bg-white/5" />
                <div className="mt-6 h-8 w-1/2 animate-pulse rounded bg-white/5" />
                <div className="mt-3 h-4 w-2/3 animate-pulse rounded bg-white/5" />
              </div>
            )}
          </div>
          {/* La fiche apporte sa barre de navigation et son pied de page : dans
              la pop-up, ce sont ceux de la page dessous qui comptent. */}
          <style>{`
            .lab-fiche-sheet > nav.as-navbar, .lab-fiche-sheet > footer, .lab-fiche .as-above-tabbar { display: none !important; }
          `}</style>
        </div>
      )}
    </>
  );
}
