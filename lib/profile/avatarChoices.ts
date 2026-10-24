/**
 * LES AVATARS DU STUDIO (24/10/2026, Luc) : des personnages AniList à porter
 * comme image d'avatar. Demandés en direct depuis le navigateur — aucune
 * fonction Vercel —, et gardés pour la session : rouvrir l'onglet ne
 * redemande rien.
 *
 * DEUX IMAGES PAR PERSONNAGE : `thumb` (medium, 100×150, ~50 Ko) pour les
 * cases de la grille, `image` (large, 230×345, ~180 Ko) pour l'avatar porté.
 * Une grille de 250 portraits en `large` pesait trois fois plus pour rien.
 */

export type AvatarChar = { id: number; name: string; image: string; thumb: string };

const CHAR = "id name { full } image { large medium }";

async function ask<T>(query: string, variables: Record<string, unknown>, retried = false): Promise<T | null> {
  try {
    const r = await fetch("https://graphql.anilist.co/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    /* 429 : AniList dit quand revenir ; on y retourne UNE fois si c'est court. */
    if (r.status === 429 && !retried) {
      const wait = Number(r.headers.get("retry-after")) || 2;
      if (wait <= 5) {
        await new Promise((ok) => setTimeout(ok, wait * 1000));
        return ask<T>(query, variables, true);
      }
    }
    if (!r.ok) return null;
    return (await r.json())?.data ?? null;
  } catch {
    return null;
  }
}

/* L'image « par défaut » d'AniList (silhouette grise) ne vaut pas un avatar. */
const toChar = (n: any): AvatarChar | null =>
  n?.image?.large && !/\/default\.(jpg|png)$/.test(n.image.large)
    ? { id: n.id, name: n.name?.full || "?", image: n.image.large, thumb: n.image.medium || n.image.large }
    : null;
const chars = (nodes: any[] | undefined) => (nodes ?? []).map(toChar).filter(Boolean) as AvatarChar[];
const dedupe = (list: AvatarChar[]) => {
  const seen = new Set<number>();
  return list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
};

const favCache = new Map<string, AvatarChar[]>();
/** Les personnages favoris d'un compte AniList (jusqu'à 50). */
export async function loadFavouriteChars(userName: string): Promise<AvatarChar[]> {
  const hit = favCache.get(userName);
  if (hit) return hit;
  /* Deux pages de 25 (le plafond d'AniList) dans la même requête. */
  const d = await ask<any>(
    `query ($name: String) { User(name: $name) { favourites {
      a: characters(perPage: 25, page: 1) { nodes { ${CHAR} } }
      b: characters(perPage: 25, page: 2) { nodes { ${CHAR} } }
    } } }`,
    { name: userName },
  );
  const f = d?.User?.favourites;
  const out = dedupe([...chars(f?.a?.nodes), ...chars(f?.b?.nodes)]);
  if (d) favCache.set(userName, out);
  return out;
}

/* LES PERSONNAGES D'UN ANIME, principaux d'abord.
   AniList n'en rend JAMAIS plus de 25 par page (`perPage` plafonné), et son
   `pageInfo.total` est faux (500 pour tout le monde) : pour COMPTER, il faut
   charger. GraphQL permet plusieurs pages dans UNE requête par des alias,
   jusqu'à sa « complexité » de 500, soit ~10 points par page (mesuré le
   24/10/2026) — 49 pages au plus. Mais une grosse requête est lente (49 pages
   = 3,5 s) : plusieurs de 10 pages EN PARALLÈLE vont trois fois plus vite.

   Un lot de 10 pages d'abord (il dit s'il y a une suite), puis tout le reste
   en parallèle, montré AU FUR ET À MESURE dans l'ordre des pages (One Piece :
   ~810 personnages en ~2 s au lieu de 3 lots à la file). */
const PAGES_PER_BATCH = 10;
const MAX_PAGES = 50; /* 1 250 personnages */

const pagesOf = (first: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const page = first + i;
    return `p${page}: characters(sort: [ROLE, FAVOURITES_DESC], perPage: 25, page: ${page}) { pageInfo { hasNextPage } nodes { ${CHAR} } }`;
  }).join(" ");

/** Les pages `first`…`first+n-1` d'un `Media` déjà reçu, dans l'ordre. */
function readPages(m: any, first: number, n: number) {
  const out: AvatarChar[] = [];
  let more = false;
  for (let i = 0; i < n; i++) {
    const c = m?.[`p${first + i}`];
    out.push(...chars(c?.nodes));
    more = !!c?.pageInfo?.hasNextPage;
    if (!more) break;
  }
  return { list: out, more };
}

