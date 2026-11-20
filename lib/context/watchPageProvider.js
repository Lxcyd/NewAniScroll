import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

export const WatchPageContext = createContext();

/** Flou minimal des ambient lights. */
export const AMBIENT_BLUR_MIN = 5;
/** Flou par defaut (choix de Luc le 03/10). */
export const AMBIENT_BLUR_DEFAULT = 20;

export const WatchPageProvider = ({ children }) => {
  const [theaterMode, setTheaterMode] = useState(false);
  const [aspectRatio, setAspectRatio] = useState("16/9");
  const [playerState, setPlayerState] = useState({
    currentTime: 0,
    isPlaying: false,
  });
  // Persisted player preferences. Initialized from localStorage on mount
  // (lazy initializer to avoid SSR/CSR mismatch — `typeof window` guard).
  // Default: autoplay OFF — most users prefer to opt in per session, and an
  // unsolicited audio-on autoplay is the #1 complaint on streaming sites.
  const [autoplay, setAutoPlayState] = useState(() => {
    if (typeof window === "undefined") return false;
    const v = localStorage.getItem("autoplay");
    return v === "true";
  });
  const [autoNext, setAutoNextState] = useState(() => {
    if (typeof window === "undefined") return false;
    const v = localStorage.getItem("autoNext");
    return v === "true";
  });
  // Ambient lights default ON — they're a flagship visual feature and most
  // users like them. Saved as `ambient_lights` in localStorage.
  const [ambientLights, setAmbientLightsState] = useState(() => {
    if (typeof window === "undefined") return true;
    const v = localStorage.getItem("ambient_lights");
    if (v === null) return true; // first visit
    return v === "true";
  });

  // Wrap the setters so any change is mirrored to localStorage. Caller
  // semantics stay the same (`setAutoPlay(true)`); persistence is automatic.
  const setAutoPlay = useCallback((v) => {
    const bool = v === true || v === "true";
    setAutoPlayState(bool);
    if (typeof window !== "undefined") {
      localStorage.setItem("autoplay", String(bool));
    }
  }, []);
  const setAutoNext = useCallback((v) => {
    const bool = v === true || v === "true";
    setAutoNextState(bool);
    if (typeof window !== "undefined") {
      localStorage.setItem("autoNext", String(bool));
    }
  }, []);
  const setAmbientLights = useCallback((v) => {
    const bool = v === true || v === "true";
    setAmbientLightsState(bool);
    if (typeof window !== "undefined") {
      localStorage.setItem("ambient_lights", String(bool));
    }
  }, []);
  // Flou des ambient lights, sur l'echelle de l'extension « Ambient light for
  // YouTube » dont le rendu est porte : 5-100. Minimum 5 : sans flou du tout,
  // la copie agrandie hors du lecteur se lit comme une seconde image. Defaut
  // 20 (choix de Luc le 03/10 ; le leur est 30).
  // Saved as `ambient_blur:v4` — v4 le 03/10, au passage du defaut de 5 a 20 :
  // les valeurs d'essai de la v3 auraient masque le nouveau defaut.
  const [ambientBlur, setAmbientBlurState] = useState(() => {
    if (typeof window === "undefined") return AMBIENT_BLUR_DEFAULT;
    const raw = localStorage.getItem("ambient_blur:v4");
    const v = Number(raw);
    return raw === null || !Number.isFinite(v)
      ? AMBIENT_BLUR_DEFAULT
      : Math.min(100, Math.max(AMBIENT_BLUR_MIN, v));
  });
  const setAmbientBlur = useCallback((v) => {
    const n = Math.min(
      100,
      Math.max(AMBIENT_BLUR_MIN, Math.round(Number(v) || 0)),
    );
    setAmbientBlurState(n);
    if (typeof window !== "undefined") {
      localStorage.setItem("ambient_blur:v4", String(n));
    }
  }, []);
  const [marked, setMarked] = useState(0);

  const [userData, setUserData] = useState(null);
  const [dataMedia, setDataMedia] = useState(null);

  const [ratingModalState, setRatingModalState] = useState({
    isOpen: false,
    isFullscreen: false,
  });

  const [track, setTrack] = useState(null);
  /* AniSkip op/ed/recap intervals for the current episode. Shape:
       [{ start: number, end: number, type: "op" | "ed" | "recap" }]
     Stored in the watch context (not local to a player component) so
     the seek-bar chrome AND the floating "Skip" button can both read
     it without prop-drilling. Cleared on episode change by the same
     effect that fetches the new times. */
  const [skipTimes, setSkipTimes] = useState([]);

  // Live, MEASURED playback speed per server id:
  //   { [serverId]: "fast" | "medium" | "slow" }
  // UniversalPlayer writes the active stream's real hls.js throughput /
  // rebuffering here; the server selector reads it to draw a dynamic speed
  // poinçon instead of a static guess (megaplay can be fast on one title and
  // slow on another, so a fixed rank lies). Reset per episode.
  const [liveSpeed, setLiveSpeedState] = useState({});
  const setLiveSpeedFor = useCallback((serverId, tier) => {
    if (!serverId || !tier) return;
    setLiveSpeedState((prev) =>
      prev[serverId] === tier ? prev : { ...prev, [serverId]: tier },
    );
  }, []);
  const resetLiveSpeed = useCallback(() => setLiveSpeedState({}), []);

  /* Valeur MEMOISEE (20/11/2026) : ce fournisseur entoure tout le site
     depuis _app. Un objet neuf a chaque rendu re-rendait chaque consommateur
     (UniversalPlayer, page watch, SkipOverlay…) a chaque rendu du parent,
     meme sans changement. Les setters ci-dessus sont stables (useCallback /
     setters de useState) : la valeur ne change que si un etat change. */
  const value = useMemo(
    () => ({
      theaterMode,
      setTheaterMode,
      aspectRatio,
      setAspectRatio,
      playerState,
      setPlayerState,
      userData,
      setUserData,
      autoplay,
      setAutoPlay,
      marked,
      setMarked,
      track,
      setTrack,
      dataMedia,
      setDataMedia,
      autoNext,
      setAutoNext,
      ambientLights,
      setAmbientLights,
      ambientBlur,
      setAmbientBlur,
      ratingModalState,
      setRatingModalState,
      skipTimes,
      setSkipTimes,
      liveSpeed,
      setLiveSpeedFor,
      resetLiveSpeed,
    }),
    [theaterMode, aspectRatio, playerState, userData, autoplay, marked, track, dataMedia, autoNext, ambientLights, ambientBlur, ratingModalState, skipTimes, liveSpeed, setAutoPlay, setAutoNext, setAmbientLights, setAmbientBlur, setLiveSpeedFor, resetLiveSpeed],
  );

  return (
    <WatchPageContext.Provider
      value={value}
    >
      {children}
    </WatchPageContext.Provider>
  );
};

export function useWatchProvider() {
  return useContext(WatchPageContext);
}
