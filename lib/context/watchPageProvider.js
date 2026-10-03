import React, { createContext, useContext, useState } from "react";

export const WatchPageContext = createContext();

/** Flou minimal des ambient lights. */
export const AMBIENT_BLUR_MIN = 5;
/** Flou par defaut : celui de l'extension (leur `blur2`). */
export const AMBIENT_BLUR_DEFAULT = 30;

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
  const setAutoPlay = (v) => {
    const bool = v === true || v === "true";
    setAutoPlayState(bool);
    if (typeof window !== "undefined") {
      localStorage.setItem("autoplay", String(bool));
    }
  };
  const setAutoNext = (v) => {
    const bool = v === true || v === "true";
    setAutoNextState(bool);
    if (typeof window !== "undefined") {
      localStorage.setItem("autoNext", String(bool));
    }
  };
  const setAmbientLights = (v) => {
    const bool = v === true || v === "true";
    setAmbientLightsState(bool);
    if (typeof window !== "undefined") {
      localStorage.setItem("ambient_lights", String(bool));
    }
  };
  // Flou des ambient lights, sur l'echelle de l'extension « Ambient light for
  // YouTube » dont le rendu est porte : 5-100. Minimum 5 : sans flou du tout,
  // la copie agrandie hors du lecteur se lit comme une seconde image. Defaut
  // 30, le leur : a 5, le projecteur agrandi ×2,8 garde le detail de l'image
  // (etoiles, arcs nets) la ou YouTube montre un halo lisse (03/10, captures
  // cote a cote).
  // Saved as `ambient_blur:v4` — v4 le 03/10, pour que le 5 enregistre par
  // l'ancien defaut ne masque pas le nouveau.
  const [ambientBlur, setAmbientBlurState] = useState(() => {
    if (typeof window === "undefined") return AMBIENT_BLUR_DEFAULT;
    const raw = localStorage.getItem("ambient_blur:v4");
    const v = Number(raw);
    return raw === null || !Number.isFinite(v)
      ? AMBIENT_BLUR_DEFAULT
      : Math.min(100, Math.max(AMBIENT_BLUR_MIN, v));
  });
  const setAmbientBlur = (v) => {
    const n = Math.min(
      100,
      Math.max(AMBIENT_BLUR_MIN, Math.round(Number(v) || 0)),
    );
    setAmbientBlurState(n);
    if (typeof window !== "undefined") {
      localStorage.setItem("ambient_blur:v4", String(n));
    }
  };
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
  const setLiveSpeedFor = (serverId, tier) => {
    if (!serverId || !tier) return;
    setLiveSpeedState((prev) =>
      prev[serverId] === tier ? prev : { ...prev, [serverId]: tier },
    );
  };
  const resetLiveSpeed = () => setLiveSpeedState({});

  return (
    <WatchPageContext.Provider
      value={{
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
      }}
    >
      {children}
    </WatchPageContext.Provider>
  );
};

export function useWatchProvider() {
  return useContext(WatchPageContext);
}
