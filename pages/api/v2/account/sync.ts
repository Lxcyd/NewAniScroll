import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import { touchLastSeen } from "@/lib/auth/users";
import {
  getAllData,
  isDataKind,
  MAX_PAYLOAD_BYTES,
  putData,
} from "@/lib/auth/userData";

/**
 * The cloud backup itself.
 *
 *   GET  → { data: [{ kind, payload, rev, updatedAt }, …] }
 *   POST → { entries: { <kind>: payload } } — pushes only the categories the
 *          client actually changed, and answers with the new revisions.
 *
 * Per-category revisions are what let two devices each own the part they
 * touched; the client compares them (lib/list/cloudSync.ts) and only asks the
 * user to arbitrate when the same category moved on both sides.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    void touchLastSeen(user.id);
    return res.status(200).json({ data: await getAllData(user.id) });
  }

  if (req.method === "POST") {
    const entries = req.body?.entries;
    if (!entries || typeof entries !== "object") {
      return res.status(400).json({ error: "entries" });
    }

    const revs: Record<string, number> = {};
    const rejected: string[] = [];
    for (const [kind, payload] of Object.entries(entries)) {
      if (!isDataKind(kind)) {
        rejected.push(kind);
        continue;
      }
      const rev = await putData(user.id, kind, payload);
      // null means the payload blew past MAX_PAYLOAD_BYTES: report it rather
      // than silently dropping a category the user believes is backed up.
      if (rev == null) rejected.push(kind);
      else revs[kind] = rev;
    }

    void touchLastSeen(user.id);
    return res.status(200).json({ revs, rejected, maxBytes: MAX_PAYLOAD_BYTES });
  }

  return res.status(405).json({ error: "method" });
}
