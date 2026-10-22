/**
 * Comparer deux series de captures (avant / apres) pixel par pixel.
 *
 *   node tools/browser-check/compare-captures.mjs <dossier-avant> <dossier-apres> [dossier-diff]
 *
 * Sert a prouver qu'un changement mobile ne touche PAS le PC : on capture le PC
 * avant (mobile-audit.mjs avec BUREAU=1), on modifie, on recapture, on compare.
 * Pour chaque PNG present des deux cotes : part des pixels differents (un ecart
 * de plus de 24 sur un canal), et une image de diff (avant assombri, pixels
 * changes en rouge) dans [dossier-diff].
 *
 * Bruit attendu : un compte a rebours, une recommandation tiree au hasard. Faire
 * deux captures « avant » de suite donne le niveau de bruit de chaque page.
 * Aucune dependance : PNG decode/encode avec le zlib de Node.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const [dirA, dirB, dirDiff] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.error("usage : node tools/browser-check/compare-captures.mjs <avant> <apres> [diff]");
  process.exit(1);
}
if (dirDiff) mkdirSync(dirDiff, { recursive: true });
const REF2 = process.env.REF2 || null;

function decode(buf) {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8) throw new Error("PNG 8 bits seulement"); }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error("type PNG " + ct); })();
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(w * h * 4), prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * bpp;
      out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    cur.copy(prev);
  }
  return { w, h, px: out };
}

function encode(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let pire = 0;
for (const f of readdirSync(dirA).filter((f) => f.endsWith(".png")).sort()) {
  if (!existsSync(join(dirB, f))) { console.log(`?  ${f}  absent du second dossier`); continue; }
  const A = decode(readFileSync(join(dirA, f))), B = decode(readFileSync(join(dirB, f)));
  if (A.w !== B.w || A.h !== B.h) { console.log(`≠  ${f}  taille ${A.w}x${A.h} → ${B.w}x${B.h}`); pire = Math.max(pire, 100); continue; }
  // REF2 = une seconde capture « avant » : un pixel ne compte que s'il differe
  // des DEUX references (le bruit d'une page — logo tire au hasard, toast — est
  // ignore puisqu'il differe deja entre les deux « avant »).
  const R2 = REF2 && existsSync(join(REF2, f)) ? decode(readFileSync(join(REF2, f))) : null;
  const ref2 = R2 && R2.w === A.w && R2.h === A.h ? R2.px : null;
  const ecart = (P, i) => Math.max(Math.abs(P[i] - B.px[i]), Math.abs(P[i + 1] - B.px[i + 1]), Math.abs(P[i + 2] - B.px[i + 2]));
  let diff = 0;
  const vue = Buffer.alloc(A.px.length);
  for (let i = 0; i < A.px.length; i += 4) {
    const d = ref2 ? Math.min(ecart(A.px, i), ecart(ref2, i)) : ecart(A.px, i);
    if (d > 24) { diff++; vue[i] = 255; vue[i + 1] = 0; vue[i + 2] = 0; }
    else { vue[i] = A.px[i] >> 2; vue[i + 1] = A.px[i + 1] >> 2; vue[i + 2] = A.px[i + 2] >> 2; }
    vue[i + 3] = 255;
  }
  const pct = (100 * diff) / (A.w * A.h);
  pire = Math.max(pire, pct);
  console.log(`${pct === 0 ? "=" : pct < 0.5 ? "~" : "≠"}  ${f}  ${pct.toFixed(2)} % de pixels differents`);
  if (dirDiff && diff) writeFileSync(join(dirDiff, f), encode(A.w, A.h, vue));
}
console.log(`\npire ecart : ${pire.toFixed(2)} %`);
