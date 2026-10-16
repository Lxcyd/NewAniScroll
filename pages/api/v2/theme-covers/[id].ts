import type { NextApiRequest, NextApiResponse } from "next";
import { themesForAnime, type Theme } from "@/lib/animethemes/themes";
import { THEMES_KEY } from "@/lib/animethemes/themesKey";
import { seasonCacheGet, seasonCacheSet } from "@/lib/db/seasonCache";
import { kanaToRomaji, phonetic } from "@/lib/animethemes/kanaRomaji";
import { resolvedVideoIds } from "@/lib/db/opedYoutube";

/**
 * LA POCHETTE DE CHAQUE GÉNÉRIQUE — le menu Musique du studio de profil.
 *
 *   GET /api/v2/theme-covers/{anilistId}  →  { covers: { [slug]: url | null } }
 *
 * UNE CASCADE PAR MORCEAU, chaque maillon ne servant qu'aux restes du
 * précédent : Deezer → Apple Music JP (appleCover) → MusicBrainz + Cover Art
 * Archive (musicBrainzCover) → vignette YouTube de la version complète
 * (oped_youtube) → côté client, l'affiche de l'anime. Le tout une fois par
 * anime et par semaine (Turso + CDN). La route prend
 * l'ID DE L'ANIME, jamais du texte libre : les clés de cache restent bornées et
 * elle ne peut pas servir de relais vers Deezer. Les thèmes sont relus dans le
 * cache de /api/v2/themes (même clé).
 *
 * LA RECHERCHE EST LIBRE (« titre artiste »), pas `artist:"…" track:"…"` : le
 * filtre strict ne trouve rien dès que le titre AnimeThemes porte une mention
 * (« KISS OF DEATH (Produced by HYDE) », 16/10/2026). On filtre ensuite sur
 * l'ARTISTE — sans lui, une pochette fausse vaut moins que pas de pochette — et
 * on garde le titre le plus proche (la version remix a sa propre pochette).
 *
 * Caches : Turso une semaine (season_cache), CDN une semaine. Une réponse
 * PARTIELLE (budget de 5 s épuisé, service en panne) n'est jamais mise en cache
 * et porte `partial: true` : le studio redemande, et l'appel suivant reprend où
 * le précédent s'est arrêté (`tried`, cf. Entry).
 */
// v3 : replis MusicBrainz et YouTube. Les lignes v2 gardaient des `null`.
const COVERS_KEY = (anilistId: number) => `themecovers:v3:al${anilistId}`;
/** Au-delà, on rend ce qu'on a et le studio redemande la suite. Court
 *  exprès : la PREMIÈRE vague de pochettes s'affiche au bout de ~5 s au plus,
 *  au lieu d'attendre qu'un anime à vingt-cinq génériques soit fini. */
const BUDGET_MS = 5000;
const DEEZER = "https://api.deezer.com/search";

type Hit = { title: string; artist: { name: string }; album: { cover_medium?: string } };

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (s: string) => new Set(norm(s).split(" ").filter(Boolean));
const VERSION = new Set(["remix", "ver", "version", "tv", "size", "instrumental", "acoustic", "live", "cover", "karaoke", "edit", "mix"]);

/** Le titre sans ses mentions entre parenthèses ou crochets. */
const bare = (s: string) => s.replace(/[([【].*?[)\]】]/g, " ").replace(/\s+/g, " ").trim();

async function search(q: string): Promise<Hit[]> {
  const r = await fetch(`${DEEZER}?q=${encodeURIComponent(q)}&limit=10`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`deezer ${r.status}`);
  const d = await r.json();
  return Array.isArray(d?.data) ? d.data : [];
}

