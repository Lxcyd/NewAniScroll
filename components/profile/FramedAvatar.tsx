import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { frameThumbUrl, frameUrl } from "@/lib/profile/frames";

/**
 * Un cadre de GRILLE : la miniature fixe d'abord (~6 Ko, affichée tout de
 * suite), puis l'APNG animé (~800 Ko — Discord n'en sert pas de plus petit)
 * chargé dès que la case entre à l'écran, et substitué une fois arrivé. La
 * grille s'affiche donc aussi vite qu'avant, et chaque cadre visible s'anime
 * sans attendre qu'on le survole. Les cases jamais atteintes au défilement ne
 * téléchargent jamais leur animé.
 */
export function FrameTileImage({ asset, className }: { asset: string; className?: string }) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    setAnimated(false);
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const probe = new window.Image();
        probe.onload = () => alive && setAnimated(true);
        probe.src = frameUrl(asset);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [asset]);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={animated ? frameUrl(asset) : frameThumbUrl(asset)}
      alt=""
      decoding="async"
      draggable={false}
      className={className}
    />
  );
}

/**
 * L'avatar du profil : TOUJOURS rond, et coiffé de son cadre quand il en porte
 * un.
 *
 * Rond partout (bandeau, centré, médaillon, colonne, aperçu du studio) parce
 * que les cadres sont dessinés pour un cercle : ce sont les décorations de
 * Discord, et un carré arrondi en dessous laissait dépasser ses coins sous la
 * couronne.
 *
 * LE CADRE DÉBORDE DE 20 % DE CHAQUE CÔTÉ, la géométrie de Discord : la
 * décoration y fait 1,2 fois l'avatar, centrée sur lui. Il est posé PAR-DESSUS
 * (`pointer-events-none`) et ne change pas la boîte de l'avatar : la mise en
 * page autour ne bouge pas d'un pixel qu'on porte un cadre ou non.
 *
 * Un `<img>` et pas `next/image` pour le cadre : l'optimiseur réencoderait
 * l'APNG animé en image fixe, et le CDN de Discord sert déjà la bonne taille.
 */
export default function FramedAvatar({
  src,
  name,
  frame,
  sizeClass,
  textClass = "text-3xl",
  px = 160,
  priority,
}: {
  src?: string | null;
  name: string;
  frame?: string | null;
  /** Taille de l'avatar SANS l'anneau, p. ex. « h-24 w-24 md:h-36 md:w-36 ». */
  sizeClass: string;
  textClass?: string;
  /** Largeur demandée à l'optimiseur pour la photo. */
  px?: number;
  priority?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      {/* L'anneau d'accent s'efface sous un cadre : le cadre EST la bordure, et
          un liseré rose entre lui et la photo faisait double contour. */}
      <div
        className={
          /* Marge au lieu de padding : la boîte garde sa taille (la mise en page
             ne bouge pas), mais il n'y a plus d'espace vide entre la photo et
             le cadre. */
          frame
            ? "m-[3px] rounded-full"
            : "rounded-full bg-gradient-to-br from-as-accent to-as-accent2 p-[3px] shadow-glow"
        }
      >
        {src ? (
          <Image
            src={src}
            alt={name}
            width={px}
            height={px}
            priority={priority}
            className={`${sizeClass} rounded-full object-cover`}
          />
        ) : (
          <div
            className={`${sizeClass} ${textClass} flex items-center justify-center rounded-full bg-primary font-bold text-white/80`}
          >
            {name.charAt(0).toUpperCase() || "?"}
          </div>
        )}
      </div>
      {frame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={frameUrl(frame)}
          alt=""
          aria-hidden
          draggable={false}
          /* 1,2 fois la PHOTO, pas la boîte : celle-ci la dépasse de 3 px de
             chaque côté, d'où le « - 7,2 px » (1,2 x 6). Mesuré sur la boîte, le
             cadre était trop grand et laissait un vide autour du visage. */
          className="pointer-events-none absolute left-1/2 top-1/2 h-[calc(120%-7.2px)] w-[calc(120%-7.2px)] max-w-none -translate-x-1/2 -translate-y-1/2 select-none"
        />
      ) : null}
    </div>
  );
}
