/**
 * Import / export for the local list (lib/list/localList.ts).
 *
 * Export: one JSON file (the LocalListExport shape) — used for backup and for
 * moving a list between devices/browsers.
 *
 * Import — three sources, all client-side, no auth required:
 *   1. AniScroll JSON   — our own export, round-trips losslessly.
 *   2. AniList username — read a PUBLIC MediaListCollection (same query the
 *      profile page + userListCache already use) and map → LocalEntry.
 *   3. MyAnimeList XML  — the official MAL export. MAL ids are mapped to AniList
 *      ids in batches via `Media(idMal:)` (AniList exposes `idMal`, used all
 *      over the codebase). Unmatched entries are skipped and reported.
 *
 * Everything returns a small result summary so the Settings UI can toast it.
 */

import {
  LocalEntry,
  LocalListExport,
  importEntries,
  buildExport,
  ImportMode,
} from "./localList";
import type { Status, FuzzyDate } from "./types";

const ENDPOINT = "https://graphql.anilist.co/";

export type ImportResult = { imported: number; skipped: number; total: number };

// ── Export ────────────────────────────────────────────────────────

/** Trigger a browser download of the current local list as JSON. */
export function downloadExport(): void {
  if (typeof window === "undefined") return;
  const data = buildExport();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aniscroll-list-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── AniScroll JSON import ──────────────────────────────────────────

export function importFromJson(text: string, mode: ImportMode): ImportResult {
  let parsed: Partial<LocalListExport>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid-json");
  }
  const entries = Array.isArray(parsed?.entries) ? (parsed.entries as LocalEntry[]) : null;
  if (!entries) throw new Error("invalid-format");
  const imported = importEntries(entries, mode);
  return { imported, skipped: entries.length - imported, total: entries.length };
}

// ── AniList username import ────────────────────────────────────────

const USERNAME_QUERY = `
  query ($userName: String) {
    MediaListCollection(userName: $userName, type: ANIME) {
      lists {
        entries {
          status
          score(format: POINT_10_DECIMAL)
          progress
          startedAt { year month day }
          completedAt { year month day }
          notes
          media {
            id
            episodes
            title { english romaji native userPreferred }
            coverImage { large }
          }
        }
      }
    }
  }
`;

export async function importFromAniListUsername(
  userName: string,
  mode: ImportMode,
): Promise<ImportResult> {
  const name = userName.trim();
  if (!name) throw new Error("empty-username");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: USERNAME_QUERY, variables: { userName: name } }),
  });
  const json = await res.json();
  if (json?.errors?.length) {
    // AniList returns a 404-style error for unknown users / private lists.
    throw new Error("user-not-found");
  }
  const lists = json?.data?.MediaListCollection?.lists || [];
  const byId = new Map<number, LocalEntry>();
  const now = Date.now();
  for (const list of lists) {
    for (const e of list?.entries || []) {
      const mediaId = Number(e?.media?.id);
      if (!Number.isFinite(mediaId)) continue;
      byId.set(mediaId, {
        mediaId,
        status: (e.status as Status) ?? null,
        score: typeof e.score === "number" && e.score > 0 ? e.score : null,
        progress: Number(e.progress) || 0,
        total: typeof e.media?.episodes === "number" ? e.media.episodes : null,
        title: e.media?.title || undefined,
        coverImage: e.media?.coverImage?.large ?? null,
        startedAt: emptyFuzzy(e.startedAt),
        completedAt: emptyFuzzy(e.completedAt),
        notes: e.notes || null,
        updatedAt: now,
      });
    }
  }
  const entries = Array.from(byId.values());
  const imported = importEntries(entries, mode);
  return { imported, skipped: entries.length - imported, total: entries.length };
}

// ── MyAnimeList XML import ─────────────────────────────────────────

const MAL_STATUS_MAP: Record<string, Status> = {
  Watching: "CURRENT",
  Completed: "COMPLETED",
  "On-Hold": "PAUSED",
  Dropped: "DROPPED",
  "Plan to Watch": "PLANNING",
};

type MalRow = {
  malId: number;
  status: Status | null;
  progress: number;
  score: number | null;
};

