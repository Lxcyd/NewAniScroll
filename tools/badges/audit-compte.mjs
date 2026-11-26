/**
 * L'AUDIT DES BADGES SUR UN VRAI COMPTE, en lecture seule.
 *
 *   node tools/badges/check-catalog.mjs
 *   node tools/badges/audit-compte.mjs --user=<pseudo AniList> [--famille=episodes]
 *
 * check-catalog prouve les règles sur des cas fabriqués ; le 24/11/2026, elles
 * passaient toutes alors que plusieurs badges étaient faux sur le compte de Luc.
 * Ce script rejoue les VRAIES fonctions (`derive`, `measure`, `detailOf`, compilées
 * par check-catalog) sur les données du compte, et montre pour chaque badge sa
 * valeur et ce qui la prouve.
 *
 * Coût : 1 lecture de compte dans Turso (une dizaine de lignes), et ~1 point
 * AniList par tranche de 50 titres pour les champs que la copie du compte ne
 * garde pas (tags, popularité, relations). Aucun nom n'est envoyé à AniList.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
if (!args.user) {
  console.error("usage : node tools/badges/audit-compte.mjs --user=<pseudo AniList> [--famille=x]");
  process.exit(2);
}

const CACHE = join(ROOT, "node_modules", ".cache", "badges-check", "lib", "badges");
const imp = (f) => import(pathToFileURL(join(CACHE, f)).href);
const { derive, titleOf } = await imp("derive.mjs");
const { measure } = await imp("measure.mjs");
const { detailKind, detailOf } = await imp("detail.mjs");
const { BADGES } = await imp("catalog.mjs");
const { NO_DATE } = await imp("store.mjs");

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const { createClient } = createRequire(join(ROOT, "package.json"))("@libsql/client");
const db = createClient({ url: env.TURSO_USERS_URL, authToken: env.TURSO_USERS_TOKEN });

const user = (await db.execute({
  sql: "SELECT id FROM users WHERE lower(anilist_name) = ? LIMIT 1",
  args: [args.user.toLowerCase()],
})).rows[0];
if (!user) {
  console.error("compte introuvable");
  process.exit(2);
}
const rows = (await db.execute({
  sql: "SELECT kind, payload FROM user_data WHERE user_id = ? AND kind IN ('list','progress','badges','favourites','anilist_feed','anilist_snapshot')",
  args: [user.id],
})).rows;
const K = Object.fromEntries(rows.map((r) => [r.kind, JSON.parse(String(r.payload))]));
const pick = (kind, key) => {
  const v = K[kind]?.[key];
  return typeof v === "string" ? JSON.parse(v) : v;
};
const list = pick("list", "aniscroll:localList") ?? {};
const progress = pick("progress", "aniscroll:progress") ?? {};
const state = pick("badges", "aniscroll:badges") ?? { v: 1, got: {} };
const facts = {
  v: 1, flags: {}, counters: {}, hosts: [], noPause: [], opSkipped: [], bothLangs: [], seen: [],
  ...(pick("badges", "aniscroll:badgeFacts") ?? {}),
};
/* Ce que la synchro lit sur AniList : une liste personnalisée existante. */
if (K.anilist_snapshot?.z) {
  const copie = JSON.parse(gunzipSync(Buffer.from(K.anilist_snapshot.z, "base64")).toString());
  if (copie.lists?.some((l) => l.isCustomList && l.entries?.length)) facts.flags.customListAniList ??= Date.now();
}
const fr = JSON.parse(readFileSync(join(ROOT, "locales", "fr.json"), "utf8")).badges;

