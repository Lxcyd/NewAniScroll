#!/usr/bin/env node
/**
 * L'INSTANTANE des statistiques du site, lu par la page admin « Statistiques »
 * (components/admin/stats, /api/v2/admin/site-stats).
 *
 * Pourquoi un instantane et pas des requetes a l'ouverture de la page : des
 * statistiques « sur tout » touchent des tables de 100 000 a 220 000 lignes, et
 * Turso facture chaque ligne lue (500 M par mois pour TOUTES les bases). Ici
 * chaque section est calculee une fois, son cout exact (`rows_read`) est
 * mesure et affiche ; la page ne lit ensuite qu'une quinzaine de lignes.
 *
 *   node tools/stats/instantane.mjs                sections dues (quotidiennes ; hebdo si > 6 j)
 *   node tools/stats/instantane.mjs --tout         toutes, maintenant
 *   node tools/stats/instantane.mjs --sections=a,b --sec   (--sec : n'ecrit rien, affiche)
 *
 * Ecrit dans la base ADMIN : `site_stats` (derniere valeur de chaque section)
 * et `site_stats_jour` (un resume chiffre par jour, pour les courbes).
 * Lit : Turso (4 bases), Cloudflare (GraphQL analytics), Upstash, Turso API,
 * GitHub (executions des automatisations). Jamais aniscroll.com.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of [".env", ".env.local"]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
}
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "1"];
}));

/* ── Turso par HTTP : les lignes ET le cout exact de chaque requete ───────── */
const BASES = {
  cache: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
  fanarts: ["TURSO_FANARTS_DATABASE_URL", "TURSO_FANARTS_AUTH_TOKEN"],
  admin: ["TURSO_ADMIN_URL", "TURSO_ADMIN_TOKEN"],
  users: ["TURSO_USERS_URL", "TURSO_USERS_TOKEN"],
};
let coutSection = 0;
const valeur = (c) => (c.type === "null" ? null : c.type === "integer" || c.type === "float" ? Number(c.value) : c.value);
async function sql(base, requete, params = []) {
  const [u, t] = BASES[base];
  if (!process.env[u] || !process.env[t]) throw new Error(`${u} absent`);
  const url = process.env[u].replace(/^libsql:/, "https:").replace(/\/$/, "");
  const arg = (v) => (v === null ? { type: "null" } : Number.isInteger(v) ? { type: "integer", value: String(v) } : typeof v === "number" ? { type: "float", value: v } : { type: "text", value: String(v) });
  const r = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env[t]}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: requete, args: params.map(arg) } }, { type: "close" }] }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => null);
  const res = j?.results?.[0];
  if (res?.type !== "ok") throw new Error(res?.error?.message ?? `HTTP ${r.status}`);
  const { cols, rows, rows_read } = res.response.result;
  coutSection += rows_read || 0;
  return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, valeur(row[i])])));
}
const un = async (base, requete, params) => (await sql(base, requete, params))[0] || {};
/** Une table qui peut manquer (base fraiche, fonction pas encore deployee). */
const peutManquer = async (p, defaut) => { try { return await p; } catch { return defaut; } };

const maintenant = Date.now();
const S = Math.floor(maintenant / 1000);
const J = 86400;

/* ── Les sections, DANS L'ORDRE de la page ────────────────────────────────── */
const SECTIONS = [];
const section = (id, cadence, fn) => SECTIONS.push({ id, cadence, fn });

/* Audience : Cloudflare voit toutes les requetes (le site est derriere lui
   depuis le 30/10/2026). `user_analytics` n'est plus alimentee depuis juillet. */
