/**
 * Les listes d'episodes d'un panneau anime-sama, pour les outils hors du site
 * (detecteur OP/ED, anime-moments). Le site a sa version dans
 * pages/api/v2/source/index.js (parseAnimeSamaPanel / resolveAnimeSamaLien).
 *
 * Format du 12/11/2026 : `episodes.js` repond 404 ; la PAGE du panneau
 * (`/catalogue/<slug>/<saison>/<langue>/`) porte
 *
 *   var eps1 = ["lien:137747", "", …];        // un repere par episode, "" = trou
 *   var epsMeta = {"137747":["ansembed.net"], "137778":["x.com",2]};  // 2e elt = supprimee
 *   var epsJeton = "3824.1794618000.d0ed…";   // valable 24 h
 *
 * et l'adresse d'un episode se demande a /api/lien.php?j=<jeton>&l=<n> ({"u": …}).
 * Chaque repere devient `https://<hote>/aslien/<n>?j=<jeton>` : l'hote y figure,
 * donc le choix du lecteur par nom d'hote marche comme avant, et seul l'episode
 * retenu coute un appel. Une video marquee supprimee devient un trou ("").
 * Une page a l'ancien format (adresses en clair) passe telle quelle.
 */

/** `var epsN = [...]` -> tableaux, en GARDANT les cases vides (position = episode). */
export function listesEps(texte) {
  const out = [];
  for (const m of String(texte).matchAll(/var\s+eps\d+\s*=\s*\[([^\]]*)\]/g)) {
    const urls = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => (x[1] ?? x[2] ?? "").trim());
    if (urls.some((u) => u)) out.push(urls);
  }
  return out;
}

/** Page du panneau (nouveau format) ou episodes.js (ancien) -> tableaux d'adresses. */
export function parsePanneau(texte) {
  const listes = listesEps(texte);
  if (!listes.some((a) => a.some((u) => u.startsWith("lien:")))) return listes;
  let meta = {};
  try { meta = JSON.parse(texte.match(/var\s+epsMeta\s*=\s*(\{[\s\S]*?\})\s*;/)?.[1] || "{}"); } catch { meta = {}; }
  const jeton = texte.match(/var\s+epsJeton\s*=\s*"([^"]+)"/)?.[1] || "";
  return listes.map((arr) => arr.map((u) => {
    if (!u.startsWith("lien:")) return u;
    const n = u.slice(5), m = meta[n];
    if (!Array.isArray(m) || !m[0] || m[1]) return "";
    return `https://${m[0]}/aslien/${n}?j=${encodeURIComponent(jeton)}`;
  }));
}

/** Premiere adresse non vide d'un tableau (le nom d'hote d'une liste). */
export const premiere = (arr) => arr.find((u) => u) || "";

const ASLIEN = /^https:\/\/[^/]+\/aslien\/(\d+)\?j=(.*)$/;

/** L'adresse lien.php d'une pseudo-adresse, ou null si ce n'en est pas une. */
export function urlLienPhp(url, base = "https://anime-sama.to") {
  const m = typeof url === "string" && url.match(ASLIEN);
  return m ? `${base}/api/lien.php?j=${m[2]}&l=${m[1]}` : null;
}

/**
 * Pseudo-adresse -> adresse reelle ; toute autre adresse est rendue telle quelle.
 * `lireTexte(url)` : la facon de l'outil d'aller chercher une page (direct,
 * Worker…). En direct, ne PAS envoyer `Sec-Fetch-Site: cross-site` (403
 * {"erreur":"origine"}) — node n'en envoie aucun, ce qui passe.
 */
export async function adresseReelle(url, lireTexte, base) {
  const php = urlLienPhp(url, base);
  if (!php) return url;
  const texte = await lireTexte(php);
  let u = null;
  try { u = JSON.parse(texte)?.u; } catch { u = null; }
  if (typeof u !== "string" || !/^https?:\/\//.test(u)) throw new Error(`lien.php sans adresse (${url.match(ASLIEN)[1]})`);
  return u;
}
