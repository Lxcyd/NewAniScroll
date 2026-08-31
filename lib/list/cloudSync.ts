/**
 * Cloud backup of the local stores, for a signed-in account.
 *
 * Deliberately a LISTENER, not a rewrite: every store already announces its
 * changes with a CustomEvent (aniscroll:localList:change, …), so this module
 * subscribes and pushes. No existing store is modified, and a store that is
 * never touched is never pushed.
 *
 * Independent from lib/list/syncEngine.ts, which pushes to AniList. The two
 * can run at the same time on the same list without knowing about each other:
 * AniList owns the anime list, this owns the backup of the device.
 *
 * Conflict rule is last-writer-wins PER CATEGORY, arbitrated by the server's
 * `rev`. The one case the user is asked about is a category that moved on
 * both sides since the last pull (see CloudMergeModal).
 */

import { LOCAL_LIST_EVENT } from "./localList";
import { QUEUE_EVENT } from "./queue";
import { HISTORY_EVENT } from "../profile/history";
import { DATA_KINDS, type DataKind } from "../auth/userData";

const ENDPOINT = "/api/v2/account/sync";
/** Coalesce bursts: finishing an episode touches three stores at once. */
const DEBOUNCE_MS = 5000;
/** Revisions we last saw from the server, per category. */
const REV_KEY = "aniscroll:cloudRev";

/**
 * Which localStorage keys make up each category.
 *
 * `favourites` has no entry: favourites live on AniList
 * (lib/anilist/favouritesCache.ts, a sessionStorage cache), so they are
 * already persisted server-side and clearing the cache doesn't lose them.
 * The kind stays declared for the day a local favourites store exists.
 */
const KEYS: Partial<Record<DataKind, string[]>> = {
  list: ["aniscroll:localList"],
  progress: ["aniscroll:progress"],
  queue: ["aniscroll:queue"],
  recent: ["artplayer_settings"],
  player: [
    "aniscroll:playerPrefs",
    "aniscroll:keybindings:v5",
    "aniscroll:volume",
    "aniscroll:muted",
    "aniscroll:playbackRate",
    "autoplay",
    "autoNext",
    "ambient_lights",
  ],
};

/**
 * `prefs` is everything else under the aniscroll: prefix, discovered at read
 * time so a preference added later is backed up without touching this file.
 * The exclusions are the keys owned by another category, the device-local
 * identity, and the caches that would be wrong on another machine.
 */
const PREFS_EXCLUDED = new Set<string>([
  ...Object.values(KEYS).flat(),
  "aniscroll:guest",
  "aniscroll:cloudRev",
  "aniscroll:runtimes",
  "aniscroll:serverPerf",
  "aniscroll:serverPerf:shared",
]);

function isPrefsKey(key: string): boolean {
  if (!key.startsWith("aniscroll:")) return false;
  if (PREFS_EXCLUDED.has(key)) return false;
  // Per-anime score caches: volume of rows, no value off this device.
  if (key.startsWith("aniscroll:scores:")) return false;
  return true;
}

function prefsKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isPrefsKey(key)) out.push(key);
  }
  return out;
}

function keysFor(kind: DataKind): string[] {
  return kind === "prefs" ? prefsKeys() : KEYS[kind] ?? [];
}

/** A category's payload is the raw strings, keyed by storage key. */
function readKind(kind: DataKind): Record<string, string> | null {
  const keys = keysFor(kind);
  const payload: Record<string, string> = {};
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value != null) payload[key] = value;
  }
  return Object.keys(payload).length ? payload : null;
}

function writeKind(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* quota — best effort */
    }
  }
}

