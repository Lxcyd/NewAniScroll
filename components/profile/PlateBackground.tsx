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
  dressing: Pick<Dressing, "kind" | "url" | "color"> & {
    source?: Dressing["source"];
    trailerId?: Dressing["trailerId"];
  };
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

  /* ── La bande-annonce ────────────────────────────────────────────────────
     Un embed à elle, et non le lecteur partagé de TrailerStage : celui-ci est
     UNIQUE pour la session et sert déjà les survols de cartes et la musique du
     profil. Un fond qui le réclamerait le volerait au premier survol venu, et
     inversement.

     Elle est muette, et le reste : le bouton de son du profil pilote un
     `<audio>` ou le lecteur de la musique, pas cette iframe — un fond qui
     parlerait par-dessus la musique choisie serait exactement ce que la règle
     « la musique l'emporte » existe pour empêcher.

     LE ×200 EST CE QUI EFFACE L'HABILLAGE, et `controls=0` n'y suffit pas :
     YouTube repeint ses boutons — pause, précédent, suivant — dès que la vidéo
     boucle ou qu'un geste l'effleure, et ils étaient au milieu de la plaque.
     La recette est celle de TrailerStage, mesurée là-bas : le cadre est monté à
     20 000 % de sa boîte puis réduit d'autant (`scale(1/200)`, origine en haut
     à gauche). Le lecteur se croit alors énorme, dessine son habillage à la
     taille fixe qu'il dessine toujours, et la réduction le rend deux cents fois
     plus petit que la surface — donc invisible.

     La boîte intérieure, elle, est exactement en 16/9 quelle que soit la
     fenêtre (`max(100%, 177.78vh)` × `max(100%, 56.25vw)` : l'un des deux vaut
     100 %, l'autre déborde du strict nécessaire), donc rien à sur-scanner pour
     éviter les bandes noires.

     `loop` demande sa propre `playlist` — sans elle le paramètre est ignoré et
     la vidéo s'arrête à la fin sur sa grille de suggestions. */
  if (dressing.kind === "video" && dressing.trailerId) {
    const id = encodeURIComponent(dressing.trailerId);
    const SCALE = 200;
    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden"
          style={{ width: "max(100%, 177.78vh)", height: "max(100%, 56.25vw)" }}
        >
          <iframe
            key={dressing.trailerId}
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=0&loop=1&playlist=${id}&playsinline=1&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1`}
            title=""
            /* `compute-pressure` évite le « Permissions policy violation » que
               le lecteur journalise sinon à chaque montage : c'est ce qui lui
               permet de baisser la qualité plutôt que de saccader, et un cadre
               monté ×200 en a précisément besoin. */
            allow="autoplay; encrypted-media; compute-pressure"
            frameBorder="0"
            style={{
              position: "absolute",
              border: 0,
              /* En POURCENTAGE et non en pixels : le facteur tient quelle que
                 soit la taille réelle de la fenêtre. */
              width: `${SCALE * 100}%`,
              height: `${SCALE * 100}%`,
              transform: `scale(${1 / SCALE})`,
              /* En haut à gauche, sinon la réduction recentre et décale
                 l'image. */
              transformOrigin: "0 0",
            }}
          />
        </div>
      </div>
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
