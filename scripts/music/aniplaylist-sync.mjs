#!/usr/bin/env node
/**
 * LES MUSIQUES D'ANIPLAYLIST, relevées automatiquement (24/10/2026, Luc).
 *
 * Pourquoi : AnisongDB (la source des inserts du menu Musique) est tenue à la
 * main par la communauté d'Anime Music Quiz ; un anime qui vient de sortir n'y
 * est pas. Cyberpunk: Edgerunners 2, sorti le 20/10, y avait 0 musique quand
 * AniPlaylist en avait déjà 29 (inserts, endings, avec un extrait de 30 s).
 *
 * COMMENT, SANS RIEN CONTOURNER : AniPlaylist n'a pas d'API, et sa clé Algolia
 * est restreinte par referer (raison de son rejet le 18/10/2026). Ce script
 * charge donc les pages dans un VRAI Chrome headless, comme n'importe quel
 * visiteur, et lit les réponses que la page reçoit elle-même. Leur robots.txt
 * autorise tout (« User-agent: * / Disallow: »). AniPlaylist est un projet de
 * fans : un seul onglet, une page à la fois, une pause entre deux.
 *
 * Chaque URL est une recherche (aniplaylist.com/<titre>). On garde les
 * morceaux dont l'anime porte EXACTEMENT un titre de l'anime AniList (romaji,
 * anglais, natif, synonymes) et, quand AniPlaylist donne la saison, la même
 * saison : « Cyberpunk: Edgerunners » ne ramène jamais « … Edgerunners 2 ».
 *
 * LA FILE = L'ÉTAT DE LA TABLE `aniplaylist_songs` (comme refresh-characters) :
 * jamais relevé, ou expiré. En cours de diffusion → 2 jours, à venir → 14
 * jours, terminé depuis moins d'un an → 7 jours, plus vieux → 60 jours. Chaque relevé REMPLACE la
 * liste de l'anime : une musique ajoutée sur AniPlaylist arrive au passage
 * suivant. Les animes en diffusion passent d'abord, puis le reste du
 * catalogue par popularité, dans le budget de temps.
 *
 *   node scripts/music/aniplaylist-sync.mjs
 *   node scripts/music/aniplaylist-sync.mjs --max-minutes=30
 *   node scripts/music/aniplaylist-sync.mjs --ids=195539,154587   (test)
 *
 * CHROME_PATH : le Chrome à lancer (défaut : celui de Windows ; sur GitHub
 * Actions, /usr/bin/google-chrome).
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
};
const MAX_MINUTES = parseFloat(opt("max-minutes", "25"));
const ONLY_IDS = opt("ids", "")
  .split(",")
  .map(Number)
  .filter((n) => n > 0);

const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const PORT = Number(process.env.CDP_PORT || 9368);
const PAUSE_MS = 1500; /* entre deux animes : un visiteur pressé, pas plus */
const MAX_SCROLLS = 25; /* 16 morceaux par page : 400 au plus */

