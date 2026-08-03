/**
 * `/` is redirected to `/en` by `redirects()` in next.config.js — NOT here.
 *
 * This file used to hold a `getServerSideProps` that returned nothing but
 * `{ redirect: { destination: "/en" } }`. That is a **function invocation on
 * every visit to the site root** (133 of them in a 12h window, read off the
 * Vercel Functions dashboard) to emit a Location header that the routing layer
 * serves on its own, for free, before any function is reached.
 *
 * The component below is effectively never rendered — the redirect fires first.
 * The file stays because Next.js needs a page to own the `/` route, and the
 * <Head> meta stays for the crawler that reads the body of a 307 instead of
 * following it.
 */
import Head from "next/head";

export default function Home() {
  return (
    <>
      <Head>
        <meta
          name="twitter:title"
          content="AniScroll - Free Anime and Manga Streaming"
        />
        <meta
          name="twitter:description"
          content="Discover your new favorite anime or manga title! AniScroll offers a vast library of high-quality content, accessible on multiple devices and without any interruptions. Start using AniScroll today!"
        />
        <meta name="twitter:image" content="/logo.png" />
        <meta
          name="description"
          content="Discover your new favorite anime or manga title! AniScroll offers a vast library of high-quality content, accessible on multiple devices and without any interruptions. Start using AniScroll today!"
        />
      </Head>
    </>
  );
}
