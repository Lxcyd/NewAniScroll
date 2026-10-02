import { CREATE_SQL } from "./opedHostSkipsSchema";

/**
 * oped_host_skips — minutages OP/ED PAR LECTEUR du detecteur hors ligne
 * (tools/opening-detector-v2/), une ligne par (mal_id, episode, lang, host).
 *
 * Pourquoi par lecteur : la position d'un generique depend de l'encodage.
 * Mesure sur SnK ep1 : l'OP commence a 2:02 chez sibnet et a 2:19 chez megaplay.
 *
 * Une ligne EXISTE des qu'un lecteur a ete traite pour un episode, meme sans
 * generique trouve (op_… et ed_… nuls, serve = 0) : c'est ce qui distingue
 * « traite, rien a servir » de « pas encore traite ».
 *
 * `host` est toujours un des DISPLAYED_HOSTS de lib/hostRegistry.js : l'importeur
 * refuse le reste et purge les lecteurs retires.
 *
 * Lecture : par SAISON et par lecteur, dans l'appel /api/v2/runtimes que la
 * page fait deja (lib/db/episodeRuntimes.ts, `getSeason`). Avant le 02/10/2026
 * la route /api/v2/skip lisait cette table et `oped_skips` a CHAQUE episode
 * ouvert : deux requetes Turso par episode, pour des tables vides.
 */
export { CREATE_SQL };

/**
 * Les generiques d'un episode sur un lecteur :
 * `[opDebut, opFin, edDebut, edFin, pts]`, nul la ou il n'y a rien.
 *
 * `pts` (lignes v2) : les bornes sont dans l'horloge du FICHIER, et `pts` est
 * le PTS du debut du flux. Le lecteur convertit a la lecture (t - initPTS de
 * hls.js, a defaut t - pts) : son heure a lui depend de la variante jouee et du
 * point de reprise (tools/browser-check/frame-truth.mjs). Nul : ligne
 * historique, deja dans l'horloge du lecteur.
 */
export type SeasonSkip = [
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

export const SEASON_SKIPS_SQL = `
SELECT episode, op_start, op_end, ed_start, ed_end, duration, clock_offset
  FROM oped_host_skips
 WHERE mal_id = ? AND lang = ? AND host = ? AND serve = 1`;

/**
 * Au-dela de cet ecart entre la duree contre laquelle une ligne a ete mesuree et
 * celle que les lecteurs rapportent aujourd'hui, la ligne n'est plus servie.
 *
 * Les hotes changent de fichier : le jour ou l'un d'eux reuploade un MONTAGE
 * different, la ligne stockee devient un minutage etranger servi avec pleine
 * confiance (DEVLOG, « 2026-08-07 — Audit OP/ED », §6). 10 s laisse passer le
 * bruit de mesure entre ffprobe et le lecteur et arrete un remplacement.
 *
 * Cette garde etait INERTE dans l'ancienne route (aucun appelant n'envoyait la
 * duree). Ici elle mord : `runtimes` est ce que les lecteurs ont mesure sur ce
 * meme hote, lu dans le meme aller-retour.
 */
const DURATION_TOLERANCE_S = 10;

const num = (v: unknown) => (v == null ? null : Number(v));
const round3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);

/** Lignes de SEASON_SKIPS_SQL -> `{ episode: SeasonSkip }`. */
export function seasonSkipsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  runtimes: Record<number, number>,
): Record<number, SeasonSkip> {
  const out: Record<number, SeasonSkip> = {};
  for (const r of rows) {
    const episode = Number(r.episode);
    const measured = num(r.duration);
    const current = runtimes[episode];
    if (measured && current && Math.abs(measured - current) > DURATION_TOLERANCE_S) {
      console.warn(
        `[skip] ligne perimee ignoree: ep${episode} mesuree sur ${measured}s, lecteur a ${current}s`,
      );
      continue;
    }
    out[episode] = [
      round3(num(r.op_start)),
      round3(num(r.op_end)),
      round3(num(r.ed_start)),
      round3(num(r.ed_end)),
      round3(num(r.clock_offset)),
    ];
  }
  return out;
}
