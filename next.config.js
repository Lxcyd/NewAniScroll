/** @type {import('next').NextConfig} */

// Default next-pwa runtimeCaching minus the `.mp4` / audio entries that
// route playback through workbox's CacheFirst+rangeRequests strategy. That
// strategy issues a CORS-mode fetch internally; cross-origin video CDNs
// (sibnet's cvn cluster being the canonical case) don't send
// Access-Control-Allow-Origin, so every Range request fails CORS and
// playback never starts. We let the <video> element handle media itself
// with its native no-cors mode — the SW still caches everything else for
// the PWA / offline story.
/* Endpoints VOLATILS : le SW ne doit JAMAIS en servir une copie, ni meme les
   intercepter.
   21/09/2026 — « quand on recharge une page apres longtemps, par exemple apres
   redemarrage du PC, parfois les lecteurs ne se rechargent pas et on a une page
   d'erreur ». L'onglet est restaure AVANT que le reseau soit pret : la regle
   NetworkFirst attend `networkTimeoutSeconds` (10 s), echoue, et sert une
   reponse `/api/v2/source` vieille de 24 h. Or les tokens des URL upstream ne
   vivent que 60 a 240 min : le proxy repond 410 (worker/src/index.js), que
   hls.js traite en « stream mort » — tier 1, aucune recovery. La bascule
   s'enchaine d'un lecteur a l'autre et on finit sur « serveur indisponible ».
   Et rien ne refetch au retour du reseau.
   La route dit pourtant elle-meme ce qu'elle vaut (`Cache-Control: max-age=60`,
   cf. pages/api/v2/source/index.js) — mais le cache du SW ne lit pas cet
   en-tete, il ne connait que son propre `maxAgeSeconds`. D'ou cette liste.

   IMPORTANT — la soustraction se fait sur les DEUX regles NetworkFirst plus
   bas. Retiree de la seule regle `apis`, la requete retombait sur le fourre-tout
   `others`, NetworkFirst lui aussi : le bug aurait simplement change de cache.
   Le routeur workbox parcourt les routes DANS L'ORDRE, premiere qui matche
   gagne, et n'intercepte pas du tout quand aucune ne matche (`findMatchingRoute`
   puis `if (!handler) return` dans public/workbox-*.js). Zero route qui matche
   est donc exactement le but : le navigateur fait sa propre requete et applique
   le `max-age=60` natif.

   Gain annexe : `/api/v2/source` est sur le chemin critique du lecteur — c'est
   la requete que le script pre-bundle (lib/watch/earlySource.ts) tire avant
   meme React, en `priority:"high"`. On lui retire la traversee du routeur et le
   `cache.put` de la reponse.

   ⚠ LE LITTERAL EST RECOPIE DANS CHAQUE `urlPattern`, ET C'EST OBLIGATOIRE.
   next-pwa serialise ces fonctions avec `.toString()` pour les ecrire dans
   public/sw.js : toute variable de ce fichier referencee dans le corps est
   PERDUE a la generation. Une constante partagee produit un sw.js qui appelle
   `API_VOLATILE.test(...)` sans que rien ne la definisse — ReferenceError dans
   le routeur, a chaque requete. Verifie sur le sw.js genere le 21/09/2026.
   La constante ci-dessous n'est donc JAMAIS employee dans un `urlPattern` :
   elle sert de reference au garde-fou pose en bas de `runtimeCaching`, qui
   fait echouer le build si l'une des deux copies derive. */
const API_VOLATILE =
  /^\/api\/(auth|user)\/|^\/api\/v2\/(source|availability|track|watch2gether|account|admin|list-entry|proxy|download)/;

