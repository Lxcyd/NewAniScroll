/**
 * Per-episode stills from TMDB — a strict COMPLEMENT to ani.zip, never a
 * rival.
 *
 * Read lib/anizip/episodes.ts first: ani.zip is keyed on the AniList id
 * itself, so it needs no season inference — that is why it leads the chain.
 * TMDB holds a key here for series artwork anyway (backdrops, logos —
 * lib/tmdb/animeImages.ts), and the marginal cost of asking it for the
 * episodes ani.zip could not cover is one request.
 *
 * (Simkl occupied this middle place jusqu'au 22/08/2026. Il est retire ; le
 * raisonnement ci-dessous vaut mot pour mot avec ani.zip a sa place.)
 *
 * THE RULE, jusqu'au 28/08/2026 : TMDB ne pouvait ecrire que dans les numeros
 * d'episode qu'ani.zip avait laisses VIDES. Elle a saute pour les images — voir
 * `fillStillGaps`, TMDB passe devant, il est de meilleure definition et il
 * CHOISIT parmi plusieurs stills quand ani.zip n'en a qu'un. Elle tient
 * toujours pour les TITRES : TMDB n'en fournit aucun.
 *
 * WHY THIS ISN'T THE OLD CODE. The removed implementation was the sole
 * provider and had to prove its mapping, so it demanded an exact
 * episode-count equality and refused on every airing show and every split
 * cour. Here the floor is a lower bound (TMDB must know AT LEAST as many
 * episodes as we display). Ce plancher etait un confort tant que TMDB ne
 * comblait que les trous ; depuis qu'il passe devant, c'est lui — avec le garde
 * de coherence Fribb — qui empeche une image fausse, alors verifier avant de
 * l'assouplir.
 *
 * WHAT WE STILL REFUSE. Fribb's `season.tmdb` is its weakest field — it
 * collides and fuses (Bungo Stray Dogs: 1,1,2,3,3) and is null on long sagas
 * (One Piece, Naruto). No season, no fill.
 *
 * The floor check alone is NOT enough to catch a fusion, which is why
 * `isFribbGroupConsistent()` is consulted too. Measured on the live API
 * (2026-08-08): TMDB's Jujutsu Kaisen season 1 holds **59** episodes — it has
 * S1 and S2 fused into one. AniList's S2 entry maps to that same season, so a
 * naive fill would take TMDB episodes 1-23 (which are S1's) and paste them onto
 * S2's rows: a "more episodes than we display" pass, and every single image
 * wrong. That is precisely the undercut case the guard detects (fewer distinct
 * TMDB seasons than TV-like entries in the franchise). It costs one extra Turso
 * read and buys the difference between a missing image and a lying one.
 *
 * Fail-soft throughout; nothing throws.
 */

import {
  getCachedStills,
  setCachedStills,
  type StillsCacheValue,
} from "@/lib/db/tmdbStillsCache";
import {
  getFribbEntry,
  getFribbFranchise,
  isFribbGroupConsistent,
} from "@/lib/fribb/fribbMap";
import { getSeasonEpisodes, tmdbEnabled, tmdbImageUrl } from "./client";

/** episode number → still URL. */
export type TmdbStills = Record<number, string>;

const EMPTY: TmdbStills = {};

/* Les tuiles font ~200 px de large, mais un ecran HiDPI en reclame le double et
   `images.unoptimized: true` (next.config.js) fait que cette URL est exactement
   ce que le navigateur telecharge — pas de redimensionnement en amont, voir
   lib/images/cover.ts. w300 laissait donc une vignette floue sur un ecran
   moderne. w780 la couvre, et coute MOINS cher que ce qu'on servait avant : 59 ko
   contre les 138 ko de la screencap TVDB d'ani.zip, mesure sur Cyberpunk ep1. */
const STILL_SIZE = "w780" as const;

type Reason =
  | "ok"
  | "no-key"
  | "no-fribb"
  | "no-tmdb-id"
  | "no-season"
  | "fribb-inconsistent"
  | "unknown-episode-count"
  | "too-few-episodes"
  | "no-images"
  | "tmdb-error";

