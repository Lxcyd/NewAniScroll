import { norm } from "@/lib/music/deezer";

/**
 * LA CLÉ D'UN TITRE DE MORCEAU, pour reconnaître le même morceau d'une source
 * à l'autre (24/10/2026). AnimeThemes écrit « WATSON - FEAT. OSLO GREEN » et
 * « 10:15 SATURDAY NIGHT (REMASTERED 2020) », AniPlaylist « Watson » et
 * « 10:15 Saturday Night » : sans parenthèses, crochets ni « feat. », le titre
 * nu est le même.
 */
export function titleKey(t: string | null | undefined): string {
  const bare = String(t ?? "")
    .replace(/[(\[（【][^)\]）】]*[)\]）】]/g, " ")
    .split(/\s+-\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0];
  return norm(bare) || norm(String(t ?? ""));
}

/** Le même morceau ? Clés égales, ou l'une commence l'autre, à partir de 6
    caractères (sous ce seuil, « Hero » commencerait « Heroine »). */
export function sameTitle(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 6 && l.startsWith(s);
}
