/**
 * IMPORTER SON AVATAR (24/10/2026, Luc). Pas de serveur de fichiers (R2 exige
 * une carte bancaire) : l'image est réduite DANS LE NAVIGATEUR puis rangée
 * avec le profil, en data URL WebP — ~512 px au plus grand côté, sous
 * `AVATAR_DATA_MAX` caractères. Le cadrage, lui, se fait ensuite dans l'éditeur.
 *
 * Les imports se gardent dans CE navigateur (« Tes imports », comme « Mes
 * vidéos ») ; celui qu'on porte part avec le profil.
 *
 * GIF ET VIDÉO (24/10/2026, Luc) : un canvas figerait l'animation, et ni l'un
 * ni l'autre ne tient sous 60 Ko. Ils partent au Worker (lib/upload/client.ts)
 * et la liste garde leur adresse d'import. Les images fixes restent ici.
 */
import { AVATAR_DATA_MAX } from "@/lib/profile/dressing";
import { isUploadUrl } from "@/lib/upload/media";
import { sniffFile, uploadMedia } from "@/lib/upload/client";

const KEY = "as-studio-avatar-imports";
/** Dix au plus (24/10/2026, Luc). */
export const MAX_IMPORTS = 10;
/** `name` : celui qu'on lui donne au crayon, sinon rien (« Image importée »). */
/** `h` : l'empreinte du fichier d'origine (lib/upload/client.ts), pour refuser
    un doublon avant de l'envoyer. */
export type AvatarImport = { id: string; url: string; name?: string; h?: string };

export function readImports(): AvatarImport[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw)
      ? raw
          .filter(
            (v) =>
              typeof v?.id === "string" &&
              typeof v?.url === "string" &&
              (v.url.startsWith("data:image/") || isUploadUrl(v.url)),
          )
          .map((v) => ({
            id: v.id,
            url: v.url,
            ...(typeof v.name === "string" && v.name ? { name: v.name.slice(0, 40) } : {}),
            ...(typeof v.h === "string" && /^[0-9a-f]{16}$/.test(v.h) ? { h: v.h } : {}),
          }))
          .slice(0, MAX_IMPORTS)
      : [];
  } catch {
    return [];
  }
}

export function writeImports(list: AvatarImport[]): AvatarImport[] {
  const out = list.slice(0, MAX_IMPORTS);
  try {
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* Stockage plein : la liste reste en mémoire pour la session. */
  }
  return out;
}

/** Un fichier choisi pour l'avatar → son adresse : data URL pour une image
    fixe, adresse d'import pour un GIF ou une vidéo. Erreurs : cf. client.ts. */
export async function fileToAvatarUrl(file: File): Promise<string> {
  const s = await sniffFile(file);
  if (s.kind === "image") return fileToAvatar(file);
  return (await uploadMedia(file, { maxSide: 512, allow: ["gif", "video"] })).url;
}

/** Une image choisie → data URL WebP assez légère pour le profil, ou une erreur. */
export async function fileToAvatar(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("type");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let side = 512;
    let quality = 0.86;
    for (let i = 0; i < 8; i++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k));
      const h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      if (!g) throw new Error("canvas");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, w, h);
      const data = c.toDataURL("image/webp", quality);
      /* Un navigateur sans encodeur WebP rend du PNG : trop lourd, on le
         ramène en JPEG. */
      const out = data.startsWith("data:image/webp") ? data : c.toDataURL("image/jpeg", quality);
      if (out.length <= AVATAR_DATA_MAX) return out;
      /* Trop lourd : un peu moins de qualité, puis un peu moins de pixels. */
      if (quality > 0.6) quality -= 0.12;
      else side = Math.round(side * 0.8);
    }
    throw new Error("size");
  } finally {
    URL.revokeObjectURL(url);
  }
}
