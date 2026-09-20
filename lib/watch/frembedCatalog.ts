/**
 * Cote navigateur : frembed peut-il avoir cet anime ?
 *
 * Frembed est le lecteur le plus rapide du site (CDN direct, ~100 ms) et il est
 * classe premier — mais son catalogue ne compte que quelques centaines de
 * fiches. Pour tout le reste, on le choisissait quand meme, on attendait son
 * « absent », puis on basculait : un aller-retour et un chip qui clignote,
 * a chaque ouverture, sur l'immense majorite des series.
 *
 * La liste est demandee une fois par session (mise en cache au bord une
 * demi-journee, et ici dans `localStorage` pour la journee). Tant qu'on ne l'a
 * pas, `frembedPossible` repond `true` : on ne prive personne d'un lecteur sur
 * une ignorance.
 */

const KEY = "aniscroll:frembedCatalog";
const TTL_MS = 12 * 3600_000;

type Store = { ids: number[]; at: number };

let memo: Set<number> | null = null;
let enVol: Promise<void> | null = null;

function lireStockage(): Store | null {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Store) : null;
    if (!p || !Array.isArray(p.ids)) return null;
    if (Date.now() - (p.at || 0) > TTL_MS) return null;
    return p;
  } catch {
    return null;
  }
}

/** Charge la liste si besoin. A appeler au repos, jamais dans un chemin bloquant. */
export function chargeFrembedCatalog(): void {
  if (typeof window === "undefined" || memo || enVol) return;
  const local = lireStockage();
  if (local) {
    memo = new Set(local.ids);
    return;
  }
  enVol = fetch("/api/v2/frembed-catalog")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j?.known || !Array.isArray(j.ids)) return;
      memo = new Set(j.ids.map(Number));
      try {
        localStorage.setItem(KEY, JSON.stringify({ ids: j.ids, at: Date.now() }));
      } catch {
        /* stockage plein ou mode prive : on garde la liste en memoire */
      }
    })
    .catch(() => {})
    .finally(() => {
      enVol = null;
    });
}

/** `false` seulement si la liste est connue ET ne contient pas cet anime. */
export function frembedPossible(aniId: number | string | null | undefined): boolean {
  if (aniId == null) return true;
  if (!memo) {
    chargeFrembedCatalog();
    return true;
  }
  return memo.has(Number(aniId));
}

/** Les ids frembed a ecarter d'une liste de candidats pour cet anime. */
export function sansFrembed(servers: string[], aniId: number | string): string[] {
  if (frembedPossible(aniId)) return servers;
  return servers.filter((id) => !/^frembed/.test(id));
}
