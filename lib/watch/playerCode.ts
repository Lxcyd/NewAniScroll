/* Le code du lecteur, et le moyen de le faire venir avant d'en avoir besoin.

   hls.js etait charge par Vidstack depuis `cdn.jsdelivr.net/npm/hls.js@^1.0.0` :
   une AUTRE origine (DNS + TLS a froid, lourd sur mobile), une version
   flottante qui changeait sans deploy, et une dependance de plus — jsDelivr en
   panne, plus aucun lecteur HLS. Il vient maintenant du bundle (version
   epinglee dans package.json, celle que servait jsDelivr), en chunk de la meme
   origine, deja en HTTP/2 ouvert.

   `preloadPlayerCode` lance les deux telechargements sans rien executer de
   plus : la page de lecture l'appelle au chargement de son module (le chunk
   du lecteur ne partait qu'au premier rendu de <UniversalPlayer>, donc APRES
   la source et la liste d'episodes), la page info et le survol de « Regarder »
   aussi. Les `import()` sont dedupliques par webpack : appeler plusieurs fois
   ne coute rien. */

import { fabriqueLoader } from "./hlsPreload";

export const loadHlsLibrary = () => import("hls.js");

/* Le chargeur d'hls.js qui lit d'abord les manifestes deja en memoire.
   Il ne peut etre fabrique qu'une fois hls.js la (il herite de son chargeur par
   defaut), alors que `onProviderChange` est synchrone : on le prepare donc des
   le prechargement, et le lecteur le prend s'il est pret. Sinon il s'en passe,
   et hls.js fait ses requetes comme avant — un prechargement rate n'est jamais
   une panne. */
let loaderMemoire: any = null;

export function getLoaderMemoire(): any {
  return loaderMemoire;
}

export function preloadPlayerCode(): void {
  if (typeof window === "undefined") return;
  void import("@/components/watch/primary/UniversalPlayer").catch(() => {});
  void loadHlsLibrary()
    .then((m) => {
      if (!loaderMemoire) loaderMemoire = fabriqueLoader((m as any).default || m);
    })
    .catch(() => {});
}
