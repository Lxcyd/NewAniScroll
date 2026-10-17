import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MdPause, MdPlayArrow } from "react-icons/md";
import { fadeGain } from "@/lib/profile/dressing";
import HoverVolume from "@/components/shared/HoverVolume";
import { createMusicAnalyser, musicAnalyserAllowed, type MusicAnalyser } from "@/lib/profile/musicAnalyser";

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
  card?: {
    playing: boolean;
    muted: boolean;
    volume: number;
    onToggle: () => void;
    onMuted: (m: boolean) => void;
    onVolume: (v: number) => void;
    fallback?: number;
    /** Se tasse en petit carré hors survol (le profil, pas le studio). */
    minimizable?: boolean;
  } | null;
};

/** La case du profil, grande (17/10/2026 : 240 px, un peu plus que le
    minimum de 200 de YouTube) ; réduite, le petit carré. */
export const CARD = 240;
const MINI = 48;
/** Du centre de la grande case au centre du petit carré, calé au coin bas droit. */
const SHIFT = (CARD - MINI) / 2;

const EQ_BARS = 8;

/** Huit barres d'égaliseur propres à un morceau : vitesses, décalages et
    creux tirés de l'identifiant de la vidéo, pour que deux profils ne dansent
    pas pareil. Un tempo commun par morceau, varié par barre. */
