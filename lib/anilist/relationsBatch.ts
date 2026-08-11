import { anilistFetch } from "./anilistFetch";
import { getCachedMediaMeta, getMediaMeta } from "./getMediaMeta";
import { toRelationsPayload, type RelationsPayload } from "./relationsPayload";

/**
 * A whole wave of the franchise graph in ONE upstream request.
 *
 * `/api/v2/relations/batch` takes up to thirty ids and used to answer them with
 * thirty `getMediaMeta` calls. Warm, that is thirty memory hits and instant.
 * Cold — the first time anybody opens a franchise — it is thirty AniList
 * queries, and each one:
 *
 *   - spends a token from a 28-per-minute bucket, so the tail of the very first
 *     wave already queues, and the next wave waits its 5s budget out and comes
 *     back empty (cards drawn without a cover, branches missing);
 *   - is preceded by a round trip to Upstash-London for the response cache;
 *   - pulls FULL_MEDIA_QUERY — characters, staff, tags, rankings, streaming
 *     episodes — to read six fields and a relation list.
 *
 * One `Page(media: { id_in: ... })` carrying only what the graph draws costs a
 * single token, a single cache key and a fraction of the bytes.
 *
 * Layers, cheapest first:
 *   1. the process memory cache — free, and warm for anything the page's own
 *      SSR already touched;
 *   2. this batched query;
 *   3. `getMediaMeta` for whatever is still missing — the three-layer path,
 *      which is what answers when AniList is down and Turso has the entry. A
 *      handful of ids at most, so the fan-out that made this slow can't return.
 *
 * Nothing here writes to the caches: the batched Media is a slice, not the full
 * shape `memSet`/`upsertAnime` promise their readers.
 */

/** Exactly the fields `toRelationsPayload` reads, and no others. */
const BATCH_QUERY = `
  query ($ids: [Int]) {
    Page(perPage: 50) {
      media(id_in: $ids) {
        id format type status(version: 2) episodes
        title { romaji english native userPreferred }
        coverImage { extraLarge large medium }
        relations {
          edges {
            relationType(version: 2)
            node {
              id format type status(version: 2) episodes
              title { romaji english native userPreferred }
              coverImage { extraLarge large medium }
            }
          }
        }
      }
    }
  }
`;

/** A bigger answer than a single Media, and the caller is a click away. */
const TIMEOUT_MS = 7000;

export async function fetchRelationsBatch(ids: number[]): Promise<RelationsPayload[]> {
  const out = new Map<number, RelationsPayload>();

  const missing: number[] = [];
  for (const id of ids) {
    const mem = getCachedMediaMeta(id);
    if (mem) out.set(id, toRelationsPayload(mem));
    else missing.push(id);
  }

  if (missing.length > 0) {
    try {
      const data = await anilistFetch({
        query: BATCH_QUERY,
        variables: { ids: missing },
        timeoutMs: TIMEOUT_MS,
        label: `relations:batch:${missing.length}`,
      });
      for (const m of data?.data?.Page?.media || []) {
        const id = Number(m?.id);
        if (Number.isFinite(id)) out.set(id, toRelationsPayload(m));
      }
    } catch {
      /* every id falls through to the per-id path below */
    }
  }

  const stillMissing = missing.filter((id) => !out.has(id));
  if (stillMissing.length > 0) {
    await Promise.all(
      stillMissing.map(async (id) => {
        try {
          const media = await getMediaMeta(id);
          if (media) out.set(id, toRelationsPayload(media));
        } catch {
          /* a dead node costs the caller nothing but its own card */
        }
      })
    );
  }

  // Requested order, so the answer reads like the question.
  return ids.map((id) => out.get(id)).filter(Boolean) as RelationsPayload[];
}