function readRevs(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(REV_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeRevs(patch: Record<string, number>): void {
  try {
    localStorage.setItem(REV_KEY, JSON.stringify({ ...readRevs(), ...patch }));
  } catch {
    /* best-effort */
  }
}

/** Everything, as one object — used by signup to carry a guest's data over. */
export function snapshotAll(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const out: Record<string, unknown> = {};
  for (const kind of DATA_KINDS) {
    const payload = readKind(kind);
    if (payload) out[kind] = payload;
  }
  return out;
}

export type PullResult = {
  /** Categories the server had that we applied locally. */
  applied: DataKind[];
  /** Categories that changed on BOTH sides — the user has to arbitrate. */
  conflicts: DataKind[];
};

/**
 * Fetch the server state and apply what is unambiguous.
 *
 * A category is applied when the device has nothing for it, or when its
 * revision moved while the local copy did not. Anything else is reported as a
 * conflict and left untouched — this function never silently overwrites a
 * device's data.
 *
 * `force` is the answer to that conflict once the visitor has confirmed it:
 * the account's copy replaces this device's, every category, no questions.
 */
export async function pullAll(options?: { force?: boolean }): Promise<PullResult> {
  const result: PullResult = { applied: [], conflicts: [] };
  if (typeof window === "undefined") return result;

  const res = await fetch(ENDPOINT);
  if (!res.ok) return result;
  const { data } = (await res.json()) as {
    data: { kind: DataKind; payload: unknown; rev: number }[];
  };

  const revs = readRevs();
  const nextRevs: Record<string, number> = {};

  for (const entry of data ?? []) {
    const local = readKind(entry.kind);
    const known = revs[entry.kind];

    if (options?.force || !local) {
      // Nothing here (or the visitor asked for the cloud to win outright) —
      // the cloud copy replaces whatever this device had.
      writeKind(entry.payload);
      nextRevs[entry.kind] = entry.rev;
      result.applied.push(entry.kind);
    } else if (known === entry.rev) {
      // We are already on this revision; local edits since then are ours to push.
      nextRevs[entry.kind] = entry.rev;
    } else if (known == null) {
      // Both sides have data and this device never synced: only the user knows.
      result.conflicts.push(entry.kind);
    } else {
      // Server moved on without us: another device wrote after our last pull.
      writeKind(entry.payload);
      nextRevs[entry.kind] = entry.rev;
      result.applied.push(entry.kind);
    }
  }

  writeRevs(nextRevs);
  if (result.applied.length) {
    // Every store listens to `storage` as well as its own event, so a single
    // notification is enough to refresh the whole UI.
    window.dispatchEvent(new StorageEvent("storage"));
  }
  return result;
}

/** Push the given categories now, ignoring the debounce. */
export async function pushKinds(kinds: DataKind[]): Promise<void> {
  if (typeof window === "undefined" || !kinds.length) return;

  const entries: Record<string, unknown> = {};
  for (const kind of kinds) {
    const payload = readKind(kind);
    if (payload) entries[kind] = payload;
  }
  if (!Object.keys(entries).length) return;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) return;
  const { revs } = (await res.json()) as { revs: Record<string, number> };
  writeRevs(revs ?? {});
}

/** Force the whole local state up — "keep this device" in the merge modal. */
export function pushAll(): Promise<void> {
  return pushKinds([...DATA_KINDS]);
}

/* ------------------------------------------------------------------ */
/* Live subscription                                                    */
/* ------------------------------------------------------------------ */

let pending = new Set<DataKind>();
let timer: ReturnType<typeof setTimeout> | null = null;
let stop: (() => void) | null = null;

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending.size) return;
  const kinds = [...pending];
  pending = new Set();
  void pushKinds(kinds);
}

function mark(kind: DataKind): void {
  pending.add(kind);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
}

/**
 * Start listening. Returns a stop function; calling start twice is a no-op so
 * a re-render of the bootstrap component can't double-subscribe.
 */
