import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { redis } from "@/lib/redis";
import {
  getAdminTursoClient,
  ensureAdminSchema,
  logAuditEvent,
} from "@/lib/db/turso-admin";
import { collectAll, type Measure } from "@/lib/quotas/measure";
import { buildRows, sortRows, SORTS, type SortKey } from "@/lib/quotas/rows";

/**
 * GET  /api/v2/admin/quotas?sort=closest[&fresh=1]
 * POST /api/v2/admin/quotas   { id, used, note? }   — releve manuel
 *
 * Admin uniquement.
 *
 * CE QUE CETTE PAGE COUTE. Elle interroge trois API tierces. Les plans de
 * controle (Upstash mgmt, Turso platform, Vercel) ne comptent pas dans les
 * quotas qu'ils rapportent, mais ils ne sont pas gratuits en temps de fonction
 * — et le temps de fonction, lui, sort du budget Fluid qui a fait tomber le
 * compte. D'ou un cache Redis de 10 minutes : une page de surveillance qu'on
 * rafraichit nerveusement ne doit pas devenir elle-meme une ligne du tableau.
 * `?fresh=1` force le releve quand on veut voir l'effet d'une action.
 */
const CACHE_KEY = "admin:quotas:v1";
const TTL_S = 10 * 60;

/** Releves manuels stockes dans la base admin, ramenes au meme format que les
 *  mesures automatiques pour que buildRows n'ait pas a distinguer les deux. */
async function readManual(): Promise<Record<string, Measure>> {
  const db = getAdminTursoClient();
  if (!db) return {};
  try {
    await ensureAdminSchema();
    const r = await db.execute(
      "SELECT quota_id, used, note, recorded_by, recorded_at FROM quota_readings",
    );
    const out: Record<string, Measure> = {};
    for (const row of r.rows as any[]) {
      out[String(row.quota_id)] = {
        used: Number(row.used),
        at: new Date(Number(row.recorded_at) * 1000).toISOString(),
        source: `saisie — ${row.recorded_by || "admin"}`,
        detail: row.note ? String(row.note) : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "POST") {
    const { id, used, note } = req.body || {};
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "id manquant" });
    }
    const db = getAdminTursoClient();
    if (!db) {
      return res
        .status(503)
        .json({ error: "base admin indisponible (TURSO_ADMIN_URL absent)" });
    }
    await ensureAdminSchema();

    // `used` nul ou vide = effacer le releve, pour qu'un chiffre faux puisse
    // etre retire plutot que corrige a l'aveugle.
    if (used === null || used === "" || used === undefined) {
      await db.execute({
        sql: "DELETE FROM quota_readings WHERE quota_id = ?",
        args: [id],
      });
    } else {
      const n = Number(used);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: "valeur invalide" });
      }
      await db.execute({
        sql: `INSERT INTO quota_readings (quota_id, used, note, recorded_by, recorded_at)
              VALUES (?, ?, ?, ?, strftime('%s','now'))
              ON CONFLICT(quota_id) DO UPDATE SET
                used = excluded.used,
                note = excluded.note,
                recorded_by = excluded.recorded_by,
                recorded_at = excluded.recorded_at`,
        args: [id, n, note ? String(note).slice(0, 300) : null, session?.user?.name || "admin"],
      });
    }

    // Le cache porte les releves : le laisser en place afficherait l'ancienne
    // valeur pendant 10 minutes juste apres l'avoir corrigee.
    if (redis) {
      try {
        await redis.del(CACHE_KEY);
      } catch {}
    }
    await logAuditEvent(
      session?.user?.name || "admin",
      "quota.reading",
      id,
      String(used ?? "supprime"),
    );
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const sortParam = String(req.query.sort || "closest");
  const sort: SortKey = (sortParam in SORTS ? sortParam : "closest") as SortKey;
  const bypass = req.query.fresh === "1";

  let payload: any = null;
  if (redis && !bypass) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        payload = JSON.parse(cached);
        res.setHeader("X-Cache", "HIT");
      }
    } catch {
      /* un cache indisponible ne doit jamais couter la page */
    }
  }

  if (!payload) {
    const [collected, manual] = await Promise.all([collectAll(), readManual()]);
    payload = {
      rows: buildRows(collected.measures, manual),
      errors: collected.errors,
      collectedAt: new Date().toISOString(),
    };
    if (redis) {
      try {
        await redis.set(CACHE_KEY, JSON.stringify(payload), "EX", TTL_S);
      } catch {}
    }
    res.setHeader("X-Cache", "MISS");
  }

  // Jamais de cache au bord : la reponse depend de la session admin.
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({
    ...payload,
    sort,
    sorts: SORTS,
    rows: sortRows(payload.rows, sort),
  });
}
