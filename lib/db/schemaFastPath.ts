import type { Client } from "@libsql/client";

/**
 * UNE lecture au lieu d'une quinzaine (20/11/2026).
 *
 * ensureUsersSchema / ensureAdminSchema rejouaient tout leur DDL a chaque
 * demarrage a froid : ~17 allers-retours Turso SEQUENTIELS (CREATE IF NOT
 * EXISTS, ALTER attendus en echec…) sur le chemin de la premiere requete. Une
 * fois la base migree, tout cela est un no-op couteux.
 *
 * On lit donc sqlite_master une fois : si chaque table existe avec chaque
 * colonne attendue, et chaque index aussi, le schema est deja la et l'ensureur
 * s'arrete. Au moindre manque (ou en cas d'erreur) on rend `false` et l'ancien
 * chemin complet s'execute, inchange — c'est un raccourci, jamais une
 * condition.
 */
export async function schemaAlreadyThere(
  db: Client,
  want: { tables: Record<string, string[]>; indexes?: string[]; forbid?: Record<string, RegExp> },
): Promise<boolean> {
  try {
    const names = [...Object.keys(want.tables), ...(want.indexes ?? [])];
    const res = await db.execute({
      sql: `SELECT name, sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")})`,
      args: names,
    });
    const ddl = new Map(res.rows.map((r) => [String(r.name), String(r.sql ?? "")]));
    for (const idx of want.indexes ?? []) if (!ddl.has(idx)) return false;
    for (const [table, cols] of Object.entries(want.tables)) {
      const sql = ddl.get(table);
      if (sql == null) return false;
      for (const c of cols)
        if (!new RegExp("(^|[^a-z0-9_])" + c + "([^a-z0-9_]|$)", "i").test(sql)) return false;
      const bad = want.forbid?.[table];
      if (bad && bad.test(sql)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
