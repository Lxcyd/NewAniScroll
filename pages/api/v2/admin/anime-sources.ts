import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { getTursoClient } from "@/lib/db/turso";

/**
 * La fiche « sources » d'un anime pour la page admin Statistiques (01/11/2026) :
 * quelles pages anime-sama / voir-anime le servent, langue par langue, et l'etat
 * de chaque episode dans la copie de la nuit. Admin seulement, a la demande.
 *
 *   GET ?q=baki      -> candidats (id AniList + titre)
 *   GET ?id=97888    -> la fiche
 *
 * Cout : la recherche parcourt va_page (~6 800 lignes, titres) ; la fiche lit
 * player_map par cle, va_page par son index d'ancre et as_panneau par cle.
 */
type Ep = { n: number; etat: string };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) return res.status(403).json({ error: "Forbidden" });
  const db = getTursoClient();
  if (!db) return res.status(503).json({ error: "Base cache non configuree" });
  res.setHeader("Cache-Control", "private, no-store");

  const q = String(req.query.q || "").trim();
  const id = Number(req.query.id) || (/^\d+$/.test(q) ? Number(q) : 0);
  try {
    if (!id) {
      if (q.length < 2) return res.status(200).json({ candidats: [] });
      const like = `%${q.replace(/[%_]/g, "")}%`;
      const r = await db.execute({
        sql: `SELECT anilist id, max(coalesce(romaji, anglais)) titre, group_concat(langue) langues
              FROM va_page WHERE anilist IS NOT NULL AND (romaji LIKE ? OR anglais LIKE ? OR slug LIKE ?)
              GROUP BY anilist ORDER BY sum(nb_vivants) DESC LIMIT 20`,
        args: [like, like, like],
      });
      return res.status(200).json({ candidats: r.rows.map((x) => ({ id: Number(x.id), titre: String(x.titre || ""), langues: String(x.langues || "") })) });
    }

    const [fiche, pm, va] = await Promise.all([
      db.execute({ sql: `SELECT id, format, status, season_year annee, json_extract(data, '$.episodes') episodes,
          coalesce(json_extract(data, '$.title.userPreferred'), json_extract(data, '$.title.romaji')) titre FROM anime WHERE id = ?`, args: [id] }),
      db.execute({ sql: "SELECT source, lang, status, slug, season_dir, ep_offset, note FROM player_map WHERE ani_id = ?", args: [id] }),
      db.execute({ sql: "SELECT slug, langue, episodes FROM va_page WHERE anilist = ?", args: [id] }),
    ]);
    const lignes: any[] = [];

    // anime-sama : la saison que player_map designe, dans chaque piste de langue (vf, vf1, vf2).
    for (const r of pm.rows.filter((x) => x.source === "animesama")) {
      const langues = r.lang === "vf" ? ["vf", "vf1", "vf2"] : ["vostfr"];
      const p = await db.execute({
        sql: `SELECT langue, nb_ep, nb_vivants, nb_morts, liens, sendvid FROM as_panneau WHERE slug = ? AND dossier = ? AND langue IN (${langues.map(() => "?").join(",")})`,
        args: [String(r.slug), String(r.season_dir), ...langues],
      });
      for (const x of p.rows) {
        let liens: Record<string, any[]> = {};
        try { liens = JSON.parse(String(x.liens)); } catch { /* illisible */ }
        const eps: Ep[] = Object.entries(liens).map(([n, l]) => ({
          n: Number(n),
          etat: l.some((y: any[]) => y[1] === "vivant") ? "vivant" : l.some((y: any[]) => y[1] === "mort") ? "mort" : "inconnu",
        })).sort((a, b) => a.n - b.n);
        lignes.push({ source: "anime-sama", lecteur: "Ansembed", lang: r.lang, page: `${r.slug}/${r.season_dir}/${x.langue}`, statut: r.status, note: r.note, nbEp: Number(x.nb_ep), vivants: Number(x.nb_vivants), morts: Number(x.nb_morts), eps });
        // Sendvid : liens gardes a part par la copie (presence seule, pas de controle).
        let sv: Record<string, string> = {};
        try { sv = JSON.parse(String(x.sendvid || "{}")); } catch { /* illisible */ }
        if (Object.keys(sv).length) {
          const n = Number(x.nb_ep) || Math.max(...Object.keys(sv).map(Number));
          const svEps: Ep[] = Array.from({ length: n }, (_, i) => ({ n: i + 1, etat: sv[i + 1] ? "present" : "absent" }));
          lignes.push({ source: "anime-sama", lecteur: "Sendvid", lang: r.lang, page: `${r.slug}/${r.season_dir}/${x.langue}`, statut: r.status, note: "presence du lien, non controle", nbEp: Object.keys(sv).length, vivants: Object.keys(sv).length, morts: 0, eps: svEps });
        }
      }
      if (!p.rows.length) lignes.push({ source: "anime-sama", lecteur: "Ansembed", lang: r.lang, page: `${r.slug}/${r.season_dir}`, statut: r.status, note: r.note, nbEp: 0, vivants: 0, morts: 0, eps: [] });
    }

    // voir-anime : la page servie (player_map) ou, a defaut, celles ancrees sur cet id.
    const pages = new Map<string, any>(va.rows.map((x) => [String(x.slug), x]));
    for (const r of pm.rows.filter((x) => x.source === "voiranime" && x.slug && !pages.has(String(x.slug)))) {
      const p = await db.execute({ sql: "SELECT slug, langue, episodes FROM va_page WHERE slug = ?", args: [String(r.slug)] });
      if (p.rows[0]) pages.set(String(r.slug), p.rows[0]);
    }
    for (const x of pages.values()) {
      let eps: Record<string, any[]> = {};
      try { eps = JSON.parse(String(x.episodes)); } catch { /* illisible */ }
      const lang = x.langue === "vf" ? "vf" : "vostfr";
      const r = pm.rows.find((y) => y.source === "voiranime" && y.lang === lang);
      const liste: Ep[] = Object.entries(eps).map(([n, e]) => ({ n: Number(n), etat: String(e?.[2] || "inconnu") })).sort((a, b) => a.n - b.n);
      lignes.push({
        source: "voir-anime", lecteur: "Vidmoly (myTV)", lang, page: String(x.slug),
        statut: r ? (String(r.slug) === String(x.slug) ? r.status : `${r.status} sur ${r.slug}`) : "ancree, sans ligne player_map",
        note: r?.note ?? null, nbEp: liste.length, vivants: liste.filter((e) => e.etat === "vivant").length, morts: liste.filter((e) => e.etat === "mort").length, eps: liste,
      });
    }

    // Les lignes player_map sans page (absent / broken) disent aussi quelque chose.
    for (const r of pm.rows) {
      if (r.status === "verified") continue;
      if (lignes.some((l) => l.source === (r.source === "animesama" ? "anime-sama" : "voir-anime") && l.lang === r.lang)) continue;
      lignes.push({ source: r.source === "animesama" ? "anime-sama" : "voir-anime", lecteur: "—", lang: r.lang, page: r.slug ? String(r.slug) : "—", statut: r.status, note: r.note, nbEp: 0, vivants: 0, morts: 0, eps: [] });
    }

    const f = fiche.rows[0];
    return res.status(200).json({
      anime: f ? { id, titre: f.titre, format: f.format, statut: f.status, annee: f.annee, episodes: f.episodes == null ? null : Number(f.episodes) } : { id },
      lignes: lignes.sort((a, b) => a.source.localeCompare(b.source) || a.lang.localeCompare(b.lang)),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
