#!/usr/bin/env node
/**
 * Etat de sante de toute l'infra, en UNE passe : Vercel, Cloudflare, Upstash,
 * Turso, Oracle. Chaque service est interroge par SON API (gratuit, hors
 * quota du site) ; le site lui-meme ne recoit qu'UN appel par hote — jamais de
 * boucle (cf. CLAUDE.md, regle 2).
 *
 *   node tools/infra-health/check.mjs            rapport dans le terminal
 *   node tools/infra-health/check.mjs --md F     et copie markdown dans F
 *
 * Code de sortie : 0 tout va bien, 1 au moins un probleme (❌), 2 avertissements.
 *
 * Ce qui n'est PAS mesurable : le Fluid Active CPU de Vercel. Son API
 * d'observabilite (/v2/observability/query) repond 402 sur Hobby (verifie le
 * 30/10/2026). On suit a la place ce qui le fait monter : les requetes que
 * Cloudflare laisse passer jusqu'a Vercel (cache MISS/DYNAMIC/BYPASS).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of [".env", ".env.local"]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
}

const out = [];
const problems = [];
const warnings = [];
const say = (s = "") => out.push(s);
const bad = (s) => (problems.push(s), say(`  ❌ ${s}`));
const warn = (s) => (warnings.push(s), say(`  ⚠️ ${s}`));
const ok = (s) => say(`  ✅ ${s}`);
const info = (s) => say(`  · ${s}`);
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("fr-FR"));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

async function section(title, fn) {
  say(`\n## ${title}`);
  try {
    await fn();
  } catch (e) {
    warn(`controle interrompu : ${e.message}`);
  }
}

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}
  return { status: r.status, json: j, text: t, headers: r.headers };
}

/* ── Site : un appel par hote ─────────────────────────────────────────────── */
const HOSTS = ["aniscroll.com", "dev.aniscroll.com", ...(process.env.VM_HOST ? [process.env.VM_HOST] : [])];

await section("Site (1 requete par hote)", async () => {
  for (const h of HOSTS) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://${h}/api/v2/anilist-health`, {
        headers: { "User-Agent": "Mozilla/5.0 aniscroll-health/1" },
        signal: AbortSignal.timeout(20000),
      });
      const ms = Date.now() - t0;
      const cache = [r.headers.get("cf-cache-status") && `CF ${r.headers.get("cf-cache-status")}`,
        r.headers.get("x-vercel-cache") && `Vercel ${r.headers.get("x-vercel-cache")}`,
        r.headers.get("x-cache") && `nginx ${r.headers.get("x-cache")}`].filter(Boolean).join(", ");
      const line = `${h} : HTTP ${r.status} en ${ms} ms${cache ? ` (${cache})` : ""}`;
      if (r.status === 402) bad(`${line} — COMPTE VERCEL EN PAUSE (quota depasse). Voir le tableau de bord Usage.`);
      else if (r.status >= 500) bad(`${line} — le site renvoie une erreur serveur`);
      else if (r.status === 429 && r.headers.get("x-vercel-mitigated") === "challenge")
        info(`${line} — pare-feu Vercel en mode challenge : un script est defie, attendu (un navigateur passe)`);
      else if (r.status === 429) warn(`${line} — limite de debit (pare-feu ou rate limit)`);
      else if (r.status >= 400) warn(line);
      else if (ms > 3000) warn(`${line} — lent`);
      else ok(line);
    } catch (e) {
      bad(`${h} : injoignable (${e.name === "TimeoutError" ? "20 s sans reponse" : e.message})`);
    }
  }
});

