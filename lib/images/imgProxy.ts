/**
 * wsrv.nl — proxy d'images public et gratuit (open source, weserv/images),
 * servi par le CDN de Cloudflare et mis en cache un an.
 *
 * Pourquoi il est la : notre propre proxy fanart (fanart-proxy.aniscroll.com)
 * convertit en AVIF via les Image Transformations de Cloudflare, limitees a
 * 5 000 variantes uniques par mois sur l'offre gratuite. Une fois le quota
 * mange, chaque nouvelle image repondait 429 et le site retombait sur
 * l'ORIGINAL de fanart.tv : un PNG/JPEG de plusieurs Mo, servi par une seule
 * origine lente. wsrv s'intercale entre les deux — meme image, reencodee en
 * WebP, sans quota — et l'original ne reste que le dernier recours.
 *
 * Pas de redimensionnement ici (pas de `w`) : l'image doit rester celle qu'on
 * affichait. `default=` fait rediriger wsrv vers l'original s'il echoue.
 *
 * Interrupteur : NEXT_PUBLIC_IMG_PROXY=off le coupe partout, sans code.
 * Limite connue : 2 500 images NON cachees par IP de visiteur toutes les
 * 10 min — hors de portee d'une navigation humaine.
 */

const HOST = "https://wsrv.nl/";
const ENABLED = process.env.NEXT_PUBLIC_IMG_PROXY !== "off";

/** L'URL wsrv pour `url`, ou null si le proxy est coupe / l'URL absente. */
export function wsrvUrl(url: string | null | undefined): string | null {
  if (!ENABLED || !url) return null;
  const p = new URLSearchParams({
    url,
    output: "webp",
    q: "85",
    default: url,
  });
  return `${HOST}?${p.toString()}`;
}

/** Si `src` est une URL wsrv, l'URL d'origine qu'elle enveloppe ; sinon null. */
export function unwrapWsrv(src: string | null | undefined): string | null {
  if (!src || !src.startsWith(HOST)) return null;
  try {
    return new URL(src).searchParams.get("url");
  } catch {
    return null;
  }
}
