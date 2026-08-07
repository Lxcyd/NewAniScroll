/**
 * Point 4 — par quels titres commencer.
 *
 * ⚠️ CE N'EST PAS DU TRAFIC RÉEL, ET IL FAUT LE SAVOIR EN LISANT LA SORTIE.
 * Le plan demandait de classer par trafic mesuré (`vercel logs --json`). Ce
 * n'est pas faisable ici : le CLI Vercel n'est pas installé et son
 * authentification est interactive, et la base Turso ne contient aucune table
 * de trafic (`user_analytics` n'existe pas côté prod ; le Worker ne l'alimente
 * plus depuis le 11/07). Le substitut retenu est la **popularité AniList**,
 * qui corrèle avec l'audience sans s'y réduire — une série ancienne très
 * populaire peut n'être quasiment pas regardée chez nous.
 * → Refaire ce classement sur les vraies journaux dès qu'un `vercel login`
 *   aura été fait, avant de décider quoi que ce soit d'irréversible.
 *
 * Ce que le script classe : les titres qui ont un lecteur exploitable ET une
 * couverture OP/ED incomplète, du plus populaire au moins populaire. Un titre
 * déjà couvert n'a rien à gagner ; un titre sans lecteur n'est pas adressable.
 *
 * Usage : node tools/opening-detector/_prioritise_titles.mjs [--limit 50]
 */
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

function env() {
  const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  return Object.fromEntries(
    raw.split('\n').filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
  );
}

/** Ce que le détecteur a déjà produit, par mal_id : cellules et cellules servables. */
function coverage() {
  const outDir = path.join(HERE, 'out');
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(outDir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  // La ligne la PLUS RÉCENTE par cellule — même piège que côté Python : un tri
  // alphabétique garderait `audit.jsonl` devant `audit6.jsonl`, donc le lot le
  // plus ANCIEN, et on mesurerait une couverture déjà périmée.
  const cells = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r.per_host) continue;
      cells.set(`${r.mal_id}|${r.episode}|${r.lang}`, r);
    }
  }
  const per = new Map();
  for (const r of cells.values()) {
    const e = per.get(r.mal_id) || { cells: 0, servable: 0 };
    e.cells += 1;
    // Servable = le seuil de service réel : au moins 2 hôtes ont trouvé.
    const live = Object.values(r.per_host).filter((v) => v.op || v.ed).length;
    if (live >= 2) e.servable += 1;
    per.set(r.mal_id, e);
  }
  return per;
}

const limit = Number((process.argv.find((a) => a.startsWith('--limit')) || '').split('=')[1] || 50);
const e = env();
const db = createClient({ url: e.TURSO_DATABASE_URL, authToken: e.TURSO_AUTH_TOKEN });

// Titres ayant au moins un lecteur exploitable (le détecteur ne peut rien sans).
const pm = await db.execute(
  `select distinct ani_id from player_map where status in ('verified','heuristic')`,
);
const playable = new Set(pm.rows.map((r) => Number(r.ani_id)));

const an = await db.execute(
  `select id, id_mal, popularity from anime where popularity is not null and id_mal is not null`,
);

const cov = coverage();
const rows = [];
for (const r of an.rows) {
  const aniId = Number(r.id);
  if (!playable.has(aniId)) continue;
  const malId = Number(r.id_mal);
  const c = cov.get(malId) || { cells: 0, servable: 0 };
  rows.push({
    malId, aniId, pop: Number(r.popularity),
    cells: c.cells, servable: c.servable,
    // Ce qui reste à gagner : jamais mesuré, ou mesuré et incomplet.
    gap: c.cells === 0 ? 1 : 1 - c.servable / c.cells,
  });
}
rows.sort((a, b) => (b.gap * b.pop) - (a.gap * a.pop));

const head = ['#', 'mal_id', 'popularite', 'cellules', 'servables', 'manque'];
console.log('SUBSTITUT : popularite AniList, PAS le trafic reel (voir en-tete du fichier).\n');
console.log(head.map((h, i) => h.padStart(i === 0 ? 4 : 12)).join(''));
console.log('-'.repeat(76));
for (const [i, r] of rows.slice(0, limit).entries()) {
  console.log(
    String(i + 1).padStart(4) + String(r.malId).padStart(12)
    + String(r.pop).padStart(12) + String(r.cells).padStart(12)
    + String(r.servable).padStart(12) + `${(r.gap * 100).toFixed(0)}%`.padStart(12),
  );
}
const never = rows.filter((r) => r.cells === 0).length;
console.log(`\n${rows.length} titres jouables ; ${never} jamais mesures.`);
console.log(`couverture servable sur les ${limit} premiers : `
  + `${rows.slice(0, limit).reduce((s, r) => s + r.servable, 0)}`
  + `/${rows.slice(0, limit).reduce((s, r) => s + r.cells, 0)} cellules`);
