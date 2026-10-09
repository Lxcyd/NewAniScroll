import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { frameAnimUrl, frameThumbUrl, frameUrl } from "@/lib/profile/frames";

/**
 * La source animée d'un cadre, dans l'ordre du plus léger au plus lourd :
 *
 *   1. la miniature FIXE de Discord (~6 Ko), affichée tout de suite ;
 *   2. l'AVIF animé de notre Worker (~55 Ko en 160 px, cf. `frameAnimUrl`),
 *      téléchargé ET décodé avant d'être montré, donc fluide dès sa première
 *      image ;
 *   3. s'il n'existe pas encore (cadre sorti dans la nuit, pas encore encodé),
 *      l'APNG d'origine de Discord (~800 Ko), même règle.
 *
 * `start` retarde le téléchargement (une case de grille attend d'être à
 * l'écran) ; l'avatar du profil part tout de suite.
 */
function useFrameSrc(asset: string | null | undefined, size: 160 | 256, start: boolean) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!asset || !start) return;
    let alive = true;
    const tente = (url: string) => {
      const probe = new window.Image();
      probe.src = url;
      return probe.decode().then(() => url);
    };
    tente(frameAnimUrl(asset, size))
      .catch(() => tente(frameUrl(asset)))
      .then((url) => alive && setSrc(url))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [asset, size, start]);
  return asset ? src ?? frameThumbUrl(asset, size) : null;
}

/**
 * Un cadre de GRILLE : miniature fixe tout de suite, animé léger dès que la
 * case approche de l'écran (cf. `useFrameSrc`). Les cases jamais atteintes au
 * défilement ne téléchargent rien de plus que leur miniature.
 */
export function FrameTileImage({
  asset,
  className,
  size = 160,
}: {
  asset: string;
  className?: string;
  size?: 160 | 256;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        setVisible(true);
      },
      /* Large : l'AVIF est assez léger pour partir AVANT que la case arrive,
         et elle s'anime alors dès qu'on la voit. */
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [asset]);
  const src = useFrameSrc(asset, size, visible);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src ?? undefined}
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
 * l'animation en image fixe, et nos AVIF sont déjà à la bonne taille.
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
  /* Version 256 px : l'avatar du profil monte à ~170 px, cadre compris.
     Miniature fixe d'abord, animé une fois décodé (plus de saccade au
     rechargement), cf. `useFrameSrc`. */
  const frameSrc = useFrameSrc(frame, 256, true);

  return (
    /* L'anneau d'accent s'efface sous un cadre (le cadre EST la bordure), mais
       son padding reste : la boîte garde sa taille et la mise en page autour ne
       bouge pas. */
    <div
      className={`shrink-0 rounded-full p-[3px] ${
        frame ? "" : "bg-gradient-to-br from-as-accent to-as-accent2 shadow-glow"
      }`}
    >
      {/* LE CADRE EST POSÉ SUR LA PHOTO ELLE-MÊME, dans cette boîte qui n'a
          qu'elle : -10 % de chaque côté = 1,2 fois la photo, la géométrie de
          Discord (l'anneau de « Summoning Circle » s'ouvre sur 83 % de l'image,
          soit 1/1,2). Mesuré sur une boîte plus grande que la photo (padding,
          puis marge qui fuyait en hauteur mais pas en largeur), le cadre sortait
          trop grand, puis écrasé, et la photo débordait de l'anneau. */}
      <div className="relative">
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
        {frame ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={frameSrc ?? undefined}
            alt=""
            aria-hidden
            draggable={false}
            className="pointer-events-none absolute -left-[10%] -top-[10%] h-[120%] w-[120%] max-w-none select-none"
          />
        ) : null}
      </div>
    </div>
  );
}
