/**
 * Controle de la chaine megaplay, maillon par maillon, SANS passer par Vercel.
 *
 * Pourquoi : megaplay casse par morceaux et en silence — getSources refuse les
 * IP Cloudflare pour les fichiers recents, les CDN de segments meurent en
 * pleine lecture, les segments sont deguises (.jpg/.html, leurre PNG), le CDN
 * ignore `Range`. Chacun de ces trous a fait « basculer » le lecteur sur
 * iPhone (28/09/2026). Ce script rejoue ce que font la route /api/v2/source et
 * le lecteur natif d'iOS, et dit quel maillon lache.
 *
 *   node tools/browser-check/megaplay-check.mjs            # jeu par defaut
 *   node tools/browser-check/megaplay-check.mjs 16049:1 40748:3
 *
 * Par episode (id MAL:episode) :
 *   1. page megaplay (via le Worker) → data-id
 *   2. getSources : via le Worker, puis en direct avec X-Requested-With
 *      (le second essai de la route) → enc dechiffre → master
 *   3. master puis variante via le Worker (Referer megaplay)
 *   4. 3 segments pris au hasard, `Range: bytes=0-1` → 206, video/*, CORS
 *   5. 1 segment complet → 200, commence par 0x47 (TS)
 *
 * Une requete a la fois, jamais de boucle contre aniscroll.com.
 */
import crypto from "node:crypto";

const WORKER = process.env.PROXY_BASE || "https://proxy.aniscroll.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REF = "https://megaplay.buzz/";

// Clef/IV de leur lib/newclient.min.js — meme valeur que lib/extractors.js.
const IV = Buffer.from("W0;27ToaUpl_P%'c", "utf8");
const KEY = Buffer.alloc(32);
Buffer.from("i?LMTAx0Q6,:}50U", "utf8").copy(KEY, 0);
function ouvreEnc(enc) {
  try {
    const d = crypto.createDecipheriv("aes-256-cbc", KEY, IV);
    d.setAutoPadding(false);
    const c = Buffer.concat([d.update(enc.replace(/-/g, "+").replace(/_/g, "/"), "base64"), d.final()]).toString("utf8");
    return JSON.parse(c.slice(0, c.lastIndexOf("}") + 1)).file || null;
  } catch {
    return null;
  }
}

const via = (u, ref, init = {}) =>
  fetch(`${WORKER}/?url=${encodeURIComponent(u)}${ref ? `&referer=${encodeURIComponent(ref)}` : ""}`, {
    ...init,
    headers: { Origin: "https://dev.aniscroll.com", ...(init.headers || {}) },
  });

const JEU = [
  "16049:1", "16049:2", "16049:3", // Railgun S — ids recents (> 117 000)
  "52991:1", "40748:3", "16498:1", "38000:1", "21:1",
  "5114:1", "11061:1", "20583:1", "30276:1", "51009:1", "54595:1", "37521:1",
];

async function controle(mal, ep) {
  const r = { ep: `${mal}:${ep}`, ok: false, etapes: [] };
  const note = (s) => r.etapes.push(s);
  const page = await (await via(`https://megaplay.buzz/stream/mal/${mal}/${ep}/sub`)).text();
  const id = page.match(/data-id="(\d+)"/)?.[1];
  if (!id) return note("pas de data-id (episode absent ?)"), r;
  note(`data-id ${id}`);

  let src = null;
  const w = await via(`https://megaplay.buzz/stream/getSources?id=${id}`).then((x) => x.json()).catch(() => null);
  if (w && !w.error && w.enc) src = w, note("getSources Worker OK");
  else {
    note(`getSources Worker refuse (${w?.upstream ?? w?.error ?? "?"})`);
    const d = await fetch(`https://megaplay.buzz/stream/getSources?id=${id}`, {
      headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" },
    }).then((x) => x.json()).catch(() => null);
    if (d && !d.error && d.enc) src = d, note("getSources direct OK");
    else return note("getSources direct refuse aussi"), r;
  }
  const master = ouvreEnc(src.enc);
  if (!master) return note("enc illisible (clef changee ?)"), r;

  const m = await via(master, REF);
  const mt = await m.text();
  if (!m.ok || !/#EXTM3U/.test(mt)) return note(`master ${m.status}`), r;
  if (!m.headers.get("access-control-allow-origin")) return note("master sans CORS"), r;
  const variante = mt.split("\n").find((l) => l && !l.startsWith("#"));
  const v = await fetch(variante.trim(), { headers: { Origin: "https://dev.aniscroll.com" } });
  const vt = await v.text();
  const segs = vt.split("\n").filter((l) => l && !l.startsWith("#"));
  if (!v.ok || segs.length === 0) return note(`variante ${v.status}`), r;
  note(`${segs.length} segments`);

  for (let k = 0; k < 3; k++) {
    const s = segs[Math.floor(Math.random() * segs.length)].trim();
    const x = await fetch(s, { headers: { Range: "bytes=0-1", Origin: "https://dev.aniscroll.com" } });
    const corps = Buffer.from(await x.arrayBuffer());
    const ty = x.headers.get("content-type") || "";
    const cors = !!x.headers.get("access-control-allow-origin");
    if (x.status !== 206 || corps.length !== 2 || !/video/.test(ty) || !cors) {
      return note(`segment Range : ${x.status} ${ty} ${corps.length} o cors=${cors}`), r;
    }
  }
  note("Range 3/3 → 206 video");
  const plein = await fetch(segs[Math.floor(segs.length / 2)].trim());
  const b = Buffer.from(await plein.arrayBuffer());
  if (!plein.ok || b[0] !== 0x47) return note(`segment complet : ${plein.status} premier octet ${b[0]}`), r;
  note(`segment complet ${b.length} o, TS`);
  r.ok = true;
  return r;
}

const jeu = process.argv.slice(2).length ? process.argv.slice(2) : JEU;
let bons = 0;
for (const e of jeu) {
  const [mal, ep] = e.split(":");
  let r;
  try {
    r = await controle(mal, ep);
  } catch (err) {
    r = { ep: e, ok: false, etapes: [`exception ${err.message}`] };
  }
  if (r.ok) bons++;
  console.log(`${r.ok ? "OK  " : "ECHEC"} ${r.ep.padEnd(9)} ${r.etapes.join(" · ")}`);
}
console.log(`\n${bons}/${jeu.length} episodes : chaine megaplay complete`);
process.exit(bons === jeu.length ? 0 : 1);
