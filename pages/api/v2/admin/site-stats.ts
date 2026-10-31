import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { getAdminTursoClient } from "@/lib/db/turso-admin";

/**
 * Les statistiques du site, telles que tools/stats/instantane.mjs les a
 * calculees (chaque jour par GitHub Actions ; catalogue et images chaque
 * semaine). Admin seulement.
 *
 * Aucune requete lourde ici : une ligne par section (~10) et un resume par
 * jour pour les courbes (90 jours au plus). Le cout de chaque section est dans
 * la reponse, mesure au moment du calcul.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) return res.status(403).json({ error: "Forbidden" });

  const db = getAdminTursoClient();
  if (!db) return res.status(503).json({ error: "Base admin non configuree" });
  try {
    const [sections, jours] = await Promise.all([
      db.execute("SELECT section, data, calcule_le, cout, duree_ms, erreur FROM site_stats"),
      db.execute("SELECT jour, resume FROM site_stats_jour ORDER BY jour DESC LIMIT 90"),
    ]);
    const out: Record<string, unknown> = {};
    for (const r of sections.rows) {
      let data: unknown = null;
      try { data = JSON.parse(String(r.data)); } catch { /* ligne illisible : section vide */ }
      out[String(r.section)] = {
        data,
        calculeLe: Number(r.calcule_le) || null,
        cout: r.cout == null ? null : Number(r.cout),
        dureeMs: r.duree_ms == null ? null : Number(r.duree_ms),
        erreur: r.erreur ?? null,
      };
    }
    const historique = jours.rows.reverse().map((r) => {
      let resume: Record<string, number | null> = {};
      try { resume = JSON.parse(String(r.resume)); } catch { /* ignore */ }
      return { jour: String(r.jour), ...resume };
    });
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ sections: out, historique });
  } catch (e: any) {
    // Tables pas encore creees : l'instantane n'a jamais tourne.
    if (/no such table/i.test(String(e?.message))) return res.status(200).json({ sections: {}, historique: [], vide: true });
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