const DAY = 86400;
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("✘ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  process.exit(1);
}
const db = createClient({ url, authToken });
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Chrome (CDP, sans dépendance — cf. tools/ost-resolver) ─────────────── */
async function openChrome() {
  const profil = mkdtempSync(join(tmpdir(), "aniplaylist-sync-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profil}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--mute-audio",
      "--no-sandbox",
      "--window-size=1400,2000",
    ],
    { stdio: "ignore" },
  );
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      wsUrl = pages.find((p) => p.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {}
    if (!wsUrl) await dors(250);
  }
  if (!wsUrl) throw new Error("Chrome n'a pas ouvert son port CDP");
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", j);
  });
  let n = 0;
  const wait = new Map();
  const urls = new Map();
  /** Les réponses Algolia reçues depuis la dernière navigation. */
  let got = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) {
      wait.get(m.id)(m.result ?? null);
      wait.delete(m.id);
    }
    if (m.method === "Network.responseReceived") urls.set(m.params.requestId, m.params.response.url);
    if (m.method === "Network.loadingFinished" && /-dsn\.algolia\.net\/1\/indexes/.test(urls.get(m.params.requestId) || "")) {
      send("Network.getResponseBody", { requestId: m.params.requestId }).then((b) => {
        try {
          if (b?.body) got.push(JSON.parse(b.body));
        } catch {}
      });
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      wait.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Network.enable");
  await send("Page.enable");
  return {
    send,
    take: () => got,
    reset: () => {
      got = [];
    },
    close: () => {
      try {
        ws.close();
      } catch {}
      proc.kill();
      try {
        rmSync(profil, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Toutes les réponses de la recherche `q` : on fait défiler jusqu'à ce que
    le compte annoncé (`nbHits`) soit atteint ou que plus rien n'arrive. */
async function search(chrome, q) {
  chrome.reset();
  await chrome.send("Page.navigate", { url: `https://aniplaylist.com/${encodeURIComponent(q)}` });
  const hits = new Map();
  let total = null;
  let still = 0;
  for (let i = 0; i < MAX_SCROLLS; i++) {
    await dors(i === 0 ? 2500 : 900);
    for (const res of chrome.take().splice(0)) {
      for (const r of res?.results ?? []) {
        if (r.index !== "songs_prod") continue;
        total = r.nbHits ?? total;
        for (const h of r.hits ?? []) hits.set(h.objectID ?? h.id, h);
      }
    }
    if (total != null && hits.size >= total) break;
    const before = hits.size;
    await chrome.send("Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" });
    if (i > 2 && hits.size === before) still++;
    else still = 0;
    if (still >= 3) break;
  }
  return [...hits.values()];
}

/* ── Rapprochement avec l'anime AniList ─────────────────────────────────── */
const norm = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
/* Une saison en nombre : année × 4 + rang (hiver 0 … automne 3). */
const RANK = { winter: 0, spring: 1, summer: 2, fall: 3 };
const fromMonth = (y, m) => y * 4 + Math.floor(((m || 1) - 1) / 3);
function seasonIndex(label) {
  const [s, y] = String(label).toLowerCase().split(/\s+/);
  return RANK[s] != null && Number(y) ? Number(y) * 4 + RANK[s] : null;
}

/* LA SAISON D'UN MORCEAU, chez AniPlaylist, est celle de SA sortie, pas celle
   du début de l'anime : le 2e opening de Frieren est « Winter 2024 », les
   openings de One Piece s'étalent de 1999 à aujourd'hui. On accepte donc
   toute saison entre le début et la fin de diffusion (une saison de marge de
   chaque côté : un générique sort souvent avant l'épisode). */
function matches(h, a) {
  const names = (h.anime_titles ?? []).map(norm).filter(Boolean);
  if (!names.some((n) => a.names.has(n))) return false;
  const at = h.season ? seasonIndex(h.season) : null;
  if (at != null && a.from != null && (at < a.from - 1 || at > a.to + 1)) return false;
  return true;
}

/* LE FORMAT GARDÉ, compact, relu par pages/api/v2/anisongs/[id].ts :
   { i: id, k: "op"|"ed"|"ins", t: titre, a: [artistes], e: "4" (épisodes),
     p: extrait (Apple, 30 s), c: vignette (chemin sur cdn.aniplaylist.com),
     s: score de popularité AniPlaylist }
   Seuls les MORCEAUX jouables : pas les albums (OST, Vocal Album), pas ceux
   sans extrait. */
const KIND = { Opening: "op", Ending: "ed", Insert: "ins", "Theme Song": "ins" };
function compact(h) {
  const k = KIND[h.song_type];
  if (!k || h.type !== "track" || !h.preview_url || !h.titles?.[0]) return null;
  /* La liste structurée, un nom par artiste : `display_artists` répète les
     noms PUIS le crédit entier (« A, B, C, A, B & C »). */
  const structured = [...new Set((h.artists ?? []).map((x) => x?.names?.[0]).filter(Boolean))];
  /* La structure elle-même contient parfois le crédit groupé (« A, B & C »)
     à côté de A, B et C : il saute quand ses noms sont déjà là. */
  const solo = structured.filter(
    (n) => !/,\s|\s&\s/.test(n) || !n.split(/,\s*|\s+&\s+/).every((p) => structured.includes(p.trim())),
  );
  const artists = solo.length ? solo : (h.display_artists ?? []).map(String).slice(0, 1);
  return {
    i: h.id,
    k,
    t: String(h.titles[0]),
    a: artists.slice(0, 4),
    e: Array.isArray(h.episodes) && h.episodes.length ? h.episodes.join(", ") : null,
    p: h.preview_url,
    c: h.thumbnail || null,
    s: typeof h.score === "number" ? h.score : null,
  };
}

function ttl(a) {
  const year = new Date().getUTCFullYear();
  /* À VENIR : 14 jours, pas 2 (24/10/2026). Le premier relevé l'a montré :
     ~740 titres annoncés, presque tous sans aucune musique encore, et un
     passage n'en traite que ~260 — redemandés tous les 2 jours, ils
     occupaient tout le budget, et le reste du catalogue n'était jamais
     atteint. Un générique annoncé arrive au plus tard deux semaines après. */
  const base =
    a.status === "RELEASING"
      ? 2 * DAY
      : a.status === "NOT_YET_RELEASED"
        ? 14 * DAY
        : a.year && a.year >= year - 1
          ? 7 * DAY
          : 60 * DAY;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

async function ensureTable() {
  await db.execute(`CREATE TABLE IF NOT EXISTS aniplaylist_songs (
    ani_id      INTEGER PRIMARY KEY,
    n           INTEGER NOT NULL,
    data        TEXT    NOT NULL,
    checked_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  )`);
}

async function main() {
  const t0 = Date.now();
  await ensureTable();
  const now = Math.floor(Date.now() / 1000);
  const r = await db.execute({
    sql: `SELECT a.id, a.status, a.season, a.season_year,
                 json_extract(a.data, '$.title') AS title,
                 json_extract(a.data, '$.synonyms') AS syn,
                 json_extract(a.data, '$.startDate') AS sd,
                 json_extract(a.data, '$.endDate') AS ed
            FROM anime a
            LEFT JOIN aniplaylist_songs p ON p.ani_id = a.id
           WHERE ${ONLY_IDS.length ? `a.id IN (${ONLY_IDS.map(() => "?").join(",")})` : `(a.type IS NULL OR a.type = 'ANIME') AND a.is_adult = 0 AND (p.ani_id IS NULL OR p.expires_at < ?)`}
           ORDER BY (a.status = 'RELEASING') DESC, a.popularity DESC NULLS LAST
           LIMIT 3000`,
    args: ONLY_IDS.length ? ONLY_IDS : [now],
  });
  const queue = r.rows.map((row) => {
    const t = row.title ? JSON.parse(String(row.title)) : {};
    const syn = row.syn ? JSON.parse(String(row.syn)) : [];
    const names = new Set([t.romaji, t.english, t.native, t.userPreferred, ...(syn || [])].map(norm).filter(Boolean));
    const sd = row.sd ? JSON.parse(String(row.sd)) : null;
    const ed = row.ed ? JSON.parse(String(row.ed)) : null;
    const today = new Date();
    return {
      id: Number(row.id),
      status: row.status,
      season: row.season,
      year: row.season_year ? Number(row.season_year) : null,
      names,
      from: sd?.year ? fromMonth(sd.year, sd.month) : null,
      /* Pas de fin connue (en cours, ou fiche incomplète) : jusqu'à aujourd'hui. */
      to: ed?.year ? fromMonth(ed.year, ed.month) : fromMonth(today.getUTCFullYear(), today.getUTCMonth() + 1),
      /* La recherche : l'anglais d'abord (AniPlaylist nomme surtout en anglais), le romaji ensuite. */
      queries: [...new Set([t.english, t.romaji].filter(Boolean))],
    };
  });
  console.log(`┌─ AniPlaylist : ${queue.length} anime(s) dans la file (budget ${MAX_MINUTES} min)`);

  const chrome = await openChrome();
  const deadline = Date.now() + MAX_MINUTES * 60_000;
  let done = 0;
  let songs = 0;
  let withSongs = 0;
  try {
    for (const a of queue) {
      if (Date.now() > deadline) {
        console.log(`│  ↳ ${MAX_MINUTES} min écoulées — la suite au prochain passage`);
        break;
      }
      let kept = [];
      for (const q of a.queries) {
        const hits = await search(chrome, q);
        kept = hits.filter((h) => matches(h, a)).map(compact).filter(Boolean);
        if (kept.length) break;
        await dors(PAUSE_MS);
      }
      /* Doublons possibles (le même morceau sous deux fiches) : un par titre et type. */
      const seen = new Set();
      kept = kept.filter((x) => {
        const key = `${x.k}:${norm(x.t)}`;
        return seen.has(key) ? false : (seen.add(key), true);
      });
      const checked = Math.floor(Date.now() / 1000);
      await db.execute({
        sql: `INSERT INTO aniplaylist_songs (ani_id, n, data, checked_at, expires_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(ani_id) DO UPDATE SET n = excluded.n, data = excluded.data,
                checked_at = excluded.checked_at, expires_at = excluded.expires_at`,
        args: [a.id, kept.length, JSON.stringify(kept), checked, checked + ttl(a)],
      });
      done++;
      songs += kept.length;
      if (kept.length) withSongs++;
      if (ONLY_IDS.length || done % 25 === 0)
        console.log(`│  ↳ ${done} relevés — ${withSongs} avec musiques, ${songs} morceaux (${((Date.now() - t0) / 60000).toFixed(1)} min)${ONLY_IDS.length ? ` · ${a.queries[0]} : ${kept.length}` : ""}`);
      await dors(PAUSE_MS);
    }
  } finally {
    chrome.close();
  }
  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`└─ ${done} relevés, ${withSongs} avec musiques, ${songs} morceaux en ${Math.floor(dt / 60)}m${dt % 60}s`);
}

main().catch((e) => {
  console.error("✘ aniplaylist-sync crashed:", e);
  process.exit(1);
});
