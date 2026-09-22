/* ── Debit memorise, et comment on s'en sert au demarrage ──────────────────────
   Deplace depuis UniversalPlayer : la page info et la page de lecture en ont
   besoin aussi, pour chauffer la variante qu'hls.js va REELLEMENT demander
   (cf. `pickStartVariant`, lib/watch/sourcePrefetch.ts).

   Mesure du 20/09/2026, profil neuf, One Piece 1100 sur ansembed : hls.js fait
   son TEST de debit sur `_l/seg-1` (fini a 5,8 s), le jette — un segment de
   test n'est jamais ajoute au tampon —, passe sur `_n` et redemande le MEME
   segment, que vmpx.online met 10 s a livrer. Premiere image a 17,4 s, pour un
   segment jouable arrive a 5,8 s. Et avec un debit memorise, le travers
   inverse : hls.js part d'emblee sur le plus haut niveau, dont le premier
   segment pese 8x celui du plus bas, sur un CDN qui ne suit pas toujours.

   D'ou la regle, « partir bas, monter tout de suite » :
     - le test de debit est TOUJOURS coupe (`testBandwidth: false`) ;
     - l'estimation de depart vaut le debit memorise POUR CE CDN x START_FACTOR,
       ou, sans mesure, le defaut d'hls.js (500 kb/s → le plus bas niveau) ;
     - des le premier segment, hls.js a une vraie mesure et l'ABR remonte au
       segment suivant.
   On paie quelques secondes de moindre definition ; on gagne la premiere image.

   La mesure est rangee PAR CDN (domaine enregistrable) et non plus par profil
   « direct / proxifie » : frembed (~100 ms) et vidmoly (plusieurs secondes)
   etaient melanges sous « direct », et l'un reglait le depart de l'autre. */

const BW_KEY = "aniscroll:hlsBandwidth";
const BW_MAX_AGE_MS = 7 * 24 * 3600_000;

/* Un quart : un segment de 4 s au niveau choisi se telecharge en ~1 s au debit
   mesure. Assez prudent pour un CDN qui ralentit d'une visite a l'autre, assez
   haut pour qu'une bonne connexion parte deja en HD. */
const START_FACTOR = 0.25;

/**
 * La cle de mesure d'un flux. Proxifie : le Worker, un seul chemin. Direct : le
 * domaine ENREGISTRABLE du CDN — vidmoly tourne entre `prx-am-o-1.vmpx.online`,
 * `prx-1546-ant.vmpx.online`… qui sont un seul et meme reseau.
 */
export function bandwidthKey(url: string | null | undefined, direct: boolean): string {
  if (!direct) return "proxied";
  try {
    const labels = new URL(String(url)).hostname.split(".");
    return `direct:${labels.slice(-2).join(".")}`;
  } catch {
    return "direct";
  }
}

function lire(): Record<string, { bps: number; at: number }> {
  try {
    return JSON.parse(localStorage.getItem(BW_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

export function readSavedBandwidth(key: string): number | null {
  const all = lire();
  // Repli sur l'ancienne entree par profil (« direct ») : mieux qu'aucune mesure.
  const e = all[key] || (key.startsWith("direct:") ? all.direct : undefined);
  if (!e || typeof e.bps !== "number" || !(e.bps > 0)) return null;
  if (Date.now() - (e.at || 0) > BW_MAX_AGE_MS) return null;
  return e.bps;
}

export function saveBandwidth(key: string, bps: number) {
  if (!Number.isFinite(bps) || bps <= 0) return;
  try {
    const all = lire();
    all[key] = { bps: Math.round(bps), at: Date.now() };
    localStorage.setItem(BW_KEY, JSON.stringify(all));
  } catch {
    /* stockage indisponible : on repart du defaut d'hls.js */
  }
}

/** L'estimation de depart a donner a hls.js, ou `null` (defaut d'hls.js). */
export function startEstimate(key: string): number | null {
  const bw = readSavedBandwidth(key);
  return bw ? Math.round(bw * START_FACTOR) : null;
}

/**
 * La variante qu'hls.js demandera en premier, lue dans le texte d'un master :
 * la plus haute BANDWIDTH sous l'estimation de depart, sinon la plus basse —
 * le meme calcul que son ABR (a son facteur de prudence pres). `null` quand le
 * texte n'est pas un master (playlist de media directe).
 */
export function pickStartVariant(masterText: string, key: string): string | null {
  const lines = masterText.split("\n").map((l) => l.trim());
  const variants: { bw: number; uri: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:.*?\bBANDWIDTH=(\d+)/.exec(lines[i]);
    if (!m) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (uri) variants.push({ bw: Number(m[1]), uri });
  }
  if (!variants.length) return null;
  variants.sort((a, b) => a.bw - b.bw);
  const budget = (startEstimate(key) ?? 500_000) * 0.95;
  const fits = variants.filter((v) => v.bw <= budget);
  return (fits.length ? fits[fits.length - 1] : variants[0]).uri;
}
