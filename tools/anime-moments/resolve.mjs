// Resolveur autonome : slug anime-sama + saison -> URLs de flux directes.
//
// Volontairement INDEPENDANT de tools/opening-detector : cet outil doit pouvoir
// vivre, evoluer et casser sans toucher au detecteur OP/ED, qui alimente la
// prod. La seule dependance partagee est `lib/extractors.js`, la bibliotheque
// d'extraction de l'application elle-meme — pas un composant du detecteur.
//
// N'importe PAS pages/api/v2/source : cette route tire Redis, Turso et AniList.
// Le parsing d'episodes.js est reecrit ici en une dizaine de lignes.
//
// Usage:
//   node resolve.mjs <slug> <seasonDir> <lang> <epStart> <epEnd> [host]
// Exemple:
//   node resolve.mjs cyberpunk-edgerunners saison1 vostfr 1 10 ansembed
//
// Sortie : UNE ligne JSON — { ok, host, episodes: [{ep, url, isM3U8}], errors }

import { getExtractor, VIDMOLY_HOST_RE } from "../../lib/extractors.js";

// ⚠️ La famille Vidmoly (vidmoly.*, ansembed.net, voembed.net) NE PASSE PAS par
// `getExtractor`. `lib/extractors.js` extrait deliberement via le Worker
// Cloudflare, pour que le jeton du master.m3u8 se lie au Worker — ce qui est
// juste pour le NAVIGATEUR, dont les segments transitent par le meme Worker.
//
// Ici c'est faux : ffmpeg tire depuis CETTE machine. Un jeton lie au Worker
// donne un 403 sur chaque segment. Signature reconnaissable : l'URL rendue
// porte `asn=132892` (Cloudflare) au lieu de l'ASN du fournisseur local.
// L'extraction doit donc partir d'ici, pour que le jeton s'y lie.
const VIDMOLY_DOMAINS = ["ansembed.net", "voembed.net", "vidmoly.net",
                         "vidmoly.to", "vidmoly.biz"];
const VIDMOLY_PASSES = 2;      // un leurre a froid ou un 429 ne prouve rien
const VIDMOLY_PAUSE_MS = 1500;

async function extractVidmolyLocal(embedUrl) {
  const why = new Map();
  for (let pass = 0; pass < VIDMOLY_PASSES; pass++) {
    if (pass) await new Promise((r) => setTimeout(r, VIDMOLY_PAUSE_MS));
    for (const domain of VIDMOLY_DOMAINS) {
      const url = embedUrl.replace(VIDMOLY_HOST_RE, domain);
      let html;
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": UA, Referer: `${BASE}/` },
          redirect: "follow",
        });
        if (!r.ok) { why.set(domain, `HTTP ${r.status}`); continue; }
        html = await r.text();
      } catch (e) { why.set(domain, e.message); continue; }
      if (!html || html.length < 500) {
        why.set(domain, `page courte (${html ? html.length : 0}o)`);
        continue;
      }
      const m = html.match(/file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/)
             || html.match(/['"](https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)['"]/);
      if (m && m[1].startsWith("http")) {
        // ffmpeg a besoin du Referer du domaine pour les segments.
        return { streams: [{ url: m[1], isM3U8: true, referer: `https://${domain}/` }] };
      }
      why.set(domain, `page ${html.length}o sans m3u8`);
    }
  }
  const detail = [...why].map(([d, r]) => `${d}: ${r}`).join(" | ");
  return { error: `vidmoly: aucune source apres ${VIDMOLY_PASSES} passages — ${detail}` };
}

const BASE = "https://anime-sama.to";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// anime-sama bloque les IP de data-center (erreur Cloudflare 1042), donc pas de
// worker ici : la requete part de la machine qui execute l'outil.
async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: `${BASE}/` } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

/** episodes.js declare une liste d'URLs d'embed par lecteur : `var eps1 = [...]`. */
function parseEpisodesJs(js) {
  const arrays = [];
  const re = /var\s+eps\d+\s*=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    const urls = [];
    const ure = /['"]([^'"]+)['"]/g;
    let um;
    while ((um = ure.exec(m[1])) !== null) urls.push(um[1]);
    if (urls.length) arrays.push(urls);
  }
  return arrays;
}

// Le nom d'hote sous lequel chaque lecteur apparait dans episodes.js. ansembed
// est du Vidmoly en marque blanche : c'est le meme backend, servi par un autre
// domaine, et c'est le plus tolerant a plusieurs flux simultanes.
const HOST_MATCH = {
  ansembed: ["ansembed", "vidmoly"],
  vidmoly: ["vidmoly"],
  sibnet: ["sibnet"],
  sendvid: ["sendvid"],
  uqload: ["uqload"],
};

// Quand l'extracteur n'en fournit pas, ces hotes en exigent un quand meme.
const REFERER_FALLBACK = {
  sibnet: "https://video.sibnet.ru/",
};

function findHostArray(arrays, host) {
  const needles = HOST_MATCH[host] || [host];
  for (const needle of needles) {
    for (const arr of arrays) {
      if (arr.length && arr[0].toLowerCase().includes(needle)) return arr;
    }
  }
  return null;
}

async function main() {
  const [slug, seasonDir, lang, startS, endS, hostArg] = process.argv.slice(2);
  if (!slug || !seasonDir || !lang || !startS || !endS) {
    console.error("args: <slug> <seasonDir> <lang> <epStart> <epEnd> [host]");
    process.exit(2);
  }
  const host = hostArg || "ansembed";
  const start = Number(startS);
  const end = Number(endS);
  const out = { ok: false, host, episodes: [], errors: [] };

  try {
    const js = await fetchText(`${BASE}/catalogue/${slug}/${seasonDir}/${lang}/episodes.js`);
    const arr = findHostArray(parseEpisodesJs(js), host);
    if (!arr) {
      // Distinguer « non propose par le catalogue » d'une panne : les logs qui
      // confondent les deux ont deja coute une soiree de faux diagnostic.
      out.errors.push(`${host}: non propose par anime-sama pour cette saison`);
      console.log(JSON.stringify(out));
      return;
    }
    for (let ep = start; ep <= end; ep++) {
      const embed = arr[ep - 1];
      if (!embed) {
        out.errors.push(`ep ${ep}: pas d'embed a l'index ${ep - 1}`);
        continue;
      }
      try {
        let res;
        if (VIDMOLY_HOST_RE.test(embed)) {
          res = await extractVidmolyLocal(embed);   // jamais via le Worker, cf. plus haut
        } else {
          const extractor = getExtractor(embed);
          if (!extractor) {
            out.errors.push(`ep ${ep}: aucun extracteur pour ${embed}`);
            continue;
          }
          res = await extractor(embed);
        }
        const s = res?.streams?.[0];
        // Le `referer` rendu par l'extracteur n'est PAS decoratif : la famille
        // Vidmoly refuse les segments (403) sans lui. Le perdre ici donnait des
        // URLs qui resolvaient parfaitement et que ffmpeg ne pouvait pas lire.
        if (s?.url) {
          out.episodes.push({
            ep, url: s.url, isM3U8: !!s.isM3U8, embed,
            referer: s.referer || REFERER_FALLBACK[host] || null,
          });
        } else out.errors.push(`ep ${ep}: ${res?.error || "aucun flux"}`);
      } catch (e) {
        out.errors.push(`ep ${ep}: ${e.message}`);
      }
    }
    out.ok = out.episodes.length > 0;
  } catch (e) {
    out.errors.push(e.message);
  }
  console.log(JSON.stringify(out));
}

main();
