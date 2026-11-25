/**
 * GET /api/v2/anizone/sub?u=<url d'un sous-titre anizone>
 *
 * Le relais des sous-titres d'anizone, et de RIEN d'autre.
 *
 * Leur CDN (seiryuu.vid-cdn.xyz) ne repond qu'a l'origine anizone.to (CORS) et
 * refuse notre Worker (403 depuis les IP Cloudflare). La video, elle, se lit
 * sans nous (lecteur HLS natif, cf. lib/anizone/resolve.js) ; mais un
 * sous-titre se charge en `fetch`, donc sous CORS : il lui faut un relais.
 *
 * Cout borne : un .ass fait ~30 Ko, un fichier ne change jamais (son URL porte
 * l'uuid de l'episode), et la reponse est cachee un an a l'edge — la fonction
 * ne tourne qu'une fois par fichier et par region.
 *
 * Volontairement ferme : hote `*.vid-cdn.xyz`, chemin `/<uuid>/subtitles/…` et
 * extension de sous-titre uniquement, sans quoi ce serait un proxy ouvert.
 */

import { getTursoClient } from "@/lib/db/turso";
import { lisSousTitre } from "@/lib/anizone/core.mjs";

const PERMIS =
  /^https:\/\/[a-z0-9-]+\.vid-cdn\.xyz\/[0-9a-f-]{36}\/subtitles\/[\w.-]+\.(ass|ssa|vtt|srt)$/i;
const TYPES = { ass: "text/x-ssa", ssa: "text/x-ssa", vtt: "text/vtt", srt: "application/x-subrip" };
const MAX_OCTETS = 2 * 1024 * 1024;

const envoie = (res, u, corps) => {
  const ext = u.split(".").pop().toLowerCase();
  res.setHeader("Content-Type", `${TYPES[ext] || "text/plain"}; charset=utf-8`);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=31536000, immutable");
  return res.status(200).send(corps);
};

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  const u = typeof req.query.u === "string" ? req.query.u : "";
  if (!PERMIS.test(u)) return res.status(400).json({ error: "url refusee" });

  /* D'ABORD LA TABLE (25/11/2026) : le CDN refuse aussi les IP de Vercel
     (403). Les .ass fr/en y sont ranges par tools/anizone/seed.mjs. */
  const db = getTursoClient();
  if (db) {
    const stocke = await lisSousTitre(db, u).catch(() => null);
    if (stocke) return envoie(res, u, stocke);
  }

  let r;
  try {
    r = await fetch(u, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        Referer: "https://anizone.to/",
      },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "cdn injoignable" });
  }
  if (!r.ok) {
    // 404/410 : le fichier n'existe pas, on peut le dire une heure.
    res.setHeader("Cache-Control", r.status === 404 || r.status === 410 ? "public, s-maxage=3600" : "no-store");
    return res.status(r.status === 404 || r.status === 410 ? 404 : 502).json({ error: `cdn ${r.status}` });
  }
  const corps = await r.text();
  if (corps.length > MAX_OCTETS) return res.status(413).json({ error: "trop gros" });
  return envoie(res, u, corps);
}
