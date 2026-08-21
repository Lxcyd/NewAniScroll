/** @type {import('next').NextConfig} */
// const nextSafe = require("next-safe");

// Default next-pwa runtimeCaching minus the `.mp4` / audio entries that
// route playback through workbox's CacheFirst+rangeRequests strategy. That
// strategy issues a CORS-mode fetch internally; cross-origin video CDNs
// (sibnet's cvn cluster being the canonical case) don't send
// Access-Control-Allow-Origin, so every Range request fails CORS and
// playback never starts. We let the <video> element handle media itself
// with its native no-cors mode — the SW still caches everything else for
// the PWA / offline story.
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
  // anything that must reflect a live change (/api/v2/source, /api/v2/track).
  {
    urlPattern: ({ url, sameOrigin }) =>
      sameOrigin &&
      /^\/api\/v2\/(skip|themes|episode-scores|changelog-popup|changelog|banner-tone|fanarts)\b/.test(
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
    urlPattern: ({ url, sameOrigin }) =>
      sameOrigin && url.pathname.startsWith("/api/"),
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
  {
    urlPattern: ({ sameOrigin }) => sameOrigin,
    handler: "NetworkFirst",
    options: {
      cacheName: "others",
      expiration: { maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 },
      networkTimeoutSeconds: 10,
    },
  },
];

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
    return [
      {
        source: "/fr",
        destination: "/en",
      },
      {
        source: "/fr/:path*",
        destination: "/en/:path*",
      },
    ];
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
  // async headers() {
  //   return [
  //     {
  //       // matching all API routes
  //       source: "/api/:path*",
  //       headers: [
  //         { key: "Access-Control-Allow-Credentials", value: "true" },
  //         {
  //           key: "Access-Control-Allow-Origin",
  //           value: "https://moopa.live",
  //         }, // replace this your actual origin
  //         {
  //           key: "Access-Control-Allow-Methods",
  //           value: "GET,DELETE,PATCH,POST,PUT",
  //         },
  //         {
  //           key: "Access-Control-Allow-Headers",
  //           value:
  //             "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version",
  //         },
  //       ],
  //     },
  // {
  //   source: "/:path*",
  //   headers: nextSafe({
  //     contentTypeOptions: "nosniff",
  //     contentSecurityPolicy: {
  //       "base-uri": "'none'",
  //       "child-src": "'none'",
  //       "connect-src": [
  //         "'self'",
  //         "webpack://*",
  //         "https://graphql.anilist.co/",
  //         "https://api.aniskip.com/",
  //         "https://m3u8proxy.moopa.workers.dev/",
  //       ],
  //       "default-src": "'self'",
  //       "font-src": [
  //         "'self'",
  //         "https://cdnjs.cloudflare.com/",
  //         "https://fonts.gstatic.com/",
  //       ],
  //       "form-action": "'self'",
  //       "frame-ancestors": "'none'",
  //       "frame-src": "'none'",
  //       "img-src": [
  //         "'self'",
  //         "https://s4.anilist.co",
  //         "data:",
  //         "https://media.kitsu.io",
  //         "https://artworks.thetvdb.com",
  //         "https://img.moopa.live",
  //         "https://meo.comick.pictures",
  //         "https://kitsu-production-media.s3.us-west-002.backblazeb2.com",
  //       ],
  //       "manifest-src": "'self'",
  //       "media-src": ["'self'", "blob:"],
  //       "object-src": "'none'",
  //       "prefetch-src": false,
  //       "script-src": [
  //         "'self'",
  //         "https://static.cloudflareinsights.com",
  //         "'unsafe-inline'",
  //         "'unsafe-eval'",
  //       ],

  //       "style-src": [
  //         "'self'",
  //         "'unsafe-inline'",
  //         "https://cdnjs.cloudflare.com",
  //         "https://fonts.googleapis.com",
  //       ],
  //       "worker-src": "'self'",
  //       mergeDefaultDirectives: false,
  //       reportOnly: false,
  //     },
  //     frameOptions: "DENY",
  //     permissionsPolicy: false,
  //     // permissionsPolicyDirectiveSupport: ["proposed", "standard"],
  //     isDev: false,
  //     referrerPolicy: "no-referrer",
  //     xssProtection: "1; mode=block",
  //   }),
  // },
  //   ];
  // },
});
