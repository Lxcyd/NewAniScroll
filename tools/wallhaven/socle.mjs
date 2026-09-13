/**
 * Le socle commun aux trois moissonneurs Wallhaven : environnement, bases,
 * cadence, curseur de reprise.
 *
 * CES SCRIPTS NE TOURNENT QUE SUR LE POSTE. C'est le but de tout le dispositif :
 * Wallhaven limite a 45 requetes/minute PAR IP, et cette IP etait celle de la
 * fonction Vercel, partagee par tous les visiteurs. Depuis une machine
 * personnelle, la meme limite ne gene plus personne — et le temps, lui, devient
 * gratuit : on peut passer trente heures a moissonner ce qu'une lambda ne
 * pouvait pas se permettre de demander une seule fois.
 */

import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { REQUETES_PAR_MINUTE } from "../../lib/wallhaven/criteres.js";

export const RACINE = path.resolve(import.meta.dirname, "..", "..");

export function chargerEnv() {
  for (const nom of [".env", ".env.local"]) {
    const p = path.join(RACINE, nom);
    if (!fs.existsSync(p)) continue;
    for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m && m[2].trim() && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  }
}

/** La base des METADONNEES (table `anime`) — c'est elle qui donne les titres. */
export function baseAnime() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL absente — voir le .env du projet.");
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

/**
 * La base des IMAGES. Elle retombe sur la principale quand la base dediee n'est
 * pas configuree, exactement comme lib/db/turso-fanarts.ts — sans quoi le
 * moissonneur ecrirait dans une base et le site lirait dans l'autre.
 */
export function baseImages() {
  const url = process.env.TURSO_FANARTS_DATABASE_URL || process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_FANARTS_DATABASE_URL
    ? process.env.TURSO_FANARTS_AUTH_TOKEN
    : process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("Aucune base images configuree.");
  if (!process.env.TURSO_FANARTS_DATABASE_URL) {
    console.error("[socle] TURSO_FANARTS_DATABASE_URL absente — ecriture dans la base principale.");
  }
  return createClient({ url, authToken: token });
}

/* ── La cadence ───────────────────────────────────────────────────────────── */

const ENTRE_APPELS_MS = Math.ceil(60_000 / REQUETES_PAR_MINUTE);
let prochain = 0;

/**
 * Un appel a Wallhaven, jamais plus vite que la cadence autorisee.
 *
 * L'espacement est calcule sur l'HORODATAGE et non par un `sleep` apres coup :
 * une requete lente ne doit pas s'ajouter au delai, sinon la cadence reelle
 * derive bien en dessous de la cible et un moissonnage de 28 h en prend 40.
 *
 * Un 429 n'est PAS une erreur fatale : on attend une minute pleine — la fenetre
 * de Wallhaven — et on rejoue. Toute autre erreur rend `null` ; c'est a
 * l'appelant de decider, et aucun des trois moissonneurs ne considere un echec
 * ponctuel comme une raison de s'arreter.
 */
export async function appel(url, essais = 3) {
  for (let i = 0; i < essais; i++) {
    const attente = prochain - Date.now();
    if (attente > 0) await new Promise((r) => setTimeout(r, attente));
    prochain = Date.now() + ENTRE_APPELS_MS;
    try {
      /* Sans timeout, une connexion morte sans FIN bloque le moissonneur pour
         toujours : vu le 13/09, deux heures figees sur le curseur 11 212. */
      const r = await fetch(url, {
        headers: { "User-Agent": "aniscroll-moissonneur" },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 429) {
        console.error("  429 — fenetre saturee, pause d'une minute");
        prochain = Date.now() + 60_000;
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (i === essais - 1) return null;
      /* Coupure reseau : on laisse passer un peu de temps avant de rejouer. */
      prochain = Date.now() + 5_000;
    }
  }
  return null;
}

/* ── Le curseur de reprise ────────────────────────────────────────────────── */

const CREATE_PROGRES = `
CREATE TABLE IF NOT EXISTS wallhaven_progres (
  tache   TEXT PRIMARY KEY,
  curseur TEXT,
  note    TEXT,
  maj_at  INTEGER NOT NULL
)`;

export async function preparerProgres(db) {
  await db.execute(CREATE_PROGRES);
}

export async function lireCurseur(db, tache) {
  try {
    const r = await db.execute({
      sql: "SELECT curseur FROM wallhaven_progres WHERE tache = ?",
      args: [tache],
    });
    return r.rows.length ? r.rows[0].curseur : null;
  } catch {
    return null;
  }
}

export async function ecrireCurseur(db, tache, curseur, note = null) {
  try {
    await db.execute({
      sql: `INSERT INTO wallhaven_progres (tache, curseur, note, maj_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(tache) DO UPDATE SET
              curseur = excluded.curseur, note = excluded.note, maj_at = excluded.maj_at`,
      args: [tache, String(curseur), note, Math.floor(Date.now() / 1000)],
    });
  } catch {
    /* Perdre le curseur coute une reprise plus longue, pas le travail. */
  }
}

/* ── Parcourir le catalogue sans le charger d'un bloc ─────────────────────── */

/**
 * LA LECON DU 13/09/2026, apprise a l'execution.
 *
 * Le premier moissonnage est mort sur
 * « Resource exhausted: mem_hrana_response » des la requete d'ouverture. La
 * cause etait dans la charge utile, pas dans le code : `SELECT id, data FROM
 * anime` rend 22 643 lignes dont chaque `data` est un blob AniList d'environ
 * 15 ko. Soit **~340 Mo dans une seule reponse**. Turso refuse, et il a raison.
 *
 * D'ou ce decoupage en deux temps : la LISTE DES IDS d'abord — 22 643 entiers,
 * quelques centaines de kilo-octets et l'ordre qu'on veut — puis les blobs par
 * lots. Ce qui tient en memoire est alors borne par la taille du lot, jamais
 * par celle du catalogue.
 */
export async function listerIds(db, sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows.map((x) => Number(x.id));
}

/** La taille d'un lot : 150 x 15 ko ≈ 2 Mo, loin de la limite. */
const LOT = 150;

/**
 * Rend `{id, data}` un par un, en ne chargeant qu'un lot a la fois.
 *
 * L'ORDRE DEMANDE EST PRESERVE : un `IN (...)` rend les lignes dans l'ordre qui
 * arrange SQLite, or l'ordre est ici porteur de sens — le moissonneur de tags
 * descend le catalogue par popularite, et le rendre melange ferait taguer des
 * titres obscurs avant les titres qu'on ouvre vraiment.
 */
export async function* parLots(db, ids, taille = LOT) {
  for (let i = 0; i < ids.length; i += taille) {
    const lot = ids.slice(i, i + taille);
    let parId = new Map();
    try {
      const r = await db.execute({
        sql: `SELECT id, data FROM anime WHERE id IN (${lot.map(() => "?").join(",")})`,
        args: lot,
      });
      parId = new Map(r.rows.map((x) => [Number(x.id), x.data]));
    } catch (e) {
      console.error(`\n  lot de ${lot.length} illisible (${e.message}) — ignore`);
    }
    for (const id of lot) yield { id, data: parId.get(id) ?? null };
  }
}

/* ── Confort ──────────────────────────────────────────────────────────────── */

export const maintenant = () => Math.floor(Date.now() / 1000);

export function duree(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** Ecrit sur une seule ligne, pour qu'un moissonnage de 28 h ne produise pas
 *  100 000 lignes de journal. */
export function avancement(txt) {
  if (process.stderr.isTTY) process.stderr.write(`\r${txt.padEnd(110)}`);
  else console.error(txt);
}
