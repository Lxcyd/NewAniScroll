import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { getFanartsClient } from "@/lib/db/turso-fanarts";

/**
 * POST /api/v2/admin/fanarts-flag
 *
 * Body: { id: number, decision: "safe"|"suggestive"|"nsfw"|"explicit"|"error"|"reset" }
 *
 * Writes a `manual-*` label so it overrides the IA prediction permanently
 * and can't be re-classified. `reset` sets the row back to NULL so the next
 * classifier run picks it up again.
 */
const ALLOWED = ["safe", "suggestive", "nsfw", "explicit", "error", "reset"] as const;
type Decision = (typeof ALLOWED)[number];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Not signed in" });
  if (session.user?.name !== process.env.ADMIN_USERNAME) {
    return res.status(403).json({ error: "Not admin" });
  }

  const { id, decision } = (req.body || {}) as { id?: number; decision?: string };
  const idNum = Number(id);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return res.status(400).json({ error: "Missing/invalid id" });
  }
  if (!decision || !ALLOWED.includes(decision as Decision)) {
    return res.status(400).json({ error: `decision must be one of ${ALLOWED.join(", ")}` });
  }

  const db = getFanartsClient();
  if (!db) return res.status(503).json({ error: "DB unavailable" });

  const now = Math.floor(Date.now() / 1000);

  try {
    // The same image URL can be attached to many AniList ids (Pokémon has
    // 43 entries pointing at the same fanart, each One Piece season too).
    // Look up the URL of the row the admin clicked, then fan the decision
    // out to ALL rows sharing that URL — otherwise the next 42 review
    // rounds would just show the same Pokémon image again.
    const urlRow = await db.execute({
      sql: "SELECT url FROM anime_fanarts WHERE id = ?",
      args: [idNum],
    });
    if (urlRow.rows.length === 0) {
      return res.status(404).json({ error: "Row not found" });
    }
    const url = String((urlRow.rows[0] as any).url);

    let result;
    if (decision === "reset") {
      result = await db.execute({
        sql: `UPDATE anime_fanarts SET
                nsfw_label = NULL,
                classified_at = NULL,
                classification_attempts = 0,
                nsfw_safe = NULL,
                nsfw_score = NULL
              WHERE url = ?`,
        args: [url],
      });
    } else {
      const newLabel = `manual-${decision}`;
      result = await db.execute({
        sql: `UPDATE anime_fanarts SET
                nsfw_label = ?,
                classified_at = ?
              WHERE url = ?`,
        args: [newLabel, now, url],
      });
    }
    return res.status(200).json({ ok: true, rowsAffected: result.rowsAffected });
  } catch (e: any) {
    console.error("[admin/fanarts-flag]", e?.message);
    return res.status(500).json({ error: e?.message });
  }
}