const runtimeCaching = [
  {
    urlPattern: /^https:\/\/fonts\.(?:gstatic)\.com\/.*/i,
    handler: "CacheFirst",
    options: {
      cacheName: "google-fonts-webfonts",
      expiration: { maxEntries: 4, maxAgeSeconds: 365 * 24 * 60 * 60 },
    },
  },
  {
    urlPattern: /^https:\/\/fonts\.(?:googleapis)\.com\/.*/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "google-fonts-stylesheets",
      expiration: { maxEntries: 4, maxAgeSeconds: 7 * 24 * 60 * 60 },
    },
  },
  {
    urlPattern: /\.(?:eot|otf|ttc|ttf|woff|woff2|font.css)$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "static-font-assets",
      expiration: { maxEntries: 4, maxAgeSeconds: 7 * 24 * 60 * 60 },
    },
  },
  {
    urlPattern: /\.(?:jpg|jpeg|gif|png|svg|ico|webp)$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "static-image-assets",
      expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
    },
  },
  {
    urlPattern: /\/_next\/image\?url=.+$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "next-image",
      expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
    },
  },
  // mp3/wav/ogg/mp4 deliberately omitted — see comment above.
  {
    urlPattern: /\.(?:js)$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "static-js-assets",
      expiration: { maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 },
    },
  },
  {
    urlPattern: /\.(?:css|less)$/i,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "static-style-assets",
      expiration: { maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 },
    },
  },
  {
    urlPattern: /\.(?:json|xml|csv)$/i,
    handler: "NetworkFirst",
    options: {
      cacheName: "static-data-assets",
      expiration: { maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 },
    },
  },
  // Quasi-static API GETs — CacheFirst, so a repeat view costs NO network
  // request at all. Every one of these already ships a long Cache-Control from
  // the server (24h on skip, an hour on changelog-popup, a year on
  // banner-tone), but the blanket NetworkFirst rule below used to intercept
  // them first and go to the network anyway. On Vercel an Edge Request is
  // billed on a cache HIT just the same as a MISS, so "served from the CDN"
  // was never free — not making the request is the only thing that is.
  //
  // Deliberately excluded: anything user-scoped (/api/user, /api/auth) and
  // anything that must reflect a live change (/api/v2/source, /api/v2/track)
  // — voir `API_VOLATILE` ci-dessus, qui rend cette exclusion vraie pour les
  // DEUX regles NetworkFirst qui suivent, et plus seulement pour celle-ci.
  {
    urlPattern: ({ url, sameOrigin }) =>
      sameOrigin &&
      /^\/api\/v2\/(skip|themes|episode-scores|episode-meta|changelog-popup|changelog|banner-tone|fanarts)\b/.test(
        url.pathname,
      ),
    handler: "CacheFirst",
    method: "GET",
    options: {
      cacheName: "apis-static",
      // Generous entry budget: these are keyed per anime/episode, so a viewer
      // working through a season fills a lot of distinct URLs. Too small an
      // LRU evicts entries before they're ever reused — which is exactly what
      // maxEntries:16 was doing to the shared cache below.
      expiration: { maxEntries: 256, maxAgeSeconds: 24 * 60 * 60 },
    },
  },
  {
    // Copie 1/2 du littéral d'API_VOLATILE — cf. son commentaire : une variable
    // ne survit pas au `.toString()` de next-pwa. Copie 2/2 sur `others`.
    urlPattern: ({ url, sameOrigin }) =>
      sameOrigin &&
      url.pathname.startsWith("/api/") &&
      !/^\/api\/(auth|user)\/|^\/api\/v2\/(source|availability|track|watch2gether|account|admin|list-entry|proxy|download)/.test(
        url.pathname,
      ),
    handler: "NetworkFirst",
    method: "GET",
    options: {
      cacheName: "apis",
      // Was 16 — far too small once a session touches a dozen distinct
      // per-id endpoints, so entries were evicted before they could serve.
      expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
      networkTimeoutSeconds: 10,
    },
  },
  // Catch-all for the rest of the app shell — gated on sameOrigin so the
  // SW never tries to handle a cross-origin video / segment fetch (which
  // is the bug that broke sibnet playback).
  //
  // …et gate aussi sur `request.mode !== "navigate"`. Une NAVIGATION prise en
  // charge ici passe par NetworkFirst : si le reseau echoue ou depasse les 10 s
  // et que rien n'est en cache, workbox rend une REPONSE D'ERREUR — le
  // navigateur affiche alors une page morte au lieu de faire sa propre requete.
  // Signature exacte relevee le 26/08/2026 sur dev, page /fr/anime/watch/… :
  //     The FetchEvent for "…" resulted in a network error response:
  //     the promise was resolved with an error response object.
  // suivie d'un `blob: ERR_FILE_NOT_FOUND` et d'un `removeChild` React — le
  // lecteur se montait sur une page dont la ressource n'etait jamais arrivee.
  // Laisser passer les navigations rend au navigateur son propre repli ; on ne
  // perd rien, le document n'etait de toute facon pas servi depuis le cache.
  //
  // `API_VOLATILE` est soustrait ICI AUSSI, et ce n'est pas une precaution :
  // sans cette clause, tout ce qu'on retire de la regle `apis` ci-dessus
  // retombe ici, sous la meme strategie NetworkFirst 10 s / 24 h. Le bug
  // aurait juste change de cache (21/09/2026).
  {
    // Copie 2/2 du littéral d'API_VOLATILE — cf. son commentaire.
    urlPattern: ({ url, sameOrigin, request }) =>
      sameOrigin &&
      request.mode !== "navigate" &&
      !/^\/api\/(auth|user)\/|^\/api\/v2\/(source|availability|track|watch2gether|account|admin|list-entry|proxy|download)/.test(
        url.pathname,
      ),
    handler: "NetworkFirst",
    options: {
      cacheName: "others",
      expiration: { maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 },
      networkTimeoutSeconds: 10,
    },
  },
];