section("audience", "jour", async () => {
  /* CF_STATS_TOKEN : jeton en LECTURE seule (Analytics Read + Zone Read sur
     aniscroll.com), cree le 31/10/2026. CF_ZONE_API_TOKEN, le jeton
     d'administration, est verrouille sur l'IP du PC : depuis GitHub, Cloudflare
     le refusait et l'audience restait vide (« zone introuvable »). */
  const tok = process.env.CF_STATS_TOKEN || process.env.CF_ZONE_API_TOKEN;
  if (!tok) return { indisponible: "CF_STATS_TOKEN absent" };
  const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const zone = process.env.CF_ZONE_ID
    || (await (await fetch("https://api.cloudflare.com/client/v4/zones?name=aniscroll.com", { headers: H })).json()).result?.[0]?.id;
  if (!zone) return { indisponible: "zone Cloudflare introuvable" };
  const gql = async (query) => {
    const r = await (await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: H, body: JSON.stringify({ query }) })).json();
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return r.data.viewer.zones[0];
  };
  const d30 = new Date(maintenant - 30 * J * 1000).toISOString().slice(0, 10);
  const jours = (await gql(`{viewer{zones(filter:{zoneTag:"${zone}"}){ httpRequests1dGroups(limit:40, filter:{date_geq:"${d30}"}, orderBy:[date_ASC]){
    dimensions{date} uniq{uniques}
    sum{requests pageViews cachedRequests threats bytes cachedBytes
      countryMap{clientCountryName requests} browserMap{uaBrowserFamily pageViews}
      responseStatusMap{edgeResponseStatus requests} clientHTTPVersionMap{clientHTTPProtocol requests} } } }}}`)).httpRequests1dGroups;
  const cumul = (champ, cle, val) => {
    const m = {};
    for (const d of jours) for (const x of d.sum[champ] || []) m[x[cle]] = (m[x[cle]] || 0) + x[val];
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([nom, n]) => ({ nom, n }));
  };
  const parJour = jours.map((d) => ({
    jour: d.dimensions.date, visiteurs: d.uniq.uniques, requetes: d.sum.requests, pages: d.sum.pageViews,
    enCache: d.sum.cachedRequests, menaces: d.sum.threats, octets: d.sum.bytes,
    // Les reponses 5xx du jour : le premier signe qu'une page ou une API casse.
    erreurs5xx: (d.sum.responseStatusMap || []).filter((x) => x.edgeResponseStatus >= 500).reduce((s, x) => s + x.requests, 0),
  }));
  const depuis = new Date(maintenant - J * 1000).toISOString();
  const z24 = await gql(`{viewer{zones(filter:{zoneTag:"${zone}"}){
    chemins: httpRequestsAdaptiveGroups(limit:200, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}", clientRequestHTTPHost:"aniscroll.com", requestSource:"eyeball", clientRequestPath_notlike:"/_next/%"}){ count dimensions{clientRequestPath} }
    appareils: httpRequestsAdaptiveGroups(limit:10, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}", clientRequestHTTPHost:"aniscroll.com", requestSource:"eyeball"}){ count dimensions{clientDeviceType} }
    os: httpRequestsAdaptiveGroups(limit:12, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}", clientRequestHTTPHost:"aniscroll.com", requestSource:"eyeball"}){ count dimensions{userAgentOS} }
    hotes: httpRequestsAdaptiveGroups(limit:20, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}"}){ count dimensions{clientRequestHTTPHost cacheStatus} }
    erreurs: httpRequestsAdaptiveGroups(limit:25, orderBy:[count_DESC], filter:{datetime_geq:"${depuis}", edgeResponseStatus_geq:500}){ count dimensions{clientRequestHTTPHost clientRequestPath edgeResponseStatus} }
  }}}`);
  /* « Animes les plus regardes » : PAS mesurable ici (essaye le 01/11/2026).
     Les groupes adaptatifs de Cloudflare sont ECHANTILLONNES (7 a 34 pages de
     lecture vues sur 24 h, pour ~1 200 visiteurs), le plan gratuit refuse la
     dimension clientRequestQuery (aniId est dans la requete), et la page de
     lecture se charge par navigation interne. L'historique des comptes
     (user_data « progress ») ne couvre que 4 comptes. Il faudrait un compteur. */
  // Les pages par FAMILLE : /en/anime/watch/…, /en/anime/123, /api/v2/source…
  const famille = (p) => {
    const s = p.split("?")[0].split("/").filter(Boolean);
    if (!s.length) return "/";
    if (s[0] === "api") return `/${s.slice(0, 3).join("/")}`;
    if (s[0] === "en" && s[1] === "anime" && s[2] === "watch") return "/en/anime/watch/…";
    if (s[0] === "en" && s[1] === "anime" && /^\d/.test(s[2] || "")) return "/en/anime/[id]";
    if (s[0] === "en" && s[1] === "manga") return "/en/manga/[id]";
    if (s[0] === "en" && s[1] === "profile") return "/en/profile/…";
    return `/${s.slice(0, 2).join("/")}`;
  };
  const fam = {};
  for (const c of z24.chemins) fam[famille(c.dimensions.clientRequestPath)] = (fam[famille(c.dimensions.clientRequestPath)] || 0) + c.count;
  const hotes = {};
  for (const h of z24.hotes) {
    const x = (hotes[h.dimensions.clientRequestHTTPHost] ||= { nom: h.dimensions.clientRequestHTTPHost, n: 0, cache: 0 });
    x.n += h.count;
    if (["hit", "stale", "revalidated", "updating"].includes(h.dimensions.cacheStatus)) x.cache += h.count;
  }
  const tot = (k) => parJour.reduce((s, d) => s + (d[k] || 0), 0);
  const der = parJour.at(-1) || {};
  const sept = parJour.slice(-7);
  return {
    resume: {
      visiteursHier: parJour.at(-2)?.visiteurs ?? null, visiteursAujourdhui: der.visiteurs ?? null,
      visiteurs7j: sept.reduce((s, d) => s + d.visiteurs, 0), pages30j: tot("pages"), requetes30j: tot("requetes"),
      cache30j: tot("requetes") ? Math.round((tot("enCache") / tot("requetes")) * 100) : null,
      menaces30j: tot("menaces"), octets30j: tot("octets"),
      // Hier (jour complet) : la part de 5xx parmi les requetes.
      erreurs5xxHier: parJour.at(-2)?.erreurs5xx ?? null, requetesHier: parJour.at(-2)?.requetes ?? null,
    },
    parJour,
    pays: cumul("countryMap", "clientCountryName", "requests").slice(0, 20),
    navigateurs: cumul("browserMap", "uaBrowserFamily", "pageViews").slice(0, 12),
    statuts: cumul("responseStatusMap", "edgeResponseStatus", "requests"),
    http: cumul("clientHTTPVersionMap", "clientHTTPProtocol", "requests"),
    chemins24h: z24.chemins.slice(0, 25).map((c) => ({ nom: c.dimensions.clientRequestPath, n: c.count })),
    familles24h: Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([nom, n]) => ({ nom, n })),
    appareils24h: z24.appareils.map((x) => ({ nom: x.dimensions.clientDeviceType, n: x.count })),
    os24h: z24.os.map((x) => ({ nom: x.dimensions.userAgentOS || "inconnu", n: x.count })),
    hotes24h: Object.values(hotes).sort((a, b) => b.n - a.n),

    // Les 5xx des dernieres 24 h : adresse, chemin (sans la requete), code.
    erreurs24h: z24.erreurs.map((x) => ({
      hote: x.dimensions.clientRequestHTTPHost, chemin: x.dimensions.clientRequestPath.split("?")[0].slice(0, 120),
      code: x.dimensions.edgeResponseStatus, n: x.count,
    })),
  };
});

section("comptes", "jour", async () => {
  const ms = Date.now();
  const u = await un("users", `SELECT count(*) total,
      sum(email_verified_at IS NOT NULL) verifies, sum(anilist_id IS NOT NULL) anilist,
      sum(created_at >= ?) nouveaux7j, sum(created_at >= ?) nouveaux30j,
      sum(last_seen_at >= ?) actifs24h, sum(last_seen_at >= ?) actifs7j, sum(last_seen_at >= ?) actifs30j,
      sum(avatar_url IS NOT NULL OR anilist_avatar_url IS NOT NULL) avecAvatar, sum(profile_banner IS NOT NULL) avecBanniere
    FROM users`, [ms - 7 * J * 1000, ms - 30 * J * 1000, ms - J * 1000, ms - 7 * J * 1000, ms - 30 * J * 1000]);
  const roles = await sql("users", "SELECT role || ' / ' || status nom, count(*) n FROM users GROUP BY role, status ORDER BY n DESC");
  const inscriptions = await sql("users", "SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') mois, count(*) n FROM users GROUP BY mois ORDER BY mois");
  const donnees = await sql("users", "SELECT kind nom, count(*) n, sum(length(payload)) octets, max(updated_at) dernier FROM user_data GROUP BY kind ORDER BY n DESC");
  const jetons = await peutManquer(sql("users", "SELECT kind nom, count(*) n, sum(used_at IS NOT NULL) utilises, sum(expires_at > ?) valides FROM auth_tokens GROUP BY kind", [ms]), []);
  const throttle = await peutManquer(un("users", "SELECT count(*) n, sum(reset_at > ?) actifs FROM auth_throttle", [ms]), {});
  return { resume: { comptes: u.total, actifs7j: u.actifs7j, nouveaux30j: u.nouveaux30j }, comptes: u, roles, inscriptions, donnees, jetons, throttle };
});

