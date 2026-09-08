import Image from "next/image";
import { useEffect, useRef, type MutableRefObject } from "react";
import { fadeGain, isVideoKind, type Dressing } from "@/lib/profile/dressing";

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

/**
 * L'hôte du lecteur YouTube — nocookie, comme les survols de cartes. C'est
 * l'origine attendue des messages ET la cible des commandes : un `postMessage`
 * envoyé à une autre origine est refusé par le navigateur.
 */
const YT_ORIGIN = "https://www.youtube-nocookie.com";

/** La télécommande d'un fond vidéo, pour qui le pilote de l'extérieur. */
export type TrailerRemote = {
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
};

type Props = {
  dressing: Pick<Dressing, "kind" | "url" | "color"> & {
    source?: Dressing["source"];
    trailerId?: Dressing["trailerId"];
    videoFrom?: Dressing["videoFrom"];
    videoTo?: Dressing["videoTo"];
    videoFade?: Dressing["videoFade"];
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
  /**
   * Le studio écoute le fond vidéo pour dessiner son rail : position et durée
   * telles que le lecteur les rapporte, jamais un compteur local.
   */
  onVideoProgress?: (at: number, duration: number, playing: boolean) => void;
  /** Rempli d'une télécommande tant qu'une vidéo est à l'écran. */
  videoRemote?: MutableRefObject<TrailerRemote | null>;
};

export default function PlateBackground({
  dressing,
  contain,
  fallback,
  priority,
  unmuted,
  sizes = "100vw",
  onVideoProgress,
  videoRemote,
}: Props) {
  const video = useRef<HTMLVideoElement | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  /* Le cadre existe avant d'avoir chargé, et son `contentWindow` est alors
     encore `about:blank` sur NOTRE origine : lui poster un message adressé à
     YouTube lève « target origin does not match ». */
  const frameLoaded = useRef(false);
  /* Les bornes voyagent par référence : elles bougent à chaque image pendant
     qu'on tire une poignée, et l'abonnement aux messages ne doit pas se
     défaire (donc se réabonner, donc se taire une seconde) à chaque pixel. */
  const bounds = useRef({ from: 0, to: 0, fade: 0 });
  bounds.current = {
    from: dressing.videoFrom ?? 0,
    to: dressing.videoTo ?? 0,
    fade: dressing.videoFade ?? 0,
  };
  const report = useRef(onVideoProgress);
  report.current = onVideoProgress;
  const duration = useRef(0);
  /* La dernière position CONNUE d'un lecteur YouTube, et l'instant où il l'a
     dite. Il ne parle que toutes les 250 ms environ : le fondu, lui, se
     redessine à chaque image, donc entre deux messages on extrapole. */
  const said = useRef({ at: 0, wall: 0, playing: false });
  /** Le voile noir du fondu. Écrit à même le DOM : soixante rendus React par
      seconde pour une opacité, c'est le genre de boucle qui fait ramer une
      page qu'on est en train de lire. */
  const veil = useRef<HTMLDivElement | null>(null);
  /* L'endroit où la vidéo DÉMARRE, figé au moment où la bande-annonce change.
     Il part dans l'URL du cadre pour éviter la seconde de carton de titre qui
     précède sinon le premier saut ; s'il suivait la borne, tirer la poignée
     réécrirait l'URL — donc rechargerait le lecteur — à chaque pixel. */
  const startAt = useRef(0);
  const startFor = useRef<string | null>(null);

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

  /* ── L'extrait de la bande-annonce ───────────────────────────────────────
     La boucle est tenue ICI, à la main, et non par les paramètres `start` et
     `end` de l'embed : `end` arrête le lecteur au lieu de reboucler, et la
     boucle de YouTube repart du début de la VIDÉO, pas de la borne — on
     entendait donc le carton de titre à chaque tour, ce que le découpage
     existe précisément pour écarter.

     Le protocole est celui, éprouvé, des survols de cartes (TrailerStage) :
     un `listening` posté au cadre, puis des `infoDelivery` qui rapportent la
     position. Pas de script d'API à charger pour autant — trois lignes de
     `postMessage` suffisent à ce qu'on demande ici. */
  const trailerId = dressing.kind === "video" ? dressing.trailerId ?? null : null;
  useEffect(() => {
    if (!trailerId) return;
    frameLoaded.current = false;
    duration.current = 0;

    const post = (func: string, args: unknown[] = []) => {
      if (!frameLoaded.current) return;
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func, args }),
        YT_ORIGIN,
      );
    };
    if (videoRemote) {
      videoRemote.current = {
        seek: (s) => {
          post("seekTo", [s, true]);
          said.current = { at: s, wall: performance.now(), playing: said.current.playing };
        },
        play: () => post("playVideo"),
        pause: () => post("pauseVideo"),
      };
    }

    /* Le lecteur ne dit rien tant qu'on ne lui a pas demandé de parler, et il
       rate un `listening` envoyé pendant son démarrage : on répète. */
    const subscribe = () => {
      if (!frameLoaded.current) return;
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
        YT_ORIGIN,
      );
    };
    const ping = window.setInterval(subscribe, 800);

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN) return;
      /* Plusieurs lecteurs peuvent vivre sur la page (les survols de cartes en
         montent deux) : on ne lit que le nôtre. */
      if (e.source !== frame.current?.contentWindow) return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      const info = data?.info as
        | { playerState?: unknown; currentTime?: unknown; duration?: unknown }
        | null
        | undefined;
      const state = data?.event === "onStateChange" ? data.info : info?.playerState;
      if (typeof info?.duration === "number" && info.duration > 0) {
        duration.current = info.duration;
      }
      const at = info?.currentTime;
      if (typeof at !== "number") return;

      said.current = {
        at,
        wall: performance.now(),
        playing: state === undefined ? said.current.playing : state === 1,
      };

      const { from, to } = bounds.current;
      /* Deux sorties à rattraper : la fin de l'extrait, et le retour à zéro que
         la boucle de YouTube fait d'elle-même. Une seconde de marge en amont,
         sinon un lecteur qui rapporte 4,98 s pour une borne à 5 s se ferait
         renvoyer en boucle sur sa propre position. */
      if (to > from && (at >= to || at < from - 1)) {
        post("seekTo", [from, true]);
        said.current = { at: from, wall: performance.now(), playing: said.current.playing };
      }
    };
    window.addEventListener("message", onMessage);

    return () => {
      window.clearInterval(ping);
      window.removeEventListener("message", onMessage);
      if (videoRemote) videoRemote.current = null;
    };
  }, [trailerId, videoRemote]);

  /* ── Le fondu au noir, et la boucle d'un fichier ─────────────────────────
     Une seule boucle d'animation pour les deux sortes de fond vidéo, parce que
     le fondu se dessine à l'image et qu'aucun lecteur ne le fait pour nous :
     un `<video>` n'a pas de bornes, et YouTube ne parle que quatre fois par
     seconde — trop peu pour une opacité, assez pour l'extrapoler entre deux
     messages (`said`).

     Le voile est écrit directement sur le nœud. C'est le même raisonnement que
     la boucle du studio : passer par un état React ferait rendre la page
     soixante fois par seconde pour animer une seule valeur. */
  const fileVideo = !trailerId && !!dressing.url && isVideoKind(dressing.kind);
  useEffect(() => {
    if (!trailerId && !fileVideo) return;
    let raf = 0;
    const tick = () => {
      const { from, to, fade } = bounds.current;
      let at = 0;
      let len = 0;
      let playing = false;

      const el = video.current;
      if (el) {
        at = el.currentTime;
        len = el.duration || 0;
        playing = !el.paused;
        /* La boucle du fichier : `loop` ne connaît que la fin du fichier. */
        if (to > from && at >= to) {
          el.currentTime = from;
          at = from;
        } else if (from > 0 && at < from - 0.5) {
          el.currentTime = from;
          at = from;
        }
      } else {
        len = duration.current;
        playing = said.current.playing;
        at = said.current.at + (playing ? (performance.now() - said.current.wall) / 1000 : 0);
        /* L'extrapolation ne doit pas dépasser la borne : le lecteur nous dira
           qu'il est revenu, et d'ici là le voile resterait au noir. */
        if (to > from) at = Math.min(at, to);
      }

      if (veil.current) {
        /* `fadeGain` rend 1 en plein milieu et 0 aux extrémités : le voile est
           son complément. Bornes absentes, l'extrait vaut tout le fichier — le
           fondu se pose alors au début et à la fin de la vidéo.

           LE FONDU NE MANGE JAMAIS PLUS DU QUART DE L'EXTRAIT. Une seconde de
           chaque côté est douce sur un générique entier ; sur un extrait de
           cinq secondes, c'est deux secondes de noir sur cinq — mesuré sur un
           profil réel le 08/09/2026, où le fond passait pour éteint et le flou
           des widgets n'avait plus rien à flouter. Le plafond ne mord que sur
           les extraits courts : au-delà de huit secondes, le réglage passe
           intact. */
        const fin = to > from ? to : len;
        const f = Math.min(fade, Math.max(0, (fin - from) / 8));
        const gain = fadeGain(at, from, fin, f);
        veil.current.style.opacity = String(1 - gain);
      }
      report.current?.(at, len, playing);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [trailerId, fileVideo, dressing.url]);

  /* Un fichier vidéo se pilote directement : pas de messages, pas d'attente. */
  useEffect(() => {
    if (!fileVideo || !videoRemote) return;
    videoRemote.current = {
      seek: (s) => {
        if (video.current) video.current.currentTime = s;
      },
      play: () => void video.current?.play().catch(() => {}),
      pause: () => video.current?.pause(),
    };
    return () => {
      videoRemote.current = null;
    };
  }, [fileVideo, videoRemote]);

  /** Le voile du fondu, posé par-dessus la vidéo — et seulement par-dessus. */
  const fadeVeil = (
    <div
      ref={veil}
      className="pointer-events-none absolute inset-0 bg-black"
      style={{ opacity: 0 }}
    />
  );

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
    if (startFor.current !== dressing.trailerId) {
      startFor.current = dressing.trailerId;
      startAt.current = Math.max(0, Math.floor(dressing.videoFrom ?? 0));
    }
    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden"
          style={{ width: "max(100%, 177.78vh)", height: "max(100%, 56.25vw)" }}
        >
          <iframe
            key={dressing.trailerId}
            ref={frame}
            onLoad={() => {
              frameLoaded.current = true;
            }}
            /* `enablejsapi` est ce qui permet le découpage : sans lui le cadre
               n'écoute aucune commande et ne rapporte aucune position. Mesuré
               sans conséquence visible sur l'image (devlog/preview). */
            src={`${YT_ORIGIN}/embed/${id}?autoplay=1&mute=1&controls=0&loop=1&playlist=${id}&playsinline=1&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&enablejsapi=1${
              startAt.current > 0 ? `&start=${startAt.current}` : ""
            }`}
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
        {fadeVeil}
      </div>
    );
  }

  if (!dressing.url) return null;

  if (isVideoKind(dressing.kind)) {
    return (
      <div className="absolute inset-0 overflow-hidden">
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
        {fadeVeil}
      </div>
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
