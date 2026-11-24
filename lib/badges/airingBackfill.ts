/**
 * LES DATES DE DIFFUSION, pour « Toujours à jour » et « Final le jour même ».
 *
 * Le fil AniList dit QUAND un épisode a été vu, pas quand il est sorti. Le site
 * ne le mesurait qu'à la fin d'un épisode, en devinant la date depuis le prochain
 * épisode : tout le passé manquait (6 comptés pour 87 réels sur un compte).
 *
 * Lu par le navigateur, à l'ouverture de l'onglet Badges. Une `Page` de 50 titres
 * coûte UN point AniList, et les pages d'épisodes y sont imbriquées (mesuré :
 * 5 requêtes pour 148 titres). Seules les œuvres pas encore terminées sont relues.
 */

import { sleep } from "@/utils/sleep";
import { getLocalList } from "../list/localList";
import { readProgressMap } from "../watch/progress";

const KEY = "aniscroll:badgeAiring";
const REFRESH_MS = 12 * 3_600_000;
const GAP_MS = 2200;
const QUERY = `query($ids:[Int],$p:Int){Page(perPage:50){media(id_in:$ids,type:ANIME){id episodes status
  airingSchedule(page:$p,perPage:25){pageInfo{hasNextPage} nodes{episode airingAt}}}}}`;

/** `t` : nombre d'épisodes de l'œuvre, `s` : son statut, `a` : [épisode, secondes]. */
export type AiringInfo = { t: number | null; s?: string | null; a: [number, number][] };
export type AiringMap = Record<number, AiringInfo>;
type Stored = { at: number; complete: boolean; m: AiringMap };

export function readAiring(): Stored | null {
  if (typeof window === "undefined") return null;
  try {
    const p = JSON.parse(window.localStorage.getItem(KEY) || "null");
    return p && typeof p.m === "object" ? p : null;
  } catch {
    return null;
  }
}

async function page(ids: number[], p: number): Promise<any[] | null> {
  for (let essai = 0; essai < 4; essai++) {
    try {
      const r = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { ids, p } }),
      });
      if (r.status === 429) {
        await sleep(((Number(r.headers.get("retry-after")) || 60) + 1) * 1000);
        continue;
      }
      if (!r.ok) return null;
      return (await r.json())?.data?.Page?.media ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Les titres qui peuvent avoir été vus le jour de leur diffusion. */
function candidates(): number[] {
  let feed: [number, number, number][] = [];
  try {
    const raw = JSON.parse(window.localStorage.getItem("aniscroll:anilistFeedEvents") || "[]");
    if (Array.isArray(raw)) feed = raw.filter((r) => Array.isArray(r) && r[0] > 0 && r[1] > 0);
  } catch {
    /* sans fil : la table de lecture suffit */
  }
  const ids = new Set(feed.map((r) => Number(r[1])));
  try {
    const fins = JSON.parse(window.localStorage.getItem("aniscroll:anilistFeedCompletions") || "{}");
    for (const k of Object.keys(fins ?? {})) if (Number(k) > 0) ids.add(Number(k));
  } catch {
    /* sans lignes « completed » : le fil suffit */
  }
  for (const k of Object.keys(readProgressMap())) {
    const id = Number(k.slice(0, k.lastIndexOf(":")));
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  /* Une œuvre finie avant le début de l'historique ne peut rien donner. */
  const first = feed.length ? new Date(Math.min(...feed.map((r) => r[0])) * 1000).getFullYear() : 0;
  const list = getLocalList();
  return [...ids].filter((id) => {
    const e = list[id];
    return !e || e.year == null || e.year >= first - 1 || e.mediaStatus === "RELEASING";
  });
}

let running: Promise<void> | null = null;

export function backfillAiring(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (running) return running;
  running = (async () => {
    const cached = readAiring();
    const ids = candidates();
    const known = cached?.m ?? {};
    const fresh = !!cached?.complete && Date.now() - cached.at < REFRESH_MS;
    const todo = ids.filter((id) => !known[id] || (!fresh && known[id].s !== "FINISHED"));
    if (!todo.length) {
      if (cached?.complete || !ids.length) {
        if (!cached) save({ at: Date.now(), complete: true, m: {} });
        return;
      }
    }

    const m: AiringMap = { ...known };
    for (const id of todo) delete m[id];
    let complete = true;
    let suite = todo;
    for (let p = 1; suite.length && p <= 60 && complete; p++) {
      const next: number[] = [];
      for (let i = 0; i < suite.length; i += 50) {
        const media = await page(suite.slice(i, i + 50), p);
        if (!media) {
          complete = false;
          break;
        }
        for (const x of media) {
          const info = (m[x.id] ??= { t: x.episodes ?? null, s: x.status ?? null, a: [] });
          for (const n of x.airingSchedule?.nodes ?? []) info.a.push([n.episode, n.airingAt]);
          if (x.airingSchedule?.pageInfo?.hasNextPage) next.push(x.id);
        }
        await sleep(GAP_MS);
      }
      suite = next;
    }
    save({ at: Date.now(), complete, m });
  })().finally(() => {
    running = null;
  });
  return running;
}

function save(v: Stored): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    return;
  }
  /* Du passé : l'évaluateur accorde en silence, comme pour un import. */
  window.dispatchEvent(new CustomEvent("aniscroll:localList:bulk"));
}
