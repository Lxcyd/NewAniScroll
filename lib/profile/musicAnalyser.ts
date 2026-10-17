/**
 * L'ÉGALISEUR EN DIRECT de la case musique du profil (17/10/2026).
 *
 * Le son qu'on entend vient du lecteur YouTube officiel, dans une iframe d'un
 * autre site : la page ne peut pas le lire, aucune bibliothèque n'y change rien
 * (recherche consignée dans docs/RESSOURCES.md). On analyse donc une COPIE du
 * même morceau, servie avec CORS par notre Worker (worker-ytaudio/,
 * yta.aniscroll.com), lue par un <audio> hors page et calée sur l'horloge du
 * lecteur YouTube. Elle n'est jamais entendue : le graphe finit sur un gain nul.
 *
 * Tout échec (YouTube refuse notre Worker, réseau, autoplay jamais débloqué)
 * laisse l'animation CSS de repli en place : ce module ne fait qu'AJOUTER le
 * direct quand il marche. Pas de nouvelle tentative côté visiteur : c'est le
 * Worker qui réchauffe un morceau refusé (warmLater), le visiteur suivant
 * l'aura depuis le cache.
 */

const BASE = process.env.NEXT_PUBLIC_YTA_BASE;

export type AnalyserState = "idle" | "loading" | "live" | "failed";

export type MusicAnalyser = {
  readonly state: AnalyserState;
  /** Appelé à chaque image : recopie lecture/pause et rattrape l'écart. */
  sync(t: number, playing: boolean): void;
  /** Remplit `out` (une valeur 0-1 par barre). Faux tant que ce n'est pas en direct. */
  levels(out: Float32Array): boolean;
  dispose(): void;
};

/** Huit bandes, de 60 Hz à 8 kHz en échelle logarithmique : l'oreille
    entend en octaves, une échelle linéaire mettrait 7 barres sur les aigus. */
const LOW_HZ = 60;
const HIGH_HZ = 8000;
/** Au-delà de cet écart avec YouTube, on recale la copie. */
const DRIFT_S = 0.3;
/** Pas plus d'un recalage par seconde : un saut coûte une requête de plage. */
const SEEK_EVERY_MS = 1000;
/** Lecture demandée et rien après ce délai : on abandonne pour cette visite. */
const START_TIMEOUT_MS = 12000;

/**
 * Le direct est-il permis ici ? Non sans Worker configuré, en mode économie de
 * données, ou sur un téléphone : la copie est le format 18 de YouTube (360p,
 * image comprise), 10 à 20 Mo pour un morceau de 4 min.
 */
export function musicAnalyserAllowed(): boolean {
  if (!BASE || typeof window === "undefined" || typeof AudioContext === "undefined") return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return false;
  if (window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 768) return false;
  return true;
}

export function createMusicAnalyser(videoId: string, bars: number): MusicAnalyser {
  let state: AnalyserState = "idle";
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let bins: Uint8Array | null = null;
  let edges: number[] = [];
  const smooth = new Float32Array(bars);
  let lastSeek = 0;
  let wantPlay = false;
  let playing = false;
  let blocked = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const el = new Audio();
  el.crossOrigin = "anonymous";
  el.preload = "none";

  const fail = () => {
    if (state === "failed") return;
    state = "failed";
    cleanup();
  };

  const onPlaying = () => {
    playing = true;
    if (timeout) clearTimeout(timeout);
    timeout = null;
  };
  const onPause = () => {
    playing = false;
  };
  el.addEventListener("playing", onPlaying);
  el.addEventListener("pause", onPause);
  el.addEventListener("error", fail);

  /* L'AudioContext naît suspendu tant que la page n'a pas eu de geste (sauf
     sur un site où Chrome a le score d'engagement). Le premier geste le
     relance, et relance la lecture que l'autoplay avait refusée. */
  const onGesture = () => {
    if (!ctx) return;
    void ctx.resume().then(() => {
      if (blocked && wantPlay) tryPlay();
    });
  };
  window.addEventListener("pointerdown", onGesture, { passive: true });
  window.addEventListener("keydown", onGesture);

  function build() {
    ctx = new AudioContext();
    const src = ctx.createMediaElementSource(el);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -20;
    /* Un gain nul jusqu'à la sortie : sans destination, Chrome ne fait pas
       tourner le graphe ; avec, on entendrait le morceau en double. */
    const silence = ctx.createGain();
    silence.gain.value = 0;
    src.connect(analyser);
    analyser.connect(silence);
    silence.connect(ctx.destination);
    bins = new Uint8Array(analyser.frequencyBinCount);
    const hzPerBin = ctx.sampleRate / analyser.fftSize;
    edges = Array.from({ length: bars + 1 }, (_, i) =>
      Math.max(1, Math.round((LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / bars)) / hzPerBin)),
    );
    el.src = `${BASE}/a/${videoId}.mp4`;
    state = "loading";
  }

  function tryPlay() {
    blocked = false;
    el.play().catch((e: unknown) => {
      // Refus d'autoplay : on attend le premier geste, ce n'est pas un échec.
      if ((e as DOMException)?.name === "NotAllowedError") blocked = true;
      else if ((e as DOMException)?.name !== "AbortError") fail();
    });
    if (!timeout) timeout = setTimeout(() => !blocked && !playing && fail(), START_TIMEOUT_MS);
  }

  function cleanup() {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    window.removeEventListener("pointerdown", onGesture);
    window.removeEventListener("keydown", onGesture);
    el.removeEventListener("playing", onPlaying);
    el.removeEventListener("pause", onPause);
    el.removeEventListener("error", fail);
    el.pause();
    el.removeAttribute("src");
    el.load();
    void ctx?.close().catch(() => {});
    ctx = null;
    analyser = null;
  }

  return {
    get state() {
      return state;
    },
    sync(t, ytPlaying) {
      if (state === "failed") return;
      wantPlay = ytPlaying;
      if (!ytPlaying) {
        if (!el.paused) el.pause();
        return;
      }
      // Rien n'est téléchargé avant la première lecture réelle.
      if (state === "idle") build();
      if (el.paused && !blocked) tryPlay();
      if (el.readyState >= 1 && Math.abs(el.currentTime - t) > DRIFT_S) {
        const now = performance.now();
        if (now - lastSeek > SEEK_EVERY_MS) {
          lastSeek = now;
          el.currentTime = t;
        }
      }
      if (playing && ctx?.state === "running") state = "live";
    },
    levels(out) {
      if (state !== "live" || !analyser || !bins || !playing) return false;
      analyser.getByteFrequencyData(bins);
      for (let b = 0; b < bars; b++) {
        const lo = edges[b];
        const hi = Math.max(lo + 1, edges[b + 1]);
        let sum = 0;
        for (let i = lo; i < hi && i < bins.length; i++) sum += bins[i];
        const v = sum / (hi - lo) / 255;
        /* Monte vite, retombe doucement : l'attaque se voit, la retombée ne
           tremble pas. */
        const prev = smooth[b];
        smooth[b] = v > prev ? prev + (v - prev) * 0.6 : prev + (v - prev) * 0.15;
        out[b] = smooth[b];
      }
      return true;
    },
    dispose() {
      if (state !== "failed") cleanup();
      state = "failed";
    },
  };
}
