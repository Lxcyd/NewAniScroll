import { timeoutSignal } from "@/lib/net/timeoutSignal";
/**
 * L'IMPORT DU FIL D'ACTIVITÉ ANILIST (03/11/2026, Luc : « quand on se connecte
 * à AniList, tu peux récupérer toutes les données automatiquement ? »).
 *
 * AniList garde une ligne datée par épisode marqué vu (« A regardé l'épisode 4
 * de … »), depuis la création du compte AniList. C'est le seul historique daté
 * qui existe : la liste ne dit que COMBIEN d'épisodes, pas QUAND.
 *
 * Lu par le NAVIGATEUR du propriétaire, pas par le serveur : AniList limite les
 * requêtes par adresse (90/min, souvent 30), et un serveur qui lirait le fil de
 * tout le monde serait bloqué aussitôt — en plus de brûler le CPU Vercel. La
 * première fois, tout le fil (77 pages pour Luc, 2 à 3 min, lentement pour
 * laisser de la marge au reste du site) ; ensuite seulement les nouvelles lignes,
 * jusqu'à la dernière activité déjà rangée (en général une page).
 *
 * Rangé sur le compte par /api/v2/account/anilist-feed ; la page de profil le
 * mêle à la progression (lib/profile/activity.ts).
 */

type FeedEvent = [number, number, number];

const AT_KEY = "aniscroll:anilistFeedAt";
/** Pas plus d'une lecture toutes les 30 min par appareil. */
const EVERY_MS = 30 * 60_000;
/** Une page toutes les 2,2 s : ~27/min, sous la limite dégradée d'AniList. */
const PAGE_GAP_MS = 2200;
const MAX_PAGES = 400;

const QUERY = `query($id:Int,$p:Int,$before:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage}
activities(userId:$id,type:ANIME_LIST,sort:ID_DESC,createdAt_lesser:$before){... on ListActivity{id createdAt status progress media{id}}}}}`;
/** Un envoi toutes les 5 pages : un rechargement ne perd qu'une dizaine de secondes. */
const SAVE_EVERY = 5;

let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function page(token: string | undefined, id: number, p: number, before?: number) {
  for (let tries = 0; tries < 6; tries++) {
    const r = await fetch("https://graphql.anilist.co", {
      signal: timeoutSignal(15000),
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        /* Le jeton : un profil AniList privé ne montre son fil qu'à lui-même. */
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      /* JAMAIS `null` (06/11/2026) : AniList répond 400 « Illegal operator and
         value combination » à `createdAt_lesser: null`. La lecture des nouvelles
         lignes, qui n'a pas de borne, échouait donc à chaque fois depuis la fin
         de l'import initial — le fil s'était figé le 03/11. Demain fait office
         de « pas de borne ». */
      body: JSON.stringify({ query: QUERY, variables: { id, p, before: before ?? Math.floor(Date.now() / 1000) + 86_400 } }),
    });
    if (r.status === 429) {
      await sleep((Number(r.headers.get("retry-after")) || 60) * 1000);
      continue;
    }
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.data?.Page ?? null;
  }
  return null;
}

/** « 4 » ou « 1 - 3 » → les épisodes. */
function episodes(progress: unknown): number[] {
  const m = String(progress ?? "")
    .split("-")
    .map((s) => Number(s.trim()));
  if (m.length === 1 && Number.isInteger(m[0]) && m[0] > 0) return [m[0]];
  if (m.length === 2 && Number.isInteger(m[0]) && Number.isInteger(m[1]) && m[0] > 0 && m[1] >= m[0] && m[1] - m[0] < 500) {
    return Array.from({ length: m[1] - m[0] + 1 }, (_, i) => m[0] + i);
  }
  return [];
}

/** Les heures du fil (en heures depuis 1970), gardees pour les badges de serie
 *  (lib/badges/evaluate.ts) : ils se calculent ici, le fil vit sur le serveur. */
export const FEED_HOURS_KEY = "aniscroll:anilistFeedHours";

/** Les lignes du fil : les badges de rythme, d'heure et de date les lisent. */
export const FEED_EVENTS_KEY = "aniscroll:anilistFeedEvents";
/** Les lignes « completed » : AniList y range souvent le DERNIER épisode, sans numéro. */
export const FEED_COMPLETIONS_KEY = "aniscroll:anilistFeedCompletions";

async function storeFeedHours(): Promise<void> {
  try {
    const r = await fetch("/api/v2/account/anilist-feed?hours=1&events=1");
    const j = r.ok ? await r.json() : null;
    if (Array.isArray(j?.h)) localStorage.setItem(FEED_HOURS_KEY, JSON.stringify(j.h));
    if (Array.isArray(j?.ev)) {
      localStorage.setItem(FEED_EVENTS_KEY, JSON.stringify(j.ev));
      localStorage.setItem(FEED_COMPLETIONS_KEY, JSON.stringify(j.c ?? {}));
      /* Du passé : l'évaluateur accorde en silence, comme pour un import. */
      window.dispatchEvent(new CustomEvent("aniscroll:localList:bulk"));
    }
  } catch {
    /* best-effort : sans elles, les badges ne voient que la table locale */
  }
}

/** Prévient un détail de badge ouvert que de nouvelles dates de fin sont rangées. */
export const FEED_FINS_EVENT = "aniscroll:anilistFeedFins";
const estFin = (a: any) => /^completed/i.test(String(a?.status ?? "")) && !!a?.media?.id;

let finsEnCours = false;

/**
 * Les lignes « completed » du passé, lues UNE fois pour tout le compte.
 *
 * Le premier import n'a gardé que les lignes d'épisode : un anime passé en
 * Terminé sans cocher d'épisode n'y a aucune date. Reprise comme l'import
 * principal, sous la plus ancienne date déjà lue, avec un envoi toutes les dix
 * pages. Sans le délai de 30 min : tant que ce n'est pas fini, ça reprend.
 */