async function coverFor(song: string, artists: string[]): Promise<string | null> {
  const names = artists.map(norm).filter(Boolean);
  if (!names.length) return null;
  const sameArtist = (h: Hit) => {
    const a = norm(h.artist?.name ?? "");
    return !!a && names.some((n) => a.includes(n) || n.includes(a));
  };
  const want = words(song);
  /* Mots communs entre le titre voulu et celui de Deezer, moins les mots en
     trop — et un mot de VERSION en trop (remix, ver., tv size…) pèse lourd :
     sans lui, « KISS OF DEATH (Produced by HYDE) » prenait la pochette du remix,
     plus riche en mots communs que l'original « Kiss of Death » (16/10/2026). */
  const score = (h: Hit) => {
    const got = words(h.title);
    let s = 0;
    for (const w of want) if (got.has(w)) s += 2;
    for (const w of got) if (!want.has(w)) s -= VERSION.has(w) ? 10 : 1;
    return s;
  };
  for (const q of [`${song} ${artists[0]}`, `${bare(song)} ${artists[0]}`]) {
    const hits = (await search(q)).filter((h) => sameArtist(h) && h.album?.cover_medium);
    if (hits.length) {
      hits.sort((a, b) => score(b) - score(a));
      return hits[0].album.cover_medium ?? null;
    }
    if (bare(song) === song) break;
  }
  return appleCover(song, artists[0]);
}

/* REPLI : LE CATALOGUE JAPONAIS D'APPLE MUSIC (iTunes Search, sans clé).
   Deezer n'a pas tout — aucun des six endings de XX:me (DARLING in the FRANXX,
   16/10/2026) — et Apple les a, mais en titres japonais (トリカゴ, 真夏のセツナ).
   Le titre est donc comparé après passage des kana en romaji, sur une clé
   phonétique lâche (« Darling » = ダーリン). Un mot du titre voulu (3 lettres
   ou plus) doit se retrouver dans celui d'Apple, et l'artiste doit concorder :
   sans quoi on garde la note plutôt qu'une pochette au hasard. Deux requêtes au
   plus : « titre artiste », puis le répertoire de l'artiste. */
type AppleHit = { trackName?: string; artistName?: string; artworkUrl100?: string };
const appleFlat = (s: string) =>
  phonetic(kanaToRomaji(s.normalize("NFKC").toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, ""));
const latinWords = (s: string) =>
  new Set(s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean));

async function appleCover(song: string, artist: string | undefined): Promise<string | null> {
  if (!artist) return null;
  const who = appleFlat(artist);
  const want = latinWords(song);
  const score = (title: string) => {
    const flat = appleFlat(title);
    let s = 0;
    for (const w of want) if (w.length >= 3 && !VERSION.has(w) && flat.includes(phonetic(w))) s += w.length;
    for (const w of latinWords(title)) if (VERSION.has(w) && !want.has(w)) s -= 10;
    return s;
  };
  for (const [term, limit] of [[`${song} ${artist}`, 10], [artist, 50]] as const) {
    const r = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&country=jp&limit=${limit}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!r.ok) throw new Error(`itunes ${r.status}`);
    const hits: AppleHit[] = (await r.json())?.results ?? [];
    const best = hits
      .filter((h) => {
        const a = appleFlat(h.artistName ?? "");
        return !!a && !!who && (a.includes(who) || who.includes(a)) && h.artworkUrl100 && h.trackName;
      })
      .map((h) => ({ h, s: score(h.trackName!) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)[0];
    /* 100 px de base ; le motif de l'URL donne la taille voulue. */
    if (best) return best.h.artworkUrl100!.replace("100x100bb", "250x250bb");
  }
  return null;
}

/* 3. MUSICBRAINZ + COVER ART ARCHIVE. Les éditions CD que les plateformes
   n'ont pas : ED3 de DARLING in the FRANXX (« Beautiful World », XX:me) n'est
   que sur l'« Ending Collection vol.1 » (16/10/2026). MusicBrainz exige un
   User-Agent identifié et UNE requête par seconde par IP : appels espacés,
   et seulement pour les morceaux que Deezer et Apple n'ont pas trouvés. Une
   édition sur trois avait une pochette au Cover Art Archive (les autres :
   404) : on les essaie dans l'ordre, puis le groupe d'éditions. */
const MB_UA = "AniScroll/1.0 (https://aniscroll.com)";
let mbLast = 0;
async function musicBrainzCover(song: string, artists: string[]): Promise<string | null> {
  const names = artists.map(norm).filter(Boolean);
  if (!names.length) return null;
  const esc = (s: string) => s.replace(/(["\\])/g, "\\$1");
  const wait = 1100 - (Date.now() - mbLast);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  mbLast = Date.now();
  const q = `recording:"${esc(bare(song))}" AND artist:"${esc(artists[0])}"`;
  const r = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=5`, {
    headers: { "User-Agent": MB_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`musicbrainz ${r.status}`);
  type Rec = {
    title?: string;
    "artist-credit"?: { name?: string }[];
    releases?: { id: string; "release-group"?: { id: string } }[];
  };
  const recs: Rec[] = (await r.json())?.recordings ?? [];
  /* Les « TV size » en dernier : leur single a souvent la même pochette, mais
     l'album complet est la bonne réponse. */
  const tv = (t: string) => (/\btv\b|size/i.test(t) ? 1 : 0);
  const releases: string[] = [];
  const groups: string[] = [];
  for (const rec of recs.sort((a, b) => tv(a.title ?? "") - tv(b.title ?? ""))) {
    const who = norm(rec["artist-credit"]?.map((c) => c.name ?? "").join(" ") ?? "");
    if (!who || !names.some((n) => who.includes(n) || n.includes(who))) continue;
    for (const rel of rec.releases ?? []) {
      if (!releases.includes(rel.id)) releases.push(rel.id);
      const g = rel["release-group"]?.id;
      if (g && !groups.includes(g)) groups.push(g);
    }
  }
  const candidates = [
    ...releases.slice(0, 4).map((id) => `https://coverartarchive.org/release/${id}/front-250`),
    ...groups.slice(0, 2).map((id) => `https://coverartarchive.org/release-group/${id}/front-250`),
  ];
  for (const url of candidates) {
    /* Pas de suivi de redirection : le 307 vers archive.org suffit à savoir
       qu'il y a une image, et l'URL du Cover Art Archive reste stable. */
    const h = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000) });
    if (h.status === 200 || (h.status >= 300 && h.status < 400)) return url;
  }
  return null;
}