section("lecteurs", "jour", async () => {
  const carte = await sql("cache", "SELECT source, lang, status, count(*) n FROM player_map GROUP BY source, lang, status");
  // Les raisons, regroupees : « verify:count 12/13 » -> « verify:count ».
  const notesBrutes = await sql("cache", "SELECT source, status, note, count(*) n FROM player_map WHERE status IN ('broken','absent') GROUP BY source, status, note");
  const notes = {};
  for (const r of notesBrutes) {
    const k = `${r.source} · ${r.status} · ${String(r.note || "(sans note)").replace(/ .*$/, "").replace(/: .*$/, "")}`;
    notes[k] = (notes[k] || 0) + r.n;
  }
  const origines = await sql("cache", `SELECT source, CASE WHEN note LIKE 'verify:alignement%' THEN 'alignement' WHEN note LIKE 'verify:ok%' THEN 'verificateur'
      WHEN note LIKE 'runtime%' THEN 'execution' WHEN note LIKE 'manuel%' THEN 'manuel' ELSE 'autre' END origine, count(*) n
    FROM player_map WHERE status = 'verified' GROUP BY 1, 2`);
  const as = await peutManquer(un("cache", `SELECT count(DISTINCT slug) fiches, count(*) panneaux, sum(nb_ep) episodes,
      sum(nb_vivants) vivants, sum(nb_morts) morts, sum(anilist_fiche IS NOT NULL) avecId, sum(nb_vivants > 0) jouables, max(maj_le) maj
    FROM as_panneau`), {});
  const asLangues = await peutManquer(sql("cache", "SELECT langue nom, count(*) panneaux, sum(nb_vivants) vivants FROM as_panneau GROUP BY langue ORDER BY vivants DESC"), []);
  const asGenres = await peutManquer(sql("cache", `SELECT CASE WHEN dossier LIKE 'saison%' THEN 'saisons' WHEN dossier LIKE 'film%' THEN 'films'
      WHEN dossier LIKE 'oav%' THEN 'OAV' WHEN dossier LIKE 'kai%' THEN 'kai' ELSE 'autres' END nom, count(*) panneaux, sum(nb_vivants) vivants
    FROM as_panneau GROUP BY 1 ORDER BY vivants DESC`), []);
  const va = await peutManquer(un("cache", `SELECT count(*) pages, sum(anilist IS NOT NULL) ancrees, sum(nb_ep) episodes,
      sum(nb_vivants) vivants, sum(nb_morts) morts, sum(nb_vivants > 0) jouables, max(maj_le) maj FROM va_page`), {});
  const vaLangues = await peutManquer(sql("cache", "SELECT langue nom, count(*) pages, sum(nb_vivants) vivants FROM va_page GROUP BY langue"), []);
  const vaTypes = await peutManquer(sql("cache", "SELECT coalesce(type, '?') nom, count(*) n FROM va_page GROUP BY type ORDER BY n DESC"), []);
  const vaAncres = await peutManquer(sql("cache", "SELECT coalesce(ancre, 'pas encore cherchee') nom, count(*) n FROM va_page GROUP BY ancre ORDER BY n DESC"), []);
  const frembed = await peutManquer(un("cache", "SELECT count(*) sondes, sum(hosted) heberges, max(checked_at) dernier FROM frembed_probe"), {});
  const perf = await peutManquer(sql("cache", "SELECT server_id nom, crit, ewma, n, updated_at FROM server_perf ORDER BY n DESC"), []);
  const runtimes = await peutManquer(sql("cache", "SELECT host || ' · ' || lang nom, count(*) n FROM episode_runtimes GROUP BY host, lang ORDER BY n DESC"), []);
  const doublages = await peutManquer(sql("cache", "SELECT lang nom, count(*) n FROM dub_catalog GROUP BY lang ORDER BY n DESC"), []);
  const verifies = carte.filter((r) => r.status === "verified").reduce((s, r) => s + r.n, 0);
  return {
    resume: { lignesVerifiees: verifies, asVivants: as.vivants ?? null, vaVivants: va.vivants ?? null },
    carte, notes: Object.entries(notes).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([nom, n]) => ({ nom, n })),
    origines, animeSama: { ...as, langues: asLangues, genres: asGenres },
    voirAnime: { ...va, langues: vaLangues, types: vaTypes, ancres: vaAncres },
    frembed, perf, runtimes, doublages,
    lecteurs: JSON.parse(fs.readFileSync(path.join(ROOT, "lib/lecteurs.json"), "utf8")).lecteurs,
  };
});

/* Le catalogue VIDEO vu par anime AniList (01/11/2026) : qui sert quoi, et les
   trous. Une source « a » un anime dans une langue si player_map a une ligne
   verified pour lui (le site la sert telle quelle) ; le nombre d'episodes
   jouables vient de la copie de la page servie (as_panneau / va_page).
   as_panneau.anilist_fiche ne vaut pas pour la saison : c'est l'id de la FICHE
   (Baki 2018 sur le film et l'OAV de « baki »), d'ou le detour par player_map.
   Cout mesure : ~15 000 lignes (player_map + les deux copies + ~900 fiches). */
