#!/usr/bin/env node
/**
 * Controle de sante de la production, apres un deploiement ou une migration.
 *
 * CE QUE C'EST, ET CE QUE CE N'EST PAS. C'est UNE passe : chaque route est
 * appelee une fois, puis le script s'arrete. Ce n'est PAS une sonde qui tourne
 * en boucle — le compteur d'invocations Vercel est la ressource la plus rare du
 * projet, et un moniteur qui interroge le site toutes les minutes consommerait
 * a lui seul plus que les visiteurs. Pour surveiller dans la duree, espacer les
 * passes (un cron quotidien), pas raccourcir l'intervalle.
 *
 * Chaque verification dit ce qu'elle attend, pas seulement si "ca repond".
 * Un 200 sur une page qui devrait rediriger est un echec ; un 404 attendu est
 * un succes. Sans cette distinction, un smoke test finit par ne prouver que
 * l'existence d'un serveur web.
 *
 * Usage : node tools/smoke/prod-check.mjs [base]
 *         node tools/smoke/prod-check.mjs https://dev.aniscroll.com
 */

const base = (process.argv[2] || "https://aniscroll.com").replace(/\/$/, "");
const TIMEOUT_MS = 20000;

/** One Piece — un titre qui existe depuis toujours et ne disparaitra pas du
 *  catalogue, contrairement a un anime de saison. */
const ID = 21;

const CAS = [
  { nom: "racine -> locale", url: "/", attendu: [307, 308], suivre: false },
  { nom: "accueil", url: "/en", attendu: [200], contient: "<html" },
  { nom: "fiche anime", url: `/en/anime/${ID}`, attendu: [200], contient: "<html" },
  { nom: "recherche locale", url: "/api/v2/search?q=naruto", attendu: [200], json: true },
  { nom: "media (metadonnees)", url: `/api/v2/media/${ID}`, attendu: [200, 404], json: true },
  { nom: "catalogue trending", url: "/api/v2/catalog/trending", attendu: [200, 503], json: true },
  { nom: "sante AniList", url: "/api/v2/anilist-health", attendu: [200], json: true },
  { nom: "saisons", url: `/api/v2/seasons/${ID}`, attendu: [200], json: true },
  // Route livree sur `dev` seulement (commits du 12/09). Un 404 ici ne dit pas
  // que la prod est cassee : il dit que la prod tourne sur `main`, ce qui est
  // exact et voulu tant que la branche dev n'a pas ete refaite. Marquee
  // optionnelle plutot que retiree — le jour ou elle passera, ce sera le signal
  // que la fusion est reellement en ligne.
  {
    nom: "wallhaven (dev only)",
    url: `/api/v2/wallhaven?anime=${ID}`,
    attendu: [200],
    json: true,
    optionnel: "pas encore sur main",
  },
  { nom: "admin sans session", url: "/admin", attendu: [307, 308, 302], suivre: false },
  { nom: "route inexistante", url: "/api/v2/nexistepas", attendu: [404] },
];

async function verifier(cas) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(base + cas.url, {
      redirect: cas.suivre === false ? "manual" : "follow",
      signal: ctl.signal,
      headers: { "User-Agent": "aniscroll-smoke/1" },
    });
    const ms = Date.now() - t0;
    const statutOk = cas.attendu.includes(res.status);
    let detail = `HTTP ${res.status}`;
    let corpsOk = true;

    if (statutOk && (cas.contient || cas.json)) {
      const texte = await res.text();
      if (cas.json) {
        try {
          JSON.parse(texte);
          detail += " · JSON valide";
        } catch {
          corpsOk = false;
          detail += " · corps NON JSON";
        }
      }
      if (cas.contient && !texte.includes(cas.contient)) {
        corpsOk = false;
        detail += ` · "${cas.contient}" absent`;
      }
    }
    const cache = res.headers.get("x-vercel-cache");
    if (cache) detail += ` · cache ${cache}`;
    return { ok: statutOk && corpsOk, detail, ms };
  } catch (e) {
    return { ok: false, detail: e.name === "AbortError" ? "expiration" : e.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`Controle de ${base}\n`);
let echecs = 0;
let attendus = 0;
for (const cas of CAS) {
  const r = await verifier(cas);
  let etat;
  if (r.ok) etat = "ok    ";
  else if (cas.optionnel) {
    etat = "absent";
    attendus++;
  } else {
    etat = "ECHEC ";
    echecs++;
  }
  const suffixe = !r.ok && cas.optionnel ? ` (${cas.optionnel})` : "";
  console.log(
    `  ${etat} ${cas.nom.padEnd(22)} ${String(r.ms).padStart(5)} ms  ${r.detail}${suffixe}`,
  );
}
const dur = CAS.length - attendus;
console.log(
  echecs
    ? `\n${echecs} echec(s) sur ${dur} controles bloquants.`
    : `\nLes ${dur} controles bloquants passent${attendus ? ` (${attendus} route(s) absente(s), attendu)` : ""}.`,
);
process.exit(echecs ? 1 : 0);
