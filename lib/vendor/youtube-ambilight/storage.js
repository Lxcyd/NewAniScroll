// Remplacement AniScroll : l'original passe par `chrome.storage` (API
// d'extension). Le projecteur WebGL n'y range qu'un drapeau
// (`majorPerformanceCaveatDetected`) : localStorage, prefixe, suffit.
const KEY = (name) => `ytal:${name}`;

export const storage = {
  get: async (name) => {
    try {
      const raw = localStorage.getItem(KEY(name));
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  },
  set: async (name, value) => {
    try {
      if (value === undefined) localStorage.removeItem(KEY(name));
      else localStorage.setItem(KEY(name), JSON.stringify(value));
    } catch {
      /* stockage refuse (navigation privee, quota) */
    }
  },
};
