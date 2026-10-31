import { getTursoClient } from "./turso";

/**
 * va_page — la COPIE de voir-anime (tools/voir-anime/copie.mjs, chaque nuit).
 *
 * Pourquoi le site la lit au lieu de voir-anime : depuis fin octobre 2026,
 * voir-anime repond 503 au Worker Cloudflare (proxy.aniscroll.com) sur toutes
 * ses pages, et refuse deja les IP de Vercel. Le resolveur ne pouvait plus lire
 * la liste des episodes ni la page d'un episode : le chip `vidmoly-va` ne
 * sortait plus. La copie, elle, lit voir-anime depuis des IP ordinaires et
 * controle chaque lien myTV (voembed) — elle a deja tout ce qu'il faut.
 *
 * Une page = une ligne (cle : le slug). `episodes` :
 *   {"num": [chemin_page_episode, lien_mytv|null, etat, vu_ms, lu_ms]}
 */
export interface VaEpisode {
  lien: string | null;
  etat: string;
}
export interface VaPage {
  slug: string;
  numMin: number;
  episodes: Record<string, [string, string | null, string, number, number]>;
}

const TTL_MS = 10 * 60 * 1000;
const parSlug = new Map<string, { t: number; page: VaPage | null }>();
const parAncre = new Map<string, { t: number; slug: string | null }>();

/** La page copiee, ou null si la copie ne la connait pas. */
export async function getVaPage(slug: string): Promise<VaPage | null> {
  const c = parSlug.get(slug);
  if (c && Date.now() - c.t < TTL_MS) return c.page;
  const db = getTursoClient();
  if (!db) return null;
  try {
    const r = await db.execute({ sql: "SELECT slug, num_min, episodes FROM va_page WHERE slug = ?", args: [slug] });
    const row = r.rows[0];
    const page = row
      ? { slug: String(row.slug), numMin: Number(row.num_min) || 1, episodes: JSON.parse(String(row.episodes)) }
      : null;
    parSlug.set(slug, { t: Date.now(), page });
    return page;
  } catch {
    return null; // table absente ou Turso indisponible : le chemin d'avant prend le relais
  }
}

/** Le lien myTV de l'episode `num` (numerotation de la page), ou null si la copie ne l'a pas. */
export function vaEpisode(page: VaPage, num: number): VaEpisode | null {
  const e = page.episodes[String(num)];
  return e ? { lien: e[1], etat: e[2] } : null;
}

/**
 * La page dont l'ANCRE est cet anime dans cette langue (meme titre et meme
 * date de debut sur AniList — cf. la copie). Une seule, sinon rien.
 */
export async function getVaSlugParAncre(aniId: number, langue: "vf" | "vostfr"): Promise<string | null> {
  const k = `${aniId}:${langue}`;
  const c = parAncre.get(k);
  if (c && Date.now() - c.t < TTL_MS) return c.slug;
  const db = getTursoClient();
  if (!db) return null;
  try {
    const r = await db.execute({
      sql: "SELECT slug FROM va_page WHERE anilist = ? AND langue = ? LIMIT 2",
      args: [aniId, langue],
    });
    const slug = r.rows.length === 1 ? String(r.rows[0].slug) : null;
    parAncre.set(k, { t: Date.now(), slug });
    return slug;
  } catch {
    return null;
  }
}
