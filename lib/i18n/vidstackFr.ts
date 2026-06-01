/**
 * French translations for Vidstack's DefaultVideoLayout. Vidstack ships its
 * control chrome (Settings menu: Speed, Quality, Captions, Audio…) in English
 * and exposes a `translations` prop keyed by the English label. We only
 * override the strings the user actually sees in our layout; anything not
 * listed falls back to Vidstack's English default.
 *
 * Passed to <DefaultVideoLayout translations={...}> only when the active UI
 * language is French.
 */
export const VIDSTACK_FR: Record<string, string> = {
  Speed: "Vitesse",
  Normal: "Normale",
  Quality: "Qualité",
  Auto: "Auto",
  Settings: "Paramètres",
  Captions: "Sous-titres",
  Audio: "Audio",
  Default: "Par défaut",
  Off: "Désactivé",
  Play: "Lecture",
  Pause: "Pause",
  Mute: "Couper le son",
  Unmute: "Activer le son",
  "Closed-Captions On": "Sous-titres activés",
  "Closed-Captions Off": "Sous-titres désactivés",
  "Enter Fullscreen": "Plein écran",
  "Exit Fullscreen": "Quitter le plein écran",
  "Enter PiP": "Incrustation d'image",
  "Exit PiP": "Quitter l'incrustation",
  Seek: "Avancer",
  Volume: "Volume",
  "Skip To Live": "Aller au direct",
  LIVE: "DIRECT",
  Continue: "Continuer",
  Replay: "Revoir",
  Chapters: "Chapitres",
  Accessibility: "Accessibilité",
  "Keyboard Animations": "Animations clavier",
  "Seek Backward": "Reculer",
  "Seek Forward": "Avancer",
  "Google Cast": "Google Cast",
  AirPlay: "AirPlay",
  Download: "Télécharger",
};