function eqBars(videoId: string) {
  let h = 2166136261;
  for (let i = 0; i < videoId.length; i++) h = Math.imul(h ^ videoId.charCodeAt(i), 16777619);
  const rnd = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const tempo = 0.55 + rnd() * 0.45;
  return Array.from({ length: EQ_BARS }, () => ({
    d: +(tempo * (0.8 + rnd() * 0.7)).toFixed(2),
    dl: +(rnd() * 1.2).toFixed(2),
    lo: +(0.15 + rnd() * 0.3).toFixed(2),
  }));
}

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
  /* L'égaliseur suit le fondu : écrit à même le style (pas d'état React à
     chaque image), et seulement quand il bouge d'un vingtième. */
  const eqRef = useRef<HTMLDivElement | null>(null);
  const eqFade = useRef(-1);
  /* Le direct (lib/profile/musicAnalyser) : les barres sont pilotées une à
     une par l'analyse quand elle tourne, l'animation CSS reprend sinon. */
  const analyser = useRef<MusicAnalyser | null>(null);
  const barEls = useRef<(HTMLElement | null)[]>([]);
  const eqLive = useRef(false);
  const eqLevels = useRef(new Float32Array(EQ_BARS));
  useEffect(() => {
    if (!hasClip) return;
    let raf = 0;
    const drive = () => {
      const an = analyser.current;
      if (!an) return;
      an.sync(now(), s.current.playing);
      const live = an.levels(eqLevels.current);
      if (live !== eqLive.current) {
        eqLive.current = live;
        for (const b of barEls.current) {
          if (!b) continue;
          b.style.animation = live ? "none" : "";
          if (!live) b.style.transform = "";
        }
      }
      if (live) {
        barEls.current.forEach((b, i) => {
          if (b) b.style.transform = `scaleY(${(0.08 + 0.92 * eqLevels.current[i]).toFixed(3)})`;
        });
      }
    };
    const tick = () => {
      drive();
      const st = s.current;
      const end = to > from ? to : st.duration;
      if (st.playing) {
        const t = now();
        if (to > from && t >= to) {
          st.t = from;
          st.at = performance.now();
          post("seekTo", [from, true]);
        }
        const g = fadeGain(t, from, end || 0, fade);
        setVol(base * g);
        const q = Math.round(g * 20) / 20;
        if (eqRef.current && q !== eqFade.current) {
          eqFade.current = q;
          eqRef.current.style.setProperty("--eq-fade", String(q));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasClip, from, to, fade, base, post, setVol]);

  /* Les commandes de la case : là quand la main bouge, parties après 3 s
     d'immobilité. À l'arrêt, elles restent. La PREMIÈRE fois qu'elle joue,
     elles restent 5 s même sans la main (17/10/2026 : on doit les voir avant
     qu'elles partent). */
  const [awake, setAwake] = useState(false);
  const sleep = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = (ms = 3000) => {
    setAwake(true);
    if (sleep.current) clearTimeout(sleep.current);
    sleep.current = setTimeout(() => setAwake(false), ms);
  };
  const greeted = useRef(false);
  const cardPlaying = !!card?.playing;
  useEffect(() => {
    if (!cardPlaying || greeted.current) return;
    greeted.current = true;
    wake(5000);
  }, [cardPlaying]);
  useEffect(
    () => () => {
      if (sleep.current) clearTimeout(sleep.current);
    },
    [],
  );

  /* LE PETIT CARRÉ (17/10/2026, choix de Luc) : grande 5 s à l'arrivée, puis
     elle se tasse en carré de 48 px aux bords arrondis ; le survol la rend
     grande, la quitter la retasse. Pas de bouton. La musique ne s'arrête
     jamais : c'est la même iframe, seule la boîte change de taille. */
  const canMini = !!card?.minimizable;
  const [mini, setMini] = useState(false);
  const shrinkAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shrinkIn = (ms: number) => {
    if (shrinkAt.current) clearTimeout(shrinkAt.current);
    shrinkAt.current = setTimeout(() => setMini(true), ms);
  };
  const grow = () => {
    if (shrinkAt.current) clearTimeout(shrinkAt.current);
    setMini(false);
  };
  useEffect(() => {
    if (!canMini) return;
    shrinkIn(5000);
    return () => {
      if (shrinkAt.current) clearTimeout(shrinkAt.current);
    };
  }, [canMini]);
  const folded = canMini && mini;

  /* L'analyse naît à la première lecture réelle et meurt avec le morceau. */
  useEffect(() => {
    if (!canMini || !started || !musicAnalyserAllowed()) return;
    const an = createMusicAnalyser(videoId, EQ_BARS);
    analyser.current = an;
    return () => {
      an.dispose();
      analyser.current = null;
      eqLive.current = false;
      for (const b of barEls.current) {
        if (!b) continue;
        b.style.animation = "";
        b.style.transform = "";
      }
    };
  }, [canMini, started, videoId]);

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
  const chrome = `transition-opacity duration-200 ${awake || !card.playing ? "opacity-100" : "pointer-events-none opacity-0"}`;
  return (
    <div className={`relative isolate ${className ?? ""}`}>
      {/* LA LUMIÈRE, SANS SECOND LECTEUR (17/10/2026). C'était une copie muette
         de la vidéo, floutée à 34 px : deux décodeurs YouTube et un flou
         recalculé à chaque image — la case faisait ramer le studio. C'est
         maintenant la vignette publiée par YouTube, floutée UNE fois : le
         repli de l'aperçu au survol en économie de données (TrailerAmbient).
         Le petit carré a SA lumière, à sa taille : la grande réduite au zoom
         laissait un voile gris dans le coin (17/10/2026). On passe de l'une à
         l'autre en fondu d'opacité, sans jamais animer de flou. Et chacune
         SUIT la case pendant qu'elle change de taille (même durée, même
         courbe, en transform) : la grande se replie vers le coin en
         s'éteignant, la petite part de la taille de la grande. */}
      <img
        aria-hidden
        alt=""
        src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
        className={`pointer-events-none absolute -inset-3 -z-10 h-[calc(100%+1.5rem)] w-[calc(100%+1.5rem)] object-cover blur-[34px] transition-[transform,opacity] duration-300 ease-out will-change-transform ${folded ? "opacity-0" : "opacity-70"}`}
        style={{ transform: folded ? `translate(${SHIFT}px, ${SHIFT}px) scale(${MINI / CARD})` : "scale(1.1)" }}
      />
      {canMini ? (
        <img
          aria-hidden
          alt=""
          src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
          /* À peine visible (17/10/2026) : 4 px de débord, 8 px de flou. */
          className={`pointer-events-none absolute -bottom-1 -right-1 -z-10 object-cover blur-[8px] transition-[transform,opacity] duration-300 ease-out will-change-transform ${folded ? "opacity-30" : "opacity-0"}`}
          style={{
            width: MINI + 8,
            height: MINI + 8,
            transform: folded ? "none" : `translate(${-SHIFT}px, ${-SHIFT}px) scale(${CARD / (MINI + 8)})`,
          }}
        />
      ) : null}
      <div
        /* Pas de liseré : sur une image claire il se lisait comme un bord bleu.
           En TRANSFORM, pas en width/height : animer la taille remettait en
           page à chaque image une iframe 200 fois plus grande (saccades,
           17/10/2026). La boîte garde sa taille (CARD) ; la carte graphique la
           réduit vers le coin bas droit. Réduite, son rayon l'est avec :
           40 px ici font ~10 px à l'écran. Le rayon glisse PENDANT la
           réduction, même durée, même courbe : posé à la fin, il sautait
           (17/10/2026). */
        className={`relative h-full w-full overflow-hidden bg-black shadow-2xl transition-[transform,border-radius] duration-300 ease-out will-change-transform ${folded ? "rounded-[40px]" : "rounded-xl"}`}
        style={canMini ? { transform: folded ? `scale(${MINI / CARD})` : "none", transformOrigin: "100% 100%" } : undefined}
        onPointerMove={() => wake()}
        onPointerEnter={() => {
          wake();
          if (canMini) grow();
        }}
        onPointerLeave={canMini ? () => shrinkIn(0) : undefined}
      >
        {player}
        {started ? null : (
          <img
            alt=""
            /* `mqdefault` : 16:9 sans bandes (`hqdefault` est un 4:3 aux
               bandes noires incrustées). */
            src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
        )}
        {canMini && started ? (
          /* LE TÉMOIN DE LECTURE (n° 2 des pistes, 17/10/2026) : huit barres au
             pied de la case, en grand comme en petit (la case réduite les
             réduit avec elle). Le son lui-même est hors d'atteinte (iframe
             d'un autre domaine) ; elles suivent ce qu'on sait : la pause les
             fige, le muet les couche, le fondu les baisse, et chaque morceau
             a son propre jeu de vitesses (tiré de son identifiant). */
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/60 to-transparent transition-opacity duration-200 ${card.playing ? "opacity-100" : "opacity-0"}`}
          >
            <div
              ref={eqRef}
              className="absolute inset-x-4 bottom-3 flex h-7 items-end justify-between transition-transform duration-200"
              style={{
                transform: `scaleY(calc(var(--eq-fade, 1) * ${card.playing && !card.muted ? 1 : 0.15}))`,
                transformOrigin: "bottom",
              }}
            >
              {eqBars(videoId).map((b, i) => (
                <i
                  key={i}
                  ref={(el) => {
                    barEls.current[i] = el;
                  }}
                  className="as-eq-bar block h-full w-3 rounded-sm bg-white/90"
                  style={{
                    ["--d" as string]: `${b.d}s`,
                    ["--dl" as string]: `${-b.dl}s`,
                    ["--lo" as string]: b.lo,
                    animationPlayState: card.playing ? "running" : "paused",
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}
        {folded ? null : (
        <>
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
        </>
        )}
      </div>
    </div>
  );
});

export default YouTubeMusic;