section("video", "jour", async () => {
  const pm = await sql("cache", "SELECT ani_id, source, lang, status, slug, season_dir, ep_offset, note, checked_at FROM player_map");
  const somme0 = (l, k) => l.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const asP = await sql("cache", "SELECT slug, dossier, langue, libelle, anilist_fiche, nb_ep, nb_vivants, nb_morts FROM as_panneau");
  const va = await sql("cache", "SELECT slug, langue, anilist, romaji, anglais, num_max, nb_ep, nb_vivants, nb_morts FROM va_page");
  const fr = await peutManquer(sql("cache", "SELECT anilist_id FROM frembed_catalog"), []);
  const asPan = new Map();
  for (const p of asP) {
    const k = `${p.slug}|${p.dossier}|${p.langue.startsWith("vf") ? "vf" : "vostfr"}`;
    asPan.set(k, Math.max(asPan.get(k) || 0, p.nb_vivants));
  }
  const vaPage = new Map(va.map((p) => [p.slug, p]));
  // dispo[id][lang] = { as, va } : episodes jouables par source.
  const dispo = new Map();
  const poser = (id, lang, src, n) => {
    const d = (dispo.get(id) || dispo.set(id, { vf: {}, vostfr: {} }).get(id))[lang];
    d[src] = Math.max(d[src] || 0, n);
  };
  for (const r of pm) {
    if (r.status !== "verified") continue;
    const lang = r.lang === "vf" ? "vf" : "vostfr";
    if (r.source === "animesama") poser(r.ani_id, lang, "as", asPan.get(`${r.slug}|${r.season_dir}|${lang}`) ?? 0);
    else if (r.source === "voiranime") poser(r.ani_id, lang, "va", vaPage.get(r.slug)?.nb_vivants ?? 0);
  }
  // Une page voir-anime ancree sans ligne player_map reste servie (lib/db/vaPage.ts).
  for (const p of va) if (p.anilist && p.nb_vivants > 0) poser(p.anilist, p.langue === "vf" ? "vf" : "vostfr", "va", p.nb_vivants);
  const frembed = new Set(fr.map((x) => x.anilist_id));
  for (const id of frembed) { poser(id, "vf", "fr", 1); poser(id, "vostfr", "fr", 1); }
  const max = (id, lang) => { const d = dispo.get(id)?.[lang] || {}; return Math.max(d.as || 0, d.va || 0); };
  const a = (id, src) => { const d = dispo.get(id); return !!d && ((d.vf[src] || 0) > 0 || (d.vostfr[src] || 0) > 0); };
  const ids = [...dispo.keys()].filter((id) => a(id, "as") || a(id, "va") || a(id, "fr"));
  const recouvrement = {
    total: ids.length,
    deux: ids.filter((id) => a(id, "as") && a(id, "va")).length,
    asSeul: ids.filter((id) => a(id, "as") && !a(id, "va")).length,
    vaSeul: ids.filter((id) => a(id, "va") && !a(id, "as")).length,
    frembedSeul: ids.filter((id) => a(id, "fr") && !a(id, "as") && !a(id, "va")).length,
    avecVf: ids.filter((id) => max(id, "vf") > 0 || (dispo.get(id).vf.fr || 0) > 0).length,
  };

  /* Les fiches AniList : les plus populaires, et la saison en cours. Lus par
     l'index de popularite / de statut, quelques centaines de lignes. */
  const fiche = `SELECT id, popularity, format, status, season_year annee, json_extract(data, '$.episodes') episodes,
      json_extract(data, '$.nextAiringEpisode.episode') prochain, json_extract(data, '$.nextAiringEpisode.airingAt') prochainLe,
      coalesce(json_extract(data, '$.title.userPreferred'), json_extract(data, '$.title.romaji')) titre FROM anime`;
  const FORMATS = new Set(["TV", "TV_SHORT", "MOVIE", "ONA", "OVA", "SPECIAL"]);
  const populaires = (await sql("cache", `${fiche} WHERE is_adult = 0 ORDER BY popularity DESC LIMIT 700`))
    .filter((x) => FORMATS.has(x.format) && x.status !== "NOT_YET_RELEASED" && x.status !== "CANCELLED").slice(0, 500);
  const etat = (x, rang) => ({
    id: x.id, rang, titre: x.titre, format: x.format, annee: x.annee, episodes: x.episodes,
    vostfr: max(x.id, "vostfr"), vf: max(x.id, "vf"), frembed: frembed.has(x.id),
  });
  const top = populaires.map((x, i) => etat(x, i + 1));
  const sansVideo = top.filter((x) => !x.vostfr && !x.vf && !x.frembed);
  const sansVf = top.filter((x) => x.vostfr && !x.vf && !x.frembed);
  let incomplets = top.filter((x) => x.episodes > 1 && !x.frembed && populaires[x.rang - 1].status === "FINISHED"
    && ((x.vostfr > 0 && x.vostfr < x.episodes) || (x.vf > 0 && x.vf < x.episodes)));
  /* Les episodes qui MANQUENT, numero par numero, pour les incomplets : l'union
     des episodes vivants de toutes les pages qui servent l'anime dans la
     langue. Lu par cle (as_panneau, va_page) : quelques lignes par anime. */
  const pagesDe = (id, lang) => pm.filter((r) => r.ani_id === id && r.status === "verified" && (r.lang === "vf") === (lang === "vf"));
  const vivantsDe = async (id, lang) => {
    const eps = new Set();
    for (const r of pagesDe(id, lang)) {
      if (r.source === "animesama") {
        const l = lang === "vf" ? ["vf", "vf1", "vf2"] : ["vostfr"];
        for (const p of await sql("cache", `SELECT liens FROM as_panneau WHERE slug = ? AND dossier = ? AND langue IN (${l.map(() => "?").join(",")})`, [r.slug, r.season_dir, ...l])) {
          let j = {};
          try { j = JSON.parse(p.liens); } catch {}
          for (const [n, liens] of Object.entries(j)) if (liens.some((y) => y[1] === "vivant")) eps.add(Number(n) - (r.ep_offset || 0));
        }
      } else if (r.source === "voiranime") {
        for (const p of await sql("cache", "SELECT episodes FROM va_page WHERE slug = ?", [r.slug])) {
          let j = {};
          try { j = JSON.parse(p.episodes); } catch {}
          for (const [n, e] of Object.entries(j)) if (e?.[2] === "vivant") eps.add(Number(n) - (r.ep_offset || 0));
        }
      }
    }
    for (const p of va) if (p.anilist === id && (p.langue === "vf") === (lang === "vf") && !pagesDe(id, lang).some((r) => r.slug === p.slug)) {
      for (const q of await sql("cache", "SELECT episodes FROM va_page WHERE slug = ?", [p.slug])) {
        let j = {};
        try { j = JSON.parse(q.episodes); } catch {}
        for (const [n, e] of Object.entries(j)) if (e?.[2] === "vivant") eps.add(Number(n));
      }
    }
    return eps;
  };
  for (const x of incomplets.slice(0, 120)) {
    for (const lang of ["vostfr", "vf"]) {
      if (!x[lang]) { x[`${lang}Manque`] = "absente"; continue; }
      const eps = await vivantsDe(x.id, lang);
      const manque = [];
      for (let n = 1; n <= x.episodes; n++) if (!eps.has(n)) manque.push(n);
      x[`${lang}Manque`] = manque;
    }
  }
  /* Le compte « max d'une source » sous-estime : un lien mort sur une page
     est souvent vivant sur l'autre (Death Parade : 11/12 ici, 12/12 la-bas).
     Seuls restent les animes ou l'UNION des sources a un trou. */
  incomplets = incomplets.slice(0, 120).filter((x) => [x.vostfrManque, x.vfManque].some((m) => Array.isArray(m) && m.length));

  /* La part de chaque catalogue qu'on SERT, hors ce qu'on ne prend pas : un
     panneau sans aucun lien vivant d'un lecteur valide, ou une version « sans
     fillers » (dossier `…hs`, doublon monte d'une serie qu'on sert deja). */
  const servisAs = new Set(pm.filter((r) => r.source === "animesama" && r.status === "verified").map((r) => `${r.slug}|${r.season_dir}|${r.lang === "vf" ? "vf" : "vostfr"}`));
  const servisVa = new Set(pm.filter((r) => r.source === "voiranime" && r.status === "verified").map((r) => r.slug));
  const asSansFillers = asP.filter((p) => /hs$/.test(p.dossier) && p.nb_vivants > 0).length;
  const asElig = asP.filter((p) => p.nb_vivants > 0 && !/hs$/.test(p.dossier));
  const asNonServis = asElig.filter((p) => !servisAs.has(`${p.slug}|${p.dossier}|${p.langue.startsWith("vf") ? "vf" : "vostfr"}`));
  const vaElig = va.filter((p) => p.nb_vivants > 0);
  const vaNonServis = vaElig.filter((p) => !servisVa.has(p.slug) && !p.anilist);
  const fp = await peutManquer(un("cache", "SELECT count(*) sondes, sum(hosted) heberges FROM frembed_probe"), {});
  const part = {
    animeSama: {
      panneaux: asP.length, nonPris: asP.length - asElig.length, sansFillers: asSansFillers, sansLecteur: asP.length - asElig.length - asSansFillers, eligibles: asElig.length, servis: asElig.length - asNonServis.length,
      episodesEligibles: somme0(asElig, "nb_vivants"), episodesServis: somme0(asElig, "nb_vivants") - somme0(asNonServis, "nb_vivants"),
      nonServis: asNonServis.sort((p, q) => q.nb_vivants - p.nb_vivants).slice(0, 30).map((p) => ({ page: `${p.slug}/${p.dossier}/${p.langue}`, titre: p.libelle, ep: p.nb_vivants })),
    },
    voirAnime: {
      panneaux: va.length, nonPris: va.length - vaElig.length, eligibles: vaElig.length, servis: vaElig.length - vaNonServis.length,
      episodesEligibles: somme0(vaElig, "nb_vivants"), episodesServis: somme0(vaElig, "nb_vivants") - somme0(vaNonServis, "nb_vivants"),
      nonServis: vaNonServis.sort((p, q) => q.nb_vivants - p.nb_vivants).slice(0, 30).map((p) => ({ page: p.slug, titre: p.romaji || p.anglais, ep: p.nb_vivants })),
    },
    frembed: { sondes: fp.sondes ?? null, heberges: fp.heberges ?? null, mappes: frembed.size },
  };

  const enCoursBrut = (await sql("cache", `${fiche} WHERE status = 'RELEASING' AND is_adult = 0 ORDER BY popularity DESC LIMIT 120`))
    .filter((x) => FORMATS.has(x.format) && x.prochain > 1);
  const enCours = enCoursBrut.map((x, i) => ({ ...etat(x, i + 1), sortis: x.prochain - 1, prochainLe: x.prochainLe }))
    .map((x) => ({ ...x, retard: Math.max(0, x.sortis - x.vostfr) }));

  // Rattachement : pages et fiches sans AniList, lignes retirees par la parite.
  const vaSansId = va.filter((p) => !p.anilist);
  const asSansId = [...new Map(asP.filter((p) => !p.anilist_fiche).map((p) => [p.slug, p])).values()];
  const parite = pm.filter((r) => String(r.note || "").startsWith("parite:"));
  const sautees = {};
  for (const r of pm) if (r.status === "broken" || r.status === "absent") sautees[`${r.source} · ${r.status}`] = (sautees[`${r.source} · ${r.status}`] || 0) + 1;

  const somme = (l, k) => l.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const sources = {
    animeSama: {
      fiches: new Set(asP.map((p) => p.slug)).size, panneaux: asP.length,
      vostfr: asP.filter((p) => p.langue === "vostfr").length, vf: asP.filter((p) => p.langue.startsWith("vf")).length,
      episodes: somme(asP, "nb_ep"), vivants: somme(asP, "nb_vivants"), morts: somme(asP, "nb_morts"),
      animes: ids.filter((id) => a(id, "as")).length, sansAnilist: asSansId.length,
    },
    voirAnime: {
      pages: va.length, vostfr: va.filter((p) => p.langue !== "vf").length, vf: va.filter((p) => p.langue === "vf").length,
      episodes: somme(va, "nb_ep"), vivants: somme(va, "nb_vivants"), morts: somme(va, "nb_morts"),
      animes: ids.filter((id) => a(id, "va")).length, sansAnilist: vaSansId.length,
    },
    frembed: { animes: frembed.size },
  };
  return {
    resume: {
      animesJouables: recouvrement.total, avecVf: recouvrement.avecVf,
      videosVivantes: sources.animeSama.vivants + sources.voirAnime.vivants,
      videosMortes: sources.animeSama.morts + sources.voirAnime.morts,
      asAnimes: sources.animeSama.animes, vaAnimes: sources.voirAnime.animes,
      top500SansVideo: sansVideo.length, top500Incomplets: incomplets.length,
      enCoursEnRetard: enCours.filter((x) => x.retard > 0).length,
    },
    sources, recouvrement, part,
    trous: {
      sansVideo: sansVideo.slice(0, 60), sansVf: sansVf.length, sansVfListe: sansVf.slice(0, 40),
      incomplets: incomplets.slice(0, 60), nbIncomplets: incomplets.length,
      enCours: enCours.slice(0, 80),
    },
    rattachement: {
      vaSansId: vaSansId.length, vaSansIdListe: vaSansId.slice(0, 40).map((p) => ({ slug: p.slug, titre: p.romaji || p.anglais, ep: p.nb_ep })),
      asSansId: asSansId.length, asSansIdListe: asSansId.map((p) => ({ slug: p.slug, titre: p.libelle })),
      parite: parite.length,
      pariteListe: parite.sort((x, y) => y.checked_at - x.checked_at).slice(0, 40).map((r) => ({ id: r.ani_id, lang: r.lang, note: r.note, quand: r.checked_at })),
      sautees: Object.entries(sautees).sort((x, y) => y[1] - x[1]).map(([nom, n]) => ({ nom, n })),
    },
  };
});

