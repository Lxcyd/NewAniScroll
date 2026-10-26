import type { NextApiRequest, NextApiResponse } from "next";
import { createHmac, randomBytes } from "node:crypto";
import { requireUser } from "@/lib/auth/session";
import { checkThrottle } from "@/lib/auth/throttle";
import { UPLOAD_ORIGIN } from "@/lib/upload/media";

/**
 * POST → un jeton d'envoi pour UN fichier du studio (avatar ou fond), à
 * présenter au Worker (`POST https://proxy.aniscroll.com/w/u`,
 * worker/src/uploads.js). Le fichier ne passe jamais par Vercel : pas de corps
 * de 15 Mo dans une fonction, pas de CPU facturé pour le transférer.
 *
 * Jeton : `uid.exp.nonce.usage.sig`, signé HMAC-SHA256 par UPLOAD_SECRET (le
 * même secret côté Worker). Le `nonce` devient l'identifiant du fichier, d'où
 * « un jeton = un fichier ». Le Worker borne aussi la PLACE : 30 Mo par compte.
 *
 * BORNÉ PAR COMPTE : 20 jetons par 24 h. C'est ce qui protège le KV gratuit
 * (1 000 écritures par jour, 1 Go en tout) d'un compte qui enverrait en boucle.
 * Un invité n'a pas de compte et n'arrive pas ici : l'import par serveur est
 * réservé aux comptes.
 */
const PER_DAY = 20;
const TTL_MS = 5 * 60 * 1000;

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  res.setHeader("Cache-Control", "no-store");
  const secret = process.env.UPLOAD_SECRET;
  if (!secret) return res.status(503).json({ error: "storage" });

  const user = await requireUser(req, res);
  if (!user) return;

  /* `?for=delete` : un jeton de SUPPRESSION (retirer un de ses fichiers).
     Hors limite — retirer rend de la place —, et signé comme tel : le Worker
     refuse un jeton de suppression pour un envoi, et inversement. */
  const usage = req.query.for === "delete" ? "d" : "u";
  if (usage === "u") {
    const gate = await checkThrottle(`upload:${user.id}`, PER_DAY, 24 * 3600 * 1000);
    if (!gate.ok) return res.status(429).json({ error: "quota", retryAfterMs: gate.retryAfterMs });
  }

  const exp = Date.now() + TTL_MS;
  const nonce = randomBytes(16).toString("hex");
  const body = `${user.id}.${exp}.${nonce}.${usage}`;
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return res.status(200).json({ token: `${body}.${sig}`, endpoint: `${UPLOAD_ORIGIN}/w/u` });
}
