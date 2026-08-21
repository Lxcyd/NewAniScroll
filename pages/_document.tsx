import { Html, Head, Main, NextScript } from "next/document";
import { EARLY_SOURCE_SCRIPT } from "@/lib/watch/earlySource";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* Premier de tout, et volontairement : il demande la video pendant que
            le bundle se telecharge, au lieu d'attendre derriere lui. Pose ici
            plutot que dans le <Head> de la page de lecture — c'est le seul
            endroit ou la place dans le document est garantie — et il sort de
            lui-meme sur toutes les autres pages, dont l'URL ne lui parle pas.
            Voir lib/watch/earlySource.ts pour ce qu'il tire et ce qu'il laisse
            au code. */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_SOURCE_SCRIPT }} />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/logo.png" />
        <meta name="theme-color" content="#0c0d10" />
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.14.0/css/all.min.css"
          integrity="sha512-1PKOgIY59xJ8Co8+NE6FZ+LOAZKjy+KY8iq0G4B3CyeY6wYHN3yt9PW0XpSriVlkMXe40PTKnXrLnZ9+fkDaog=="
          crossOrigin="anonymous"
        />
        <link rel="icon" type="image/png" href="/logo.png" />
        {/* Chrome deprecated the apple- prefixed meta in favour of the
            standard one; ship both (Safari still reads the apple- one). */}
        <meta name="mobile-web-app-capable" content="yes"></meta>
        <meta name="apple-mobile-web-app-capable" content="yes"></meta>
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        ></meta>
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
