/**
 * Le catalogue des cadres d'avatar, lu dans `avatar_frames` (Turso).
 *
 * La table est remplie chaque nuit par scripts/discord-frames/sync-frames.mjs
 * (source itemshop.gg/discord). Ici on ne fait que la lire, rangee par
 * collection, la plus recente en tete (`rank` = ordre de la boutique).
 *
 * Memo par lambda : quelques centaines de lignes qui ne bougent qu'une fois par
 * nuit, et l'API qui les sert est de toute facon cachee au bord.
 */

import { getTursoClient } from "./turso";
import type { FrameCollection } from "@/lib/profile/frames";

let memo: { at: number; data: FrameCollection[] } | null = null;
const MEMO_TTL_MS = 30 * 60 * 1000;

export async function getFrameCatalog(): Promise<FrameCollection[]> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.data;
  const db = getTursoClient();
  if (!db) return [];
  try {
    const r = await db.execute(
      "SELECT asset, name, collection, rank FROM avatar_frames ORDER BY rank ASC",
    );
    /* L'ordre de la boutique range deja les collections : la premiere carte vue
       d'une collection fixe sa place. Une collection retiree garde son dernier
       rang connu, donc tombe naturellement apres les nouvelles. */
    const byName = new Map<string, FrameCollection>();
    for (const row of r.rows as any[]) {
      const name = String(row.collection);
      let c = byName.get(name);
      if (!c) byName.set(name, (c = { name, frames: [] }));
      c.frames.push({ asset: String(row.asset), name: String(row.name) });
    }
    const data = [...byName.values()];
    memo = { at: Date.now(), data };
    return data;
  } catch (e: any) {
    console.warn("[avatar-frames] read failed:", e?.message);
    return [];
  }
}
