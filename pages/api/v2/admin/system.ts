import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { getAdminNames, isAdminSession } from "@/lib/auth/isAdmin";
import { getTursoClient } from "@/lib/db/turso";
import { getFanartsClient } from "@/lib/db/turso-fanarts";
import { getUsersClient } from "@/lib/db/turso-users";
import { getAdminTursoClient } from "@/lib/db/turso-admin";
import { redis } from "@/lib/redis";

/**
 * GET /api/v2/admin/system — what this deployment is and what it can reach.
 *
 * Built for the question that cost an evening on 13/09/2026: « why can't I get
 * into the admin panel on dev? ». The answer was two facts nobody could see
 * from the UI — the admin list named `Lxcyd` while the account is `Lucyd`, and
 * which variables the dev project actually carries.
 *
 * ⛔ VARIABLES ARE REPORTED AS PRESENT OR ABSENT, NEVER BY VALUE. Not even a
 * prefix: a page listing secrets is one screenshot away from leaking them.
 *
 * On demand only, never polled: each database probe is a real query and the
 * Redis probe is one Upstash command.
 */

/** Grouped the way they are debugged. Names only. */
const ENV_GROUPS: Record<string, string[]> = {
  Auth: ["NEXTAUTH_URL", "NEXTAUTH_SECRET", "CLIENT_ID", "CLIENT_SECRET", "NEXT_PUBLIC_ADMIN_USERNAMES", "ADMIN_USERNAMES"],
  Bases: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "TURSO_FANARTS_DATABASE_URL", "TURSO_FANARTS_AUTH_TOKEN",
    "TURSO_USERS_URL", "TURSO_USERS_TOKEN", "DATABASE_URL", "DIRECT_URL"],
  Cache: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CF_KV_NAMESPACE_ID", "CF_KV_API_TOKEN"],
  "Services tiers": ["FANART_API_KEY", "TMDB_API_KEY", "RESEND_API_KEY", "ABLY_API_KEY",
    "ANIME_SKIP_CLIENT_ID", "NEXT_PUBLIC_PROXY_BASE"],
};

async function probe(name: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 5s")), 5000)),
    ]);
    return { name, ok: true, ms: Date.now() - t0, detail: detail == null ? null : String(detail) };
  } catch (e: any) {
    return { name, ok: false, ms: Date.now() - t0, detail: String(e?.message || e).slice(0, 160) };
  }
}

const count = (db: any, table: string) => async () => {
  if (!db) throw new Error("non configurée");
  const r = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return `${Number(r.rows[0]?.n ?? 0).toLocaleString("fr-FR")} lignes (${table})`;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) return res.status(403).json({ error: "Forbidden" });
  res.setHeader("Cache-Control", "private, no-store");

  const users = getUsersClient();

  const [services, admins, wallhaven] = await Promise.all([
    Promise.all([
      probe("Turso · anime", count(getTursoClient(), "anime")),
      probe("Turso · fanarts", count(getFanartsClient(), "anime_fanarts")),
      probe("Turso · users", count(users, "users")),
      probe("Turso · admin", count(getAdminTursoClient(), "audit_log")),
      probe("Upstash Redis", async () => {
        if (!redis) throw new Error("non configuré");
        await redis.get("admin:system:probe");
        return "joignable";
      }),
    ]),
    users
      ? users
          .execute(`SELECT username, tag, email FROM users WHERE role = 'admin' ORDER BY created_at`)
          .then((r) => r.rows.map((x: any) => ({ username: x.username, tag: x.tag, email: x.email })))
          .catch(() => [])
      : Promise.resolve([]),
    (async () => {
      const db = getFanartsClient();
      if (!db) return null;
      try {
        const r = await db.execute(`SELECT
            (SELECT COUNT(*) FROM wallhaven_image)                          AS images,
            (SELECT COUNT(DISTINCT anime_id) FROM wallhaven_image)          AS animes,
            (SELECT COUNT(*) FROM wallhaven_image WHERE tagged_at IS NOT NULL) AS taguees,
            (SELECT COUNT(*) FROM wallhaven_image WHERE serie_ok = 0)       AS horsSujet`);
        const row = r.rows[0] as any;
        return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
      } catch {
        return null;
      }
    })(),
  ]);

  const env = Object.entries(ENV_GROUPS).map(([group, keys]) => ({
    group,
    vars: keys.map((key) => ({ key, set: Boolean(process.env[key]?.trim()) })),
  }));

  return res.status(200).json({
    deployment: {
      env: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
      commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0] || null,
      url: process.env.VERCEL_URL || null,
      region: process.env.VERCEL_REGION || null,
      node: process.version,
    },
    services,
    admins: {
      byRole: admins,
      byNameList: getAdminNames(),
      you: {
        name: (session as any)?.user?.name ?? null,
        role: (session as any)?.user?.role ?? null,
      },
    },
    env,
    wallhaven,
  });
}
