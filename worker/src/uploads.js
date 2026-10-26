/**
 * LES IMPORTS DU STUDIO (24/10/2026) : images, GIF et vidéos déposés pour
 * l'avatar ou le fond d'un profil. Rangés dans KV (W2G_CACHE, clé `up:<id>`),
 * servis d'ici avec un an de cache au bord. Le pourquoi et les cinq étages de
 * sécurité : lib/upload/media.ts côté site.
 *
 *   POST /w/u                → dépose un fichier. Corps = le fichier brut.
 *                              `Authorization: Bearer <jeton>`, jeton signé par
 *                              le site (pages/api/v2/account/upload-token.ts).
 *   GET  /w/u/<id>.<ext>     → le fichier, avec le type reconnu à l'envoi.
 *   DELETE /w/u/<id>.<ext>   → retire un de SES fichiers (même jeton), et
 *                              rend sa place dans le quota de 30 Mo du compte.
 *
 * UN JETON = UN FICHIER. Le jeton porte un identifiant aléatoire qui DEVIENT
 * celui du fichier : un second envoi avec le même jeton tombe sur une clé déjà
 * prise et est refusé. Le site ne délivre qu'un nombre limité de jetons par
 * compte et par jour, c'est donc lui qui borne les écritures (KV gratuit :
 * 1 000 écritures/jour, 1 Go en tout).
 *
 * PAS DE HACHAGE DU CONTENU : un SHA-256 sur 15 Mo dépasse les 10 ms de CPU
 * d'une requête du plan gratuit. L'identifiant vient du jeton.
 *
 * Secret attendu : UPLOAD_SECRET (wrangler secret put UPLOAD_SECRET), le même
 * que celui du site.
 */

const IMAGE_MAX = 5 * 1024 * 1024;
const VIDEO_MAX = 15 * 1024 * 1024;
/* LA PLACE D'UN COMPTE : 30 Mo au total (24/10/2026, Luc). Avec le 1 Go du
   KV gratuit, ~33 comptes tiennent même s'ils n'importent que des vidéos.
   Tenue dans `upu:<uid>` : la liste { id, s } de ses fichiers. */
const USER_MAX = 30 * 1024 * 1024;