async function syncCompletions(token: string | undefined): Promise<boolean> {
  if (finsEnCours || typeof window === "undefined") return false;
  finsEnCours = true;
  try {
    const state = await fetch("/api/v2/account/anilist-feed")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const id = Number(state?.anilistId);
    if (!id || state?.cDone) return false;
    const before = Number(state?.cOldest) || Math.floor(Date.now() / 1000) + 86_400;
    let c: Record<number, number> = {};
    let low = before;
    let changed = false;
    for (let p = 1; p <= MAX_PAGES; p++) {
      const d = await page(token, id, p, before);
      if (!d) return changed;
      for (const a of d.activities ?? []) {
        if (!a?.id) continue;
        low = Math.min(low, a.createdAt);
        if (estFin(a)) c[a.media.id] = Math.min(c[a.media.id] ?? Infinity, a.createdAt);
      }
      const end = !d.pageInfo?.hasNextPage;
      if (end || p % 10 === 0) {
        const ok = await fetch("/api/v2/account/anilist-feed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ e: [], last: 0, c, cOldest: low, cDone: end }),
        })
          .then((r) => r.ok)
          .catch(() => false);
        if (!ok) return changed;
        changed = true;
        c = {};
        window.dispatchEvent(new CustomEvent(FEED_FINS_EVENT));
      }
      if (end) break;
      await sleep(PAGE_GAP_MS);
    }
    return changed;
  } finally {
    finsEnCours = false;
  }
}

/** Vrai quand de nouvelles lignes ont été rangées (le profil est alors à recharger). */
export async function syncAnilistFeed(token: string | undefined): Promise<boolean> {
  const changed = await syncFeed(token);
  await syncCompletions(token);
  /* Relues quand le fil a bouge, ou tant qu'elles n'ont jamais ete lues. */
  try {
    if (changed || !localStorage.getItem(FEED_HOURS_KEY) || !localStorage.getItem(FEED_EVENTS_KEY) || !localStorage.getItem(FEED_COMPLETIONS_KEY)) {
      await storeFeedHours();
    }
  } catch {
    /* sans stockage */
  }
  return changed;
}

async function syncFeed(token: string | undefined): Promise<boolean> {
  if (running || typeof window === "undefined") return false;
  try {
    if (Date.now() - Number(localStorage.getItem(AT_KEY) || 0) < EVERY_MS) return false;
  } catch {
    /* sans stockage : on lit quand même, la reprise borne le coût */
  }
  running = true;
  let changed = false;
  try {
    const state = await fetch("/api/v2/account/anilist-feed")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const id = Number(state?.anilistId);
    if (!id) return false;
    const last = Number(state?.last) || 0;
    const save = (body: { e: FeedEvent[]; last: number; oldest?: number; done?: boolean; c?: Record<number, number> }) =>
      fetch("/api/v2/account/anilist-feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((r) => r.ok)
        .catch(() => false);
    /* « watched episode » et « rewatched episode » ; pas « completed »,
       « plans to watch »… qui ne portent pas d'épisode. */
    const take = (a: any, into: FeedEvent[]) => {
      if (!/episode/i.test(String(a.status)) || !a.media?.id) return;
      for (const ep of episodes(a.progress)) into.push([a.createdAt, a.media.id, ep]);
    };

    /* 1. LES NOUVELLES LIGNES, au-dessus de la dernière déjà rangée. */
    if (last > 0) {
      const e: FeedEvent[] = [];
      const c: Record<number, number> = {};
      let top = last;
      for (let p = 1; p <= MAX_PAGES; p++) {
        const d = await page(token, id, p);
        if (!d) return changed; // AniList en panne : on réessaiera à la prochaine visite
        let reached = false;
        for (const a of d.activities ?? []) {
          if (!a?.id) continue;
          if (a.id <= last) {
            reached = true;
            break;
          }
          top = Math.max(top, a.id);
          take(a, e);
          if (estFin(a)) c[a.media.id] = Math.min(c[a.media.id] ?? Infinity, a.createdAt);
        }
        if (reached || !d.pageInfo?.hasNextPage) break;
        await sleep(PAGE_GAP_MS);
      }
      if (top > last) {
        if (!(await save({ e, last: top, c }))) return changed;
        changed = true;
      }
    }

    /* 2. LE PASSÉ, tant qu'il n'est pas lu jusqu'au bout. Une REPRISE : on
       relit sous la plus ancienne date déjà rangée (`createdAt_lesser`), et on
       range toutes les 5 pages. Un rechargement en pleine lecture ne perdait
       sinon que tout — c'est ce qui est arrivé au premier essai (03/11/2026). */
    if (!state?.done) {
      const before = Number(state?.oldest) || Math.floor(Date.now() / 1000) + 86_400;
      let e: FeedEvent[] = [];
      let top = last;
      let low = before;
      for (let p = 1; p <= MAX_PAGES; p++) {
        const d = await page(token, id, p, before);
        if (!d) return changed;
        for (const a of d.activities ?? []) {
          if (!a?.id) continue;
          top = Math.max(top, a.id);
          low = Math.min(low, a.createdAt);
          take(a, e);
        }
        const end = !d.pageInfo?.hasNextPage;
        if (end || p % SAVE_EVERY === 0) {
          if (!(await save({ e, last: top, oldest: low, done: end }))) return changed;
          changed = true;
          e = [];
        }
        if (end) break;
        await sleep(PAGE_GAP_MS);
      }
    }
    try {
      localStorage.setItem(AT_KEY, String(Date.now()));
    } catch {
      /* best-effort */
    }
    return changed;
  } finally {
    running = false;
  }
}
