/**
 * LES IMPORTS DU STUDIO (24/10/2026, Luc) : images, GIF et vidéos qu'on dépose
 * soi-même, pour l'avatar et pour le fond du profil.
 *
 * Où ils vivent : dans le KV Cloudflare du Worker `aniscroll-proxy`, servis
 * par `GET https://proxy.aniscroll.com/w/u/<id>.<ext>` avec un an de cache au
 * bord (worker/src/uploads.js). Pas de Vercel dans le chemin : ni stockage de
 * déploiement, ni CPU par vue.
 *
 * CE QUI EMPÊCHE UN IMPORT D'EXÉCUTER DU CODE — chaque étage compte, aucun ne
 * fait confiance au précédent :
 *   1. Le TYPE se lit dans les premiers octets du fichier (`sniff`), jamais
 *      dans son nom ni dans ce que le navigateur en dit. Six formats passent :
 *      PNG, JPEG, WebP, GIF, MP4, WebM. Pas de SVG (il porte du script), pas de
 *      HTML, rien d'autre.
 *   2. Une image FIXE est redessinée dans un canvas puis réencodée en WebP
 *      avant l'envoi : ce qui part n'est plus le fichier déposé mais des
 *      pixels. Métadonnées et charge cachée (fichiers « polyglottes ») ne
 *      survivent pas.
 *   3. Le Worker relit les octets lui-même, refuse le reste, et range le type
 *      qu'IL a reconnu.
 *   4. Il sert avec ce type exact, `X-Content-Type-Options: nosniff` (le
 *      navigateur ne devine rien) et `Content-Security-Policy: default-src
 *      'none'; sandbox` (ouvert seul dans un onglet, le fichier n'a droit à
 *      aucun script).
 *   5. Le profil n'accepte qu'une adresse de la forme exacte `UPLOAD_RE`, et ne
 *      l'affiche que dans un `<img>` ou un `<video>` — jamais un iframe.
 *
 * Module sans dépendance : il est lu côté serveur à la validation du profil.
 */

export const UPLOAD_ORIGIN = "https://proxy.aniscroll.com";

/** L'adresse d'un import, et rien d'autre : id de 32 hex, extension connue. */
export const UPLOAD_RE = /^https:\/\/proxy\.aniscroll\.com\/w\/u\/[0-9a-f]{32}\.(webp|jpg|png|gif|mp4|webm)$/;

/** 5 Mo par image (GIF compris), 15 Mo par vidéo (24/10/2026, Luc). */
export const IMAGE_MAX = 5 * 1024 * 1024;
export const VIDEO_MAX = 15 * 1024 * 1024;

export function isUploadUrl(url: unknown): boolean {
  return typeof url === "string" && url.length <= 120 && UPLOAD_RE.test(url);
}

/** Un import vidéo (MP4, WebM) : il se lit dans un `<video>`, pas un `<img>`. */
export function isVideoUpload(url: unknown): boolean {
  return isUploadUrl(url) && /\.(mp4|webm)$/.test(url as string);
}

/** Un import image (fixe ou GIF). */
export function isImageUpload(url: unknown): boolean {
  return isUploadUrl(url) && !/\.(mp4|webm)$/.test(url as string);
}

export type Sniffed = { type: string; ext: "png" | "jpg" | "webp" | "avif" | "gif" | "mp4" | "webm"; kind: "image" | "gif" | "video" };

/* Les marques ISO-BMFF d'IMAGES : même en-tête `ftyp` qu'un MP4, mais ce sont
   des photos (AVIF, HEIC). Sans ce tri, un AVIF passait pour une vidéo. */
const IMAGE_BRANDS = ["avif", "avis", "heic", "heix", "mif1", "msf1"];

/** Le format réel d'un fichier, d'après ses premiers octets (16 suffisent), ou `null`.
    Même règle que `sniff` dans worker/src/uploads.js — les deux se tiennent. */
export function sniff(b: Uint8Array): Sniffed | null {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length < 12) return null;
  if (b[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return { type: "image/png", ext: "png", kind: "image" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg", kind: "image" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { type: "image/webp", ext: "webp", kind: "image" };
  if (at(0, "GIF87a") || at(0, "GIF89a")) return { type: "image/gif", ext: "gif", kind: "gif" };
  if (at(4, "ftyp")) {
    /* Une image AVIF se redessine dans le navigateur (elle part en WebP) ;
       HEIC, que le navigateur ne sait pas décoder, est refusé. */
    if (at(8, "avif") || at(8, "avis")) return { type: "image/avif", ext: "avif", kind: "image" };
    if (IMAGE_BRANDS.some((x) => at(8, x))) return null;
    return { type: "video/mp4", ext: "mp4", kind: "video" };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: "video/webm", ext: "webm", kind: "video" };
  return null;
}