async function readUsage(kv, uid) {
  try {
    const list = JSON.parse((await kv.get(`upu:${uid}`)) || "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x?.id === "string" && Number.isFinite(x?.s)) : [];
  } catch {
    return [];
  }
}
const used = (list) => list.reduce((n, x) => n + x.s, 0);
const GET_RE = /^\/w\/u\/([0-9a-f]{32})\.(webp|jpg|png|gif|mp4|webm)$/;

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

/** Même règle que `sniff` dans lib/upload/media.ts — les deux se tiennent. */
function sniff(b) {
  const at = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length < 12) return null;
  if (b[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return { type: "image/png", ext: "png", video: false };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg", video: false };
  if (at(0, "RIFF") && at(8, "WEBP")) return { type: "image/webp", ext: "webp", video: false };
  if (at(0, "GIF87a") || at(0, "GIF89a")) return { type: "image/gif", ext: "gif", video: false };
  if (at(4, "ftyp")) {
    /* AVIF, HEIC : même en-tête qu'un MP4, mais des images. Le navigateur les
       redessine en WebP avant l'envoi : il n'en arrive jamais de légitime. */
    if (["avif", "avis", "heic", "heix", "mif1", "msf1"].some((x) => at(8, x))) return null;
    return { type: "video/mp4", ext: "mp4", video: true };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: "video/webm", ext: "webm", video: true };
  return null;
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** `uid.exp.nonce.usage.sig` → { uid, nonce } si la signature, la date et
    l'usage (`u` envoi, `d` suppression) tiennent. */
async function verify(token, secret, usage) {
  const parts = (token || "").split(".");
  if (parts.length !== 5 || !secret) return null;
  const [uid, exp, nonce, p, sig] = parts;
  if (p !== usage) return null;
  if (!/^[\w-]{1,64}$/.test(uid) || !/^\d{10,13}$/.test(exp) || !/^[0-9a-f]{32}$/.test(nonce)) return null;
  if (Number(exp) < Date.now()) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${uid}.${exp}.${nonce}.${p}`)));
  /* Comparaison à temps constant. */
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { uid, nonce } : null;
}

async function handlePost(request, env) {
  const kv = env.W2G_CACHE;
  if (!kv) return json({ error: "storage" }, 503);
  const auth = request.headers.get("authorization") || "";
  const who = await verify(auth.replace(/^Bearer\s+/i, ""), env.UPLOAD_SECRET, "u");
  if (!who) return json({ error: "auth" }, 401);

  /* La taille annoncée d'abord : on ne lit pas 200 Mo pour les refuser. */
  const announced = Number(request.headers.get("content-length"));
  if (!announced || announced > VIDEO_MAX) return json({ error: "size" }, 413);

  const key = `up:${who.nonce}`;
  /* Jeton déjà servi. */
  const old = await kv.get(key, "stream");
  if (old) {
    await old.cancel();
    return json({ error: "used" }, 409);
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength > VIDEO_MAX) return json({ error: "size" }, 413);
  const kind = sniff(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
  if (!kind) return json({ error: "type" }, 415);
  if (!kind.video && buf.byteLength > IMAGE_MAX) return json({ error: "size" }, 413);

  const usage = await readUsage(kv, who.uid);
  if (used(usage) + buf.byteLength > USER_MAX) {
    return json({ error: "space", used: used(usage), max: USER_MAX }, 507);
  }

  await kv.put(key, buf, {
    metadata: { t: kind.type, e: kind.ext, u: who.uid, s: buf.byteLength, at: Date.now() },
  });
  const next = [...usage, { id: who.nonce, s: buf.byteLength }];
  await kv.put(`upu:${who.uid}`, JSON.stringify(next));
  return json({
    url: `${new URL(request.url).origin}/w/u/${who.nonce}.${kind.ext}`,
    type: kind.type,
    used: used(next),
    max: USER_MAX,
  });
}

/* DELETE /w/u/<id>.<ext> — retirer un de SES fichiers (le jeton dit qui l'on
   est, la métadonnée du fichier dit à qui il est). Le cache du bord de ce
   point de présence est vidé ; ailleurs, la copie en cache s'éteint d'elle-même
   et plus personne ne pointe dessus. */
async function handleDelete(request, pathname, env, ctx) {
  const kv = env.W2G_CACHE;
  const m = GET_RE.exec(pathname);
  if (!kv || !m) return json({ error: "not_found" }, 404);
  const auth = request.headers.get("authorization") || "";
  const who = await verify(auth.replace(/^Bearer\s+/i, ""), env.UPLOAD_SECRET, "d");
  if (!who) return json({ error: "auth" }, 401);
  const { value, metadata } = await kv.getWithMetadata(`up:${m[1]}`, "stream");
  if (value) await value.cancel();
  if (!metadata) return json({ ok: true });
  if (metadata.u !== who.uid) return json({ error: "owner" }, 403);
  await kv.delete(`up:${m[1]}`);
  const usage = (await readUsage(kv, who.uid)).filter((x) => x.id !== m[1]);
  await kv.put(`upu:${who.uid}`, JSON.stringify(usage));
  ctx.waitUntil(caches.default.delete(new Request(new URL(pathname, request.url).toString())));
  return json({ ok: true, used: used(usage), max: USER_MAX });
}

function serve(body, meta, request) {
  const total = body.byteLength;
  const headers = cors({
    "Content-Type": meta.t,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
  });
  /* Les vidéos se lisent par morceaux (Safari l'exige). Une vue sur le tampon,
     pas une copie. */
  const range = request.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (m && (m[1] !== "" || m[2] !== "")) {
    const start = m[1] === "" ? Math.max(0, total - Number(m[2])) : Number(m[1]);
    const end = m[1] !== "" && m[2] !== "" ? Math.min(total - 1, Number(m[2])) : total - 1;
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` } });
    }
    return new Response(new Uint8Array(body, start, end - start + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(body, { headers: { ...headers, "Content-Length": String(total) } });
}

async function handleGet(request, pathname, env, ctx) {
  const m = GET_RE.exec(pathname);
  if (!m || !env.W2G_CACHE) return new Response("Not found", { status: 404, headers: cors() });
  /* Le cache du bord est rangé SANS l'en-tête Range : une seule entrée par
     fichier, découpée ici à la demande. */
  const cacheKey = new Request(new URL(pathname, request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const meta = { t: hit.headers.get("content-type") };
    return serve(await hit.arrayBuffer(), meta, request);
  }
  const { value, metadata } = await env.W2G_CACHE.getWithMetadata(`up:${m[1]}`, "arrayBuffer");
  /* L'extension de l'adresse doit être celle que le Worker a reconnue. */
  if (!value || !metadata || metadata.e !== m[2]) {
    return new Response("Not found", { status: 404, headers: cors({ "Cache-Control": "public, max-age=300" }) });
  }
  const full = serve(value, metadata, new Request(request.url));
  ctx.waitUntil(cache.put(cacheKey, full.clone()));
  return request.headers.has("range") ? serve(value, metadata, request) : full;
}

/** Les routes /w/u, ou `null`. */
export async function handleUpload(request, pathname, env, ctx) {
  if (pathname !== "/w/u" && !pathname.startsWith("/w/u/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (pathname === "/w/u" && request.method === "POST") return handlePost(request, env);
  if (request.method === "DELETE") return handleDelete(request, pathname, env, ctx);
  if (request.method === "GET" || request.method === "HEAD") return handleGet(request, pathname, env, ctx);
  return json({ error: "method" }, 405);
}
