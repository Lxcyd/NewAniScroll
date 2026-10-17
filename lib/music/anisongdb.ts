import { getTursoClient } from "@/lib/db/turso";

/**
 * AnisongDB (anisongdb.com), la base du jeu Anime Music Quiz : ce que la liste
 * Musique du studio (/api/v2/anisongs) et le compte de chaque anime
 * (/api/v2/theme-counts) en lisent. UNE SEULE sélection pour les deux, sinon
 * le nombre affiché avant l'ouverture ne serait pas celui de la liste.
 */

const API = "https://anisongdb.com/api/mal_ids_request";

export type AnisongRaw = {
  linked_ids?: { anilist?: number | null } | null;
  songType?: string;
  songName?: string;
  songArtist?: string;
  songLength?: number | null;
  songDifficulty?: number | null;
  isDub?: boolean;
  isRebroadcast?: boolean;
  audio?: string | null;
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Les morceaux de CET anime, strictement par identifiant AniList (Cyberpunk:
 * Edgerunners ne ramène jamais Edgerunners 2), sans doublages, rediffusions ni
 * doublons (même titre, même artiste : la version la plus longue).
 */
export function pickSongs(anilistId: number, raw: AnisongRaw[]): AnisongRaw[] {
  const kept = new Map<string, AnisongRaw>();
  for (const s of raw) {
    if (s.linked_ids?.anilist !== anilistId || s.isDub || s.isRebroadcast) continue;
    /* Le nom du fichier part dans une adresse : forme stricte. */
    if (!s.audio || !/^[\w-]+\.mp3$/.test(s.audio) || !s.songName) continue;
    const type = s.songType ?? "";
    const k = `${type.startsWith("Insert") ? "ins" : type}|${norm(s.songName)}|${norm(s.songArtist ?? "")}`;
    const had = kept.get(k);
    if (!had || (s.songLength ?? 0) > (had.songLength ?? 0)) kept.set(k, s);
  }
  return [...kept.values()].filter((s) => songSlug(s) !== undefined);
}

/** « OP1 », « ED2 » ; `null` pour un insert, qui n'a pas de numéro ; `undefined` hors sujet. */
export function songSlug(s: AnisongRaw): string | null | undefined {
  const type = s.songType ?? "";
  const m = /^(Opening|Ending)\s+(\d+)/.exec(type);
  if (m) return `${m[1] === "Opening" ? "OP" : "ED"}${m[2]}`;
  return type.startsWith("Insert") ? null : undefined;
}

/** Les morceaux de plusieurs animés d'un coup (500 MAL ids au plus). Lève en cas de panne. */
export async function fetchByMal(malIds: number[]): Promise<AnisongRaw[]> {
  if (!malIds.length) return [];
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ mal_ids: malIds.slice(0, 500) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`anisongdb ${r.status}`);
  const json = await r.json();
  return Array.isArray(json) ? json : [];
}

/** AniList → MAL, lu dans la table `anime`. Un id absent n'a pas de MAL connu. */
export async function malIdsOf(anilistIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const db = getTursoClient();
  if (!db || !anilistIds.length) return out;
  try {
    const r = await db.execute({
      sql: `SELECT id, id_mal FROM anime WHERE id IN (${anilistIds.map(() => "?").join(",")})`,
      args: anilistIds,
    });
    for (const row of r.rows as any[]) {
      const mal = Number(row.id_mal);
      if (Number.isFinite(mal) && mal > 0) out.set(Number(row.id), mal);
    }
  } catch {}
  return out;
}
