import type { CSSProperties } from "react";
import { isVideoUpload } from "@/lib/upload/media";

/**
 * UNE IMAGE OU UNE VIDÉO, selon l'adresse (24/10/2026) : un import du studio
 * peut être un MP4 ou un WebM (lib/upload/media.ts), qui se lit dans un
 * `<video>` muet en boucle. Tout le reste — personnages AniList, data URL,
 * GIF — reste un `<img>`.
 *
 * Jamais d'iframe ni d'objet : un import ne s'affiche que par ces deux balises,
 * qui n'exécutent rien (étage 5 de media.ts).
 */
export default function MediaThumb({
  src,
  alt = "",
  className,
  style,
  lazy,
}: {
  src: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  lazy?: boolean;
}) {
  if (isVideoUpload(src)) {
    return (
      <video
        src={src}
        aria-label={alt || undefined}
        autoPlay
        muted
        loop
        playsInline
        /* Une vignette parmi d'autres : pas de préchargement au-delà de ce
           qu'il faut pour la première image tant qu'elle n'est pas vue. */
        preload={lazy ? "metadata" : "auto"}
        draggable={false}
        className={className}
        style={style}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading={lazy ? "lazy" : undefined}
      decoding="async"
      draggable={false}
      className={className}
      style={style}
    />
  );
}