section("oped", "jour", async () => {
  const skips = await peutManquer(sql("cache", "SELECT kind || ' · ' || source || (CASE WHEN serve THEN '' ELSE ' (non servi)' END) nom, count(*) n FROM oped_skips GROUP BY kind, source, serve ORDER BY n DESC"), []);
  const parHote = await peutManquer(sql("cache", "SELECT host || ' · ' || lang nom, count(*) n FROM oped_host_skips GROUP BY host, lang ORDER BY n DESC"), []);
  const yt = await peutManquer(sql("cache", "SELECT coalesce(verdict, '?') nom, count(*) n FROM oped_youtube GROUP BY verdict ORDER BY n DESC"), []);
  const totalSkips = skips.reduce((s, r) => s + r.n, 0);
  return { resume: { skips: totalSkips, skipsParHote: parHote.reduce((s, r) => s + r.n, 0) }, skips, parHote, youtube: yt };
});

section("moderation", "jour", async () => {
  const b = await un("admin", `SELECT count(*) total, sum(resolved_at IS NULL) ouverts, sum(pending_at IS NOT NULL AND resolved_at IS NULL) enAttente,
      sum(created_at >= ?) nouveaux7j, sum(created_at >= ?) nouveaux30j FROM bug_reports`, [S - 7 * J, S - 30 * J]);
  const gravites = await sql("admin", "SELECT coalesce(severity, '?') nom, count(*) n, sum(resolved_at IS NULL) ouverts FROM bug_reports GROUP BY severity ORDER BY n DESC");
  const parMois = await sql("admin", "SELECT strftime('%Y-%m', created_at, 'unixepoch') mois, count(*) n FROM bug_reports GROUP BY mois ORDER BY mois");
  const resolution = await un("admin", "SELECT avg(resolved_at - created_at) moyenne FROM bug_reports WHERE resolved_at IS NOT NULL");
  const audit = await sql("admin", "SELECT action nom, count(*) n FROM audit_log GROUP BY action ORDER BY n DESC");
  const derniers = await sql("admin", "SELECT action, actor, target, created_at FROM audit_log ORDER BY created_at DESC LIMIT 10");
  const bans = await un("admin", "SELECT count(*) n FROM banned_ips");
  const annonce = await peutManquer(un("admin", "SELECT title, show_flag, start_at, end_at FROM broadcast ORDER BY updated_at DESC LIMIT 1"), {});
  return { resume: { signalementsOuverts: b.ouverts }, signalements: { ...b, resolutionMoyenneS: resolution.moyenne }, gravites, parMois, audit, derniers, bans: bans.n, annonce };
});

