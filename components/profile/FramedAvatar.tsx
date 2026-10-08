import Image from "next/image";
import { frameUrl } from "@/lib/profile/frames";

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
      <div className="rounded-full bg-gradient-to-br from-as-accent to-as-accent2 p-[3px] shadow-glow">
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
          className="pointer-events-none absolute left-1/2 top-1/2 h-[120%] w-[120%] max-w-none -translate-x-1/2 -translate-y-1/2 select-none"
        />
      ) : null}
    </div>
  );
}
