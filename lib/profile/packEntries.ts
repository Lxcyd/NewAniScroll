/**
 * Les entrees du profil, COMPACTEES pour le voyage serveur -> page (25/11/2026,
 * passe vitesse).
 *
 * Mesure sur un profil de 693 animes : 694 Ko d'entrees dans le HTML, dont
 * allTags 178 Ko, tags 69, studios 54, genres 26 — les MEMES chaines repetees
 * des centaines de fois — et 60 Ko de couvertures au prefixe identique. Le
 * navigateur devait lire et analyser tout ca avant d'afficher la page (TBT
 * mobile 2 s), et la page n'est jamais en cache (privee).
 *
 * Un DICTIONNAIRE : chaque chaine de ces champs une seule fois, les entrees n'en
 * gardent que l'indice ; le prefixe des couvertures AniList saute. `unpackEntries`
 * rend des entrees IDENTIQUES a l'original (verifie a l'aller-retour) : aucun
 * composant ne voit la difference.
 */

import type { ProfileEntry } from "./types";

/** Les champs listes de chaines repetees, et le champ chaine seule. */
const LISTES = ["allTags", "tags", "genres", "studios"] as const;
const SEULS = ["studio"] as const;
const COUV = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/";

export type PackedEntries = {
  /** Version du format : une page en cache d'une autre version decode encore. */
  v: 1;
  d: string[];
  e: Record<string, unknown>[];
};

export function packEntries(entries: ProfileEntry[]): PackedEntries {
  // Les plus frequentes d'abord : leurs indices sont les plus courts.
  const freq = new Map<string, number>();
  const compte = (s: unknown) => {
    if (typeof s === "string") freq.set(s, (freq.get(s) || 0) + 1);
  };
  for (const e of entries as any[]) {
    for (const k of LISTES) if (Array.isArray(e[k])) e[k].forEach(compte);
    for (const k of SEULS) compte(e[k]);
  }
  const d = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const idx = new Map(d.map((s, i) => [s, i]));
  const e = (entries as any[]).map((x) => {
    const o: Record<string, unknown> = { ...x };
    for (const k of LISTES) {
      const v = x[k];
      // Une liste qui contiendrait autre chose que des chaines reste telle quelle.
      if (Array.isArray(v) && v.every((s) => typeof s === "string")) o[k] = v.map((s: string) => idx.get(s)!);
    }
    for (const k of SEULS) if (typeof x[k] === "string") o[k] = idx.get(x[k])!;
    if (typeof x.cover === "string" && x.cover.startsWith(COUV)) o.cover = "~" + x.cover.slice(COUV.length);
    return o;
  });
  return { v: 1, d, e };
}

export function unpackEntries(p: PackedEntries | ProfileEntry[] | null | undefined): ProfileEntry[] {
  if (!p) return [];
  if (Array.isArray(p)) return p; // ancienne forme : deja des entrees
  const { d, e } = p;
  return e.map((x: any) => {
    const o: any = { ...x };
    for (const k of LISTES) {
      const v = x[k];
      if (Array.isArray(v) && v.every((i) => typeof i === "number")) o[k] = v.map((i: number) => d[i]);
    }
    for (const k of SEULS) if (typeof x[k] === "number") o[k] = d[x[k]];
    if (typeof x.cover === "string" && x.cover.startsWith("~")) o.cover = COUV + x.cover.slice(1);
    return o as ProfileEntry;
  });
}
