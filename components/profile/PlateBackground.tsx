import Image from "next/image";
import { useEffect, useRef } from "react";
import { isVideoKind, type Dressing } from "@/lib/profile/dressing";

/**
 * Le fond d'un profil, quel qu'il soit — couleur, image, vidéo.
 *
 * Un seul composant pour les DEUX endroits qui le dessinent : l'en-tête réel
 * (ProfileHero) et l'aperçu du studio (BannerStudio). C'est la raison d'être du
 * fichier : tant que l'aperçu réimplémentait le fond de son côté, il montrait
 * quelque chose d'approchant, et le seul moyen de savoir ce qu'on allait
 * obtenir était d'appliquer pour voir.
 *
 * Il remplit son parent (`position:absolute; inset:0`), donc le parent porte le
 * `relative` et l'`overflow-hidden`. Il ne décide RIEN d'autre : ni la hauteur,
 * ni le voile, ni le bandeau-contre-fond-de-page — cela reste à l'en-tête, qui
 * mesure l'image pour cela.
 */

type Props = {
  dressing: Pick<Dressing, "kind" | "url" | "color"> & { source?: Dressing["source"] };
  /** `object-contain` : une bande large est montrée entière, jamais recadrée. */
  contain?: boolean;
  /** Une pochette portrait étirée en bandeau : floutée et sur-dimensionnée. */
  fallback?: boolean;
  /** L'image du haut de page vaut le `priority` ; l'aperçu du studio, non. */
  priority?: boolean;
  /**
   * Vidéo sonore. Faux partout sauf sur la seule surface qui a le droit de
   * faire du bruit — et même là, un navigateur refuse le son sans geste :
   * c'est le bouton de ProfileHero qui le débloque.
   */
  unmuted?: boolean;
  sizes?: string;
};

export default function PlateBackground({
  dressing,
  contain,
  fallback,
  priority,
  unmuted,
  sizes = "100vw",
}: Props) {
  const video = useRef<HTMLVideoElement | null>(null);

  /* `muted` posé en attribut React ne suffit pas : React l'écrit comme une
     propriété au premier rendu seulement, et un navigateur qui a déjà refusé la
     lecture ne réessaie pas tout seul. On le repose sur l'élément, puis on
     relance — un échec (autoplay refusé) n'a rien à corriger ici, le bouton du
     profil s'en charge. */
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.muted = !unmuted;
    void el.play().catch(() => {});
  }, [unmuted, dressing.url]);

  if (dressing.kind === "color" || (!dressing.url && dressing.color)) {
    return (
      <div
        /* Pas de `as-hero-weave` ici : la trame à 45° salissait l'aplat et
           faisait retomber une teinte vive sur du gris hachuré. Elle reste sur
           la plaque par défaut (ProfileHero), qui n'a pas de couleur choisie à
           respecter. */
        className="absolute inset-0 as-hero-tint"
        style={{ ["--as-tint" as any]: dressing.color || "#E94560" }}
      />
    );
  }

  if (!dressing.url) return null;

  if (isVideoKind(dressing.kind)) {
    return (
      <video
        ref={video}
        src={dressing.url}
        autoPlay
        loop
        playsInline
        muted={!unmuted}
        preload="metadata"
        className={`absolute inset-0 h-full w-full ${
          contain ? "object-contain" : "object-cover"
        }`}
      />
    );
  }

  return (
    <Image
      src={dressing.url}
      alt=""
      fill
      priority={priority}
      sizes={sizes}
      className={`${contain ? "object-contain" : "object-cover"} ${
        fallback ? "as-hero-cover" : ""
      }`}
    />
  );
}
