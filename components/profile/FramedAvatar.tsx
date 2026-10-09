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
        probe.src = frameUrl(asset);
        /* Décodé avant d'être montré : même raison que pour l'avatar du profil. */
        probe
          .decode()
          .catch(() => undefined)
          .then(() => alive && setAnimated(true));
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
  /* L'ANIMÉ N'ARRIVE QU'UNE FOIS DÉCODÉ. Posé directement, l'APNG (~800 Ko) se
     mettait à jouer pendant son téléchargement et son décodage, en même temps
     que l'hydratation de la page : l'animation saccadait à chaque
     rechargement. La miniature fixe (quelques Ko) tient la place, et l'animé ne
     la remplace qu'entièrement prêt (`decode()`), donc fluide dès sa première
     image. */
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    setAnimated(false);
    if (!frame) return;
    let alive = true;
    const probe = new window.Image();
    probe.src = frameUrl(frame);
    probe
      .decode()
      .catch(() => undefined)
      .then(() => alive && setAnimated(true));
    return () => {
      alive = false;
    };
  }, [frame]);

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
            src={animated ? frameUrl(frame) : frameThumbUrl(frame, 240)}
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