/* Les champs d'œuvre que la copie du compte ne garde pas. */
const gql = async (query, variables) => {
  for (let essai = 0; essai < 4; essai++) {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (r?.status === 429) {
      await new Promise((ok) => setTimeout(ok, ((Number(r.headers.get("retry-after")) || 60) + 1) * 1000));
      continue;
    }
    if (r?.ok) return (await r.json())?.data ?? null;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  return null;
};
const RELATIONS = new Set(["SEQUEL", "PREQUEL", "SIDE_STORY", "PARENT", "ALTERNATIVE", "SPIN_OFF"]);
const ids = Object.keys(list).map(Number);
let enrichis = 0;
for (let i = 0; i < ids.length; i += 50) {
  const d = await gql(
    `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id popularity tags{name isAdult}
      relations{edges{relationType node{id type}}}}}}`,
    { ids: ids.slice(i, i + 50) },
  );
  for (const m of d?.Page?.media ?? []) {
    Object.assign(list[m.id], {
      popularity: m.popularity ?? null,
      tags: (m.tags ?? []).filter((t) => !t.isAdult).map((t) => t.name),
      relIds: (m.relations?.edges ?? [])
        .filter((e) => e?.node?.type === "ANIME" && RELATIONS.has(e.relationType))
        .map((e) => e.node.id),
    });
    enrichis++;
  }
  if (i + 50 < ids.length) await new Promise((ok) => setTimeout(ok, 2200));
}
const voc = await gql("query{GenreCollection MediaTagCollection{name isAdult}}");
const vocab = voc
  ? {
      genres: voc.GenreCollection.filter((g) => g !== "Hentai"),
      tags: voc.MediaTagCollection.filter((t) => !t.isAdult).map((t) => t.name),
    }
  : null;

const lecteurs = JSON.parse(readFileSync(join(ROOT, "lib", "lecteurs.json"), "utf8"));
const parLecteur = lecteurs.lecteurs ?? lecteurs;
const displayedHosts = Object.entries(parLecteur).filter(([, v]) => v?.site === true).map(([k]) => k);
const favourites = Array.isArray(K.favourites) ? K.favourites : null;

/* Les dates de diffusion, comme les lit lib/badges/airingBackfill.ts. */
const airing = {};
let suite = [...new Set([...(K.anilist_feed?.e ?? []).map((e) => e[1]), ...Object.keys(K.anilist_feed?.c ?? {}).map(Number)])].filter((id) => {
  const first = new Date(Math.min(...K.anilist_feed.e.map((x) => x[0])) * 1000).getFullYear();
  const e = list[id];
  return !e || e.year == null || e.year >= first - 1 || e.mediaStatus === "RELEASING";
});
for (let p = 1; suite.length && p <= 60; p++) {
  const next = [];
  for (let i = 0; i < suite.length; i += 50) {
    const r = await gql(
      "query($ids:[Int],$p:Int){Page(perPage:50){media(id_in:$ids,type:ANIME){id episodes status airingSchedule(page:$p,perPage:25){pageInfo{hasNextPage} nodes{episode airingAt}}}}}",
      { ids: suite.slice(i, i + 50), p },
    );
    for (const x of r?.Page?.media ?? []) {
      const info = (airing[x.id] ??= { t: x.episodes ?? null, s: x.status, a: [] });
      for (const n of x.airingSchedule?.nodes ?? []) info.a.push([n.episode, n.airingAt]);
      if (x.airingSchedule?.pageInfo?.hasNextPage) next.push(x.id);
    }
    await new Promise((ok) => setTimeout(ok, 2200));
  }
  suite = next;
}

const d = derive({
  progress, list, facts, favourites, vocab, accountCreatedAt: null, displayedHosts,
  feedEvents: K.anilist_feed?.e ?? [], feedCompletions: K.anilist_feed?.c ?? {}, airing, airingComplete: true, now: Date.now(),
});

const date = (x) => (x == null ? "" : x === NO_DATE ? "sans date" : new Date(x).toLocaleDateString("fr-FR"));
const preuve = (b) => {
  try {
    if (!detailKind(b, d)) return "";
    const det = detailOf(b, d);
    if (det?.kind === "list") {
      return `${det.items.length} : ${det.items.slice(0, 3).map((e) => titleOf(e).slice(0, 26)).join(" · ")}`;
    }
    if (det?.kind === "grid") return `${det.cells.filter((c) => c.done).length}/${det.cells.length} cases`;
  } catch (e) {
    return `ERREUR ${e.message}`;
  }
  return "";
};

console.log(`Compte : ${ids.length} titres (${enrichis} enrichis), ${K.anilist_feed?.e?.length ?? 0} lignes de fil, ${Object.keys(progress).length} épisodes lus ici`);
console.log(`Lecteurs du site : ${displayedHosts.join(", ")} · utilisés : ${facts.hosts.join(", ") || "aucun"}\n`);

const ecarts = [];
let famille = "";
for (const b of BADGES) {
  const p = measure(b, d, state);
  const got = state.got[b.id];
  const atteint = !!p && p[1] > 0 && p[0] >= p[1];
  let etat = got != null ? "obtenu" : "—";
  if (got != null && p && !atteint) {
    etat = "FAUX";
    ecarts.push(`à retirer : ${b.id} (${p.join("/")})`);
  }
  if (got == null && atteint) {
    etat = "MANQUE";
    ecarts.push(`à accorder : ${b.id} (${p.join("/")})`);
  }
  if (!p && b.metric.k !== "granted") ecarts.push(`non mesurable : ${b.id}`);
  if (args.famille && b.family !== args.famille) continue;
  if (b.family !== famille) console.log(`\n── ${(famille = b.family)}`);
  console.log(
    `${etat.padEnd(7)}${b.id.padEnd(22)}${(p ? p.join("/") : "n/a").padEnd(15)}${date(got).padEnd(12)}${(fr[b.id]?.name ?? "").slice(0, 24).padEnd(25)}${preuve(b)}`,
  );
}
console.log(`\n${ecarts.length} écart(s)`);
for (const e of ecarts) console.log("  " + e);

/* ── --ecrire : ACCORDER LES « MANQUE » (26/11/2026) ─────────────────────────
   Les badges ne sont calculés que dans le navigateur du membre : un compte lié
   à AniList qui ne revient pas (Kuraryn : 1 050 animés, 16 283 épisodes) n'en
   a AUCUN aux yeux des visiteurs. Ceci écrit dans sa collection enregistrée
   les badges que les VRAIES règles lui accordent (même calcul que ci-dessus),
   et rien d'autre :
     - SANS DATE (NO_DATE) : la date d'obtention, le navigateur la pose sur
       preuve ; ici on n'en a pas de certaine, donc elle ne s'affiche pas ;
     - AJOUT SEULEMENT : aucun « FAUX » retiré, aucun drapeau touché — la
       fusion de ses appareils (union, date la plus ancienne) reste valable ;
     - un badge accordé sort de `revoked`, comme quand l'évaluateur l'accorde
       de nouveau preuve à l'appui. */
if ("ecrire" in args) {
  const ajout = BADGES.filter((b) => {
    const p = measure(b, d, state);
    return state.got[b.id] == null && !!p && p[1] > 0 && p[0] >= p[1];
  }).map((b) => b.id);
  if (!ajout.length) {
    console.log("\n--ecrire : rien à accorder.");
    process.exit(0);
  }
  const next = { ...state, got: { ...state.got } };
  for (const id of ajout) {
    next.got[id] = NO_DATE;
    if (next.revoked) delete next.revoked[id];
  }
  if (next.revoked && !Object.keys(next.revoked).length) delete next.revoked;
  const payload = { ...(K.badges ?? {}), "aniscroll:badges": JSON.stringify(next) };
  await db.execute({
    sql: `INSERT INTO user_data (user_id, kind, payload, rev, updated_at)
          VALUES (?, 'badges', ?, 1, ?)
          ON CONFLICT(user_id, kind) DO UPDATE
            SET payload = excluded.payload, rev = user_data.rev + 1, updated_at = excluded.updated_at`,
    args: [user.id, JSON.stringify(payload), Date.now()],
  });
  console.log(`\n--ecrire : ${ajout.length} badge(s) accordé(s) sans date : ${ajout.join(", ")}`);
}
process.exit(0);
