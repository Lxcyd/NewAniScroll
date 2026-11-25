/**
 * Anizone (anizone.to) — ajoute le 25/11/2026 a la demande de Luc.
 *
 * CE QUE SERT L'HOTE. Une page d'episode `https://anizone.to/anime/<id>/<ep>`
 * (Laravel Livewire, pas de defi Cloudflare) porte dans son `x-data` un objet
 * `vidstackPlayer(JSON.parse('…'))` :
 *   { src: ".../master.m3u8", subtitles: [{title, format:"ass", language,
 *     default, forced, file}], storyboard, snapshot, … }
 * Le master (CDN seiryuu.vid-cdn.xyz) contient TOUTES les pistes son en
 * `#EXT-X-MEDIA:TYPE=AUDIO` (Frieren ep. 1 : ja, fr, en, de, es, es-419,
 * pt-BR, hi, ta) ; les sous-titres sont des .ass a part (~15, dont 2 fr).
 * Le CDN repond sans referer mais son CORS ne laisse passer que
 * `https://anizone.to`, et il refuse le Worker (403 depuis Cloudflare) : le
 * flux est donc lu par le lecteur HLS NATIF du navigateur, cf. `native` plus bas.
 *
 * TROIS CHIPS, UN FICHIER (cf. lib/servers.js). Toutes les pistes son et tous
 * les sous-titres sont servis aux trois ; seul le defaut change, et chaque chip
 * ne s'allume que s'il a quelque chose a offrir :
 *   anizone        VF    : piste son `fr` exigee ; son fr, sous-titres eteints ;
 *   anizone-vo     VO    : sous-titres `fr` exiges ; son ja, sous-titres fr ;
 *   anizone-multi  MULTI : toujours ; son ja, sous-titres selon la preference.
 *
 * PAS D'ID ANILIST CHEZ EUX. La recherche (composant Livewire
 * `pages.anime-index`, champ `search`) rend du JSON propre dans l'evenement
 * `filters-reset` : titres dans toutes les langues, type, annee de debut,
 * nombre d'episodes. On apparie sur un titre identique (normalise) + l'annee,
 * et la reponse est retenue dans `anizone_map` (lib/db/anizoneMap.ts).
 *
 * Contrat de retour : `{ data }` | `{ absent: raison }` | `{ transient: raison }`.
 */

import { getAnizoneMap, setAnizoneMap } from "@/lib/db/anizoneMap";

const BASE = "https://anizone.to";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export const ANIZONE_SERVERS = {
  anizone: { audioLang: "fr", subtitlePref: "none", exige: "son-fr" },
  "anizone-vo": { audioLang: "ja", subtitlePref: "full", exige: "st-fr" },
  "anizone-multi": { audioLang: "ja", subtitlePref: "full", exige: null },
};

class Passager extends Error {}