export function start(): () => void {
  if (typeof window === "undefined") return () => {};
  if (stop) return stop;

  /* LE RATTRAPAGE DES HISTORIQUES DÉJÀ FIGÉS.
     `recent` n'ayant jamais eu d'événement, un appareil a pu lire des mois
     d'épisodes sans que le compte n'en sache rien : l'écouteur ajouté ci-dessous
     répare l'avenir, pas le passé, et sans ceci le profil public de tous les
     comptes existants resterait vide jusqu'à leur prochain épisode.

     La condition est exactement « cet appareil n'a jamais vu de révision pour
     cette catégorie », donc elle s'éteint dès la première poussée réussie
     (`writeRevs`) et ne coûte plus rien ensuite — pas de POST par session. Et
     si l'historique local est vide, `pushKinds` n'envoie rien du tout. */
  if (readRevs().recent === undefined) mark("recent");

  const onList = () => mark("list");
  const onQueue = () => mark("queue");
  const onProgress = () => mark("progress");
  /* Sans lui, `recent` n'etait jamais marque sale : la seule categorie dans ce
     cas, donc la seule que le compte ne recevait qu'a un pushAll complet. */
  const onHistory = () => mark("recent");
  const onPlayer = () => mark("player");
  const onPrefs = () => mark("prefs");
  // A flush on the way out is what makes the last change of a session
  // survive: the debounce would otherwise die with the page.
  const onLeave = () => flush();

  window.addEventListener(LOCAL_LIST_EVENT, onList);
  window.addEventListener(QUEUE_EVENT, onQueue);
  window.addEventListener("aniscroll:progress-tick", onProgress);
  window.addEventListener(HISTORY_EVENT, onHistory);
  window.addEventListener("aniscroll:playerPrefs:change", onPlayer);
  window.addEventListener("aniscroll:keybindings:change", onPlayer);
  window.addEventListener("aniscroll:syncPrefs:change", onPrefs);
  window.addEventListener("aniscroll:titlePref:change", onPrefs);
  window.addEventListener("aniscroll:accent:change", onPrefs);
  window.addEventListener("aniscroll:notifPrefs:change", onPrefs);
  window.addEventListener("aniscroll:episodeAlerts:change", onPrefs);
  window.addEventListener("aniscroll:hideSpoilers:change", onPrefs);
  window.addEventListener("aniscroll:dataSaver:change", onPrefs);
  window.addEventListener("aniscroll:clickTarget:change", onPrefs);
  window.addEventListener("aniscroll:preview:prefs:change", onPrefs);
  window.addEventListener("aniscroll:langPref:change", onPrefs);
  // La disposition des widgets du profil : une clé aniscroll:* de plus, donc
  // déjà comprise dans la catégorie `prefs` par isPrefsKey — seul l'événement
  // manquait pour que le changement soit poussé.
  window.addEventListener("aniscroll:profileLayout:change", onPrefs);
  window.addEventListener("pagehide", onLeave);
  document.addEventListener("visibilitychange", onLeave);

  stop = () => {
    flush();
    window.removeEventListener(LOCAL_LIST_EVENT, onList);
    window.removeEventListener(QUEUE_EVENT, onQueue);
    window.removeEventListener("aniscroll:progress-tick", onProgress);
    window.removeEventListener(HISTORY_EVENT, onHistory);
    window.removeEventListener("aniscroll:playerPrefs:change", onPlayer);
    window.removeEventListener("aniscroll:keybindings:change", onPlayer);
    window.removeEventListener("aniscroll:syncPrefs:change", onPrefs);
    window.removeEventListener("aniscroll:titlePref:change", onPrefs);
    window.removeEventListener("aniscroll:accent:change", onPrefs);
    window.removeEventListener("aniscroll:notifPrefs:change", onPrefs);
    window.removeEventListener("aniscroll:episodeAlerts:change", onPrefs);
    window.removeEventListener("aniscroll:hideSpoilers:change", onPrefs);
    window.removeEventListener("aniscroll:dataSaver:change", onPrefs);
    window.removeEventListener("aniscroll:clickTarget:change", onPrefs);
    window.removeEventListener("aniscroll:preview:prefs:change", onPrefs);
    window.removeEventListener("aniscroll:langPref:change", onPrefs);
    window.removeEventListener("aniscroll:profileLayout:change", onPrefs);
    window.removeEventListener("pagehide", onLeave);
    document.removeEventListener("visibilitychange", onLeave);
    stop = null;
  };
  return stop;
}

/** Drop the revision bookkeeping — called on sign-out. */
export function forget(): void {
  try {
    localStorage.removeItem(REV_KEY);
  } catch {
    /* best-effort */
  }
}