/* ── Vercel : derniers deploiements, par compte ───────────────────────────── */
await section("Vercel", async () => {
  const comptes = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/vercel/comptes.json"), "utf8"));
  for (const [nom, c] of Object.entries(comptes)) {
    const authFile = path.join(os.homedir(), `.vercel-aniscroll-${nom}`, "auth.json");
    if (!fs.existsSync(authFile)) {
      info(`${nom} : pas de session (node tools/vercel/vc.mjs ${nom} login)`);
      continue;
    }
    const { token } = JSON.parse(fs.readFileSync(authFile, "utf8"));
    const q = new URLSearchParams({ projectId: c.projectId, teamId: c.orgId, limit: "20", target: "production" });
    const r = await getJson(`https://api.vercel.com/v6/deployments?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) {
      warn(`${nom} : API Vercel HTTP ${r.status}${r.json?.error?.message ? ` — ${r.json.error.message}` : ""}`);
      continue;
    }
    // CANCELED = annule par should-build.sh (commit sans effet sur ce site) : voulu.
    const deps = (r.json.deployments || []).filter((d) => d.state !== "CANCELED");
    const last = deps[0];
    if (!last) {
      info(`${nom} : aucun deploiement`);
      continue;
    }
    const age = Math.round((Date.now() - last.created) / 60000);
    const desc = `${nom} : dernier deploiement ${last.state} il y a ${age < 120 ? `${age} min` : `${Math.round(age / 60)} h`} (${(last.meta?.githubCommitMessage || "").split("\n")[0].slice(0, 60)})`;
    if (last.state === "ERROR") bad(`${desc} — build en echec : node tools/vercel/vc.mjs ${nom} inspect --logs ${last.url}`);
    else if (last.state === "BUILDING" || last.state === "QUEUED") info(desc);
    else ok(desc);
    const errs = deps.filter((d) => d.state === "ERROR").length;
    if (errs >= 2) warn(`${nom} : ${errs} des 5 derniers deploiements en echec`);
    if (deps.length >= 5 && Date.now() - deps[4].created < 24 * 3600e3)
      warn(`${nom} : 5 deploiements en moins de 24 h — stockage des deploiements (regle 1 de CLAUDE.md)`);
  }
  info("Fluid Active CPU : non lisible par API sur Hobby (402). Indicateur : requetes « origine » de Cloudflare ci-dessous.");
});

/* ── Cloudflare : trafic 24 h, cache, erreurs, pare-feu ───────────────────── */
await section("Cloudflare (24 h)", async () => {
  if (!process.env.CF_ZONE_API_TOKEN) return info("pas de CF_ZONE_API_TOKEN");
  const H = { Authorization: `Bearer ${process.env.CF_ZONE_API_TOKEN}`, "Content-Type": "application/json" };
  const z = await getJson("https://api.cloudflare.com/client/v4/zones?name=aniscroll.com", { headers: H });
  if (!z.json?.success) return bad(`jeton Cloudflare refuse (${z.json?.errors?.[0]?.message || z.status}) — jeton expire ou regenere ?`);
  const zone = z.json.result[0].id;

  const dns = await getJson(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?per_page=100`, { headers: H });
  const proxied = (dns.json?.result || []).filter((r) => r.proxied).map((r) => r.name.replace(".aniscroll.com", "") || "@");
  info(`nuage orange : ${proxied.join(", ") || "aucun"}`);

  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const g = await getJson("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      query: `{ viewer { zones(filter:{zoneTag:"${zone}"}) {
        req: httpRequestsAdaptiveGroups(limit:500, filter:{datetime_geq:"${since}"}) {
          count dimensions { clientRequestHTTPHost cacheStatus edgeResponseStatus } } } } }`,
    }),
  });
  if (g.json?.errors?.length) return warn(`statistiques : ${g.json.errors[0].message}`);
  const zd = g.json.data.viewer.zones[0];
  const per = {};
  for (const r of zd.req) {
    const h = r.dimensions.clientRequestHTTPHost;
    const p = (per[h] ||= { total: 0, hit: 0, origin: 0, e5: 0, e4: 0, e403: 0 });
    p.total += r.count;
    const cs = r.dimensions.cacheStatus;
    if (cs === "hit" || cs === "stale" || cs === "revalidated" || cs === "updating") p.hit += r.count;
    if (cs === "miss" || cs === "dynamic" || cs === "bypass" || cs === "expired") p.origin += r.count;
    const s = r.dimensions.edgeResponseStatus;
    if (s >= 500) p.e5 += r.count;
    else if (s >= 400) p.e4 += r.count;
    if (s === 403) p.e403 += r.count;
  }
  for (const [h, p] of Object.entries(per).sort((a, b) => b[1].total - a[1].total)) {
    if (!h.endsWith("aniscroll.com") || p.total < 20) continue;
    const line = `${h} : ${fmt(p.total)} req, cache ${pct(p.hit, p.total)} %, vers l'origine ${fmt(p.origin)}, 5xx ${fmt(p.e5)} (${pct(p.e5, p.total)} %), 403 ${fmt(p.e403)}`;
    const isProxy = h.startsWith("proxy.");
    if (!isProxy && pct(p.e5, p.total) >= 5) bad(`${line} — trop d'erreurs serveur`);
    else if (!isProxy && pct(p.e5, p.total) >= 1) warn(line);
    else (isProxy ? info : ok)(line);
    /* Worker video : les 5xx (504 = hote video trop lent, 503 = indisponible)
       viennent souvent des SCRIPTS (lot OP/ED, UA vide), pas des visiteurs. Le
       seuil vaut pour les navigateurs seuls. */
    if (h.startsWith("proxy.") && pct(p.e5, p.total) >= 1) {
      const b = await getJson("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          query: `{ viewer { zones(filter:{zoneTag:"${zone}"}) {
            all: httpRequestsAdaptiveGroups(limit:1, filter:{datetime_geq:"${since}", clientRequestHTTPHost:"${h}", userAgent_like:"Mozilla%"}) { count }
            err: httpRequestsAdaptiveGroups(limit:1, filter:{datetime_geq:"${since}", clientRequestHTTPHost:"${h}", userAgent_like:"Mozilla%", edgeResponseStatus_geq:500}) { count } } } }`,
        }),
      });
      const zz = b.json?.data?.viewer?.zones?.[0];
      const all = zz?.all?.[0]?.count || 0;
      const err = zz?.err?.[0]?.count || 0;
      const l2 = `${h} cote navigateurs : ${fmt(err)} 5xx sur ${fmt(all)} (${pct(err, all)} %) ; le reste vient de scripts`;
      if (pct(err, all) >= 10) bad(`${l2} — des visiteurs voient des lecteurs en panne`);
      else if (pct(err, all) >= 3) warn(l2);
      else info(l2);
    }
    // 403 = defis/blocages du pare-feu (les evenements detailles sont payants).
    if (h.startsWith("proxy.") && pct(p.e403, p.total) >= 5)
      bad(`${h} : ${pct(p.e403, p.total)} % de 403 — le Worker video est bloque ou defie, les lecteurs cassent`);
    else if (pct(p.e403, p.total) >= 20) warn(`${h} : ${pct(p.e403, p.total)} % de 403 — pare-feu trop strict, ou attaque en cours`);
  }
});

/* ── Upstash ──────────────────────────────────────────────────────────────── */
await section("Upstash (Redis)", async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return info("pas d'identifiants REST");
  const r = await getJson(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}` },
    body: JSON.stringify([["PING"], ["DBSIZE"]]),
  });
  const err = r.json?.error || (Array.isArray(r.json) && r.json.find((x) => x.error)?.error);
  if (err && /limit/i.test(err)) bad(`Upstash a atteint son plafond : « ${err} » — le cache est mort, le CPU Vercel va exploser`);
  else if (err || r.status !== 200) bad(`Upstash repond mal : HTTP ${r.status} ${err || ""}`);
  else ok(`Upstash repond (${fmt(r.json[1].result)} cles)`);
  if (process.env.UPSTASH_EMAIL && process.env.UPSTASH_API_KEY) {
    const { fetchUpstashStats } = await import("../usage-monitor/lib/upstash.mjs");
    const s = await fetchUpstashStats({ email: process.env.UPSTASH_EMAIL, apiKey: process.env.UPSTASH_API_KEY, dbId: process.env.UPSTASH_DATABASE_ID });
    const line = `commandes : hier ${fmt(s.yesterday)}, moyenne 7 j ${fmt(s.avgPerDay7d)}/j, projection ${s.projectedCapPct} % du plafond mensuel`;
    if (s.projectedCapPct >= 100) bad(`${line} — saturation avant la fin du mois`);
    else if (s.projectedCapPct >= 70) warn(line);
    else ok(line);
  } else info("consommation mensuelle : ajouter UPSTASH_EMAIL + UPSTASH_API_KEY au .env (console.upstash.com/account/api)");
});