/** Parse a MAL export XML string into raw rows (still keyed by MAL id). */
function parseMalXml(xml: string): MalRow[] {
  if (typeof window === "undefined") throw new Error("client-only");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("invalid-xml");
  const rows: MalRow[] = [];
  doc.querySelectorAll("anime").forEach((node) => {
    const malId = Number(node.querySelector("series_animedb_id")?.textContent || "");
    if (!Number.isFinite(malId) || malId <= 0) return;
    const statusRaw = (node.querySelector("my_status")?.textContent || "").trim();
    const progress = Number(node.querySelector("my_watched_episodes")?.textContent || "0") || 0;
    // MAL scores are 0-10 integers; 0 means "no score".
    const scoreRaw = Number(node.querySelector("my_score")?.textContent || "0") || 0;
    rows.push({
      malId,
      status: MAL_STATUS_MAP[statusRaw] ?? null,
      progress,
      score: scoreRaw > 0 ? scoreRaw : null,
    });
  });
  return rows;
}

/** Map a batch of MAL ids → AniList media (id/episodes/title/cover) in one
 *  request using aliased `Media(idMal:)` fields. AniList rejects huge queries,
 *  so callers should chunk; we use 25 per request. */
async function mapMalBatch(
  malIds: number[],
): Promise<Map<number, { id: number; episodes: number | null; title: any; cover: string | null }>> {
  const fields = malIds
    .map(
      (id, i) =>
        `m${i}: Media(idMal: ${id}, type: ANIME) { id idMal episodes title { english romaji native userPreferred } coverImage { large } }`,
    )
    .join("\n");
  const out = new Map<number, { id: number; episodes: number | null; title: any; cover: string | null }>();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { ${fields} }` }),
    });
    const json = await res.json();
    const data = json?.data || {};
    for (const key of Object.keys(data)) {
      const m = data[key];
      if (m?.id && m?.idMal) {
        out.set(Number(m.idMal), {
          id: Number(m.id),
          episodes: typeof m.episodes === "number" ? m.episodes : null,
          title: m.title || undefined,
          cover: m.coverImage?.large ?? null,
        });
      }
    }
  } catch {
    /* network failure — the whole batch is reported as skipped by the caller */
  }
  return out;
}

const MAL_BATCH = 25;
// Polite spacing between batches — AniList rate-limits to ~90 req/min.
const MAL_BATCH_DELAY_MS = 750;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function importFromMalXml(
  xml: string,
  mode: ImportMode,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const rows = parseMalXml(xml);
  if (rows.length === 0) throw new Error("empty-xml");

  const entries: LocalEntry[] = [];
  const now = Date.now();
  for (let i = 0; i < rows.length; i += MAL_BATCH) {
    const chunk = rows.slice(i, i + MAL_BATCH);
    const mapping = await mapMalBatch(chunk.map((r) => r.malId));
    for (const row of chunk) {
      const m = mapping.get(row.malId);
      if (!m) continue; // no AniList match — skip
      entries.push({
        mediaId: m.id,
        status: row.status,
        score: row.score,
        progress: row.progress,
        total: m.episodes,
        title: m.title,
        coverImage: m.cover,
        startedAt: null,
        completedAt: null,
        notes: null,
        updatedAt: now,
      });
    }
    onProgress?.(Math.min(i + MAL_BATCH, rows.length), rows.length);
    if (i + MAL_BATCH < rows.length) await sleep(MAL_BATCH_DELAY_MS);
  }

  const imported = importEntries(entries, mode);
  return { imported, skipped: rows.length - imported, total: rows.length };
}

// ── helpers ────────────────────────────────────────────────────────

/** Normalise an AniList fuzzy date to null when it carries no real value. */
function emptyFuzzy(d?: FuzzyDate | null): FuzzyDate | null {
  if (!d || (!d.year && !d.month && !d.day)) return null;
  return { year: d.year ?? null, month: d.month ?? null, day: d.day ?? null };
}

/** Read a File as text, transparently gunzipping a .gz MAL export when the
 *  browser supports DecompressionStream (Chrome/Edge/modern). Falls back to
 *  plain text for already-extracted XML/JSON. */
export async function readFileText(file: File): Promise<string> {
  const isGzip = file.name.endsWith(".gz") || file.type === "application/gzip";
  if (isGzip && "DecompressionStream" in window) {
    const ds = new (window as any).DecompressionStream("gzip");
    const stream = file.stream().pipeThrough(ds);
    return new Response(stream).text();
  }
  return file.text();
}
