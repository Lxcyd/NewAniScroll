/**
 * Classer une galerie d'illustrations par qualité — c'est-à-dire par nombre de
 * pixels — alors que nos trois sources ne disent pas leur résolution de la même
 * façon.
 *
 * LE POINT QUI REND CECI POSSIBLE : chez fanart.tv, le TYPE EST la résolution.
 * Le site impose des dimensions fixes par catégorie, « no exceptions » — un
 * showbackground fait 1920×1080, un tvposter 1000×1426, un tvbanner 1000×185.
 * C'est pourquoi les colonnes `width`/`height` d'`anime_fanarts` sont vides sur
 * les 123 754 lignes de la table (mesuré le 10/09/2026) : elles étaient
 * redondantes. Le tableau ci-dessous les remplace exactement, sans ré-ingérer
 * quoi que ce soit.
 *
 * Les trois sources, donc :
 *
 *   • Wallhaven  — `width`/`height` sont dans la charge utile. EXACT.
 *   • fanart.tv  — déduit du type, par spécification. EXACT.
 *   • TMDB       — déduit du type lui aussi, et là c'est une APPROXIMATION.
 *
 * Ce dernier point mérite d'être dit franchement plutôt que caché derrière le
 * tableau. `lib/tmdb/artworks.ts` jette les dimensions que l'API renvoie, et
 * les récupérer imposerait de bumper la version de son cache — donc de
 * reconstruire trente jours de galeries pour chaque anime déjà visité, ce qui
 * est exactement le profil de charge dont on sort. En attendant, les images
 * TMDB portent des types que ce tableau connaît (`background`, `poster`,
 * `logo`) et héritent donc des dimensions de fanart.tv. Ce n'est pas absurde :
 * un backdrop TMDB fait le plus souvent 1920×1080, comme un showbackground.
 * Mais c'est une supposition, et le jour où les vraies dimensions arrivent,
 * elles l'emporteront d'elles-mêmes — `artPixels` préfère toujours ce qui est
 * déclaré.
 *
 * `UNKNOWN_PIXELS` n'est donc PAS la valeur de TMDB : c'est le dernier recours
 * pour un type qu'aucune source connue n'utilise. Il vaut une valeur médiane —
 * au-dessus des petits formats certains (miniatures, art de personnage), en
 * dessous des grands (fonds d'écran, visuels clés) — pour qu'un type inattendu
 * ne soit ni récompensé ni puni d'être inconnu.
 */

/** Les dimensions imposées par fanart.tv, par type. Voir wiki.fanart.tv. */
const FANART_PIXELS: Record<string, number> = {
  background: 1920 * 1080,
  poster: 1000 * 1426,
  seasonposter: 1000 * 1426,
  thumb: 1000 * 562,
  seasonthumb: 1000 * 562,
  clearart: 1000 * 562,
  banner: 1000 * 185,
  seasonbanner: 1000 * 185,
  disc: 1000 * 1000,
  logo: 800 * 310,
  character: 512 * 512,
};

/* La valeur d'un type qu'on ne connaît pas du tout, cf. la note ci-dessus.
   Entre `thumb` (562 k) et `background` (2,07 M) : ni récompensé, ni puni. */
const UNKNOWN_PIXELS = 1280 * 720;

export type SizedArt = {
  type?: string | null;
  width?: number | null;
  height?: number | null;
};

/**
 * Le nombre de pixels d'une illustration, sur l'échelle unique du tri.
 *
 * Les dimensions déclarées l'emportent toujours sur la déduction par type :
 * une ligne Wallhaven les porte, et elle est alors exacte plutôt
 * qu'approchée.
 */
export function artPixels(a: SizedArt): number {
  const w = Number(a?.width) || 0;
  const h = Number(a?.height) || 0;
  if (w > 0 && h > 0) return w * h;
  const t = a?.type ? String(a.type) : "";
  return FANART_PIXELS[t] ?? UNKNOWN_PIXELS;
}

/**
 * Comparateur de galerie : la résolution d'abord, la popularité ensuite.
 *
 * `likes` NE SERT QU'À DÉPARTAGER, et jamais à classer en premier — les trois
 * sources ne comptent pas la même chose sous ce nom. fanart.tv sert un nombre
 * de votes (0 à 50 et plus), TMDB une note sur 10 arrondie, Wallhaven un
 * décompte de favoris qui monte à plusieurs centaines. Trier une liste fusionnée
 * sur ce champ ne classerait pas par popularité : ça classerait par
 * provenance, et Wallhaven passerait devant tout le reste pour la seule raison
 * qu'il compte plus grand.
 *
 * Le nombre de pixels, lui, veut dire la même chose partout.
 */
export function byQuality(a: SizedArt & { likes?: number }, b: SizedArt & { likes?: number }): number {
  const d = artPixels(b) - artPixels(a);
  if (d !== 0) return d;
  return (Number(b?.likes) || 0) - (Number(a?.likes) || 0);
}
