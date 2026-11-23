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
  getLocalList,
  ImportMode,
} from "./localList";
import type { Status, FuzzyDate } from "./types";
import { MEDIA_META_FIELDS, metaPatch, type MediaRow } from "../badges/metaBackfill";
import { sleep } from "@/utils/sleep";

const ENDPOINT = "https://graphql.anilist.co/";

export type ImportResult = { imported: number; skipped: number; total: number };

// ── Export (MyAnimeList XML — importable by AniList & MAL) ──────────

/** AniList status → MAL <my_status> label (reverse of MAL_STATUS_MAP). */
const STATUS_TO_MAL: Record<Status, string> = {
  CURRENT: "Watching",
  REPEATING: "Watching",
  COMPLETED: "Completed",
  PAUSED: "On-Hold",
  DROPPED: "Dropped",
  PLANNING: "Plan to Watch",
};

/** FuzzyDate → "YYYY-MM-DD" (MAL uses this; "0000-00-00" means unset). */
function fuzzyToMalDate(d?: FuzzyDate | null): string {
  if (!d?.year) return "0000-00-00";
  const mm = String(d.month ?? 0).padStart(2, "0");
  const dd = String(d.day ?? 0).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One `Page` of media for a batch of ids.
 *
 * NEVER ONE ALIAS PER TITLE: since 23/11/2026 AniList bills every aliased root
 * query against the rate limit (measured: 3 aliases = 3 of the 30 points), so
 * the old 25-alias batches burned the whole minute in about one second.
 * `id_in` / `idMal_in` fetch 50 titles for one point.
 */
async function mediaPage<T>(filter: "id_in" | "idMal_in", ids: number[], fields: string): Promise<T[]> {
  const query = `query ($ids: [Int]) { Page(perPage: ${MAL_BATCH}) { media(${filter}: $ids, type: ANIME) { ${fields} } } }`;
  for (let tries = 0; tries < 4; tries++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { ids } }),
      });
      if (res.status === 429) {
        await sleep((Number(res.headers.get("retry-after")) || 60) * 1000);
        continue;
      }
      const json = await res.json();
      return json?.data?.Page?.media ?? [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Map AniList ids → MAL ids in batches. The XML format is keyed by MAL id, so
 *  AniList entries without a MAL mapping can't be represented and are skipped. */
async function mapAniToMal(aniIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < aniIds.length; i += MAL_BATCH) {
    const chunk = aniIds.slice(i, i + MAL_BATCH);
    const media = await mediaPage<{ id: number; idMal: number | null }>("id_in", chunk, "id idMal");
    for (const m of media) {
      if (m?.id && m?.idMal) out.set(Number(m.id), Number(m.idMal));
    }
    if (i + MAL_BATCH < aniIds.length) await sleep(MAL_BATCH_DELAY_MS);
  }
  return out;
}

export type ExportResult = { exported: number; skipped: number; total: number };

/**
 * Build + download the local list as a MyAnimeList-format XML file. This is the
 * format both MAL and AniList accept on import. Returns a summary (entries with
 * no MAL mapping are skipped). `onProgress` reports id-mapping progress.
 */
export async function downloadExportXml(
  onProgress?: (done: number, total: number) => void,
): Promise<ExportResult> {
  if (typeof window === "undefined") return { exported: 0, skipped: 0, total: 0 };
  const entries = Object.values(getLocalList());
  if (entries.length === 0) {
    // Still emit a valid (empty) file so the action does something predictable.
    triggerDownload(buildMalXml([]), "xml");
    return { exported: 0, skipped: 0, total: 0 };
  }

  const aniIds = entries.map((e) => e.mediaId);
  let mapped = 0;
  const malMap = await mapAniToMal(aniIds);
  onProgress?.(aniIds.length, aniIds.length);

  const rows: MalExportRow[] = [];
  for (const e of entries) {
    const malId = malMap.get(e.mediaId);
    if (!malId) continue; // no MAL id → can't be in a MAL/AniList XML
    mapped++;
    rows.push({
      malId,
      title: e.title?.romaji || e.title?.english || e.title?.userPreferred || "",
      episodes: e.total ?? 0,
      watched: e.progress ?? 0,
      status: e.status ? STATUS_TO_MAL[e.status] : "Plan to Watch",
      score: e.score ? Math.round(e.score) : 0,
      start: fuzzyToMalDate(e.startedAt),
      finish: fuzzyToMalDate(e.completedAt),
      repeat: e.repeat ?? 0,
    });
  }
  triggerDownload(buildMalXml(rows), "xml");
  return { exported: mapped, skipped: entries.length - mapped, total: entries.length };
}