async function fetchPages(id: number, first: number, n: number) {
  const d = await ask<any>(`query ($id: Int) { Media(id: $id, type: ANIME) { ${pagesOf(first, n)} } }`, { id });
  return d?.Media ? readPages(d.Media, first, n) : null;
}

/** Par anime : ce qui est arrivé, combien de pages, et s'il en reste. */
type Got = { list: AvatarChar[]; pages: number; done: boolean };
const got = new Map<number, Got>();
const inFlight = new Map<number, Promise<AvatarChar[]>>();

/** Ce qui est déjà chargé, sans rien demander (`undefined` : pas encore). */
export const animeCharsCached = (id: number) => got.get(id)?.list;
/** Tout est là (sinon `animeCharsCached` n'en a que le début). */
export const animeCharsDone = (id: number) => !!got.get(id)?.done;

/* NOTRE COPIE D'ABORD (24/10/2026, Luc) : tous les personnages de l'anime,
   gardés dans Turso (scripts/cache/refresh-characters.mjs) et servis par
   /api/v2/characters/[id] depuis le cache du bord — une requête, instantanée,
   AniList en panne ou pas. Un anime pas encore relevé (réponse sans
   `complete`) retombe sur AniList en direct, ci-dessous. */
async function fromStore(id: number): Promise<AvatarChar[] | null> {
  try {
    const r = await fetch(`/api/v2/characters/${id}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (typeof j?.complete !== "boolean") return null;
    return dedupe(chars((j.characters?.edges ?? []).map((e: any) => e?.node)));
  } catch {
    return null;
  }
}

/** Combien de personnages avec image, pour toute une liste (notre copie). */
export async function loadCharCounts(ids: number[]): Promise<Record<number, number>> {
  if (!ids.length) return {};
  try {
    const r = await fetch(`/api/v2/character-counts?ids=${ids.join(",")}`);
    return r.ok ? ((await r.json())?.counts ?? {}) : {};
  } catch {
    return {};
  }
}

export function loadAnimeChars(id: number, onPage?: () => void): Promise<AvatarChar[]> {
  const run = inFlight.get(id);
  if (run) return run;
  const have = got.get(id);
  if (have?.done) return Promise.resolve(have.list);
  const p = (async () => {
    if (!have) {
      const stored = await fromStore(id);
      if (stored) {
        got.set(id, { list: stored, pages: MAX_PAGES, done: true });
        inFlight.delete(id);
        onPage?.();
        return stored;
      }
    }
    let list = have?.list ?? [];
    let first = (have?.pages ?? 0) + 1;
    const put = (more: boolean, pages: number) => {
      list = dedupe(list);
      got.set(id, { list, pages, done: !more || pages >= MAX_PAGES });
      onPage?.();
    };
    /* Un lot d'abord : il dit s'il y a une suite. */
    const r = await fetchPages(id, first, PAGES_PER_BATCH);
    if (r) {
      list = [...list, ...r.list];
      put(r.more, first + PAGES_PER_BATCH - 1);
      first += PAGES_PER_BATCH;
      /* Puis tout le reste d'un coup, recollé dans l'ordre des pages. */
      if (r.more && first <= MAX_PAGES) {
        const starts: number[] = [];
        for (let s = first; s <= MAX_PAGES; s += PAGES_PER_BATCH) starts.push(s);
        const reqs = starts.map((s) => fetchPages(id, s, PAGES_PER_BATCH));
        let pages = first - 1;
        for (const req of reqs) {
          const x = await req; /* dans l'ordre : la grille s'allonge sans trou */
          if (!x) break; /* un lot perdu : on garde ce qui le précède, le reste au prochain clic */
          list = [...list, ...x.list];
          pages += PAGES_PER_BATCH;
          put(x.more, pages);
          if (!x.more) break;
        }
      }
    } else if (!have) {
      got.set(id, { list: [], pages: 0, done: false });
    }
    inFlight.delete(id);
    return list;
  })();
  inFlight.set(id, p);
  return p;
}

const searchCache = new Map<string, AvatarChar[]>();
/** Recherche de personnages par nom : 50, en deux pages dans la même requête. */
export async function searchChars(q: string): Promise<AvatarChar[]> {
  const key = q.trim().toLowerCase();
  const hit = searchCache.get(key);
  if (hit) return hit;
  const d = await ask<any>(
    `query ($q: String) {
      a: Page(perPage: 25, page: 1) { characters(search: $q, sort: [SEARCH_MATCH, FAVOURITES_DESC]) { ${CHAR} } }
      b: Page(perPage: 25, page: 2) { characters(search: $q, sort: [SEARCH_MATCH, FAVOURITES_DESC]) { ${CHAR} } }
    }`,
    { q: key },
  );
  const out = dedupe([...chars(d?.a?.characters), ...chars(d?.b?.characters)]);
  if (d) searchCache.set(key, out);
  return out;
}
