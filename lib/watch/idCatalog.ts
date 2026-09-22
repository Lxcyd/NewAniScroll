/**
 * Un catalogue d'ids connu du navigateur — la mecanique commune a
 * `dubCatalog` (VF, par id MAL) et `frembedCatalog` (frembed, par id AniList).
 *
 * La liste vient d'une route edge-cachee, se garde 12 h dans localStorage, et
 * `possible(id)` ne repond `false` que si la liste est CONNUE et ne contient pas
 * l'id : on ne prive personne d'un lecteur sur une ignorance. Chaque catalogue
 * garde sa propre memoire (un appel = un catalogue).
 */

const TTL_MS = 12 * 3600_000;

type Store = { ids: number[]; at: number };

export function idCatalog(storageKey: string, url: string) {
  let memo: Set<number> | null = null;
  let enVol: Promise<void> | null = null;

  function lireStockage(): Store | null {
    try {
      const raw = localStorage.getItem(storageKey);
      const p = raw ? (JSON.parse(raw) as Store) : null;
      if (!p || !Array.isArray(p.ids)) return null;
      if (Date.now() - (p.at || 0) > TTL_MS) return null;
      return p;
    } catch {
      return null;
    }
  }

  /** Charge la liste si besoin. A appeler au repos, jamais dans un chemin bloquant. */
  function charge(): void {
    if (typeof window === "undefined" || memo || enVol) return;
    const local = lireStockage();
    if (local) {
      memo = new Set(local.ids);
      return;
    }
    enVol = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j?.known || !Array.isArray(j.ids)) return;
        memo = new Set(j.ids.map(Number));
        try {
          localStorage.setItem(storageKey, JSON.stringify({ ids: j.ids, at: Date.now() }));
        } catch {
          /* stockage plein ou mode prive : on garde la liste en memoire */
        }
      })
      .catch(() => {})
      .finally(() => {
        enVol = null;
      });
  }

  /** `false` seulement si la liste est connue ET ne contient pas cet id. */
  function possible(id: number | string | null | undefined): boolean {
    if (id == null) return true;
    if (!memo) {
      charge();
      return true;
    }
    return memo.has(Number(id));
  }

  return { charge, possible };
}
