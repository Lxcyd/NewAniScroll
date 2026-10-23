/**
 * Un petit magasin localStorage indexe par id d'anime, borne en taille.
 *
 * Partage par animeServerPref (le lecteur CHOISI pour une serie) et
 * animeHostMemory (le lecteur qui a REELLEMENT joue) : meme lecture tolerante,
 * meme ecriture best-effort, meme elagage des plus anciennes entrees. Les deux
 * fichiers recopiaient ces trois morceaux a l'identique.
 */

export type KeyedStore<V> = Record<string, V>;

/** Le magasin, ou `{}` cote serveur, en mode prive ou sur JSON illisible. */
export function readStore<V>(key: string): KeyedStore<V> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as KeyedStore<V>) : {};
  } catch {
    return {};
  }
}

export function writeStore<V>(key: string, store: KeyedStore<V>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(store));
  } catch {
    /* best-effort (quota, mode prive) */
  }
}

/**
 * Pose `value` sous `entry` en la plaçant EN DERNIER, puis ne garde que les
 * `max` plus recentes. L'ordre des cles JSON est l'ordre d'insertion : c'est ce
 * qui fait office d'anciennete pour l'elagage.
 */
export function putRecent<V>(
  store: KeyedStore<V>,
  entry: string,
  value: V,
  max: number,
): void {
  delete store[entry];
  store[entry] = value;
  const keys = Object.keys(store);
  for (const old of keys.slice(0, Math.max(0, keys.length - max))) {
    delete store[old];
  }
}
