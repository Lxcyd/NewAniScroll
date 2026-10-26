/**
 * LES FONDS IMPORTÉS (24/10/2026, Luc) : images et vidéos qu'on dépose soi-même
 * comme fond du profil, onglet Import du studio. Mêmes règles que les imports
 * d'avatar (lib/profile/avatarImport.ts) — dix au plus, gardés dans CE
 * navigateur, renommables, un doublon n'est pas réimporté — mais tous envoyés
 * au Worker (lib/upload/client.ts) : un fond ne tient pas dans le profil.
 *
 * Celui qu'on porte part avec le profil (`kind: "image"` ou `"video"`).
 */
import { isImageUpload, isUploadUrl } from "@/lib/upload/media";
import { MAX_IMPORTS } from "@/lib/profile/avatarImport";

const KEY = "as-studio-bg-imports";

/** `poster` : l'affiche d'une vidéo importée (lib/upload/client.ts,
    `videoPoster`) — la case du profil et les vignettes la montrent. */
export type BgImport = { id: string; url: string; name?: string; h?: string; poster?: string };

export function readBgImports(): BgImport[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw)
      ? raw
          .filter((v) => typeof v?.id === "string" && isUploadUrl(v?.url))
          .map((v) => ({
            id: v.id,
            url: v.url,
            ...(typeof v.name === "string" && v.name ? { name: v.name.slice(0, 40) } : {}),
            ...(typeof v.h === "string" && /^[0-9a-f]{16}$/.test(v.h) ? { h: v.h } : {}),
            ...(isImageUpload(v.poster) ? { poster: v.poster } : {}),
          }))
          .slice(0, MAX_IMPORTS)
      : [];
  } catch {
    return [];
  }
}

export function writeBgImports(list: BgImport[]): BgImport[] {
  const out = list.slice(0, MAX_IMPORTS);
  try {
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* Stockage plein : la liste reste en mémoire pour la session. */
  }
  return out;
}