async function get(url, init = {}, ms = 6000) {
  try {
    return await fetch(url, {
      ...init,
      headers: { "User-Agent": UA, ...(init.headers || {}) },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    throw new Passager(`anizone injoignable : ${e?.message || e}`);
  }
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
   Reutilisables tant que la session vit : on les garde 20 min par lambda. */
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

async function cherche(q, reessai = true) {
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

const enVolCarte = new Map();

/** aniId -> slug anizone (ou null). Retenu en base ; recherche au plus 3 fois. */
async function slugPour(aniId, media) {
  const ligne = await getAnizoneMap(aniId);
  if (ligne) return ligne.slug;
  const k = String(aniId);
  if (enVolCarte.has(k)) return enVolCarte.get(k);
  const p = (async () => {
    /* Leur recherche est litterale : « Yuukaku-hen » ne trouve pas leur
       « Yuukaku Hen ». On elargit donc pas a pas, jusqu'au nom de la franchise
       (avant le « : »), qui ramene toutes ses saisons — l'appariement ci-dessus
       fait ensuite le tri sur titre + annee. Au plus 4 recherches, une seule
       fois par fiche (la reponse est retenue). */
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
      const trouve = apparie(media, await cherche(q));
      if (trouve) {
        await setAnizoneMap(aniId, trouve.slug, trouve.main_title || null);
        return trouve.slug;
      }
    }
    await setAnizoneMap(aniId, null, null);
    return null;
  })();
  enVolCarte.set(k, p);
  try {
    return await p;
  } finally {
    enVolCarte.delete(k);
  }
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
const langCourte = (l) => {
  const x = String(l || "").toLowerCase();
  return ALIAS[x] || x.split("-")[0];
};

/**
 * Le master, demonte en pieces que le NAVIGATEUR remontera (cf. « lecture
 * native » plus bas) : pistes son et variantes video, en URL ABSOLUES vers le
 * CDN. `inf` garde la ligne #EXT-X-STREAM-INF telle quelle.
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

/* Les trois chips d'un meme episode partent en meme temps : une seule lecture
   de la page et du master pour les trois. */
const memoEp = new Map();
const MEMO_EP_MS = 5 * 60 * 1000;

async function episode(slug, ep) {
  const k = `${slug}/${ep}`;
  const hit = memoEp.get(k);
  if (hit && (hit.p || Date.now() - hit.at < MEMO_EP_MS)) return hit.p || hit.v;
  const p = (async () => {
    const r = await get(`${BASE}/anime/${slug}/${ep}`);
    if (r.status === 404) return { absent: `anizone ${slug}/${ep} 404` };
    if (!r.ok) throw new Passager(`anizone page ${r.status}`);
    const lecteur = lisLecteur(await r.text());
    if (!lecteur) return { absent: `anizone ${slug}/${ep} : pas de lecteur` };
    const m = await get(lecteur.src, {}, 5000);
    if (m.status === 404 || m.status === 410) return { absent: `anizone cdn ${m.status}` };
    if (!m.ok) throw new Passager(`anizone cdn ${m.status}`);
    const manifest = await m.text();
    if (!/^\s*#EXTM3U/.test(manifest)) throw new Passager("anizone cdn : pas une playlist");
    const natif = demonteMaster(manifest, lecteur.src);
    return { lecteur, natif, son: natif.audios.map((a) => a.lang) };
  })();
  memoEp.set(k, { p });
  try {
    const v = await p;
    memoEp.set(k, { v, at: Date.now() });
    if (memoEp.size > 500) memoEp.clear();
    return v;
  } catch (e) {
    memoEp.delete(k);
    throw e;
  }
}

/* L'ORDRE EST LE CONTRAT (cf. frembedSubtitles) : le lecteur prend la premiere
   piste de la langue voulue. Francais d'abord, puis anglais, puis le reste dans
   l'ordre de l'hote ; dans une langue, la piste complete avant « (CC) » et
   avant une piste forcee. */
function sousTitres(liste, def) {
  const rangLang = (l) => (l === "fr" ? 0 : l === "en" ? 1 : 2);
  const pistes = (Array.isArray(liste) ? liste : [])
    .filter((s) => typeof s?.file === "string" && s.file)
    .map((s, i) => ({
      i,
      file: s.file,
      label: s.title || s.language || "Subtitle",
      language: String(s.language || ""),
      court: langCourte(s.language),
      type: /^(ass|ssa|srt|vtt)$/i.test(s.format || "") ? s.format.toLowerCase() : "ass",
      secondaire: /\(CC\)/i.test(s.title || "") || String(s.forced) === "yes" || s.forced === true,
    }))
    .sort(
      (a, b) =>
        rangLang(a.court) - rangLang(b.court) ||
        (a.court === b.court ? a.secondaire - b.secondaire : 0) ||
        a.i - b.i,
    );
  let allume = false;
  return pistes.map((p) => {
    const parDefaut = def.exige === "st-fr" && !allume && p.court === "fr";
    if (parDefaut) allume = true;
    return {
      // Leur CDN ne repond qu'a l'origine anizone.to et refuse le Worker : le
      // .ass passe par notre relais, mis en cache (pages/api/v2/anizone/sub).
      file: `/api/v2/anizone/sub?u=${encodeURIComponent(p.file)}`,
      label: p.label,
      // Le lecteur retient la langue en code court (« fr »), anizone ecrit
      // parfois « pt-BR » / « es-419 » : on garde la region, elle distingue
      // deux pistes que le menu doit montrer toutes les deux.
      language: p.court === "fr" || p.court === "en" ? p.court : p.language || p.court,
      kind: "subtitles",
      type: p.type,
      default: parDefaut,
    };
  });
}

/**
 * Un chip anizone pour un episode.
 * @returns {Promise<{data?:object, absent?:string, transient?:string}>}
 */
export async function resolveAnizone(serverKey, aniId, ep, media) {
  const def = ANIZONE_SERVERS[serverKey];
  if (!def) return { absent: "chip inconnu" };
  try {
    if (!media) return { transient: "anizone : fiche AniList indisponible" };
    const slug = await slugPour(Number(aniId), media);
    if (!slug) return { absent: `anizone : ${aniId} introuvable` };
    const e = await episode(slug, Number(ep));
    if (e.absent) return { absent: e.absent };

    const { lecteur, natif, son } = e;
    const stFr = (lecteur.subtitles || []).some((s) => langCourte(s?.language) === "fr");
    if (def.exige === "son-fr" && !son.includes("fr"))
      return { absent: `anizone ${slug} : pas de piste son fr` };
    if (def.exige === "st-fr" && !stFr)
      return { absent: `anizone ${slug} : pas de sous-titres fr` };
    // Un VO qui ne serait pas japonais n'est pas une VOSTFR.
    if (def.exige === "st-fr" && son.length && !son.includes("ja"))
      return { absent: `anizone ${slug} : pas de piste son ja` };

    return {
      data: {
        streams: [
          {
            url: lecteur.src,
            quality: "1080p",
            isM3U8: true,
            // Un master sans piste ja (doublage seul) garde sa piste par defaut.
            audioLang: son.includes(def.audioLang) ? def.audioLang : undefined,
            subtitlePref: def.subtitlePref,
            /* LECTURE NATIVE (25/11/2026). Le CDN n'accepte le XHR que depuis
               anizone.to (CORS sur master, segments, cles, sous-titres) et
               refuse le Worker (403 depuis Cloudflare, 200 ailleurs) : hls.js
               ne peut rien lire, et un proxy hors Cloudflare paierait chaque
               octet. Le lecteur HLS NATIF du navigateur (Chrome recent, Safari,
               Android) charge en no-cors et lit tout directement — mesure sous
               Chrome 158 : video, cles AES et son jouent depuis une autre
               origine. Le client remonte donc un master d'UNE piste son
               (Chrome n'expose pas `audioTracks`) en blob:, et change de
               langue en le remontant. Zero octet chez nous. */
            native: natif,
            // Rien ne passe par le Worker (il est refuse) : URL jouee telle quelle.
            directUrl: true,
            // Un <video crossorigin> referait des requetes CORS — refusees.
            noCors: true,
          },
        ],
        subtitles: sousTitres(lecteur.subtitles, def),
      },
    };
  } catch (err) {
    if (err instanceof Passager) return { transient: err.message };
    throw err;
  }
}