/* Les deux copies du littéral d'API_VOLATILE doivent rester identiques a la
   constante. Elles ne peuvent pas etre factorisees (cf. le `.toString()` de
   next-pwa), alors on verifie — au build, ou une erreur est bruyante et
   gratuite, plutot qu'en production ou une derive serait muette. */
{
  const attendu = API_VOLATILE.source;
  const porteuses = runtimeCaching
    .filter(
      (r) =>
        typeof r.urlPattern === "function" &&
        r.urlPattern.toString().includes(attendu),
    )
    .map((r) => r.options.cacheName)
    .sort();
  if (porteuses.join(",") !== "apis,others") {
    throw new Error(
      `next.config.js : le littéral d'API_VOLATILE est soustrait à [${porteuses}] ` +
        `au lieu de [apis,others]. Toute règle NetworkFirst qui peut attraper ` +
        `/api/ doit le porter, sinon les endpoints volatils y retombent. ` +
        `Littéral attendu : ${attendu}`,
    );
  }
}

const withPWA = require("next-pwa")({
  dest: "public",
  register: true,
  disable: process.env.NODE_ENV === "development",
  skipWaiting: true,
  runtimeCaching,
  // Keep the ~250 watch-party emoji/sticker assets OUT of the SW precache
  // manifest. They're only ever needed inside a watch-party room (a tiny
  // fraction of sessions), but next-pwa precaches EVERYTHING under public/ by
  // default — so every visitor was downloading all of them up front (visible as
  // a flood of /emojis/*.png|gif fetches with a workbox initiator on the watch
  // page). Excluding them here means they load lazily, on demand, only when the
  // emoji picker actually renders them in a room.
  publicExcludes: ["!emojis/**/*"],
});