/**
 * Stills for `anilistId`, for the episodes in `wanted`.
 *
 * `wanted` is the set of episode numbers still missing an image after ani.zip
 * — pass it so a title ani.zip covered fully costs nothing at all.
 */
export async function getTmdbEpisodeStills(
  anilistId: number,
  displayedEpisodes: number | null,
  wanted: Set<number>,
): Promise<TmdbStills> {
  if (!tmdbEnabled()) return EMPTY;
  if (wanted.size === 0) return EMPTY;

  /* Cle `tmdbStills:v2:` depuis le 28/08/2026 — les URL stockees portent la
     taille, voir lib/db/tmdbStillsCache.ts. */
  const cached = await getCachedStills(anilistId, "tmdb");
  if (cached) return cached.stills ?? {};

  const refuse = async (
    reason: Reason,
    tvId: number | null = null,
    season: number | null = null,
  ): Promise<TmdbStills> => {
    // A transient failure must not be cached as "no stills" for a day.
    if (reason !== "tmdb-error") {
      const value: StillsCacheValue = { stills: {}, reason, tvId, season };
      await setCachedStills(anilistId, value, "tmdb");
    }
    // warn, not info: Vercel's log stream drops console.info, and "this title
    // shows placeholder tiles" is the symptom we get asked about.
    console.warn(`[tmdb-stills] ${anilistId}: no stills (${reason})`);
    return EMPTY;
  };

  if (!displayedEpisodes || displayedEpisodes <= 0) {
    return refuse("unknown-episode-count");
  }

  const entry = await getFribbEntry(anilistId);
  if (!entry) return await refuse("no-fribb");
  if (!entry.tmdbTvId) return await refuse("no-tmdb-id");
  if (entry.tmdbSeason == null) {
    return await refuse("no-season", entry.tmdbTvId);
  }

  /* Fusion guard — see the header. Without it, a franchise TMDB merged into one
     season hands every sequel entry the FIRST season's frames, and the floor
     check below waves it through because a fused season is longer, not shorter.
     Wrong images are worse than no images, so an inconsistent group refuses. */
  const franchise = await getFribbFranchise(entry.tmdbTvId);
  if (franchise.length > 1 && !isFribbGroupConsistent(franchise)) {
    return await refuse("fribb-inconsistent", entry.tmdbTvId, entry.tmdbSeason);
  }

  const episodes = await getSeasonEpisodes(entry.tmdbTvId, entry.tmdbSeason);
  // null is a failed request or a 404 on the season, not "no stills".
  if (!episodes) {
    return await refuse("tmdb-error", entry.tmdbTvId, entry.tmdbSeason);
  }

  /* A floor, not the old exact equality: a provider that knows
     MORE episodes than we display is normal (it runs ahead on airing shows);
     one that knows FEWER is a suspect mapping — most often Fribb pointing at a
     fused or renumbered season. */
  if (episodes.length < displayedEpisodes) {
    return await refuse("too-few-episodes", entry.tmdbTvId, entry.tmdbSeason);
  }

  const stills: TmdbStills = {};
  for (const ep of episodes) {
    const n = Number(ep.episode_number);
    if (!Number.isFinite(n) || n < 1 || n > displayedEpisodes) continue;
    const url = tmdbImageUrl(ep.still_path, STILL_SIZE);
    if (url) stills[n] = url;
  }

  if (Object.keys(stills).length === 0) {
    return await refuse("no-images", entry.tmdbTvId, entry.tmdbSeason);
  }

  /* Cache the WHOLE season, not just the `wanted` subset. `wanted` varies with
     what ani.zip happened to return on this particular request; caching the
     intersection would make the row depend on another provider's transient
     state, and a later request wanting a different episode would get a false
     "no". Filtering to `wanted` is the caller's job, below. */
  await setCachedStills(
    anilistId,
    {
      stills,
      reason: "ok",
      tvId: entry.tmdbTvId,
      season: entry.tmdbSeason,
    },
    "tmdb",
  );
  console.warn(
    `[tmdb-stills] ${anilistId}: ${Object.keys(stills).length}/${displayedEpisodes} ` +
      `stills (tmdb ${entry.tmdbTvId} s${entry.tmdbSeason})`,
  );
  return stills;
}

