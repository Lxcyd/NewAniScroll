/**
 * Kana → romaji, juste assez pour COMPARER un titre AnimeThemes (romaji :
 * « Torikago ») à un titre du catalogue japonais d'Apple Music (« トリカゴ »).
 * Pas une translittération exacte : les kanji restent tels quels, et
 * `phonetic` gomme ce que la lecture katakana déforme (« Darling » se lit
 * ダーリン, « daarin »). Utilisé par /api/v2/theme-covers.
 */
const TABLE =
  "あa いi うu えe おo かka きki くku けke こko さsa しshi すsu せse そso たta ちchi つtsu てte とto " +
  "なna にni ぬnu ねne のno はha ひhi ふfu へhe ほho まma みmi むmu めme もmo やya ゆyu よyo " +
  "らra りri るru れre ろro わwa をwo んn がga ぎgi ぐgu げge ごgo ざza じji ずzu ぜze ぞzo " +
  "だda ぢji づzu でde どdo ばba びbi ぶbu べbe ぼbo ぱpa ぴpi ぷpu ぺpe ぽpo ゔvu ぁa ぃi ぅu ぇe ぉo";
const MAP: Record<string, string> = Object.fromEntries(TABLE.split(" ").map((p) => [p[0], p.slice(1)]));
const YOON: Record<string, string> = { ゃ: "ya", ゅ: "yu", ょ: "yo" };

export function kanaToRomaji(s: string): string {
  /* Katakana → hiragana : même table pour les deux. */
  const h = s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  let out = "";
  let double = false;
  for (const c of h) {
    if (c === "っ") {
      double = true;
      continue;
    }
    if (c === "ー") {
      out += out.slice(-1);
      continue;
    }
    if (YOON[c] && out.endsWith("i")) {
      /* きゃ → kya, しゃ → sha, ちゃ → cha, じゃ → ja. */
      out = out.slice(0, -1);
      out += /(sh|ch|j)$/.test(out) ? YOON[c].slice(1) : YOON[c];
      continue;
    }
    let r = MAP[c] ?? c;
    if (double && MAP[c]) r = r[0] + r;
    double = false;
    out += r;
  }
  return out;
}

/** Clé de comparaison lâche : l/r confondus, lettres doublées fusionnées,
 *  « ng » final lu « n ». */
export const phonetic = (s: string) =>
  s.replace(/l/g, "r").replace(/([a-z])\1+/g, "$1").replace(/ng(?![a-z])/g, "n");