section("infra", "jour", async () => {
  const out = {};
  if (process.env.TURSO_API_TOKEN) {
    const { collectTurso } = await import("../usage-monitor/lib/turso.mjs");
    const t = await peutManquer(collectTurso(), null);
    if (t) out.turso = { lus: t.quota.rowsRead, plafond: t.quota.rowsReadLimit, ecrits: t.quota.rowsWritten ?? null, stockage: t.quota.storageBytes ?? null, finPeriode: t.quota.periodEnd, pct: t.usedPct, projection: t.projectedPct, hier: Object.fromEntries(Object.entries(t.perDb).map(([k, d]) => [k, d.rowsRead ?? null])) };
  }
  if (process.env.UPSTASH_EMAIL && process.env.UPSTASH_API_KEY) {
    const { fetchUpstashStats } = await import("../usage-monitor/lib/upstash.mjs");
    const s = await peutManquer(fetchUpstashStats({ email: process.env.UPSTASH_EMAIL, apiKey: process.env.UPSTASH_API_KEY, dbId: process.env.UPSTASH_DATABASE_ID }), null);
    if (s) out.upstash = { hier: s.yesterday, moyenne7j: s.avgPerDay7d, projection: s.projectedCapPct };
  }
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const r = await peutManquer(fetch(`${process.env.UPSTASH_REDIS_REST_URL}/dbsize`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }).then((x) => x.json()), null);
    if (r?.result != null) (out.upstash ||= {}).cles = r.result;
    // Plafond mensuel atteint : Upstash refuse TOUTE commande, le cache du site est coupe (vu le 31/10/2026).
    if (/max requests limit/i.test(String(r?.error || ""))) Object.assign((out.upstash ||= {}), { plafondAtteint: true, erreur: r.error });
  }
  return { resume: { tursoPct: out.turso?.pct ?? null, upstashProjection: out.upstash?.projection ?? null }, ...out };
});

