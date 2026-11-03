/**
 * LES AMIS ANILIST, pour l'affinité de goûts (03/11/2026, Luc : « finis ceci »).
 *
 * AniScroll n'a pas d'amis à lui ; AniList, si : les comptes que l'on SUIT. Le
 * bloc « Affinité de goûts » les compare à sa propre liste.
 *
 * Lu par le NAVIGATEUR du propriétaire, comme le fil d'activité
 * (feedImport.ts) : AniList limite par adresse, et un serveur qui lirait les
 * listes des amis de tout le monde serait bloqué aussitôt. Une liste par ami,
 * espacées de 2,2 s (~27/min, sous la limite dégradée d'AniList), au plus
 * MAX_FRIENDS amis. Le résultat est gardé 24 h sur l'appareil : on ne relit pas
 * trente listes à chaque visite du profil.
 */

import { type Taste } from "@/lib/profile/affinity";

export type Friend = { id: number; name: string; avatar: string | null; taste: Taste };

const KEY = "aniscroll:anilistFriends";
const TTL_MS = 24 * 3600_000;
const MAX_FRIENDS = 30;
const GAP_MS = 2200;
const MAX_TITLES = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql(token: string, query: string, variables: Record<string, unknown> = {}) {
  for (let tries = 0; tries < 4; tries++) {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    }).catch(() => null);
    if (!r) return null;
    if (r.status === 429) {
      await sleep((Number(r.headers.get("retry-after")) || 60) * 1000);
      continue;
    }
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.data ?? null;
  }
  return null;
}

type Cache = { at: number; me: number; friends: Friend[]; done: boolean };

function readCache(): Cache | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    return c && Array.isArray(c.friends) ? c : null;
  } catch {
    return null;
  }
}
function writeCache(c: Cache) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* plein : on garde ce qui tient, l'affinité n'est qu'un bonus */
  }
}

/** Ce qui est déjà sur l'appareil, sans réseau (pour un premier rendu immédiat). */
export function cachedFriends(): Friend[] {
  return typeof window === "undefined" ? [] : (readCache()?.friends ?? []);
}

let running: Promise<Friend[]> | null = null;

/**
 * Les amis et leurs goûts. `onFriend` est appelé à chaque liste arrivée, pour
 * que le bloc se remplisse au fur et à mesure.
 */
export function loadFriends(token: string, onFriend?: (all: Friend[]) => void): Promise<Friend[]> {
  if (running) return running;
  running = (async () => {
    const cache = readCache();
    if (cache?.done && Date.now() - cache.at < TTL_MS) return cache.friends;

    const me = await gql(token, "query{Viewer{id}}");
    const meId = Number(me?.Viewer?.id);
    if (!meId) return cache?.friends ?? [];

    /* Qui l'on suit, jusqu'à MAX_FRIENDS. */
    const people: { id: number; name: string; avatar: string | null }[] = [];
    for (let p = 1; p <= 3 && people.length < MAX_FRIENDS; p++) {
      const d = await gql(
        token,
        "query($id:Int!,$p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage} following(userId:$id,sort:USERNAME){id name avatar{medium}}}}",
        { id: meId, p },
      );
      if (!d) break;
      for (const u of d.Page?.following ?? []) {
        if (u?.id && u?.name) people.push({ id: u.id, name: u.name, avatar: u.avatar?.medium ?? null });
      }
      if (!d.Page?.pageInfo?.hasNextPage) break;
      await sleep(GAP_MS);
    }

    /* Les listes déjà connues (moins de 24 h) ne sont pas relues. */
    const fresh = cache && cache.me === meId && Date.now() - cache.at < TTL_MS;
    const known = new Map((fresh ? cache!.friends : []).map((f) => [f.id, f]));
    const out: Friend[] = [];
    for (const u of people.slice(0, MAX_FRIENDS)) {
      const had = known.get(u.id);
      if (had) {
        out.push({ ...had, name: u.name, avatar: u.avatar });
        continue;
      }
      await sleep(GAP_MS);
      const d = await gql(
        token,
        "query($id:Int){MediaListCollection(userId:$id,type:ANIME){lists{entries{mediaId status score(format:POINT_10_DECIMAL)}}}}",
        { id: u.id },
      );
      /* Une liste privée ou illisible : l'ami est sauté, pas tout le bloc. */
      if (!d) continue;
      const taste: Taste = {};
      let n = 0;
      for (const l of d.MediaListCollection?.lists ?? []) {
        for (const e of l?.entries ?? []) {
          if (!e?.mediaId || e.status === "PLANNING") continue;
          taste[e.mediaId] = e.score && e.score > 0 ? e.score : 0;
          if (++n >= MAX_TITLES) break;
        }
      }
      out.push({ ...u, taste });
      writeCache({ at: Date.now(), me: meId, friends: out, done: false });
      onFriend?.(out.slice());
    }
    writeCache({ at: Date.now(), me: meId, friends: out, done: true });
    return out;
  })().finally(() => {
    running = null;
  });
  return running;
}
