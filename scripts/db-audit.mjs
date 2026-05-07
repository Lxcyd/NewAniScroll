#!/usr/bin/env node
/**
 * Field-coverage audit. Single SQL aggregation so we don't pay for 30
 * round-trips to Turso (each ~80–200 ms over the WAN).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const SQL = `
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN json_extract(data,'$.title.romaji')        IS NOT NULL THEN 1 ELSE 0 END) AS title_romaji,
  SUM(CASE WHEN json_extract(data,'$.title.english')       IS NOT NULL THEN 1 ELSE 0 END) AS title_english,
  SUM(CASE WHEN json_extract(data,'$.title.userPreferred') IS NOT NULL THEN 1 ELSE 0 END) AS title_userPreferred,
  SUM(CASE WHEN id_mal              IS NOT NULL THEN 1 ELSE 0 END) AS idmal,
  SUM(CASE WHEN status              IS NOT NULL THEN 1 ELSE 0 END) AS status_,
  SUM(CASE WHEN format              IS NOT NULL THEN 1 ELSE 0 END) AS format_,
  SUM(CASE WHEN season_year         IS NOT NULL THEN 1 ELSE 0 END) AS season_year_,
  SUM(CASE WHEN average_score       IS NOT NULL THEN 1 ELSE 0 END) AS averageScore,
  SUM(CASE WHEN popularity          IS NOT NULL THEN 1 ELSE 0 END) AS popularity,
  SUM(CASE WHEN json_extract(data,'$.description')         IS NOT NULL AND json_extract(data,'$.description') != '' THEN 1 ELSE 0 END) AS description,
  SUM(CASE WHEN json_extract(data,'$.coverImage.extraLarge') IS NOT NULL THEN 1 ELSE 0 END) AS cover_extralarge,
  SUM(CASE WHEN json_extract(data,'$.coverImage.color')     IS NOT NULL THEN 1 ELSE 0 END) AS cover_color,
  SUM(CASE WHEN json_extract(data,'$.bannerImage')          IS NOT NULL THEN 1 ELSE 0 END) AS banner,
  SUM(CASE WHEN json_extract(data,'$.episodes')             IS NOT NULL THEN 1 ELSE 0 END) AS episodes,
  SUM(CASE WHEN json_extract(data,'$.duration')             IS NOT NULL THEN 1 ELSE 0 END) AS duration,
  SUM(CASE WHEN json_extract(data,'$.startDate.year')       IS NOT NULL THEN 1 ELSE 0 END) AS startdate,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.genres'))            > 0 THEN 1 ELSE 0 END) AS genres,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.synonyms'))          > 0 THEN 1 ELSE 0 END) AS synonyms,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.tags'))              > 0 THEN 1 ELSE 0 END) AS tags,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.studios.edges'))     > 0 THEN 1 ELSE 0 END) AS studios,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.externalLinks'))     > 0 THEN 1 ELSE 0 END) AS externallinks,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.streamingEpisodes')) > 0 THEN 1 ELSE 0 END) AS streamingep,
  SUM(CASE WHEN json_extract(data,'$.trailer.id')           IS NOT NULL THEN 1 ELSE 0 END) AS trailer,
  SUM(CASE WHEN json_extract(data,'$.nextAiringEpisode')    IS NOT NULL THEN 1 ELSE 0 END) AS nextairing,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.rankings'))          > 0 THEN 1 ELSE 0 END) AS rankings,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.relations.edges'))   > 0 THEN 1 ELSE 0 END) AS relations,
  SUM(CASE WHEN json_extract(data,'$.relations.edges[0].node.coverImage.extraLarge') IS NOT NULL THEN 1 ELSE 0 END) AS rel_extralarge,
  SUM(CASE WHEN json_extract(data,'$.relations.edges[0].node.bannerImage')  IS NOT NULL THEN 1 ELSE 0 END) AS rel_banner,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.characters.edges'))  > 0 THEN 1 ELSE 0 END) AS characters,
  SUM(CASE WHEN json_array_length(json_extract(data,'$.recommendations.nodes')) > 0 THEN 1 ELSE 0 END) AS recommendations
FROM anime
`;

console.log("Running aggregation…");
const t0 = Date.now();
const r = await db.execute(SQL);
console.log(`(query took ${Date.now() - t0}ms)\n`);

const row = r.rows[0];
const total = Number(row.total);

const labels = {
  title_romaji:        "title.romaji",
  title_english:       "title.english",
  title_userPreferred: "title.userPreferred",
  idmal:               "idMal",
  status_:             "status",
  format_:             "format",
  season_year_:        "seasonYear",
  averageScore:        "averageScore",
  popularity:          "popularity",
  description:         "description",
  cover_extralarge:    "coverImage.extraLarge",
  cover_color:         "coverImage.color",
  banner:              "bannerImage",
  episodes:            "episodes",
  duration:            "duration",
  startdate:           "startDate.year",
  genres:              "genres (≥1)",
  synonyms:            "synonyms (≥1)",
  tags:                "tags (≥1)",
  studios:             "studios.edges (≥1)",
  externallinks:       "externalLinks (≥1)",
  streamingep:         "streamingEpisodes (≥1)",
  trailer:             "trailer",
  nextairing:          "nextAiringEpisode",
  rankings:            "rankings (≥1)",
  relations:           "relations.edges (≥1)",
  rel_extralarge:      "  ↳ relations[0].coverImage.extraLarge",
  rel_banner:          "  ↳ relations[0].bannerImage",
  characters:          "characters.edges (≥1)",
  recommendations:     "recommendations.nodes (≥1)",
};

console.log(`Field coverage over ${total} anime:\n`);
console.log(`  ${"Field".padEnd(42)} ${"Filled".padStart(7)} ${"Missing".padStart(8)} ${"%".padStart(7)}`);
console.log(`  ${"─".repeat(42)} ${"─".repeat(7)} ${"─".repeat(8)} ${"─".repeat(7)}`);

for (const [key, label] of Object.entries(labels)) {
  const filled = Number(row[key]);
  const missing = total - filled;
  const pct = ((filled / total) * 100).toFixed(1);
  console.log(`  ${label.padEnd(42)} ${String(filled).padStart(7)} ${String(missing).padStart(8)} ${(pct + "%").padStart(7)}`);
}
