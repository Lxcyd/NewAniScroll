/**
 * Anizone — la LECTURE de l'hote et le STOCKAGE de ce qu'on en a lu.
 *
 * Module sans alias `@/` ni TypeScript : le site (lib/anizone/resolve.js) ET
 * l'outil de remplissage (tools/anizone/seed.mjs, lance en Node nu) le partagent.
 *
 * POURQUOI UN STOCKAGE (25/11/2026). anizone.to et son CDN (seiryuu.vid-cdn.xyz)
 * refusent par un 403 les IP de Vercel ET celles de notre Worker Cloudflare —
 * les memes requetes, en-tetes compris, repondent 200 depuis une connexion
 * domestique. Le site ne peut donc ni lire une page d'episode, ni le master, ni
 * un sous-titre. Or tout ce qu'il en tire est STABLE (URL a l'uuid de
 * l'episode, sans jeton ni expiration) : on le lit UNE fois depuis une IP
 * acceptee et on le range dans Turso (base cache) :
 *   anizone_ep  (slug, ep) -> { src, subtitles, natif, son }
 *   anizone_sub url        -> le texte du .ass (fr et en seulement)
 * Le navigateur du visiteur lit ensuite la video directement sur leur CDN
 * (HLS natif, cf. resolve.js) : son IP a lui n'est pas refusee.
 */

export const BASE = "https://anizone.to";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** Echec passager (reseau, 5xx, 429) : rien a conclure sur l'episode. */
export class Passager extends Error {}
/** 403 : CETTE machine est refusee par anizone. Rien a conclure non plus,
 *  mais inutile de reessayer d'ici. */
export class Bloque extends Passager {}

/* Delai par requete. Court pour le site (un visiteur attend) ; l'outil le
   monte a 20 s : anizone met parfois 10 s a repondre. */
export const reglages = { ms: 6000 };

