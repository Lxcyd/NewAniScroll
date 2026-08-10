/**
 * The shape the franchise graph reads, derived from an AniList Media.
 *
 * Shared by the two relation routes — `/api/v2/relations/[id]` (one node) and
 * `/api/v2/relations/batch` (many) — so a node fetched alone and the same node
 * fetched inside a wave are byte-for-byte identical. They drifted once already:
 * the batch route grew `coverImage` first, and cards drawn from a single fetch
 * came out without a thumbnail.
 */

export type RelationsPayload = {
  id: number;
  format: string | null;
  status: string | null;
  episodes: number | null;
  title: any;
  cover: string | null;
  edges: {
    relationType: string;
    node: {
      id: number;
      type: string | null;
      format: string | null;
      status: string | null;
      episodes: number | null;
      title: any;
      cover: string | null;
    };
  }[];
};

/** AniList gives `extraLarge | large | medium`; the graph draws a 150px-wide
 *  card, so `large` is already generous and `extraLarge` would be waste. */
const coverOf = (m: any): string | null =>
  m?.coverImage?.large || m?.coverImage?.extraLarge || m?.coverImage?.medium || null;

export function toRelationsPayload(media: any): RelationsPayload {
  const edges = (media?.relations?.edges || [])
    // A manga is not drawn, and — more importantly — never expanded: the light
    // novel is a franchise's hub, so walking it drags in every unrelated work
    // that shares it.
    .filter((e: any) => e?.node?.id && e.node.type !== "MANGA")
    .map((e: any) => ({
      relationType: e.relationType,
      node: {
        id: Number(e.node.id),
        type: e.node.type ?? null,
        format: e.node.format ?? null,
        status: e.node.status ?? null,
        episodes: e.node.episodes ?? null,
        title: e.node.title ?? null,
        cover: coverOf(e.node),
      },
    }));

  return {
    id: Number(media?.id),
    format: media?.format ?? null,
    status: media?.status ?? null,
    episodes: media?.episodes ?? null,
    title: media?.title ?? null,
    cover: coverOf(media),
    edges,
  };
}