/* LES ARTISTES QUE ANIMETHEMES N'A PAS. Sans artiste, aucune pochette n'est
   acceptée (c'est ce qui écarte les reprises) — or AnimeThemes n'en donne
   aucun pour la moitié des génériques de Naruto (16/10/2026). AnisongDB (la
   base d'AMQ) les a tous, par id MyAnimeList, en 0,2 s. Jikan, essayé
   d'abord, ne répondait plus du tout. L'id MAL vient d'AniList : un appel,
   et seulement quand un artiste manque. */
async function backfillArtists(anilistId: number, themes: Theme[]): Promise<Theme[]> {
  if (themes.every((th) => th.artists.length || !th.song)) return themes;
  const al = await fetch("https://graphql.anilist.co/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: "query($id:Int){Media(id:$id){idMal}}", variables: { id: anilistId } }),
    signal: AbortSignal.timeout(4000),
  });
  const mal = (await al.json())?.data?.Media?.idMal;
  if (!mal) return themes;
  const r = await fetch("https://anisongdb.com/api/mal_ids_request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mal_ids: [mal], ignore_duplicate: false }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`anisongdb ${r.status}`);
  type Song = { songType?: string; songName?: string; songArtist?: string };
  const songs: Song[] = await r.json();
  /* Deux romanisations d'un même titre : « Kanashimi wo » / « Kanashimi o »,
     « Kyosokyoku » / « Kyousoukyoku » (Naruto OP3 et OP5). La particule を et
     le « ou » long se ramènent à « o », des deux côtés. */
  const flat = (x: string) =>
    phonetic(norm(x).replace(/ /g, "").replace(/wo/g, "o").replace(/ou/g, "o"));
  return themes.map((th) => {
    if (th.artists.length || !th.song) return th;
    /* Le TITRE d'abord (AMQ range parfois une version doublée sous le même
       numéro), le numéro « Opening 1 » ↔ OP1 pour départager. */
    const kind = th.kind === "op" ? "Opening" : "Ending";
    const want = flat(th.song);
    const same = songs.filter((x) => x.songArtist && x.songName && flat(x.songName) === want);
    const hit =
      same.find((x) => x.songType === `${kind} ${th.sequence}`) ??
      same[0] ??
      null;
    return hit ? { ...th, artists: [hit.songArtist!] } : th;
  });
}

/** Ce que Turso garde : les pochettes, et les morceaux dont la cascade est
 *  allée au bout (`tried`) — un anime à vingt-cinq génériques se résout en
 *  plusieurs appels, chacun reprenant où le précédent s'est arrêté. */
