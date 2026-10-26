/**
 * LES PERSONNAGES FAVORIS, ÉDITÉS DEPUIS LE PANNEAU DU WIDGET (25/10/2026, Luc).
 *
 * Tout passe par AniList, en direct depuis le navigateur avec le jeton de la
 * session : ajouter / retirer = `ToggleFavourite(characterId)`, réordonner =
 * `UpdateFavouriteOrder`. Hors aniscroll.com, rien ne part (lib/anilist/
 * writeGuard) : la liste change sur la page seulement. Les requêtes sont dans
 * favCharsQueries.ts, vérifiées contre le schéma d'AniList le 25/10/2026.
 *
 * UNE LISTE PARTAGÉE : le panneau édite, le widget affiche, les deux lisent la
 * même (`useFavChars`).
 *
 * LA COPIE LOCALE. Le rendu serveur sert une liste AniList gardée jusqu'à 24 h
 * et rafraîchie en arrière-plan (pages/en/profile/[user].tsx) : recharger juste
 * après une modification remontrerait l'ancien ordre. La liste éditée est donc
 * gardée ici 30 min et l'emporte, chez le propriétaire seulement.
 */

import { useEffect, useState } from "react";

import { anilistWritesAllowed } from "@/lib/anilist/writeGuard";
import { LIVE_FAVS, ORDER, SEARCH, SEARCH_ANIME, TOGGLE } from "./favCharsQueries";
import type { ProfileCharacter } from "./types";

const ENDPOINT = "https://graphql.anilist.co/";
const KEY = "aniscroll.favChars";
const OVERRIDE_MS = 30 * 60_000;
const EVENT = "aniscroll:favchars";

const toChar = (n: any): ProfileCharacter | null =>
  n?.id && n?.name?.full
    ? {
        id: n.id,
        name: n.name.full,
        image: n.image?.large ?? null,
        from: n.media?.nodes?.[0]?.title?.english || n.media?.nodes?.[0]?.title?.romaji || null,
      }
    : null;

async function call(query: string, variables: Record<string, unknown>, token?: string | null) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.errors?.length) throw new Error(json?.errors?.[0]?.message || `HTTP ${res.status}`);
  return json?.data;
}

/* ── La liste partagée ─────────────────────────────────────────────── */

let shared: ProfileCharacter[] | null = null;

function readOverride(): ProfileCharacter[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || !Array.isArray(raw.list) || Date.now() - raw.ts > OVERRIDE_MS) return null;
    return raw.list;
  } catch {
    return null;
  }
}

/** Remplace la liste partagée, la garde 30 min, prévient les abonnés.
 *  `persist: false` pendant un glisser : écrire le stockage à chaque case
 *  franchie coûtait une sérialisation par mouvement ; on l'écrit au lâcher. */
export function setFavChars(list: ProfileCharacter[], opts: { persist?: boolean } = {}): void {
  shared = list;
  if (opts.persist !== false) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), list }));
    } catch {
      /* stockage plein ou coupé : la page reste juste */
    }
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Un anime trouvé par la recherche « Anime » du widget. */
export type FoundAnime = { id: number; title: string; cover: string | null };

/**
 * LES ANIMES, POUR LE MODE « ANIME » DE LA RECHERCHE (25/10/2026, Luc). Comme
 * la recherche du studio (BannerStudio) : AniList d'abord, puis notre base
 * (`/api/v2/search`, la route de la barre du site), qui trouve les titres
 * français et les synonymes qu'AniList rate. Sans doublon.
 */
export async function searchAnimes(q: string): Promise<FoundAnime[] | null> {
  const ani = call(SEARCH_ANIME, { search: q })
    .then((d) => (d?.Page?.media ?? []) as any[])
    .catch(() => null);
  const local = fetch(`/api/v2/search?q=${encodeURIComponent(q.replace(/\s+/g, " ").toLowerCase())}&limit=8`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => ((j?.results ?? []) as any[]).filter((m) => m?.id && m.title && !m.isAdult))
    .catch(() => null);
  const [a, l] = await Promise.all([ani, local]);
  if (a == null && l == null) return null;
  const seen = new Set<number>();
  const out: FoundAnime[] = [];
  for (const m of [...(a ?? []), ...(l ?? [])]) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      title: m.title?.userPreferred || m.title?.english || m.title?.romaji || `#${m.id}`,
      cover: m.coverImage?.large ?? m.coverImage?.medium ?? null,
    });
  }
  return out;
}

/** La liste à afficher : celle du serveur, sauf édition récente du propriétaire. */
export function useFavChars(server: ProfileCharacter[], isOwner: boolean): ProfileCharacter[] {
  const [list, setList] = useState(server);
  useEffect(() => {
    if (!isOwner) {
      setList(server);
      return;
    }
    if (!shared) shared = readOverride();
    setList(shared ?? server);
    const read = () => setList(shared ?? server);
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, [server, isOwner]);
  return list;
}

/* ── AniList ───────────────────────────────────────────────────────── */

/** La liste RÉELLE du compte connecté, page par page (100 au plus). */
export async function loadLiveFavChars(token: string): Promise<ProfileCharacter[] | null> {
  try {
    const out: ProfileCharacter[] = [];
    for (let page = 1; page <= 4; page++) {
      const block = (await call(LIVE_FAVS, { page }, token))?.Viewer?.favourites?.characters;
      if (!block) return null;
      for (const n of block.nodes ?? []) {
        const c = toChar(n);
        if (c && !out.some((x) => x.id === c.id)) out.push(c);
      }
      if (!block.pageInfo?.hasNextPage) break;
    }
    return out;
  } catch {
    return null;
  }
}

/** Recherche par nom, avec l'anime d'origine en sous-titre. `null` = échec. */
export async function searchFavChars(q: string): Promise<ProfileCharacter[] | null> {
  try {
    const d = await call(SEARCH, { q });
    return (d?.Page?.characters ?? []).map(toChar).filter(Boolean) as ProfileCharacter[];
  } catch {
    return null;
  }
}

/** `true` : envoyé (ou hors prod, où rien ne part — cf. l'en-tête). */
export async function toggleFavChar(token: string, id: number): Promise<boolean> {
  if (!anilistWritesAllowed()) return true;
  try {
    await call(TOGGLE, { id }, token);
    return true;
  } catch {
    return false;
  }
}

export async function saveFavCharOrder(token: string, ids: number[]): Promise<boolean> {
  if (!anilistWritesAllowed()) return true;
  try {
    await call(ORDER, { ids, order: ids.map((_, i) => i + 1) }, token);
    return true;
  } catch {
    return false;
  }
}
