/**
 * Le côté navigateur des amis (API : pages/api/v2/account/friends.ts).
 * Un seul endroit pour les appels, partagé par le bouton du profil, l'onglet
 * Amis et le widget « Affinité de goûts ».
 */

export type FriendState = "out" | "in" | "friend";
export type FriendCard = { tag: string; name: string; avatar: string | null; href: string; since: number };
export type Taste = Record<string, number>;

const API = "/api/v2/account/friends";

/* Une action ailleurs sur la page (le bouton du profil, l'onglet) prévient
   les autres, qui relisent. */
export const FRIENDS_EVENT = "aniscroll:friends";
const changed = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FRIENDS_EVENT));
};

async function get<T>(qs: string): Promise<T | null> {
  try {
    const r = await fetch(`${API}${qs}`, { credentials: "same-origin" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export function myFriends() {
  return get<{ friends: FriendCard[]; incoming: FriendCard[]; outgoing: FriendCard[] }>("");
}

export async function friendsOf(tag: string) {
  return (await get<{ friends: FriendCard[] }>(`?of=${encodeURIComponent(tag)}`))?.friends ?? [];
}

export async function stateWith(tag: string): Promise<FriendState | "none" | "self" | "guest" | null> {
  return (await get<{ state: FriendState | "none" | "self" | "guest" }>(`?with=${encodeURIComponent(tag)}`))?.state ?? null;
}

export async function searchPeople(q: string) {
  return (await get<{ users: (FriendCard & { state: FriendState | "none" })[] }>(`?q=${encodeURIComponent(q)}`))?.users ?? [];
}

export async function friendTastes() {
  return (await get<{ friends: (FriendCard & { taste: Taste })[] }>("?tastes=1"))?.friends ?? null;
}

/* Un refus du serveur (trop de demandes, plafond atteint) est annoncé à la
   page : FriendErrorToast l'affiche, quel que soit le bouton qui l'a causé. */
export const FRIENDS_ERROR_EVENT = "aniscroll:friends-error";
export type FriendError = "throttled" | "full" | "failed";
const failed = (why: FriendError) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FRIENDS_ERROR_EVENT, { detail: why }));
};

export async function friendAction(tag: string, action: "request" | "accept" | "remove"): Promise<FriendState | "none" | null> {
  try {
    const r = await fetch(API, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag, action }),
    });
    if (!r.ok) {
      failed(r.status === 429 ? "throttled" : r.status === 409 ? "full" : "failed");
      changed(); // l'état affiché peut être périmé : on relit
      return null;
    }
    const j = await r.json();
    changed();
    return j.state ?? null;
  } catch {
    failed("failed");
    return null;
  }
}

/**
 * PAS BESOIN DE RECHARGER (03/11/2026, Luc) : `load` est rejoué au retour sur
 * l'onglet du navigateur, à chaque action ailleurs sur la page
 * (FRIENDS_EVENT), et toutes les `everyMs` tant que la page est VISIBLE.
 * Caché, rien ne part : chaque appel est une invocation Vercel et une lecture
 * Turso, et un onglet oublié ne doit rien coûter.
 */
export function watchFriends(load: () => void, everyMs = 20_000): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    clearInterval(timer);
    if (everyMs > 0 && document.visibilityState === "visible") timer = setInterval(load, everyMs);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") load();
    start();
  };
  load();
  start();
  window.addEventListener(FRIENDS_EVENT, load);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", load);
  return () => {
    clearInterval(timer);
    window.removeEventListener(FRIENDS_EVENT, load);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", load);
  };
}

/* ── Mes goûts, rangés sur le compte ──
   Envoyés quand on ouvre son propre profil, et seulement s'ils ont changé
   depuis le dernier envoi depuis cet appareil (empreinte en localStorage). */
const SENT_KEY = "aniscroll:tasteSent";
function print(t: Taste): string {
  let h = 0;
  const s = JSON.stringify(Object.keys(t).sort().map((k) => [k, t[k]]));
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}
export function sendMyTaste(taste: Taste) {
  if (!Object.keys(taste).length) return;
  const fp = print(taste);
  try {
    if (localStorage.getItem(SENT_KEY) === fp) return;
  } catch {
    /* sans stockage : on envoie, le serveur ne réécrit pas un contenu identique */
  }
  void fetch(API, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taste }),
  })
    .then((r) => {
      try {
        if (r.ok) localStorage.setItem(SENT_KEY, fp);
      } catch {
        /* stockage bloqué */
      }
    })
    .catch(() => {});
}