section("automatisations", "jour", async () => {
  const repo = process.env.GITHUB_REPOSITORY || "Lxcyd/NewAniScroll";
  const H = { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const gh = async (p) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${p}`, { headers: H });
    if (!r.ok) throw new Error(`GitHub ${r.status} sur ${p}`);
    return r.json();
  };
  const w = await gh("/actions/workflows?per_page=100");
  const passage = (x) => ({
    id: x.id, quand: x.created_at, url: x.html_url, evenement: x.event, branche: x.head_branch,
    etat: x.status === "completed" ? x.conclusion : x.status,
    duree: x.updated_at && x.run_started_at ? Math.round((Date.parse(x.updated_at) - Date.parse(x.run_started_at)) / 1000) : null,
  });
  const liste = [];
  for (const wf of w.workflows || []) {
    // Les workflows de CI (push / pull request) gardent leurs passages ; les autres, tous.
    const r = await gh(`/actions/workflows/${wf.id}/runs?per_page=20&exclude_pull_requests=true`);
    const runs = (r.workflow_runs || []).map(passage);
    /* Le rythme attendu : l'ecart median entre deux passages PROGRAMMES. Un
       workflow programme dont le dernier passage date de plus de deux ecarts
       (et d'au moins 3 h de plus) ne tourne plus — panne silencieuse. */
    const prog = runs.filter((x) => x.evenement === "schedule").map((x) => Date.parse(x.quand));
    const ecarts = prog.slice(0, -1).map((t, i) => (t - prog[i + 1]) / 1000).sort((a, b) => a - b);
    const rythme = ecarts.length >= 2 ? ecarts[Math.floor(ecarts.length / 2)] : null;
    const age = runs[0] ? (maintenant - Date.parse(runs[0].quand)) / 1000 : null;
    liste.push({
      nom: wf.name, fichier: wf.path.split("/").pop(), actif: wf.state === "active", etatWorkflow: wf.state,
      rythme, enRetard: !!(wf.state === "active" && rythme && age != null && age > Math.max(2 * rythme, rythme + 3 * 3600)),
      dernier: runs[0] || null, passages: runs,
    });
  }
  /* Le detail des ECHECS des 7 derniers jours : quel job, quelle etape. Au
     plus 30 passages, du plus recent au plus ancien. */
  const echecs = liste.flatMap((wf) => wf.passages.filter((x) => x.etat === "failure" && maintenant - Date.parse(x.quand) < 7 * J * 1000).map((x) => ({ ...x, workflow: wf.nom, fichier: wf.fichier })))
    .sort((a, b) => b.quand.localeCompare(a.quand)).slice(0, 30);
  for (const e of echecs) {
    const jobs = await peutManquer(gh(`/actions/runs/${e.id}/jobs?filter=latest&per_page=100`), { jobs: [] });
    const rates = (jobs.jobs || []).filter((j) => j.conclusion === "failure");
    e.jobs = rates.slice(0, 5).map((j) => ({ nom: j.name, etape: (j.steps || []).find((s) => s.conclusion === "failure")?.name || null, url: j.html_url }));
    e.jobsRates = rates.length;
    e.jobsTotal = (jobs.jobs || []).length;
  }
  liste.sort((a, b) => String(b.dernier?.quand || "").localeCompare(String(a.dernier?.quand || "")));
  const enEchec = liste.filter((x) => x.actif && x.dernier?.etat === "failure").length;
  return { resume: { automatisationsEnEchec: enEchec, echecs7j: echecs.length }, workflows: liste, echecs };
});

/* La FRAICHEUR de chaque chaine de donnees : quand a-t-elle ecrit pour la
   derniere fois, et qu'a-t-elle ajoute. Que des lectures par index ou de
   petites tables (~15 000 lignes). Les coches vertes de GitHub ne suffisent
   pas : le 31/10/2026, refresh-fanarts etait vert tous les jours depuis mai et
   n'avait rien livre au site (il ecrivait dans la mauvaise base). */
section("fraicheur", "jour", async () => {
  const etat = Object.fromEntries((await sql("cache", "SELECT key, value, updated_at FROM scrape_state WHERE key IN ('fanart_last_check', 'fanart_last_run')")).map((r) => [r.key, r]));
  let bilan = null;
  try { bilan = JSON.parse(etat.fanart_last_run?.value || "null"); } catch {}
  const fan = await un("fanarts", "SELECT max(id) dernierId FROM anime_fanarts");
  const fanRecent = await un("fanarts", "SELECT fetched_at FROM anime_fanarts WHERE id = ?", [fan.dernierId ?? 0]);
  const nonClasses = await un("fanarts", "SELECT count(*) n FROM anime_fanarts WHERE nsfw_label IS NULL");
  const fanarts = {
    dernierPassage: bilan?.at ?? Number(etat.fanart_last_check?.value) ?? null, bilan,
    dernierId: fan.dernierId ?? null, derniereImage: fanRecent.fetched_at ?? null, nonClasses: nonClasses.n ?? null,
  };
  const progres = await peutManquer(sql("fanarts", "SELECT tache, curseur, note, maj_at FROM wallhaven_progres"), []);
  const wb = await peutManquer(un("fanarts", "SELECT count(*) n FROM wallhaven_brut"), {});
  const wAtag = await peutManquer(un("fanarts", "SELECT count(*) n FROM wallhaven_brut WHERE tagged_at IS NULL AND favorites >= 4"), {});
  const wAattr = await peutManquer(un("fanarts", "SELECT count(*) n FROM wallhaven_brut WHERE tagged_at > 0 AND attribue_at IS NULL"), {});
  const wImg = await peutManquer(un("fanarts", "SELECT max(rowid) n FROM wallhaven_image"), {});
  const wallhaven = { progres, brut: wb.n ?? null, aEtiqueter: wAtag.n ?? null, aAttribuer: wAattr.n ?? null, lignesGalerie: wImg.n ?? null };
  const as = await peutManquer(un("cache", "SELECT max(maj_le) maj, count(*) n FROM as_panneau"), {});
  const va = await peutManquer(un("cache", "SELECT max(maj_le) maj, count(*) n FROM va_page"), {});
  // checked_at melange les unites : millisecondes sur les vieilles lignes, secondes depuis. On ramene tout en secondes.
  const pm = await peutManquer(un("cache", "SELECT max(CASE WHEN checked_at > 1e11 THEN checked_at / 1000 ELSE checked_at END) maj FROM player_map"), {});
  const animes = await un("cache", "SELECT count(*) n FROM anime WHERE expires_at < ?", [S]);
  return {
    resume: { fanartsDernierId: fanarts.dernierId, wallhavenBrut: wallhaven.brut, wallhavenAEtiqueter: wallhaven.aEtiqueter },
    fanarts, wallhaven, animeSama: as, voirAnime: va, playerMap: pm, animesPerimes: animes.n ?? null,
  };
});

/* Le nombre EXACT de lignes de chaque table. MAX(rowid) ne convient pas : la
   cle de `anime` est l'id AniList, 219 237 pour 22 783 lignes. Mesure du
   31/10/2026 : Turso ne facture que ~3 300 lignes pour les COUNT(*) de toutes
   les tables, d'ou la cadence quotidienne. */
section("tables", "jour", async () => {
  const tables = [];
  for (const base of Object.keys(BASES)) {
    const t = await peutManquer(sql(base, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE '_litestream%'"), []);
    for (const { name } of t) {
      const n = await peutManquer(un(base, `SELECT count(*) n FROM "${name}"`), {});
      tables.push({ base, nom: name, n: n.n ?? null });
    }
  }
  tables.sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
  return { resume: { lignesEnBase: tables.reduce((s, t) => s + (t.n || 0), 0) }, tables };
});

/* ── Hebdomadaires : les grosses tables (~1,7 M de lignes lues au total) ──── */
section("catalogue", "semaine", async () => {
  const g = await sql("cache", `SELECT coalesce(format, '?') format, coalesce(status, '?') status, is_adult adulte,
      season_year annee, count(*) n, sum(expires_at < ?) perimes FROM anime GROUP BY 1, 2, 3, 4`, [S]);
  const somme = (cle) => {
    const m = {};
    for (const r of g) m[r[cle]] = (m[r[cle]] || 0) + r.n;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([nom, n]) => ({ nom, n }));
  };
  const decennies = {};
  for (const r of g) { const d = r.annee ? `${Math.floor(r.annee / 10) * 10}s` : "sans annee"; decennies[d] = (decennies[d] || 0) + r.n; }
  const annees = {};
  for (const r of g) if (r.annee && r.annee >= 2000) annees[r.annee] = (annees[r.annee] || 0) + r.n;
  const total = g.reduce((s, r) => s + r.n, 0);
  const perimes = g.reduce((s, r) => s + r.perimes, 0);
  const adultes = g.filter((r) => r.adulte).reduce((s, r) => s + r.n, 0);
  const persos = await un("cache", "SELECT count(*) n, sum(with_image) avecImage, sum(complete) complets FROM anime_characters");
  const musiques = await un("cache", "SELECT count(*) n, sum(n > 0) avecMusiques, sum(n) titres FROM aniplaylist_songs");
  const ids = await un("cache", `SELECT count(*) n, sum(mal_id IS NOT NULL) mal, sum(tmdb_tv_id IS NOT NULL OR tmdb_movie_id IS NOT NULL) tmdb,
      sum(tvdb_id IS NOT NULL) tvdb, sum(simkl_id IS NOT NULL) simkl FROM fribb_map`);
  const frembed = await sql("cache", "SELECT coalesce(kind, '?') nom, count(*) n FROM frembed_catalog GROUP BY kind ORDER BY n DESC");
  return {
    resume: { animes: total },
    total, perimes, adultes, formats: somme("format"), statuts: somme("status"),
    decennies: Object.entries(decennies).sort().map(([nom, n]) => ({ nom, n })),
    annees: Object.entries(annees).sort().map(([nom, n]) => ({ nom, n })),
    personnages: persos, musiques, identifiants: ids, frembed,
  };
});

section("images", "semaine", async () => {
  const f = await sql("fanarts", "SELECT type, coalesce(nsfw_label, 'non classe') label, count(*) n FROM anime_fanarts GROUP BY 1, 2");
  const fAnimes = await un("fanarts", "SELECT count(DISTINCT anime_id) n FROM anime_fanarts");
  const somme = (cle) => {
    const m = {};
    for (const r of f) m[r[cle]] = (m[r[cle]] || 0) + r.n;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([nom, n]) => ({ nom, n }));
  };
  const wh = await un("fanarts", `SELECT count(*) n, count(DISTINCT anime_id) animes, sum(has_character) personnages, sum(is_scenery) decors,
      sum(serie_ok = 1) serieOk, sum(serie_ok = 0) serieRefusee, sum(tagged_at IS NOT NULL) etiquetees FROM wallhaven_image`);
  const whTitres = await un("fanarts", "SELECT count(*) n, sum(images_prises > 0) avecImages, sum(total_dispo) dispo FROM wallhaven_titre");
  const whTypes = await sql("fanarts", "SELECT coalesce(facet_type, '?') nom, count(*) n FROM wallhaven_image GROUP BY facet_type ORDER BY n DESC");
  const tmdb = await un("fanarts", "SELECT (SELECT MAX(rowid) FROM tmdb_images_cache) images, (SELECT MAX(rowid) FROM tmdb_stills_cache) stills");
  const total = f.reduce((s, r) => s + r.n, 0);
  return { resume: { fanarts: total, wallhaven: wh.n }, fanarts: { total, animes: fAnimes.n, types: somme("type"), labels: somme("label") }, wallhaven: { ...wh, titres: whTitres, types: whTypes }, tmdb };
});

/* ── Programme ────────────────────────────────────────────────────────────── */
const SEC = !!args.sec;
const voulues = args.sections ? new Set(args.sections.split(",")) : null;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS site_stats (section TEXT PRIMARY KEY, data TEXT NOT NULL, calcule_le INTEGER NOT NULL, cout INTEGER, duree_ms INTEGER, erreur TEXT)`,
  `CREATE TABLE IF NOT EXISTS site_stats_jour (jour TEXT PRIMARY KEY, resume TEXT NOT NULL)`,
];
if (!SEC) for (const s of SCHEMA) await sql("admin", s);
const deja = SEC ? [] : await sql("admin", "SELECT section, calcule_le, data FROM site_stats");
const quand = new Map(deja.map((r) => [r.section, r.calcule_le]));
const resumes = {};
for (const r of deja) { try { resumes[r.section] = JSON.parse(r.data).resume || {}; } catch {} }

let coutTotal = 0;
for (const s of SECTIONS) {
  if (voulues && !voulues.has(s.id)) continue;
  const age = maintenant - (quand.get(s.id) || 0);
  if (!args.tout && !voulues && s.cadence === "semaine" && age < 6.5 * J * 1000) { console.log(`${s.id} : a jour (hebdomadaire)`); continue; }
  coutSection = 0;
  const t0 = Date.now();
  let data = null, erreur = null;
  try { data = await s.fn(); } catch (e) { erreur = e.message; }
  const duree = Date.now() - t0;
  coutTotal += coutSection;
  console.log(`${s.id} : ${erreur ? `ERREUR ${erreur}` : "ok"} — ${coutSection.toLocaleString("fr-FR")} lignes lues, ${duree} ms`);
  if (SEC) { console.log(args.json ? JSON.stringify(data) : JSON.stringify(data, null, 1).slice(0, 3000)); continue; }
  if (erreur) {
    // On garde la derniere valeur bonne ; seule l'erreur est notee.
    await sql("admin", `INSERT INTO site_stats (section, data, calcule_le, cout, duree_ms, erreur) VALUES (?, '{}', 0, ?, ?, ?)
      ON CONFLICT(section) DO UPDATE SET erreur = excluded.erreur`, [s.id, coutSection, duree, erreur]);
    continue;
  }
  resumes[s.id] = data.resume || {};
  await sql("admin", `INSERT INTO site_stats (section, data, calcule_le, cout, duree_ms, erreur) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, calcule_le = excluded.calcule_le, cout = excluded.cout, duree_ms = excluded.duree_ms, erreur = NULL`,
  [s.id, JSON.stringify(data), Date.now(), coutSection, duree]);
}
if (!SEC) {
  const jour = new Date().toISOString().slice(0, 10);
  const plat = Object.fromEntries(Object.entries(resumes).flatMap(([sec, r]) => Object.entries(r).map(([k, v]) => [`${sec}.${k}`, v])));
  await sql("admin", "INSERT INTO site_stats_jour (jour, resume) VALUES (?, ?) ON CONFLICT(jour) DO UPDATE SET resume = excluded.resume", [jour, JSON.stringify(plat)]);
  // Historique garde 90 jours (choix de Luc, 01/11/2026).
  await sql("admin", "DELETE FROM site_stats_jour WHERE jour < ?", [new Date(maintenant - 90 * J * 1000).toISOString().slice(0, 10)]);
}
console.log(`total : ${coutTotal.toLocaleString("fr-FR")} lignes lues`);
