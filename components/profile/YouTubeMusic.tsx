import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MdPause, MdPlayArrow } from "react-icons/md";
import { fadeGain } from "@/lib/profile/dressing";
import HoverVolume from "@/components/shared/HoverVolume";

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
  card?: {
    playing: boolean;
    muted: boolean;
    volume: number;
    onToggle: () => void;
    onMuted: (m: boolean) => void;
    onVolume: (v: number) => void;
    fallback?: number;
  } | null;
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
  { videoId, className, onPlay, onPause, onEnded, onWaiting, onPlaying, onDuration, onTime, onError, clip, card },
  ref,
) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const loaded = useRef(false);
  const queue = useRef<string[]>([]);
  const s = useRef({ t: 0, at: 0, playing: false, duration: 0, volume: 1, sent: -1 });
  const loop = useRef({ on: false, from: 0 });
  /* La lumière d'ambiance : une copie MUETTE du lecteur, floutée derrière la
     case — la technique de TrailerStage (« glow »). Elle suit les commandes
     de lecture et se recale toutes les trois secondes. */
  const glowFrame = useRef<HTMLIFrameElement | null>(null);
  const glowReady = useRef(false);
  const glowQueue = useRef<string[]>([]);
  const postGlow = useCallback((func: string, args: unknown[] = []) => {
    const msg = JSON.stringify({ event: "command", func, args });
    if (glowReady.current) glowFrame.current?.contentWindow?.postMessage(msg, ORIGIN);
    else glowQueue.current.push(msg);
  }, []);
  /* On a demandé la lecture ; `autoMuted` = relancée muette faute d'avoir pu
     partir avec le son (voir `play`). */
  const wanted = useRef(false);
  const autoMuted = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Quand on a rendu le son après un départ muet : si YouTube met en pause
      dans la seconde, c'est qu'il refuse le son — on repart muet. */
  const unmutedAt = useRef(0);
  /** Muet imposé : on ne rend plus le son tout seul jusqu'au prochain `play`. */
  const forcedMute = useRef(false);
  const armRetry = () => {
    if (retry.current) clearTimeout(retry.current);
    retry.current = setTimeout(() => {
      if (!wanted.current || s.current.playing) return;
      autoMuted.current = true;
      const w = frame.current?.contentWindow;
      w?.postMessage(JSON.stringify({ event: "command", func: "mute", args: [] }), ORIGIN);
      w?.postMessage(JSON.stringify({ event: "command", func: "playVideo", args: [] }), ORIGIN);
    }, 1200);
  };
  const cb = useRef({ onPlay, onPause, onEnded, onWaiting, onPlaying, onDuration, onTime, onError });
  cb.current = { onPlay, onPause, onEnded, onWaiting, onPlaying, onDuration, onTime, onError };

  /* PRÊT ≠ CHARGÉ. L'iframe finit de charger avant que le lecteur qu'elle
     contient écoute : une commande envoyée entre les deux est perdue — c'est
     ainsi que le volume réglé se perdait et que YouTube jouait à 100
     (16/10/2026). La file ne se vide qu'au premier message du lecteur. */
  const post = useCallback((func: string, args: unknown[] = []) => {
    const msg = JSON.stringify({ event: "command", func, args });
    if (loaded.current) frame.current?.contentWindow?.postMessage(msg, ORIGIN);
    else queue.current.push(msg);
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
        postGlow("seekTo", [v, true]);
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
        /* Le volume AVANT le son : sans lui, le premier instant part à 100. */
        s.current.sent = pctWanted();
        post("setVolume", [s.current.sent]);
        post("unMute");
        post("playVideo");
        postGlow("mute");
        postGlow("playVideo");
        /* LE MORCEAU NE PARTAIT PAS TOUJOURS (17/10/2026) : le navigateur
           refuse parfois à l'iframe de démarrer avec le son, et le lecteur
           restait sur son gros bouton ▶. Muet, la lecture est toujours
           permise : on relance muet, et le son revient dès qu'il joue. */
        wanted.current = true;
        forcedMute.current = false;
        /* Le délai court depuis que le lecteur est PRÊT : armé avant, il
           tombait dans la même rafale que l'ordre refusé, et se perdait. */
        if (loaded.current) armRetry();
        return Promise.resolve();
      },
      pause() {
        wanted.current = false;
        post("pauseVideo");
        postGlow("pauseVideo");
      },
    }),
    [post, postGlow, setVol],
  );

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
    glowReady.current = false;
    glowQueue.current = [];
    wanted.current = false;
    autoMuted.current = false;
    s.current = { ...s.current, t: 0, at: performance.now(), playing: false, duration: 0, sent: -1 };
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== ORIGIN) return;
      /* La copie d'ambiance ne sert qu'à dire qu'elle est prête. */
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
      if (glowFrame.current && e.source === glowFrame.current.contentWindow) {
        if (ready && !glowReady.current) {
          glowReady.current = true;
          for (const m of glowQueue.current) glowFrame.current.contentWindow?.postMessage(m, ORIGIN);
          glowQueue.current = [];
        }
        return;
      }
      if (e.source !== frame.current?.contentWindow) return;
      const st = s.current;
      if (ready && !loaded.current) {
        loaded.current = true;
        const w = frame.current?.contentWindow;
        for (const m of queue.current) w?.postMessage(m, ORIGIN);
        queue.current = [];
        if (wanted.current) armRetry();
      }
      if (data?.event === "onError") {
        cb.current.onError?.();
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
      if (info && typeof info.volume === "number") {
        const want = pctWanted();
        if (Math.abs(info.volume - want) > 1) {
          st.sent = want;
          post("setVolume", [want]);
        }
      }
      if (info && info.muted === true && st.volume > 0 && st.playing && !forcedMute.current && !autoMuted.current)
        post("unMute");
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
          if (autoMuted.current) {
            autoMuted.current = false;
            if (st.volume > 0) {
              unmutedAt.current = performance.now();
              post("unMute");
            }
          }
          if (!was) cb.current.onPlay?.();
          cb.current.onPlaying?.();
        } else if (state === 3) {
          cb.current.onWaiting?.();
        } else if (state === 2 && wanted.current && performance.now() - unmutedAt.current < 1000) {
          /* Pause imposée par le navigateur au retour du son : on joue muet
             plutôt que de rester arrêté (l'icône de volume le rétablit). */
          unmutedAt.current = 0;
          forcedMute.current = true;
          post("mute");
          post("playVideo");
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
              postGlow("seekTo", [loop.current.from, true]);
              postGlow("playVideo");
            }
          }
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [post, postGlow]);

  /* La copie d'ambiance dérive : on la recale sur le lecteur. */
  const hasGlow = !!card;
  useEffect(() => {
    if (!hasGlow) return;
    const id = window.setInterval(() => {
      if (s.current.playing) postGlow("seekTo", [now() + 0.15, true]);
    }, 3000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGlow, postGlow]);
  useEffect(
    () => () => {
      if (retry.current) clearTimeout(retry.current);
    },
    [],
  );

  /* La boucle de l'extrait et son fondu, pour le profil. Même calcul que le
     studio (`fadeGain`), pour que ce qu'on a réglé soit ce qu'on entend. */
  const from = clip?.from ?? 0;
  const to = clip?.to ?? 0;
  const fade = clip?.fade ?? 0;
  const base = clip?.volume ?? 1;
  const hasClip = !!clip;
  loop.current = { on: hasClip, from };
  useEffect(() => {
    if (!hasClip) return;
    let raf = 0;
    const tick = () => {
      const st = s.current;
      const end = to > from ? to : st.duration;
      if (st.playing) {
        const t = now();
        if (to > from && t >= to) {
          st.t = from;
          st.at = performance.now();
          post("seekTo", [from, true]);
          postGlow("seekTo", [from, true]);
        }
        setVol(base * fadeGain(t, from, end || 0, fade));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasClip, from, to, fade, base, post, postGlow, setVol]);

  /* Les commandes de la case : là quand la main bouge, parties après 1,8 s
     d'immobilité — comme l'aperçu au survol. À l'arrêt, elles restent. */
  const [awake, setAwake] = useState(false);
  const sleep = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = () => {
    setAwake(true);
    if (sleep.current) clearTimeout(sleep.current);
    sleep.current = setTimeout(() => setAwake(false), 1800);
  };
  useEffect(
    () => () => {
      if (sleep.current) clearTimeout(sleep.current);
    },
    [],
  );

  const player = (
    <iframe
      key={videoId}
      ref={frame}
      src={`${ORIGIN}/embed/${videoId}?enablejsapi=1&controls=0&playsinline=1&rel=0&iv_load_policy=3&disablekb=1&fs=0&start=${Math.floor(from)}`}
      allow="autoplay; encrypted-media"
      title="YouTube"
      onLoad={() => {
        /* L'embed ne parle qu'après un `listening`, et peut rater celui
           envoyé pendant son démarrage : on le répète jusqu'à ce qu'il
           réponde (c'est sa réponse qui vide la file, plus haut). */
        const listen = JSON.stringify({ event: "listening", id: 1, channel: "widget" });
        let n = 0;
        const again = () => {
          if (loaded.current || n++ > 20) return;
          frame.current?.contentWindow?.postMessage(listen, ORIGIN);
          window.setTimeout(again, 250);
        };
        again();
      }}
      /* En case : l'image REMPLIT le carré, comme l'aperçu au survol — une
         vidéo 16:9 à hauteur pleine, centrée, les côtés rognés. */
      className={card ? "absolute left-1/2 top-0 h-full w-[178%] max-w-none -translate-x-1/2" : className}
    />
  );
  if (!card) return player;
  const chrome = `transition-opacity duration-200 ${awake || !card.playing ? "opacity-100" : "pointer-events-none opacity-0"}`;
  return (
    <div className={`relative isolate ${className ?? ""}`}>
      {/* La lumière : la copie muette, agrandie et floutée, hors de la case. */}
      <div aria-hidden className="pointer-events-none absolute -inset-3 -z-10 opacity-80 blur-[34px]">
        <iframe
          key={`glow-${videoId}`}
          ref={glowFrame}
          tabIndex={-1}
          src={`${ORIGIN}/embed/${videoId}?enablejsapi=1&controls=0&mute=1&playsinline=1&rel=0&iv_load_policy=3&disablekb=1&fs=0&start=${Math.floor(from)}`}
          allow="autoplay; encrypted-media"
          title=""
          onLoad={() => {
            const listen = JSON.stringify({ event: "listening", id: 2, channel: "widget" });
            let n = 0;
            const again = () => {
              if (glowReady.current || n++ > 20) return;
              glowFrame.current?.contentWindow?.postMessage(listen, ORIGIN);
              window.setTimeout(again, 250);
            };
            again();
          }}
          className="h-full w-full scale-125"
        />
      </div>
      <div
        className="relative h-full w-full overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/15"
        onPointerMove={wake}
        onPointerEnter={wake}
      >
        {player}
        {/* Au-dessus de l'iframe : la case se pilote par ses propres commandes. */}
        <div className="absolute inset-0 grid place-items-center">
          <button
            type="button"
            onClick={card.onToggle}
            aria-label={card.playing ? "Pause" : "Play"}
            className={`as-preview-videobtn h-11 w-11 ${chrome}`}
          >
            {card.playing ? <MdPause size={28} /> : <MdPlayArrow size={28} />}
          </button>
        </div>
        <div className={`absolute right-2 top-2 ${chrome}`}>
          <HoverVolume
            muted={card.muted}
            volume={card.volume}
            onMuted={card.onMuted}
            onVolume={card.onVolume}
            fallback={card.fallback}
            placement="down"
          />
        </div>
      </div>
    </div>
  );
});

export default YouTubeMusic;