type Entry = { covers: Record<string, string | null>; tried: string[] };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const anilistId = Number(req.query.id) || null;
  if (!anilistId) return res.status(400).json({ error: "id (AniList) required" });

  let themes = await seasonCacheGet<Theme[]>(THEMES_KEY(anilistId, null));
  if (!themes) {
    try {
      themes = await themesForAnime({ anilistId, malId: null });
    } catch {
      themes = [];
    }
  }
  const slugs = themes.map((th) => th.slug);

  const entry = await seasonCacheGet<Entry>(COVERS_KEY(anilistId));
  const tried = new Set(entry?.tried ?? []);
  const covers: Record<string, string | null> = {};
  for (const s of slugs) covers[s] = entry?.covers?.[s] ?? null;
  const LONG = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800";
  if (entry && slugs.every((s) => tried.has(s))) {
    res.setHeader("Cache-Control", LONG);
    return res.status(200).json({ covers, partial: false });
  }

  const started = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - started);

  const todo = themes.filter((th) => !tried.has(th.slug));
  /* Sans titre, rien à chercher : l'affiche de l'anime. */
  for (const th of todo) if (!th.song) tried.add(th.slug);
  let pending = todo.filter((th) => th.song);
  /* AnisongDB injoignable : les morceaux sans artiste restent à tenter. S'il a
     répondu sans les connaître, il n'y a plus rien à chercher pour eux. */
  let artistsKnown = true;
  if (pending.some((th) => !th.artists.length)) {
    try {
      pending = await backfillArtists(anilistId, pending);
    } catch {
      artistsKnown = false;
    }
  }

  /* Un titre par couple (chanson, artiste) : OP1 et sa version crédits ne
     coûtent qu'une recherche. */
  const byKey = new Map<string, { song: string; artists: string[]; slugs: string[] }>();
  for (const th of pending) {
    const k = `${norm(th.song!)}|${norm(th.artists[0] ?? "")}`;
    const e = byKey.get(k) ?? { song: th.song!, artists: th.artists, slugs: [] };
    e.slugs.push(th.slug);
    byKey.set(k, e);
  }
  const jobs = [...byKey.values()];

  /* MusicBrainz : une requête par seconde, donc une seule file. */
  let mbQueue: Promise<unknown> = Promise.resolve();
  const mbSerial = <T,>(fn: () => Promise<T>) => {
    const p = mbQueue.then(fn);
    mbQueue = p.catch(() => {});
    return p;
  };

  /* La cascade complète par morceau, quatre morceaux à la fois (Deezer : 50
     requêtes / 5 s). Un morceau n'est commencé que s'il reste de quoi le
     finir ; une erreur réseau le laisse à retenter au prochain appel. */
  const run = async (j: (typeof jobs)[number]) => {
    if (!j.artists.length) {
      if (artistsKnown) for (const s of j.slugs) tried.add(s);
      return;
    }
    try {
      let url = await coverFor(j.song, j.artists);
      if (!url) url = await mbSerial(() => musicBrainzCover(j.song, j.artists));
      for (const s of j.slugs) {
        covers[s] = url;
        tried.add(s);
      }
    } catch {
      /* à retenter */
    }
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < jobs.length && timeLeft() > 2000) await run(jobs[next++]);
    }),
  );

  /* La vignette de la version complète sur YouTube, quand elle est résolue
     (oped_youtube) : aucune requête vers YouTube, l'URL est déterministe. */
  if (slugs.some((s) => tried.has(s) && !covers[s])) {
    const ids = await resolvedVideoIds(anilistId);
    for (const s of slugs) {
      const id = ids.get(s);
      if (tried.has(s) && !covers[s] && id) covers[s] = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    }
  }

  /* Le reste prend l'affiche de l'anime, côté client. */
  const done = slugs.every((s) => tried.has(s));
  if (tried.size) await seasonCacheSet(COVERS_KEY(anilistId), { covers, tried: [...tried] } satisfies Entry);
  /* Partielle : jamais en cache — le studio redemande aussitôt la suite. */
  res.setHeader("Cache-Control", done ? LONG : "no-store");
  return res.status(200).json({ covers, partial: !done });
}