module.exports = withPWA({
  reactStrictMode: true,
  // The changelog API routes read changelog/*.md at runtime via a template-
  // literal path (`full.${lang}.md`), which Next's static file tracer can't
  // resolve — so it wouldn't bundle the files and the routes would 404 in
  // production. Explicitly include the folder for those functions.
  experimental: {
    outputFileTracingIncludes: {
      "/api/v2/changelog": ["./changelog/**"],
      "/api/v2/changelog-popup": ["./changelog/**"],
    },
    // Restore the scroll position on browser back/forward. Pages-router SSR
    // pages re-fetch their data on popstate; without this flag the page lands
    // back at the top, which reads as "back navigation is broken" even when
    // the route renders correctly.
    scrollRestoration: true,
  },
  webpack(config, options) {
    config.resolve.extensions.push(".ts", ".tsx");
    return config;
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.*.*",
      },
      {
        protocol: "https",
        hostname: "**.**.*.*",
      },
      {
        protocol: "https",
        hostname: "image.tmdb.org",
      },
      {
        protocol: "https",
        hostname: "tenor.com",
      },
      {
        protocol: "https",
        hostname: "meionovel.id",
      },
    ],
  },
  // distDir: process.env.BUILD_DIR || ".next",
  // Uncomment this if you want to use Docker
  // output: "standalone",
  // French URLs (/fr/...) are served by the existing /en/... page tree — there
  // is no physical pages/fr/** directory. The visible /fr prefix is swapped in
  // client-side (history.replaceState) when the site language is French; this
  // rewrite makes those /fr URLs actually resolve on reload / when shared, with
  // zero page duplication. getServerSideProps reads `query`, not the locale
  // segment, so it works identically under either prefix.
  async rewrites() {
    return {
      /* La fiche anime choisit sa mise en page (InfoPage / InfoPageMobile)
         d'apres le User-Agent lu au SSR — mais elle est cachee au bord 6 h par
         URL, pas par appareil : le premier visiteur de la fenetre decidait pour
         tous les autres, et un telephone recevait le HTML desktop (ou
         l'inverse) jusqu'a la bascule apres hydratation. Un flash de mauvaise
         mise en page, a chaque chargement « perdant ».

         Le telephone recoit donc une AUTRE URL interne, `?__m=1`, que le SSR
         lit a la place du User-Agent : sa sortie ne depend plus que de l'URL,
         et chaque variante a sa propre entree de cache. Cote client, le routeur
         de Next evalue la meme condition sur `navigator.userAgent`
         (resolve-rewrites.js) et ajoute le parametre a l'URL de donnees : les
         navigations client sont separees de la meme facon. La barre d'adresse
         ne change pas.

         En beforeFiles pour passer avant le rewrite /fr -> /en, et le faire
         lui-meme pour les URL /fr. La regex est celle de lib/hooks/useIsMobile
         (qui est insensible a la casse : les variantes utiles sont ecrites). */
      beforeFiles: [
        /* Le prefixe /fr vaut aussi pour les ROUTES DE DONNEES.
         *
         * Une page a `getServerSideProps` voit son URL de donnees construite par
         * Next a partir de `asPath` — c'est-a-dire, sur une session francaise,
         * du chemin cosmetique `/fr/...` pose par I18nProvider. Le rewrite plus
         * bas ne couvrant que les documents, toute navigation client qui
         * redemande les props tombait sur
         * `/_next/data/<build>/fr/anime/watch/....json` → 404, et Next affichait
         * `_error` : « An error occurred on client ». Le document, lui,
         * repondait parfaitement — d'ou un bug qui ne se voyait qu'en
         * navigation interne, jamais au rechargement ni en partage de lien.
         * Signale le 20/09/2026 sur la page de lecture ; il touchait en realite
         * TOUTE page SSR ouverte en francais (verifie : Frieren aussi).
         *
         * En beforeFiles, seul rang ou l'on passe devant le gestionnaire
         * `_next/data` de Next — un rewrite afterFiles arriverait apres son 404. */
        {
          source: "/_next/data/:build/fr/:path*",
          destination: "/_next/data/:build/en/:path*",
        },
        {
          source: "/_next/data/:build/fr.json",
          destination: "/_next/data/:build/en.json",
        },
        ...["en", "fr"].map((lang) => ({
        source: `/${lang}/anime/:id(\\d+)/:rest*`,
        has: [
          {
            type: "header",
            key: "user-agent",
            value:
              ".*(Android|android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini).*",
          },
        ],
        missing: [{ type: "query", key: "__m" }],
        destination: "/en/anime/:id/:rest*?__m=1",
        })),
      ],
      afterFiles: [
        {
          source: "/fr",
          destination: "/en",
        },
        {
          source: "/fr/:path*",
          destination: "/en/:path*",
        },
      ],
    };
  },
  async redirects() {
    return [
      // The site root. This lived in `pages/index.tsx` as a getServerSideProps
      // that returned only `{ redirect: { destination: "/en" } }` — i.e. a
      // serverless invocation on every hit to `/` just to emit a Location
      // header (133 in a 12h window on the Functions dashboard). Declared here,
      // Vercel's routing layer answers it before any function exists. 307 (not
      // 308) keeps the exact status the page returned, so no browser has a
      // permanent redirect pinned for a URL we may want to render one day.
      {
        source: "/",
        destination: "/en",
        permanent: false,
      },
      {
        source: "/donate",
        destination: "https://ko-fi.com/factiven",
        permanent: false,
        basePath: false,
      },
      {
        source: "/changelogs",
        destination: "https://github.com/Lxcyd/NewAniScroll/releases",
        permanent: false,
        basePath: false,
      },
      {
        source: "/github",
        destination: "https://github.com/Lxcyd/NewAniScroll",
        permanent: false,
        basePath: false,
      },
      {
        source: "/discord",
        destination: "https://discord.gg/CbrFwstYfC",
        permanent: false,
        basePath: false,
      },
    ];
  },
});