async function get(url, init = {}, ms = reglages.ms) {
  let r;
  try {
    r = await fetch(url, {
      ...init,
      headers: { "User-Agent": UA, ...(init.headers || {}) },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    throw new Passager(`anizone injoignable : ${e?.message || e}`);
  }
  if (r.status === 403) throw new Bloque(`anizone 403 (${new URL(url).host})`);
  return r;
}

const entites = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// ── Recherche ────────────────────────────────────────────────────────────

/* Jeton CSRF + cookies de session + instantane du composant, lus sur /anime.
   Reutilisables tant que la session vit : on les garde 20 min par processus. */
let session = null;
const SESSION_MS = 20 * 60 * 1000;

async function ouvreSession() {
  if (session && Date.now() - session.at < SESSION_MS) return session;
  const r = await get(`${BASE}/anime`);
  if (!r.ok) throw new Passager(`anizone /anime ${r.status}`);
  const html = await r.text();
  const token = (html.match(/data-csrf="([^"]+)"/) || [])[1];
  const snap = [...html.matchAll(/wire:snapshot="([^"]+)"/g)]
    .map((m) => entites(m[1]))
    .find((s) => {
      try {
        return JSON.parse(s)?.memo?.name === "pages.anime-index";
      } catch {
        return false;
      }
    });
  if (!token || !snap) throw new Passager("anizone : page de recherche illisible");
  const cookies = (r.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .join("; ");
  session = { token, snap, cookies, at: Date.now() };
  return session;
}

export async function cherche(q, reessai = true) {
  const s = await ouvreSession();
  const r = await get(`${BASE}/livewire/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Livewire": "",
      Cookie: s.cookies,
      Referer: `${BASE}/anime`,
      Origin: BASE,
    },
    body: JSON.stringify({
      _token: s.token,
      components: [{ snapshot: s.snap, updates: { search: q }, calls: [] }],
    }),
  });
  // 419 = session/jeton expires : une seule nouvelle session.
  if ((r.status === 419 || r.status === 401) && reessai) {
    session = null;
    return cherche(q, false);
  }
  if (!r.ok) throw new Passager(`anizone recherche ${r.status}`);
  let j;
  try {
    j = await r.json();
  } catch {
    throw new Passager("anizone recherche : reponse non JSON");
  }
  const d = (j?.components?.[0]?.effects?.dispatches || []).find(
    (x) => x?.name === "filters-reset" || x?.name === "items-loaded",
  );
  return Array.isArray(d?.params?.items) ? d.params.items : [];
}

// ── Appariement ──────────────────────────────────────────────────────────

const norm = (s) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/* Le titre sans sa marque de saison, des deux cotes : AniList ecrit
   « Sousou no Frieren 2nd Season », anizone « Sousou no Frieren (2026) ». Ne
   sert qu'avec une annee IDENTIQUE, sans quoi la saison 1 passerait pour la 2. */
const base = (s) =>
  norm(
    String(s || "")
      .replace(/\(\d{4}\)\s*$/, "")
      .replace(
        /[\s:-]*(\b\d+(st|nd|rd|th)\s+season\b|\bseason\s*\d+\b|\bpart\s*\d+\b|\bcour\s*\d+\b|\bs\d+\b|\bstaffel\s*\d+\b).*$/i,
        "",
      ),
  );

function titresAniList(media) {
  const t = media?.title || {};
  return [t.romaji, t.english, t.native, ...(media?.synonyms || [])].filter(Boolean);
}

function titresAnizone(item) {
  return [item?.main_title, ...Object.values(item?.title_list || {})].filter(Boolean);
}

/** Le meilleur candidat, ou null. Exige un titre identique ET une annee proche
 *  (ou un titre de base identique ET la meme annee). */
export function apparie(media, items) {
  const annee = Number(media?.seasonYear || media?.startDate?.year) || null;
  const film = media?.format === "MOVIE";
  const ta = titresAniList(media);
  const exacts = new Set(ta.map(norm).filter(Boolean));
  const bases = new Set(ta.map(base).filter((x) => x.length >= 4));

  const notes = [];
  for (const it of items) {
    if (!it?.slug) continue;
    const estFilm = it.type === "Movie";
    if (film !== estFilm && (film || estFilm)) continue;
    const tz = titresAnizone(it);
    const cy = Number(it.start_year) || null;
    const ecart = annee && cy ? Math.abs(annee - cy) : null;
    let rang = 0;
    if (tz.some((x) => exacts.has(norm(x))) && (ecart == null || ecart <= 1)) rang = 2;
    else if (ecart === 0 && tz.some((x) => bases.has(base(x)))) rang = 1;
    if (!rang) continue;
    const epEcart =
      media?.episodes && it.episode_count ? Math.abs(media.episodes - it.episode_count) : 99;
    notes.push({ it, rang, ecart: ecart ?? 9, epEcart });
  }
  notes.sort((a, b) => b.rang - a.rang || a.ecart - b.ecart || a.epEcart - b.epEcart);
  return notes[0]?.it || null;
}

/**
 * La fiche anizone d'un media AniList : `{ slug, title, episodes }` ou null.
 *
 * Leur recherche est litterale : « Yuukaku-hen » ne trouve pas leur « Yuukaku
 * Hen ». On elargit donc pas a pas, jusqu'au nom de la franchise (avant le
 * « : »), qui ramene toutes ses saisons — `apparie` fait ensuite le tri sur
 * titre + annee. Au plus 4 recherches.
 */
export async function trouve(media) {
  const t = media?.title || {};
  const romaji = String(t.romaji || "");
  const requetes = [
    ...new Set(
      [
        romaji,
        t.english,
        romaji.replace(/-/g, " ").replace(/\s*(\d+(st|nd|rd|th)\s+season|season\s*\d+).*$/i, ""),
        romaji.split(":")[0],
      ]
        .map((x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, 80))
        .filter((x) => x.length >= 2),
    ),
  ];
  for (const q of requetes) {
    const it = apparie(media, await cherche(q));
    if (it)
      return {
        slug: it.slug,
        title: it.main_title || null,
        episodes: Number(it.episode_count) || null,
      };
  }
  return null;
}

// ── Episode ──────────────────────────────────────────────────────────────

/** L'objet du lecteur de la page d'episode, ou null si la page ne l'a pas. */
export function lisLecteur(html) {
  const m = html.match(/vidstackPlayer\(JSON\.parse\('((?:[^'\\]|\\.)*)'\)/);
  if (!m) return null;
  const js = entites(m[1]).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) =>
    c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c,
  );
  try {
    const o = JSON.parse(js);
    return typeof o?.src === "string" && /\.m3u8/i.test(o.src) ? o : null;
  } catch {
    return null;
  }
}

const ALIAS = { fra: "fr", fre: "fr", jpn: "ja", eng: "en" };
export const langCourte = (l) => {
  const x = String(l || "").toLowerCase();
  return ALIAS[x] || x.split("-")[0];
};

/**
 * Le master, demonte en pieces que le NAVIGATEUR remontera (cf. « lecture
 * native » dans resolve.js) : pistes son et variantes video, en URL ABSOLUES
 * vers le CDN. `inf` garde la ligne #EXT-X-STREAM-INF telle quelle.
 */
export function demonteMaster(manifest, masterUrl) {
  const audios = [];
  const variants = [];
  const lignes = manifest.split(/\r?\n/).map((l) => l.trim());
  const abs = (u) => new URL(u, masterUrl).toString();
  for (let i = 0; i < lignes.length; i++) {
    const line = lignes[i];
    if (/^#EXT-X-MEDIA:/.test(line) && /TYPE=AUDIO/.test(line)) {
      const attr = (n) => (line.match(new RegExp(`${n}="([^"]*)"`)) || [])[1] || "";
      if (!attr("URI")) continue;
      audios.push({
        lang: langCourte(attr("LANGUAGE")),
        language: attr("LANGUAGE"),
        name: attr("NAME") || attr("LANGUAGE"),
        channels: attr("CHANNELS") || "2",
        uri: abs(attr("URI")),
      });
    } else if (/^#EXT-X-STREAM-INF:/.test(line)) {
      const uri = lignes.slice(i + 1).find((l) => l && !l.startsWith("#"));
      if (uri) variants.push({ inf: line, uri: abs(uri) });
    }
  }
  return { audios, variants };
}

