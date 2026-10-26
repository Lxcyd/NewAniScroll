/**
 * ENVOYER UN IMPORT DU STUDIO au Worker, depuis le navigateur. Les règles et
 * les étages de sécurité : lib/upload/media.ts.
 *
 * Erreurs levées (leur `message`, traduit par le studio) :
 *   "type"  — format refusé (lu dans les octets, pas dans le nom) ;
 *   "size"  — au-delà de 5 Mo (image, GIF) ou 15 Mo (vidéo) ;
 *   "auth"  — pas connecté : l'import par serveur est réservé aux comptes ;
 *   "quota" — 20 imports par 24 h atteints ;
 *   "space" — les 30 Mo du compte sont pleins (retirer un import les libère) ;
 *   "fail"  — tout le reste (réseau, Worker).
 */
import { IMAGE_MAX, VIDEO_MAX, isUploadUrl, sniff, type Sniffed } from "./media";

/** L'empreinte d'un fichier (SHA-256, 16 premiers hex) : reconnaître un
    doublon AVANT de l'envoyer, puisque chaque envoi reçoit une adresse neuve. */
export async function fileHash(file: File): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return [...d.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Le format réel du fichier, ou une erreur "type". */
export async function sniffFile(file: File): Promise<Sniffed> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const s = sniff(head);
  if (!s) throw new Error("type");
  return s;
}

/** Une image fixe REDESSINÉE : des pixels réencodés en WebP, plus le fichier
    déposé (étage 2 de media.ts). Côté le plus long ≤ `maxSide`, sous 5 Mo. */
export async function redraw(file: File, maxSide: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let side = maxSide;
    let quality = 0.88;
    for (let i = 0; i < 8; i++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext("2d");
      if (!g) throw new Error("fail");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", quality));
      /* Un navigateur sans encodeur WebP rend du PNG : on passe en JPEG. */
      const out =
        blob && blob.type === "image/webp"
          ? blob
          : await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", quality));
      if (out && out.size <= IMAGE_MAX) return out;
      if (quality > 0.6) quality -= 0.12;
      else side = Math.round(side * 0.8);
    }
    throw new Error("size");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Envoie un contenu déjà vérifié. Rend l'adresse publique de l'import. */
async function send(body: Blob): Promise<string> {
  const tk = await fetch("/api/v2/account/upload-token", { method: "POST" }).catch(() => null);
  if (!tk) throw new Error("fail");
  if (tk.status === 401) throw new Error("auth");
  if (tk.status === 429) throw new Error("quota");
  if (!tk.ok) throw new Error("fail");
  const { token, endpoint } = (await tk.json()) as { token: string; endpoint: string };
  const up = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  }).catch(() => null);
  if (!up) throw new Error("fail");
  if (up.status === 413) throw new Error("size");
  if (up.status === 415) throw new Error("type");
  if (up.status === 507) throw new Error("space");
  if (!up.ok) throw new Error("fail");
  const { url } = (await up.json()) as { url: string };
  return url;
}

/**
 * Un fichier choisi → son adresse d'import.
 *   - image fixe : redessinée (`maxSide`), puis envoyée ;
 *   - GIF et vidéo : envoyés tels quels après contrôle du format et du poids
 *     (un canvas figerait l'animation) — le Worker relit le format.
 * `allow` borne ce que l'emplacement accepte.
 */
export async function uploadMedia(
  file: File,
  { maxSide, allow }: { maxSide: number; allow: Array<Sniffed["kind"]> },
): Promise<{ url: string; kind: Sniffed["kind"] }> {
  const s = await sniffFile(file);
  if (!allow.includes(s.kind)) throw new Error("type");
  if (s.kind === "video" ? file.size > VIDEO_MAX : s.kind === "gif" && file.size > IMAGE_MAX) {
    throw new Error("size");
  }
  const body = s.kind === "image" ? await redraw(file, maxSide) : file;
  return { url: await send(body), kind: s.kind };
}

/**
 * Retire un import de Cloudflare (24/10/2026, Luc) : retiré de la liste, le
 * fichier rend sa place dans les 30 Mo du compte. Sans effet sur une data URL
 * (avatar fixe, rangé dans le profil). Au mieux : un échec laisse le fichier
 * sur le serveur, la liste du navigateur est déjà à jour.
 */
export async function deleteUpload(url: string): Promise<void> {
  if (!isUploadUrl(url)) return;
  try {
    const tk = await fetch("/api/v2/account/upload-token?for=delete", { method: "POST" });
    if (!tk.ok) return;
    const { token } = (await tk.json()) as { token: string };
    await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  } catch {
    /* Au mieux. */
  }
}

/**
 * L'AFFICHE D'UNE VIDÉO IMPORTÉE (25/10/2026, Luc : « la card en bas à droite
 * n'est pas bonne ») : une image prise à 1 s (ou au milieu d'une vidéo plus
 * courte), 640 px de large, en WebP. La case du profil, sa lumière d'ambiance
 * et les vignettes du studio veulent une IMAGE ; sans elle, la case montrait
 * l'affiche d'un fond porté avant.
 */
export async function videoPoster(from: File | string): Promise<Blob | null> {
  /* Un fichier choisi, ou l'adresse d'un import déjà en ligne (le Worker sert
     avec CORS ouvert : `crossOrigin` garde le canvas lisible). */
  const local = typeof from !== "string";
  const url = local ? URL.createObjectURL(from) : from;
  try {
    const v = document.createElement("video");
    if (!local) v.crossOrigin = "anonymous";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    await new Promise<void>((ok, ko) => {
      v.onloadedmetadata = () => ok();
      v.onerror = () => ko(new Error("fail"));
    });
    const at = Math.min(1, (v.duration || 0) / 2);
    await new Promise<void>((ok, ko) => {
      v.onseeked = () => ok();
      v.onerror = () => ko(new Error("fail"));
      v.currentTime = at;
    });
    const k = Math.min(1, 640 / (v.videoWidth || 640));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round((v.videoWidth || 640) * k));
    c.height = Math.max(1, Math.round((v.videoHeight || 360) * k));
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    return await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", 0.82));
  } catch {
    return null;
  } finally {
    if (local) URL.revokeObjectURL(url);
  }
}

/** Envoie une image déjà fabriquée ici (l'affiche d'une vidéo). */
export const uploadBlob = (blob: Blob) => send(blob);
