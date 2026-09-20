/**
 * Cote navigateur : cet anime a-t-il un doublage francais ?
 *
 * Avec l'ordre de langues « VF d'abord », ouvrir une serie jamais doublee
 * faisait essayer les lecteurs VF l'un apres l'autre, chacun repondant
 * « absent » a son tour — une dizaine de secondes pour apprendre ce que
 * MyDubList sait d'avance.
 *
 * La liste est demandee une fois par session (mise en cache au bord une
 * demi-journee, et ici dans `localStorage` pour la journee). Tant qu'on ne l'a
 * pas, `vfPossible` repond `true` : on ne prive personne d'un lecteur sur une
 * ignorance. Meme regle que `frembedCatalog`.
 *
 * Ce qu'on NE fait pas : retirer les lecteurs VF. Le verdict sert a les
 * RETROGRADER — on n'en ouvre plus un d'emblee, mais les sondes de fond partent
 * quand meme, en dernier. Croisement du 20/09/2026 : MyDubList concorde a 97,8 %
 * avec nos lignes VF constatees. Les ~2 % restants sont des VF non officielles
 * qu'anime-sama heberge malgre tout, et une exclusion franche les rendrait
 * invisibles ET irrecuperables, pour ne gagner que des invocations de sonde.
 *
 * Donnees : MyDubList — https://mydublist.com — CC BY 4.0.
 */

const KEY = "aniscroll:dubCatalog";
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
export function chargeDubCatalog(): void {
  if (typeof window === "undefined" || memo || enVol) return;
  const local = lireStockage();
  if (local) {
    memo = new Set(local.ids);
    return;
  }
  enVol = fetch("/api/v2/dub-catalog?lang=french")
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
export function vfPossible(idMal: number | string | null | undefined): boolean {
  if (idMal == null) return true;
  if (!memo) {
    chargeDubCatalog();
    return true;
  }
  return memo.has(Number(idMal));
}

/**
 * La signature du verdict VF, a joindre a celle des langues dans
 * `aniscroll:earlyPick`. Sans elle, le script du `<head>` rejouerait pour un
 * anime sans VF l'ordre calcule pour un anime qui en a une.
 *
 * `?` quand la liste est encore inconnue : ce n'est ni un oui ni un non, et un
 * ordre memorise dans l'ignorance ne doit pas servir une fois la liste connue.
 */
export function signatureVf(idMal: number | string | null | undefined): string {
  if (idMal == null) return "-";
  if (!memo) return "?";
  return memo.has(Number(idMal)) ? "1" : "0";
}