type MalExportRow = {
  malId: number;
  title: string;
  episodes: number;
  watched: number;
  status: string;
  score: number;
  start: string;
  finish: string;
  repeat: number;
};

/** Assemble the MAL export XML document from mapped rows. */
function buildMalXml(rows: MalExportRow[]): string {
  const items = rows
    .map(
      (r) => `  <anime>
    <series_animedb_id>${r.malId}</series_animedb_id>
    <series_title><![CDATA[${r.title}]]></series_title>
    <series_episodes>${r.episodes}</series_episodes>
    <my_watched_episodes>${r.watched}</my_watched_episodes>
    <my_start_date>${r.start}</my_start_date>
    <my_finish_date>${r.finish}</my_finish_date>
    <my_score>${r.score}</my_score>
    <my_status>${xmlEscape(r.status)}</my_status>
    <my_times_watched>${r.repeat}</my_times_watched>
    <update_on_import>1</update_on_import>
  </anime>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8" ?>
<myanimelist>
  <myinfo>
    <user_export_type>1</user_export_type>
    <user_total_anime>${rows.length}</user_total_anime>
  </myinfo>
${items}
</myanimelist>
`;
}

/** Download a string as a file (xml/json) named with today's date. */
function triggerDownload(content: string, ext: "xml" | "json"): void {
  const type = ext === "xml" ? "application/xml" : "application/json";
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aniscroll-list-${new Date().toISOString().slice(0, 10)}.${ext}`;
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
        isCustomList
        entries {
          status
          score(format: POINT_10_DECIMAL)
          progress
          repeat
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
  if (lists.some((l: any) => l?.isCustomList && l?.entries?.length)) {
    import("../badges/facts").then((f) => f.recordFlag("customListAniList")).catch(() => {});
  }
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
        repeat: Number(e.repeat) || 0,
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
  startedAt: FuzzyDate | null;
  completedAt: FuzzyDate | null;
  repeat: number;
};

/** MAL "YYYY-MM-DD" ("0000-00-00" = unset) → FuzzyDate. */
function malDate(raw?: string | null): FuzzyDate | null {
  const [year, month, day] = (raw || "").trim().split("-").map(Number);
  return emptyFuzzy({ year: year || null, month: month || null, day: day || null });
}

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
      startedAt: malDate(node.querySelector("my_start_date")?.textContent),
      completedAt: malDate(node.querySelector("my_finish_date")?.textContent),
      repeat: Number(node.querySelector("my_times_watched")?.textContent || "0") || 0,
    });
  });
  return rows;
}

type MalMedia = MediaRow & {
  idMal: number | null;
  episodes: number | null;
  title: any;
  coverImage: { large: string | null } | null;
};

/** Map a batch of MAL ids → AniList media, with the badge metadata in the same
 *  request so the Badges tab has nothing left to fetch for these titles. */
async function mapMalBatch(malIds: number[]): Promise<Map<number, MalMedia>> {
  const media = await mediaPage<MalMedia>(
    "idMal_in",
    malIds,
    `id idMal episodes title { english romaji native userPreferred } coverImage { large }${MEDIA_META_FIELDS}`,
  );
  const out = new Map<number, MalMedia>();
  for (const m of media) if (m?.id && m?.idMal) out.set(Number(m.idMal), m);
  return out;
}

// AniList's `Page` caps at 50 rows.
const MAL_BATCH = 50;
// 27 requests/min, under AniList's current limit of 30.
const MAL_BATCH_DELAY_MS = 2200;

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
        ...metaPatch(m),
        mediaId: Number(m.id),
        status: row.status,
        score: row.score,
        progress: row.progress,
        total: typeof m.episodes === "number" ? m.episodes : null,
        title: m.title || undefined,
        coverImage: m.coverImage?.large ?? null,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        notes: null,
        repeat: row.repeat,
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
