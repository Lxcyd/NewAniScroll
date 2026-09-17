/**
 * Le rattrapage des métadonnées d'œuvre, contre AniList.
 *
 * ── LE PROBLÈME ──────────────────────────────────────────────────────────────
 * Les familles Genres, Découverte et Franchises ont besoin du genre, de
 * l'année, du studio, du format, de la popularité et des relations de chaque
 * titre terminé. La liste locale ne les porte pas : elle a été écrite pour
 * afficher « Ma liste » hors ligne, pas pour juger des badges. À partir de
 * maintenant, trois sources les remplissent au fil de l'eau — la synchro
 * AniList (même requête, plus de champs), la page anime et la page de lecture
 * (la donnée est déjà à l'écran). Reste le passé : une liste de huit cents
 * titres déjà constituée n'a rien de tout ça.
 *
 * ── POURQUOI ÇA NE COÛTE RIEN AU SITE ────────────────────────────────────────
 * Cette passe tape `graphql.anilist.co` DIRECTEMENT depuis le navigateur du
 * visiteur. Elle ne traverse ni Vercel, ni Upstash, ni Turso : ce n'est pas
 * notre quota qui la paie. C'est la seule raison pour laquelle on peut se le
 * permettre, et c'est pourquoi elle ne passe surtout pas par une route à nous.
 *
 * ── ET POURQUOI ELLE NE PART PAS TOUTE SEULE ─────────────────────────────────
 * Elle se déclenche à l'ouverture de l'onglet Badges, jamais au chargement du
 * site : personne ne doit payer — en requêtes comme en batterie — pour une
 * fonctionnalité qu'il n'ouvre pas. Une fois faite, un drapeau l'éteint.
 *
 * ── LA LEÇON DU 02/09 ────────────────────────────────────────────────────────
 * `devlog/comptes.md` : une source externe en panne ne répond pas toujours une
 * erreur, elle répond parfois 200 avec une collection vide — et ce jour-là ce
 * vide a été écrit par-dessus la liste de tout le monde. Ici, un lot qui rend
 * zéro média n'écrit RIEN et laisse le drapeau baissé pour retenter plus tard.
 * La question n'est pas « et si l'appel échoue ? » mais « et s'il réussit en ne
 * rapportant rien ? ».
 */

import { getLocalList, patchLocalEntries } from "../list/localList";

const API = "https://graphql.anilist.co/";
const VOCAB_KEY = "aniscroll:badgeVocab";
const DONE_KEY = "aniscroll:badgeMetaDone";

/** AniList plafonne à 90 requêtes/minute, et ce n'est pas notre serveur. */
const PAGE_SIZE = 50;
const PAUSE_MS = 1200;

export type Vocab = { genres: string[]; tags: string[]; at: number };

/**
 * Le vocabulaire du catalogue — tous les genres et tous les tags qui existent.
 *
 * C'est la CIBLE de « Tous les genres » et « Tous les tags » : sans lui, ces
 * deux badges n'ont pas d'objectif et restent « pas encore mesurables » plutôt
 * que de se comparer à une liste inventée.
 */
export function readVocab(): { genres: string[]; tags: string[] } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VOCAB_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Vocab;
    if (!Array.isArray(v?.genres) || !v.genres.length) return null;
    return { genres: v.genres, tags: Array.isArray(v.tags) ? v.tags : [] };
  } catch {
    return null;
  }
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.errors) return null;
    return (json?.data ?? null) as T | null;
  } catch {
    return null;
  }
}

const VOCAB_QUERY = `query { GenreCollection MediaTagCollection { name isAdult } }`;

async function fetchVocab(): Promise<boolean> {
  const data = await gql<{ GenreCollection: string[]; MediaTagCollection: { name: string; isAdult: boolean }[] }>(
    VOCAB_QUERY,
  );
  const genres = (data?.GenreCollection ?? []).filter((g) => g && g !== "Hentai");
  /* Les tags adultes sont écartés : le site masque ce catalogue, et un badge
     « tous les tags » qui exigerait d'en terminer un serait inatteignable ici. */
  const tags = (data?.MediaTagCollection ?? []).filter((t) => t && !t.isAdult).map((t) => t.name);
  if (!genres.length) return false; // 200 vide → on n'écrit rien (cf. l'en-tête)
  try {
    window.localStorage.setItem(
      VOCAB_KEY,
      JSON.stringify({ genres, tags, at: Date.now() } satisfies Vocab),
    );
  } catch {
    /* best-effort */
  }
  return true;
}

const MEDIA_QUERY = `query ($ids: [Int]) {
  Page(perPage: ${PAGE_SIZE}) {
    media(id_in: $ids, type: ANIME) {
      id
      format
      status
      popularity
      duration
      seasonYear
      startDate { year }
      genres
      tags { name isAdult }
      studios(isMain: true) { nodes { name } }
      relations { edges { relationType node { id type } } }
    }
  }
}`;

