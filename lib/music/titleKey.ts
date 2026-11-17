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

/** Distance d'édition (Levenshtein), sur des clés déjà normalisées. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const artistKey = (a: string) => norm(a).replace(/\s+/g, "");

/**
 * Le même morceau, écrit dans deux ROMANISATIONS (17/11/2026). AnisongDB et
 * AniPlaylist ne transcrivent pas le japonais pareil : Chainsaw Man listait
 * « Chu, Tayousei. » ET « Chu, Taiyousei. », « Hawatari 2-oku Centi » ET
 * « Hawatari Nioku Centi » ; Frieren « Haru » ET « Hareru » (晴る, Yorushika).
 * sameTitle ne peut pas les voir : ce ne sont ni des égalités ni des préfixes.
 *
 * Une distance d'édition SEULE confondrait deux morceaux courts différents ;
 * elle n'est donc admise qu'entre deux morceaux d'un MÊME ARTISTE (et du même
 * type, à la charge de l'appelant). Seuil : 2 lettres, ou 15 % du plus long.
 */
export function sameSong(
  a: { title: string | null | undefined; artists: string[] },
  b: { title: string | null | undefined; artists: string[] },
): boolean {
  const ka = titleKey(a.title);
  const kb = titleKey(b.title);
  if (sameTitle(ka, kb)) return true;
  if (!ka || !kb || Math.min(ka.length, kb.length) < 4) return false;
  const artists = new Set(a.artists.map(artistKey).filter(Boolean));
  if (!b.artists.some((x) => artists.has(artistKey(x)))) return false;
  const ca = ka.replace(/\s+/g, "");
  const cb = kb.replace(/\s+/g, "");
  return distance(ca, cb) <= Math.max(2, Math.floor(Math.max(ca.length, cb.length) * 0.15));
}
