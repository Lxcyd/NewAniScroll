import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { fadeGain } from "@/lib/profile/dressing";
import { storyboardFrames } from "@/lib/preview/trailerBars";
import MusicCard, { type MusicCardControls } from "@/components/profile/MusicCard";

/**
 * Ce que le studio et le profil demandent à un lecteur de musique : le
 * sous-ensemble de <audio> qu'ils utilisent. Un HTMLAudioElement le remplit
 * tel quel ; le lecteur YouTube ci-dessous l'imite.
 */
export type MusicMedia = {
  readonly paused: boolean;
  currentTime: number;
  readonly duration: number;
  volume: number;
  play(): Promise<void>;
  pause(): void;
};

const ORIGIN = "https://www.youtube-nocookie.com";
/* Le SCALE de TrailerStage. Pas d'OVERSCAN ici (17/10/2026) : ses 12 % de
   débord zoomaient l'image au passage vignette → lecteur. Même cadrage que
   la vignette (16:9 à hauteur pleine, côtés rognés). */
const YT_SCALE = 200;
const YT_OVERSCAN = 1;

type Props = {
  videoId: string;
  className?: string;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onWaiting?: () => void;
  onPlaying?: () => void;
  onDuration?: (s: number) => void;
  onTime?: (s: number) => void;
  /** La vidéo refuse l'embed ou n'existe plus. */
  onError?: () => void;
  /** Le navigateur a refusé le son : la lecture continue, MUETTE. */
  onBrowserMute?: () => void;
  /**
   * Part SEUL et MUET, dès le chargement (`autoplay=1&mute=1` dans l'adresse ;
   * le son est tenté ensuite, voir plus bas), comme une
   * <video autoplay> : YouTube commence à charger le flux pendant qu'il
   * s'initialise, au lieu d'attendre notre `playVideo` après `onReady`. Mesuré
   * au CDP le 17/10/2026 : lecture 0,2-0,3 s après « prêt », contre 0,6 s.
   * Dans l'adresse, donc décidé au rendu serveur : le profil le lit du cookie.
   */
  autoStart?: boolean;
  /**
   * Le profil confie la boucle au lecteur : bornes, fondu, volume. Le studio
   * ne le passe pas — il tient déjà sa propre boucle d'animation, la même que
   * pour le fichier d'AnimeThemes, à travers la poignée.
   */
  clip?: { from: number | null; to: number | null; fade: number; volume?: number } | null;
  /**
   * La petite case, habillée comme l'aperçu au survol (17/10/2026) : lecture
   * au centre et volume en haut à droite, qui apparaissent quand la main
   * bouge ; une lumière d'ambiance derrière. Sans elle, l'iframe nue.
   */
  card?: MusicCardControls | null;
};

/**
 * La version COMPLÈTE d'un générique (ou la bande-annonce), jouée par le
 * lecteur YouTube officiel et pilotée comme un <audio>.
 *
 * Le lecteur reste VISIBLE pendant la lecture : c'est le lecteur officiel qui
 * sert le morceau et sa publicité, et 200 px est le minimum des conditions de
 * l'API. On ne cache que lorsqu'il est à l'arrêt.
 *
 * Pourquoi pas TrailerStage : celui-ci est bâti pour l'aperçu au survol (muet,
 * halo, rognage des bandes) et ne rend pas la main sur le temps. Ici il faut
 * un temps lisible et réglable, pour le rail du studio et pour la boucle de
 * l'extrait sur le profil.
 *
 * Le temps : YouTube le publie quelques fois par seconde (`infoDelivery`) ; on
 * l'EXTRAPOLE entre deux annonces avec l'horloge de la page, sinon le rail
 * avancerait par sauts et le rebouclage tomberait jusqu'à un quart de seconde
 * trop tard.
 */