type MediaRow = {
  id: number;
  format: string | null;
  status: string | null;
  popularity: number | null;
  duration: number | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  genres: string[] | null;
  tags: { name: string; isAdult: boolean }[] | null;
  studios: { nodes: { name: string }[] } | null;
  relations: { edges: { relationType: string; node: { id: number; type: string } }[] } | null;
};

/**
 * Les relations qui font une FRANCHISE.
 *
 * Volontairement restreint : une suite, une préquelle, une histoire parallèle,
 * une version alternative. `CHARACTER` relierait deux séries qui partagent un
 * figurant, et `OTHER` relie à peu près n'importe quoi — les inclure ferait de
 * la moitié du catalogue une seule « franchise » et donnerait « Grande saga » à
 * qui n'a rien bouclé.
 */
const FRANCHISE_RELATIONS = new Set([
  "SEQUEL", "PREQUEL", "SIDE_STORY", "PARENT", "ALTERNATIVE", "SPIN_OFF",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Les titres de la liste à qui il manque encore les métadonnées. */
function missingIds(): number[] {
  const list = getLocalList();
  return Object.values(list)
    .filter((e) => e.genres === undefined)
    .map((e) => e.mediaId)
    .filter((id) => Number.isFinite(id));
}

let running: Promise<void> | null = null;

/**
 * Lance le rattrapage, au plus une fois.
 *
 * Idempotent et ré-entrant : deux onglets qui ouvrent l'onglet Badges en même
 * temps ne lancent pas deux passes, et une passe déjà faite ne recommence pas.
 * `force` sert au bouton « réessayer » quand AniList était en panne.
 */
export function backfillMetadata(opts?: { force?: boolean }): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (running) return running;

  const done = (() => {
    try {
      return window.localStorage.getItem(DONE_KEY) === "1";
    } catch {
      return false;
    }
  })();
  if (done && !opts?.force && readVocab()) return Promise.resolve();

  /* CE QUE CE MODULE NE FAIT PAS : decider du silence.
     Ce rattrapage rend mesurables, d'un seul coup, les familles Genres et
     Decouverte pour une liste entiere — donc il merite des dizaines de badges a
     la fois, et les annoncer deroulerait quarante notifications d'affilee pour
     des anime termines il y a deux ans. Mais c'est a l'APPELANT de le taire :
     lui seul sait pourquoi il lance la passe. L'onglet Badges l'entoure d'une
     portee silencieuse (cf. beginQuiet/endQuiet dans lib/badges/evaluate.ts).
     Le faire ici creerait un cycle d'imports entre les deux modules pour une
     decision qui n'appartient pas a celui-ci. */
  running = (async () => {
    const vocabOk = readVocab() ? true : await fetchVocab();

    const ids = missingIds();
    let complete = true;
    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      const batch = ids.slice(i, i + PAGE_SIZE);
      const data = await gql<{ Page: { media: MediaRow[] } }>(MEDIA_QUERY, { ids: batch });
      const media = data?.Page?.media;
      /* 200 vide, ou refus : on n'écrit rien pour ce lot et on ne déclare pas
         la passe terminée. Elle se rejouera à la prochaine ouverture. */
      if (!media || !media.length) {
        complete = false;
        break;
      }
      /* UNE écriture pour tout le lot : `upsertLocalEntry` par titre relirait et
         réécrirait la liste entière cinquante fois, et émettrait cinquante
         événements dont chacun réveille la synchro et l'évaluateur. */
      patchLocalEntries(
        media.map((m) => ({
          mediaId: m.id,
          patch: {
            genres: m.genres ?? [],
            tags: (m.tags ?? []).filter((t) => !t.isAdult).map((t) => t.name),
            year: m.seasonYear ?? m.startDate?.year ?? null,
            format: m.format ?? null,
            mediaStatus: m.status ?? null,
            studio: m.studios?.nodes?.[0]?.name ?? null,
            popularity: m.popularity ?? null,
            duration: m.duration ?? null,
            relIds: (m.relations?.edges ?? [])
              .filter((e) => e?.node?.type === "ANIME" && FRANCHISE_RELATIONS.has(e.relationType))
              .map((e) => e.node.id),
          },
        })),
      );
      if (i + PAGE_SIZE < ids.length) await sleep(PAUSE_MS);
    }

    if (complete && vocabOk) {
      try {
        window.localStorage.setItem(DONE_KEY, "1");
      } catch {
        /* best-effort */
      }
    }
  })().finally(() => {
    running = null;
  });

  return running;
}

/** Le rattrapage a-t-il encore du travail ? Sert à l'état « pas encore mesurable ». */
export function metadataPending(): boolean {
  if (typeof window === "undefined") return false;
  return missingIds().length > 0 || !readVocab();
}
