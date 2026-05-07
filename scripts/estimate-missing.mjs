#!/usr/bin/env node
/**
 * Estimate how many anime are NOT in our DB by sweeping random ID windows
 * on AniList and comparing.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchIdsInRange(low, high) {
  const ids = [];
  for (let i = low; i < high; i += 50) {
    const batch = Array.from({ length: 50 }, (_, k) => i + k).filter(x => x < high);
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($ids:[Int]){Page(page:1,perPage:50){media(id_in:$ids,type:ANIME){id}}}`,
        variables: { ids: batch },
      }),
    });
    const j = await res.json();
    for (const m of j.data?.Page?.media || []) ids.push(m.id);
    await sleep(2100);
  }
  return ids;
}

const samples = [
  [1, 100],
  [10000, 10100],
  [50000, 50100],
  [100000, 100100],
  [150000, 150100],
  [200000, 200100],
];

console.log("Sampling 100-id windows to estimate AniList coverage:\n");
let totalAniList = 0, totalDb = 0;
for (const [low, high] of samples) {
  const aniIds = await fetchIdsInRange(low, high);
  if (aniIds.length === 0) {
    console.log(`  [${low}–${high}]  ${aniIds.length} anime on AniList — empty range, skipping`);
    continue;
  }
  const r = await db.execute({
    sql: `SELECT id FROM anime WHERE id IN (${aniIds.map(() => "?").join(",")})`,
    args: aniIds,
  });
  const inDb = r.rows.length;
  const missing = aniIds.length - inDb;
  totalAniList += aniIds.length;
  totalDb += inDb;
  console.log(`  [${String(low).padStart(6)}–${String(high).padStart(6)}]  ${String(aniIds.length).padStart(3)} on AniList — ${inDb} in DB — ${missing} missing`);
}

console.log(`\nGlobal sample: ${totalDb}/${totalAniList} = ${((totalDb/totalAniList)*100).toFixed(1)}% coverage`);
const total = (await db.execute("SELECT COUNT(*) AS n FROM anime")).rows[0].n;
console.log(`DB total: ${total}`);
const projected = Math.round(Number(total) * totalAniList / Math.max(totalDb, 1));
console.log(`Projected total anime on AniList: ~${projected}`);
console.log(`Probably missing: ~${projected - Number(total)}`);