/* Les sous-titres GARDES : francais et anglais. Les autres (~12 langues) ne
   peuvent pas etre servis — le CDN refuse notre relais — et les stocker tous
   couterait ~450 Ko par episode. */
export const LANGUES_ST = new Set(["fr", "en"]);
const MAX_ST = 2 * 1024 * 1024;

/**
 * Lit un episode sur anizone : `{ ep, fichiers }` ou `{ absent }`.
 *   ep       = { src, subtitles, natif, son } — ce que resolve.js sert ;
 *   fichiers = [{ url, body }] les .ass fr/en, deja lus.
 * Leve `Bloque` (403) ou `Passager`. `sousTitres: false` ne lit pas les .ass
 * (et ne liste alors aucun sous-titre).
 */
export async function capture(slug, ep, { sousTitres = true, ms = reglages.ms } = {}) {
  const r = await get(`${BASE}/anime/${slug}/${ep}`, {}, ms);
  if (r.status === 404) return { absent: `anizone ${slug}/${ep} 404` };
  if (!r.ok) throw new Passager(`anizone page ${r.status}`);
  const lecteur = lisLecteur(await r.text());
  if (!lecteur) return { absent: `anizone ${slug}/${ep} : pas de lecteur` };

  const m = await get(lecteur.src, {}, Math.max(ms, 8000));
  if (m.status === 404 || m.status === 410) return { absent: `anizone cdn ${m.status}` };
  if (!m.ok) throw new Passager(`anizone cdn ${m.status}`);
  const manifest = await m.text();
  if (!/^\s*#EXTM3U/.test(manifest)) throw new Passager("anizone cdn : pas une playlist");
  const natif = demonteMaster(manifest, lecteur.src);

  const fichiers = [];
  const subtitles = [];
  if (sousTitres) {
    for (const s of Array.isArray(lecteur.subtitles) ? lecteur.subtitles : []) {
      if (typeof s?.file !== "string" || !LANGUES_ST.has(langCourte(s.language))) continue;
      const f = await get(s.file, { headers: { Referer: `${BASE}/` } }, Math.max(ms, 8000));
      /* Seul un fichier qui n'existe pas est saute ; un echec passager fait
         echouer l'episode, sans quoi il serait range SANS son francais (et
         sans chip VO) pour de bon. */
      if (f.status === 404 || f.status === 410) continue;
      if (!f.ok) throw new Passager(`anizone sous-titre ${f.status}`);
      const body = await f.text();
      if (!body || body.length > MAX_ST) continue;
      fichiers.push({ url: s.file, body });
      subtitles.push({
        title: s.title ?? null,
        language: s.language ?? null,
        format: s.format ?? null,
        forced: s.forced ?? null,
        file: s.file,
      });
    }
  }
  return {
    ep: { src: lecteur.src, subtitles, natif, son: natif.audios.map((a) => a.lang) },
    fichiers,
  };
}

// ── Stockage (Turso, base cache) ─────────────────────────────────────────
/* Chaque fonction prend le client libsql : le site passe getTursoClient(),
   l'outil le sien. Lectures par CLE PRIMAIRE seulement (1 ligne lue). */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS anizone_ep (
     slug TEXT NOT NULL, ep INTEGER NOT NULL, data TEXT NOT NULL,
     checked_at INTEGER NOT NULL, PRIMARY KEY (slug, ep))`,
  `CREATE TABLE IF NOT EXISTS anizone_sub (
     url TEXT PRIMARY KEY, body TEXT NOT NULL, checked_at INTEGER NOT NULL)`,
  /* La file des episodes DEMANDES par un visiteur et absents de anizone_ep :
     le cron (tools/anizone/seed.mjs --auto) la vide en premier. */
  `CREATE TABLE IF NOT EXISTS anizone_demande (
     ani_id INTEGER NOT NULL, ep INTEGER NOT NULL, at INTEGER NOT NULL,
     PRIMARY KEY (ani_id, ep))`,
];
const pretes = new WeakSet();
export async function tables(db) {
  if (pretes.has(db)) return;
  for (const sql of TABLES) {
    try {
      await db.execute(sql);
    } catch {
      /* course entre deux processus : la table existe */
    }
  }
  pretes.add(db);
}

export async function lisEpisode(db, slug, ep) {
  await tables(db);
  const r = await db.execute({
    sql: "SELECT data FROM anizone_ep WHERE slug = ? AND ep = ?",
    args: [slug, ep],
  });
  const raw = r.rows[0]?.data;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function ecrisEpisode(db, slug, ep, cap) {
  await tables(db);
  const now = Math.floor(Date.now() / 1000);
  for (const f of cap.fichiers || [])
    await db.execute({
      sql: `INSERT INTO anizone_sub (url, body, checked_at) VALUES (?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET body = excluded.body, checked_at = excluded.checked_at`,
      args: [f.url, f.body, now],
    });
  await db.execute({
    sql: `INSERT INTO anizone_ep (slug, ep, data, checked_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(slug, ep) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at`,
    args: [slug, ep, JSON.stringify(cap.ep), now],
  });
}

/** Met un episode dans la file du cron. Un doublon ne coute rien (IGNORE). */
export async function demandeEpisode(db, aniId, ep) {
  await tables(db);
  await db.execute({
    sql: "INSERT OR IGNORE INTO anizone_demande (ani_id, ep, at) VALUES (?, ?, ?)",
    args: [aniId, ep, Math.floor(Date.now() / 1000)],
  });
}

export async function lisSousTitre(db, url) {
  await tables(db);
  const r = await db.execute({ sql: "SELECT body FROM anizone_sub WHERE url = ?", args: [url] });
  const b = r.rows[0]?.body;
  return typeof b === "string" ? b : null;
}