/* ── Turso ────────────────────────────────────────────────────────────────── */
await section("Turso", async () => {
  if (!process.env.TURSO_API_TOKEN) return info("pas de TURSO_API_TOKEN");
  const { collectTurso, tursoFlags } = await import("../usage-monitor/lib/turso.mjs");
  const t = await collectTurso();
  const line = `lignes lues ce mois : ${fmt(t.quota.rowsRead)} / ${fmt(t.quota.rowsReadLimit)} (${t.usedPct} %), projection ${t.projectedPct} % en fin de periode`;
  if (t.projectedPct >= 100) bad(line);
  else if (t.projectedPct >= 70) warn(line);
  else ok(line);
  for (const f of tursoFlags(t).filter((f) => !f.includes("projeté"))) warn(f.replace(/\*\*/g, ""));
});

/* ── Oracle ───────────────────────────────────────────────────────────────── */
await section("Oracle (VM)", async () => {
  const oci = ["C:/oci/Scripts/oci.exe", "/usr/local/bin/oci", "oci"].find((p) => p === "oci" || fs.existsSync(p));
  const cfg = path.join(os.homedir(), ".oci", "config");
  if (!fs.existsSync(cfg)) return info("pas de ~/.oci/config");
  const tenancy = /tenancy=(\S+)/.exec(fs.readFileSync(cfg, "utf8"))?.[1];
  const env = { ...process.env, OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "True", SUPPRESS_LABEL_WARNING: "True" };
  const run = (args) => JSON.parse(execFileSync(oci, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "{}");
  const list = run(["compute", "instance", "list", "-c", tenancy, "--display-name", "aniscroll"]).data || [];
  const vm = list.find((i) => i["lifecycle-state"] !== "TERMINATED");
  if (!vm) return info("pas encore de VM « aniscroll » (creation en attente de capacite ?)");
  if (vm["lifecycle-state"] !== "RUNNING") return bad(`VM ${vm["lifecycle-state"]} — redemarrer : oci compute instance action --action START`);
  const vnic = run(["compute", "instance", "list-vnics", "--instance-id", vm.id]).data?.[0];
  const ip = vnic?.["public-ip"];
  ok(`VM RUNNING (${vm["shape-config"]?.ocpus} OCPU, ${vm["shape-config"]?.["memory-in-gbs"]} Go), IP ${ip}`);
  const key = path.join(os.homedir(), ".ssh", "aniscroll_oracle");
  if (!ip || !fs.existsSync(key)) return;
  const sh = (cmd) =>
    execFileSync("ssh", ["-i", key, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", `ubuntu@${ip}`, cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  let facts;
  try {
    facts = sh(
      "df -P / | awk 'NR==2{print $5}'; free -m | awk '/Mem/{print $3\"/\"$2}'; cut -d' ' -f1-3 /proc/loadavg; " +
        "docker ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -i vm- || true",
    ).split("\n");
  } catch {
    return bad(`SSH vers ${ip} impossible — VM figee ? (console Oracle → instance → Console connection)`);
  }
  const [disk, mem, load, ...ctr] = facts;
  const diskPct = parseInt(disk, 10);
  (diskPct >= 85 ? bad : diskPct >= 70 ? warn : ok)(`disque ${disk}, memoire ${mem} Mo, charge ${load}`);
  for (const c of ctr.filter(Boolean)) (/^\S+ Up/.test(c) && !/unhealthy|Restarting/.test(c) ? ok : bad)(`conteneur ${c}`);
  info("Always Free : Oracle peut recuperer une VM inactive (CPU < 20 % sur 7 j) une fois l'essai fini — un site servi suffit a l'eviter.");
});

/* ── Resume ───────────────────────────────────────────────────────────────── */
const head = [
  `# Sante de l'infra — ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`,
  problems.length
    ? `❌ ${problems.length} probleme(s), ⚠️ ${warnings.length} avertissement(s)`
    : warnings.length
      ? `⚠️ ${warnings.length} avertissement(s), aucun probleme bloquant`
      : "✅ Tout va bien",
];
const report = [...head, ...out].join("\n");
console.log(report);
const mdIdx = process.argv.indexOf("--md");
if (mdIdx > 0 && process.argv[mdIdx + 1]) fs.writeFileSync(process.argv[mdIdx + 1], report + "\n");
process.exit(problems.length ? 1 : warnings.length ? 2 : 0);
