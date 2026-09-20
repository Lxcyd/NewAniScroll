import { getTursoClient } from "./turso";

/**
 * oped_youtube — the FULL-LENGTH version of an OP/ED on YouTube.
 *
 * WHY THIS EXISTS. AnimeThemes serves the anime's own rip of the sequence, and
 * that rip is 90 seconds: measured with ffprobe, ChainsawMan-OP1 = 90.1 s,
 * CyberpunkEdgerunners-OP1 = 89.9 s. It is the TV size, not the song. So the
 * profile could loop an opening but never actually play the track. The full
 * version is on YouTube; finding WHICH video is the track is a resolution
 * problem solved offline (tools/ost-resolver/), and this table is its answer.
 *
 * THE VERDICT IS THE WHOLE POINT, so reads go through {@link resolvedVideoIds},
 * which serves `ok` and nothing else. `review` rows are a human queue, not a
 * weaker answer: they carry ONE agreeing signal, and the failure they exist to
 * catch is a plausible one — the right artist's channel, a full-length runtime,
 * and the wrong song. Chainsaw Man ED3 validated an unrelated track that way
 * before the second signal was added. Serving `review` automatically would put
 * that failure back, so the query filters rather than the caller.
 */

export type OpedVerdict = "ok" | "review" | "absent" | "api_fail";

export interface OpedYoutubeRow {
  aniId: number;
  /** "OP1", "ED2"… — the AnimeThemes theme slug this resolves. */
  slug: string;
  verdict: OpedVerdict;
  videoId: string | null;
  ytTitle: string | null;
  ytChannel: string | null;
  duration: number | null;
  artist: string | null;
  artistSrc: string | null;
  algoVersion: number;
  checkedAt: number;
}

/**
 * Slug → YouTube id for one anime, restricted to what is safe to play.
 *
 * Returns an empty map when the DB is unreachable or nothing is resolved yet —
 * never throws. The caller then serves what it already had (the 90 s rip), which
 * is the behaviour that shipped before this table existed.
 */
export async function resolvedVideoIds(
  aniId: number,
): Promise<Map<string, string>> {
  const client = getTursoClient();
  if (!client || !Number.isFinite(aniId)) return new Map();

  try {
    const rs = await client.execute({
      sql: `SELECT slug, video_id FROM oped_youtube
            WHERE ani_id = ? AND verdict = 'ok' AND video_id IS NOT NULL`,
      args: [aniId],
    });
    const out = new Map<string, string>();
    for (const row of rs.rows) {
      const slug = String(row.slug ?? "");
      const videoId = String(row.video_id ?? "");
      /* Revalidé ici bien qu'écrit par l'importeur : cette valeur part dans
         l'URL d'une iframe, et une table est modifiable en dehors de ce code. */
      if (slug && /^[A-Za-z0-9_-]{11}$/.test(videoId)) out.set(slug, videoId);
    }
    return out;
  } catch (e: any) {
    console.warn(`[oped_youtube] read failed for ${aniId}:`, e?.message);
    return new Map();
  }
}

/**
 * Every row for one anime, verdicts included — for tooling and admin views that
 * need to see what was rejected, which {@link resolvedVideoIds} deliberately
 * hides.
 */
export async function allRowsFor(aniId: number): Promise<OpedYoutubeRow[]> {
  const client = getTursoClient();
  if (!client || !Number.isFinite(aniId)) return [];

  try {
    const rs = await client.execute({
      sql: `SELECT * FROM oped_youtube WHERE ani_id = ? ORDER BY slug`,
      args: [aniId],
    });
    return rs.rows.map((r: any) => ({
      aniId: Number(r.ani_id),
      slug: String(r.slug),
      verdict: String(r.verdict) as OpedVerdict,
      videoId: r.video_id ? String(r.video_id) : null,
      ytTitle: r.yt_title ? String(r.yt_title) : null,
      ytChannel: r.yt_channel ? String(r.yt_channel) : null,
      duration: r.duration == null ? null : Number(r.duration),
      artist: r.artist ? String(r.artist) : null,
      artistSrc: r.artist_src ? String(r.artist_src) : null,
      algoVersion: Number(r.algo_version ?? 1),
      checkedAt: Number(r.checked_at ?? 0),
    }));
  } catch (e: any) {
    console.warn(`[oped_youtube] full read failed for ${aniId}:`, e?.message);
    return [];
  }
}
