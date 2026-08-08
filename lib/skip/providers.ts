/**
 * Les deux fournisseurs PARTICIPATIFS de timings OP/ED (Anime-Skip, AniSkip).
 *
 * Extrait de `pages/api/v2/skip/[malId]/[episode].ts` — déplacement pur, aucun
 * changement de comportement. Ce fichier avait déjà existé et a disparu avec le
 * revert 88170c1, qui annulait un correctif de MONTAGE et a emporté l'extraction
 * au passage ; `_crosscheck_skip.mjs` est cassé depuis, sans que rien ne le dise.
 *
 * Pourquoi il doit vivre à part : les outils de mesure hors ligne
 * (`tools/opening-detector/_crosscheck_skip.mjs`, `_compare_sources.mjs`)
 * interrogent ces fournisseurs pour se comparer au détecteur. S'ils en gardent
 * leur propre copie, les copies dérivent — et le jour où elles dérivent, la
 * mesure hors ligne cesse de décrire ce que le lecteur reçoit vraiment. La
 * route d'API ne peut pas leur servir de source : elle importe Next, Redis et
 * la base, qui s'exécuteraient à l'import.
 *
 * Aucune dépendance ici en dehors de `fetch` : c'est ce qui rend le fichier
 * compilable seul par `tsc`.
 */

export type Skip = {
  start: number;
  end: number;
  type: "op" | "ed";
  /** Présent uniquement sur les skips issus du détecteur : "audio" | "video" |
   *  "mixed". Permet au lecteur de dégrader l'auto-skip sur un timing plus
   *  grossier (vidéo seule). */
  confidence?: string;
};

const ANIME_SKIP_ENDPOINT = "https://api.anime-skip.com/graphql";
const ANIME_SKIP_CLIENT_ID =
  process.env.ANIME_SKIP_CLIENT_ID ||
  // Client public partagé, à quota limité. Définir ANIME_SKIP_CLIENT_ID dans
  // l'environnement pour un quota dédié.
  "ZGfO0sMF3eCwLYf8yMSCJjlynwNGRXWE";

// Anime-Skip stocke ses timestamps comme des POINTS (chaque marqueur est une
// seconde `at`, pas un intervalle). On mappe leurs noms de type libres vers
// notre vocabulaire op/ed ; tout point dont le type n'est pas ici est traité
// comme une frontière de section qui termine un intervalle op/ed précédent.
const ANIME_SKIP_TYPE: Record<string, "op" | "ed"> = {
  "New Intro": "op",
  Intro: "op",
  Branding: "op",
  "Mixed Intro": "op",
  "New Credits": "ed",
  "New Ending": "ed",
  Ending: "ed",
  "Mixed Credits": "ed",
  "Mixed Ending": "ed",
};

async function gql<T>(query: string, variables: any): Promise<T> {
  const res = await fetch(ANIME_SKIP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-ID": ANIME_SKIP_CLIENT_ID,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`anime-skip ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

export async function fetchFromAnimeSkip(
  aniListId: number,
  episode: number,
): Promise<Skip[]> {
  // 1. AniList id → showId(s) Anime-Skip. Anime-Skip peut avoir PLUSIEURS
  //    shows sous le même id externe (soumissionnaires différents, degrés de
  //    complétude différents). On prenait [0] en dur, ce qui sur Demon Slayer
  //    tombait sur une soumission quasi vide et ratait celle, complète, en
  //    index 1.
  const showRes = await gql<{
    findShowsByExternalId: Array<{ id: string }>;
  }>(
    `query($s: ExternalService!, $id: String!) {
       findShowsByExternalId(service: $s, serviceId: $id) { id }
     }`,
    { s: "ANILIST", id: String(aniListId) },
  );
  const showIds =
    showRes?.findShowsByExternalId?.map((s) => s.id).filter(Boolean) || [];
  if (showIds.length === 0) return [];

  // 2. Récupérer en parallèle la liste d'épisodes de chaque show et fusionner
  //    les candidats pour l'épisode demandé. On garde le candidat qui a le plus
  //    de timestamps op/ed après conversion points→intervalles — c'est la
  //    soumission « la plus utile » pour le lecteur.
  const epLists = await Promise.all(
    showIds.map((id) =>
      gql<{
        findEpisodesByShowId: Array<{
          number: string | null;
          absoluteNumber: string | null;
          timestamps: Array<{ at: number; type: { name: string } }>;
        }>;
      }>(
        `query($id: ID!) {
           findEpisodesByShowId(showId: $id) {
             number absoluteNumber
             timestamps { at type { name } }
           }
         }`,
        { id },
      ).catch(() => null),
    ),
  );

  // Points → intervalles : chaque point op/ed est apparié au point SUIVANT,
  // quel qu'en soit le type, pour en déduire une fin.
  const toSkips = (
    timestamps: Array<{ at: number; type: { name: string } }>,
  ): Skip[] => {
    const sorted = [...timestamps].sort((a, b) => a.at - b.at);
    const out: Skip[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const mapped = ANIME_SKIP_TYPE[cur.type?.name];
      if (!mapped) continue;
      const next = sorted[i + 1];
      if (!next) continue;
      if (next.at - cur.at < 5) continue;
      out.push({
        start: Math.round(cur.at),
        end: Math.round(next.at),
        type: mapped,
      });
    }
    return out;
  };

  let best: Skip[] = [];
  for (const epList of epLists) {
    const episodes = epList?.findEpisodesByShowId || [];
    const ep =
      episodes.find((e) => Number(e.number) === episode) ||
      episodes.find((e) => Number(e.absoluteNumber) === episode);
    if (!ep) continue;
    const candidate = toSkips(ep.timestamps);
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

export async function fetchFromAniSkip(
  malId: number,
  episode: number,
  episodeLength: number,
): Promise<Skip[]> {
  // AniSkip rejette désormais la requête en HTTP 400 quand episodeLength
  // manque (`episodeLength must not be less than 0`). Envoyer 0 reste accepté
  // et désactive simplement leur départage par meilleure soumission — les
  // entrées intro/outro principales reviennent identiques. SkipOverlay
  // n'attend plus la durée du lecteur avant de lancer la requête, donc on met
  // le paramètre à 0 par défaut plutôt que de réintroduire l'attente de 2-3 s.
  const params = new URLSearchParams();
  ["op", "ed"].forEach((t) => params.append("types[]", t));
  params.set("episodeLength", String(Math.max(0, Math.round(episodeLength))));
  const res = await fetch(
    `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?${params}`,
  );
  if (!res.ok) return [];
  const json = await res.json();
  const KEEP = new Set(["op", "ed"]);
  return (json?.results || [])
    .filter((r: any) => KEEP.has(r?.skipType) && r?.interval)
    .map((r: any) => ({
      start: Math.round(r.interval.startTime),
      end: Math.round(r.interval.endTime),
      type: r.skipType as "op" | "ed",
    }))
    .filter(
      (s: Skip) =>
        s.end > s.start && s.end - s.start >= 5 && !(s.type === "ed" && s.start < 3),
    );
}
