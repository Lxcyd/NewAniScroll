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
  {
    urlPattern: ({ url, sameOrigin }) =>
      sameOrigin && url.pathname.startsWith("/api/"),
    handler: "NetworkFirst",
    method: "GET",
    options: {
      cacheName: "apis",
      expiration: { maxEntries: 16, maxAgeSeconds: 24 * 60 * 60 },
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
});

module.exports = withPWA({
  reactStrictMode: true,
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
        hostname: "simkl.in",
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
  async redirects() {
    return [
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
        destination: "https://discord.gg/v5fjSdKwr2",
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