/* Le POSTER du lecteur occupe toute la largeur (~1300 px) la ou la tuile en
   fait 200 : on ne sert pas la meme taille aux deux endroits, et on ne fait pas
   payer du 1920 a une liste de dix tuiles. Mesure du 26/08/2026 sur Cyberpunk
   ep1 — ani.zip 640x360 (screencap TVDB, sa taille native, il n'a rien de plus),
   TMDB original 1920x1080. */
const HD_FROM_W300 = new RegExp(`/${STILL_SIZE}/`);

/** L'URL pleine definition d'un still TMDB deja resolu, ou null si ce n'en est
 *  pas un. Pur travail de chaine : `tmdbImageUrl` ne fait que concatener la
 *  taille au chemin, donc l'echange est sur — et surtout il ne coute AUCUNE
 *  requete de plus. Une URL ani.zip (artworks.thetvdb.com) n'a pas de variante
 *  plus grande et ressort telle quelle en null. */
export function hdStillUrl(url: string | null | undefined): string | null {
  if (!url || !HD_FROM_W300.test(url)) return null;
  return url.replace(HD_FROM_W300, "/original/");
}

/**
 * Les stills d'ani.zip, ceux de TMDB par-dessus quand il en a un.
 *
 * TMDB PASSE DEVANT, ce qui renverse la regle d'origine (« il ne comble que les
 * trous ») pour deux raisons mesurees le 28/08/2026 :
 *
 *  - la QUALITE. ani.zip sert la screencap TVDB, native 640x360 et rien
 *    au-dessus ; TMDB sert du 1920x1080. Sur une tuile HiDPI et surtout sur le
 *    poster du lecteur, l'ecart se voit.
 *  - le CHOIX. TMDB tient plusieurs images par episode et publie celle que ses
 *    votes designent (`still_path` — c'est la meme selection que lib/tmdb/pick.ts
 *    applique aux backdrops de serie, faite chez eux plutot que chez nous, donc
 *    sans une requete par episode). Cyberpunk ep2 : cinq stills, TMDB retient un
 *    1920x1080 vote 3,3. ani.zip ne choisit rien, il n'a qu'une image.
 *
 * Cela reglait aussi une incoherence : `img` venait d'ani.zip et `imgHd` de
 * TMDB, donc la tuile et le poster du lecteur montraient DEUX images
 * differentes du meme episode (verifie sur Cyberpunk ep2 : voiture en tuile,
 * Terre en poster).
 *
 * Le risque assume est celui que la regle d'origine ecartait : une saison mal
 * mappee ne laisse plus un trou, elle remplace une image juste par une fausse.
 * Ce sont les deux gardes de `getTmdbEpisodeStills` — coherence du groupe Fribb
 * et plancher sur le nombre d'episodes — qui portent desormais seules cette
 * charge.
 */
export async function fillStillGaps(
  anilistId: number,
  displayedEpisodes: number | null,
  baseStills: Record<number, string>,
): Promise<{ stills: Record<number, string>; hd: Record<number, string> }> {
  if (!tmdbEnabled() || !displayedEpisodes || displayedEpisodes <= 0) {
    return { stills: baseStills, hd: {} };
  }

  /* Toute la saison, pas seulement les trous : c'est la meme requete, et
     `getTmdbEpisodeStills` met la saison ENTIERE en cache — la reponse de la
     liste d'episodes est elle-meme cachee 30 jours. */
  const all = new Set<number>();
  for (let n = 1; n <= displayedEpisodes; n++) all.add(n);
  if (all.size === 0) return { stills: baseStills, hd: {} };

  const tmdb = await getTmdbEpisodeStills(anilistId, displayedEpisodes, all).catch(
    () => EMPTY,
  );

  // forEach, not for..of: tsconfig targets ES5 without downlevelIteration, so
  // iterating a Set directly doesn't compile.
  const merged = { ...baseStills };
  const hd: Record<number, string> = {};
  all.forEach((n) => {
    if (!tmdb[n]) return; // ani.zip garde la ligne : mieux vaut son image que rien
    merged[n] = tmdb[n];
    const big = hdStillUrl(tmdb[n]);
    if (big) hd[n] = big;
  });
  return { stills: merged, hd };
}
