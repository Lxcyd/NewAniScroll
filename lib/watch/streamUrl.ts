/* L'adresse a laquelle un flux se lit REELLEMENT.
   Le lecteur, la page de lecture et le prechauffage doivent tomber sur la meme
   chaine, sinon on chauffe le cache d'un chemin que personne ne lit — c'est
   deja arrive : `warmStream` tirait l'URL brute d'un hote qui refuse les
   requetes du navigateur pendant que la lecture passait par le Worker. */

/** Le Worker de proxy video, base resolue. L'env var n'est qu'un remplacement
 *  de build : quand elle manque, le lecteur retombe de toute facon sur cette
 *  adresse-la, donc elle est ecrite ici aussi. */
export const PROXY_BASE =
  (typeof process !== "undefined" &&
    (process as any).env?.NEXT_PUBLIC_PROXY_BASE) ||
  "https://proxy.aniscroll.com";

export function proxied(
  url: string,
  referer?: string | null,
  voeCookie?: string | null,
): string {
  if (!url) return url;
  const ref = referer ? `&referer=${encodeURIComponent(referer)}` : "";
  const ck = voeCookie ? `&vcookie=${encodeURIComponent(voeCookie)}` : "";
  return `${PROXY_BASE}?url=${encodeURIComponent(url)}${ref}${ck}`;
}

/** L'adresse de lecture d'un flux : telle quelle s'il est direct, par le
 *  Worker sinon. `null` pour un flux local (playlist blob d'un episode en
 *  plusieurs parties), qui n'existe que dans ce document. */
export function playbackUrl(
  stream: any,
  refererDeSecours?: string | null,
): string | null {
  const url: string | undefined = stream?.url;
  if (!url || stream?.localFile) return null;
  return stream.directUrl
    ? url
    : proxied(url, stream.referer || refererDeSecours, stream.voeCookie);
}

/** Ouvre la connexion vers l'origine d'une adresse, une fois par origine.
 *  Le DNS + TCP + TLS d'un CDN inconnu coute 100 a 300 ms, payes jusqu'ici au
 *  moment ou le flux etait demande. Les preconnect ecrits en dur dans la page
 *  ne peuvent pas couvrir un CDN dont le nom change (vidmoly tourne entre
 *  `prx-am-o-1.vmpx.online`, `prx-1546-ant.vmpx.online`…), celui-ci si. */
const origines = new Set<string>();
export function preconnectOrigin(url: string | null | undefined): void {
  if (!url || typeof document === "undefined") return;
  let origine: string;
  try {
    origine = new URL(url).origin;
  } catch {
    return;
  }
  if (!/^https?:$/.test(new URL(origine).protocol)) return;
  if (origines.has(origine)) return;
  origines.add(origine);
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origine;
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}
