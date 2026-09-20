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
        {/* Les covers et bannieres viennent d'AniList sur toutes les pages :
            ouvrir la connexion pendant que le HTML se lit, pas a la premiere
            <img>. (Font Awesome 5 etait charge ici en CSS bloquante depuis
            cdnjs ; aucune classe `fa` n'existe dans le depot — retire.) */}
        <link rel="preconnect" href="https://s4.anilist.co" />
        <link rel="dns-prefetch" href="https://fanart-proxy.aniscroll.com" />
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