const YouTubeMusic = forwardRef<MusicMedia, Props>(function YouTubeMusic(
  { videoId, className, onPlay, onPause, onEnded, onWaiting, onPlaying, onDuration, onTime, onError, onBrowserMute, autoStart, clip, card },
  ref,
) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const loaded = useRef(false);
  const queue = useRef<string[]>([]);
  const s = useRef({ t: 0, at: 0, playing: false, duration: 0, volume: 1, sent: -1 });
  const loop = useRef({ on: false, from: 0 });
  const onBrowserMuteRef = useRef(onBrowserMute);
  onBrowserMuteRef.current = onBrowserMute;
  /* La case montre la vignette tant que la vidéo n'a jamais joué : réduit
     ×200, le lecteur ne montre qu'un carré noir avant la lecture. */
  const [started, setStarted] = useState(false);
  const startedFor = useRef(videoId);
  if (startedFor.current !== videoId) {
    startedFor.current = videoId;
    if (started) setStarted(false);
  }
  /*
   * LE SON, EXACTEMENT COMME LE LECTEUR D'ÉPISODES (UniversalPlayer, « Autoplay »,
   * 17/10/2026). Chrome n'accorde le son sans clic qu'aux sites où l'on a déjà
   * beaucoup écouté (score d'engagement, par site : chez Luc aniscroll.com l'a,
   * localhost ne l'a pas). Personne ne peut le forcer. Donc :
   *   1. départ MUET (`autoplay=1&mute=1`) — toujours permis, tout de suite ;
   *   2. dès qu'il joue, on tente le son (`unMute`) — il tient sur un site
   *      de confiance ;
   *   3. refusé, Chrome met en pause aussitôt : on repart muet, et le son
   *      revient au premier geste sur la page (ProfileHero).
   * Pendant le muet imposé, AUCUNE commande de volume : le `setVolume` de
   * YouTube rend le son, chaque appel était un refus de plus (« Unmuting
   * failed » ×17, le fondu en envoyant un par image).
   */
  const wanted = useRef(!!autoStart);
  /** Le dernier `unMute` envoyé : une pause dans la seconde = refus du navigateur. */
  const unmutedAt = useRef(0);
  /** Muet imposé par le navigateur : plus de son sans un geste. */
  const forcedMute = useRef(false);
  /** Parti muet de lui-même, le son reste à tenter à la première image. */
  const soundPending = useRef(!!autoStart);
  /** Ce que le lecteur dit de son propre son. */
  const reportedMuted = useRef(false);
  /** Aucune commande de volume tant que le son n'est pas acquis. */
  const holdVol = () => forcedMute.current || soundPending.current;
  const cb = useRef({ onPlay, onPause, onEnded, onWaiting, onPlaying, onDuration, onTime, onError });
  cb.current = { onPlay, onPause, onEnded, onWaiting, onPlaying, onDuration, onTime, onError };

  /* PRÊT ≠ CHARGÉ. L'iframe finit de charger avant que le lecteur qu'elle
     contient écoute : une commande envoyée entre les deux est perdue — c'est
     ainsi que le volume réglé se perdait et que YouTube jouait à 100
     (16/10/2026). La file ne se vide qu'au premier message du lecteur. */
  const post = useCallback((func: string, args: unknown[] = []) => {
    const msg = JSON.stringify({ event: "command", func, args });
    if (loaded.current) frame.current?.contentWindow?.postMessage(msg, ORIGIN);
    else {
      /* Lecture et pause en attente : seule la DERNIÈRE compte. Le profil
         envoie `pause` au premier rendu puis `play` : rejouées toutes deux à
         « prêt », la pause coupait la lecture auto déjà partie (1, 2, 3, 1). */
      if (func === "playVideo" || func === "pauseVideo")
        queue.current = queue.current.filter((m) => !/"func":"(playVideo|pauseVideo)"/.test(m));
      queue.current.push(msg);
    }
  }, []);
  const pctWanted = () => Math.round(s.current.volume * 100);

  const now = () => {
    const st = s.current;
    return st.playing ? st.t + (performance.now() - st.at) / 1000 : st.t;
  };

  const setVol = useCallback(
    (v: number) => {
      const st = s.current;
      st.volume = Math.min(1, Math.max(0, v));
      const pct = Math.round(st.volume * 100);
      if (holdVol()) {
        st.sent = -1;
        return;
      }
      if (pct === st.sent) return;
      st.sent = pct;
      post("setVolume", [pct]);
    },
    [post],
  );

  useImperativeHandle(
    ref,
    () => ({
      get paused() {
        return !s.current.playing;
      },
      get currentTime() {
        return now();
      },
      set currentTime(v: number) {
        s.current.t = v;
        s.current.at = performance.now();
        post("seekTo", [v, true]);
      },
      get duration() {
        return s.current.duration;
      },
      get volume() {
        return s.current.volume;
      },
      set volume(v: number) {
        setVol(v);
      },
      play() {
        wanted.current = true;
        /* Départ muet encore en cours : c'est la première image qui tentera
           le son (étape 2), pas cet appel. */
        if (!soundPending.current) {
          /* Le volume AVANT le son : sans lui, le premier instant part à 100.
             Après un refus, cet appel vient d'un geste (ProfileHero) : le son
             est permis. */
          s.current.sent = pctWanted();
          post("setVolume", [s.current.sent]);
          if (reportedMuted.current || forcedMute.current) {
            post("unMute");
            unmutedAt.current = performance.now();
          }
          forcedMute.current = false;
        }
        post("playVideo");
        return Promise.resolve();
      },
      pause() {
        wanted.current = false;
        post("pauseVideo");
      },
    }),
    [post, setVol],
  );

  /*
   * LA POIGNÉE DE MAIN NE DÉPEND PLUS DE `onLoad` (17/10/2026). Le profil est
   * rendu côté serveur : l'iframe est dans le HTML et finit souvent de charger
   * AVANT que React n'hydrate la page — son `load` est passé, le gestionnaire
   * `onLoad` ne part jamais, aucun `listening` n'est envoyé, le lecteur ne nous
   * parle pas et la lecture attend pour toujours. Selon la course, ça marchait
   * ou pas : le « rien au clic sur ▶ ». Comme TrailerStage, on répète le
   * `listening` sur un minuteur dès le montage, jusqu'à la réponse.
   */
  useEffect(() => {
    const listen = JSON.stringify({ event: "listening", id: 1, channel: "widget" });
    const t0 = Date.now();
    let timer = 0;
    const again = () => {
      if (loaded.current || Date.now() - t0 > 60_000) return;
      frame.current?.contentWindow?.postMessage(listen, ORIGIN);
      timer = window.setTimeout(again, Date.now() - t0 < 5000 ? 250 : 1000);
    };
    again();
    return () => window.clearTimeout(timer);
  }, [videoId]);

  /** Le navigateur refuse le son : on joue muet, et on le dit. */
  const blocked = () => {
    if (forcedMute.current) return;
    forcedMute.current = true;
    post("mute");
    post("playVideo");
    onBrowserMuteRef.current?.();
  };

  /* Nouvelle vidéo : tout ce qu'on savait de l'ancienne est faux. Remis à
     zéro AU RENDU qui change d'identifiant, pas dans un effet : en dev, React
     rejoue les effets au montage, et ce rejeu passait APRÈS le `play()` du
     parent — il vidait la file et oubliait la demande de lecture. C'était
     le morceau qui ne se lançait pas (relevé au CDP, 17/10/2026). */
  const lastId = useRef(videoId);
  if (lastId.current !== videoId) {
    lastId.current = videoId;
    loaded.current = false;
    queue.current = [];
    wanted.current = !!autoStart;
    forcedMute.current = false;
    soundPending.current = !!autoStart;
    reportedMuted.current = false;
    s.current = { ...s.current, t: 0, at: performance.now(), playing: false, duration: 0, sent: -1 };
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== ORIGIN) return;
      let data: any;
      try {
        data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      /* PRÊT = `onReady`, pas le premier message. `initialDelivery` arrive
         avant, et une commande envoyée à ce moment est IGNORÉE : la file
         partait là, le lecteur restait « indicé » (état 5) sans jamais jouer
         — le morceau qui ne se lançait pas une fois sur deux (relevé au CDP,
         17/10/2026). */
      const ready = data?.event === "onReady" || data?.event === "infoDelivery" || data?.event === "onStateChange";
      if (e.source !== frame.current?.contentWindow) return;
      const st = s.current;
      if (ready && !loaded.current) {
        loaded.current = true;
        const w = frame.current?.contentWindow;
        for (const m of queue.current) w?.postMessage(m, ORIGIN);
        queue.current = [];
      }
      if (data?.event === "onError") {
        cb.current.onError?.();
        return;
      }
      if (data?.event === "onAutoplayBlocked") {
        blocked();
        return;
      }
      const info = data?.event === "infoDelivery" || data?.event === "initialDelivery" ? data.info : null;
      const state = data?.event === "onStateChange" ? data.info : info?.playerState;
      if (info && typeof info.duration === "number" && info.duration > 0 && info.duration !== st.duration) {
        st.duration = info.duration;
        cb.current.onDuration?.(info.duration);
      }
      /* Le lecteur dit son volume : s'il n'est pas le nôtre (commande perdue,
         ou YouTube qui reprend le sien au démarrage), on le lui redonne. */
      if (info && typeof info.volume === "number" && !holdVol() && info.muted !== true) {
        const want = pctWanted();
        if (Math.abs(info.volume - want) > 1) {
          st.sent = want;
          post("setVolume", [want]);
        }
      }
      if (info && typeof info.muted === "boolean") reportedMuted.current = info.muted;
      if (info && typeof info.currentTime === "number") {
        st.t = info.currentTime;
        st.at = performance.now();
        cb.current.onTime?.(info.currentTime);
      }
      if (typeof state === "number") {
        const was = st.playing;
        if (state === 1) {
          st.playing = true;
          st.at = performance.now();
          if (!was) cb.current.onPlay?.();
          cb.current.onPlaying?.();
          setStarted(true);
          /* Étape 2 : il joue (muet) — on tente le son, au bon niveau. */
          if (soundPending.current) {
            soundPending.current = false;
            if (wanted.current) {
              st.sent = pctWanted();
              post("setVolume", [st.sent]);
              post("unMute");
              unmutedAt.current = performance.now();
            }
          }
        } else if (state === 3) {
          cb.current.onWaiting?.();
        } else if (state === 2 && wanted.current && performance.now() - unmutedAt.current < 1000) {
          /* Étape 3 : pause imposée au retour du son = refus. On repart muet
             plutôt que de rester arrêté (le geste suivant rend le son). */
          unmutedAt.current = 0;
          blocked();
        } else if (state === 2 || state === 0) {
          st.t = now();
          st.playing = false;
          if (was) cb.current.onPause?.();
          if (state === 0) {
            cb.current.onEnded?.();
            /* Morceau entier sur le profil : on reboucle, comme le `loop`
               natif du fichier d'AnimeThemes. */
            if (loop.current.on) {
              post("seekTo", [loop.current.from, true]);
              post("playVideo");
            }
          }
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [post]);

  /* La boucle de l'extrait et son fondu, pour le profil. Même calcul que le
     studio (`fadeGain`), pour que ce qu'on a réglé soit ce qu'on entend. */
  const from = clip?.from ?? 0;
  const to = clip?.to ?? 0;
  const fade = clip?.fade ?? 0;
  const base = clip?.volume ?? 1;
  const hasClip = !!clip;
  loop.current = { on: hasClip, from };
  /** Le gain du fondu à l'instant : l'égaliseur de la case le suit. */
  const gainNow = useRef(1);
  useEffect(() => {
    if (!hasClip) return;
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      const frame = performance.now();
      const dt = Math.min(0.1, (frame - last) / 1000);
      last = frame;
      const st = s.current;
      const end = to > from ? to : st.duration;
      if (hasClip && st.playing) {
        const t = now();
        if (to > from && t >= to) {
          st.t = from;
          st.at = performance.now();
          post("seekTo", [from, true]);
        }
        const g = fadeGain(t, from, end || 0, fade);
        setVol(base * g);
        gainNow.current = g;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasClip, from, to, fade, base, post, setVol]);

  /* La lumière de la case glisse entre ces trois images (même tableau d'un
     rendu à l'autre : TrailerAmbient refait sa boucle quand il change). */
  const frames = useMemo(() => storyboardFrames(videoId), [videoId]);
  const player = (
    <iframe
      key={videoId}
      ref={frame}
      src={`${ORIGIN}/embed/${videoId}?enablejsapi=1${autoStart ? "&autoplay=1&mute=1" : ""}&controls=0&playsinline=1&rel=0&iv_load_policy=3&disablekb=1&fs=0&start=${Math.floor(from)}`}
      allow="autoplay; encrypted-media"
      title="YouTube"
      /* En case, le geste de l'aperçu au survol (TrailerStage, SCALE et
         OVERSCAN) : le lecteur est rendu 200 fois plus grand puis réduit
         d'autant. Son habillage (titre, logo, gros ▶), dimensionné en pixels,
         devient microscopique ; l'image, elle, remplit le carré — 16:9 à
         hauteur pleine, côtés rognés, sans débord. */
      /* En case, la souris ne doit jamais entrer dans l'iframe : ses
         mouvements y restent, et le survol de la case n'était vu qu'en
         retard (le petit carré tardait à grandir). */
      className={card ? "pointer-events-none absolute" : className}
      style={
        card
          ? {
              border: 0,
              width: `${YT_SCALE * (16 / 9) * YT_OVERSCAN * 100}%`,
              height: `${YT_SCALE * YT_OVERSCAN * 100}%`,
              left: `${(-((16 / 9) * YT_OVERSCAN - 1) / 2) * 100}%`,
              top: `${(-(YT_OVERSCAN - 1) / 2) * 100}%`,
              transform: `scale(${1 / YT_SCALE})`,
              transformOrigin: "0 0",
            }
          : undefined
      }
    />
  );
  if (!card) return player;
  const thumb = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  return (
    <MusicCard
      {...card}
      className={className}
      /* `mqdefault` : 16:9 sans bandes (`hqdefault` est un 4:3 aux bandes
         noires incrustées). Elle couvre la case tant que la vidéo n'a jamais
         joué : réduit ×200, le lecteur ne montre qu'un carré noir avant. */
      art={thumb}
      showArt={!started}
      started={started}
      eqKey={videoId}
      clock={now}
      live={() => s.current.playing}
      gain={() => (hasClip ? gainNow.current : 1)}
      frames={frames}
      progress={() => (s.current.duration > 0 ? now() / s.current.duration : null)}
    >
      {player}
    </MusicCard>
  );
});

export default YouTubeMusic;
