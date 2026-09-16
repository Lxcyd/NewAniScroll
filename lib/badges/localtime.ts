/**
 * Le calendrier des badges : celui de L'APPAREIL, jamais UTC, jamais le serveur.
 *
 * « Lancer un épisode entre 2 h et 5 h » parle de l'heure que la personne a sous
 * les yeux. Un site rendu depuis une lambda en UTC et lu depuis Paris décale
 * cette fenêtre de deux heures l'été : le badge se donnerait à qui regarde à
 * minuit et se refuserait à qui regarde à 3 h. Tout ce fichier travaille donc
 * sur `new Date(ts)` et ses accesseurs locaux (`getHours`, `getDate`…), qui sont
 * ceux du fuseau du navigateur.
 *
 * `dayKey` et `dayDiff` viennent de lib/stats/streak.ts, qui les importe
 * maintenant d'ici : deux calendriers dans le même site finiraient par diverger,
 * et la série de jours de la page profil doit compter les mêmes jours que le
 * badge « Un mois » qui la récompense.
 *
 * LES EXCEPTIONS SONT LE SUJET DE CE FICHIER, pas un détail de sa mise en œuvre.
 * Chacune est commentée à l'endroit où elle est traitée.
 */

/** Un jour du calendrier local, `YYYY-MM-DD`. */
export function dayKey(d: Date | number = new Date()): string {
  const date = typeof d === "number" ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * L'écart en JOURS CALENDAIRES entre deux `YYYY-MM-DD` (b − a).
 *
 * LE CHANGEMENT D'HEURE. Deux fois par an, un jour local dure 23 h ou 25 h. Un
 * écart calculé en divisant une différence d'epoch par 86 400 000 rend alors
 * 0,96 ou 1,04 jour, et un `=== 1` sur ce résultat casse la série de tout le
 * monde à la même date. On reprojette donc les deux dates civiles sur UTC —
 * `Date.UTC(y, m-1, d)`, où un jour vaut exactement 86 400 000 ms parce qu'UTC
 * ignore l'heure d'été — et on compte l'écart là. Le passage à l'heure d'hiver
 * devient invisible, ce qu'il doit être : personne n'a sauté un jour.
 */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** `dayKey` + n jours, en restant sur le calendrier local. */
export function dayKeyPlus(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  /* Construit en heure LOCALE (pas Date.UTC) : on veut le jour civil suivant du
     point de vue de la personne. `new Date(y, m, d + n)` normalise les
     débordements de mois et d'année tout seul. */
  return dayKey(new Date(y, m - 1, d + n));
}

/**
 * L'HORLOGE FAUSSE, écartée une fois pour toutes.
 *
 * Les horodatages des badges viennent de `localStorage`, donc d'une horloge que
 * personne ne contrôle. Une machine réglée en 2031 déposerait des `updatedAt`
 * dans le futur ; une fois l'horloge remise à l'heure, ces lignes resteraient
 * « demain » pour toujours et fabriqueraient des séries de jours imaginaires.
 *
 * Un horodatage postérieur à maintenant est donc IGNORÉ, pas ramené à
 * maintenant : le ramener inventerait un visionnage à cette seconde-là. On tolère
 * une marge d'une minute, parce qu'un écart de quelques secondes entre l'horloge
 * qui a écrit et celle qui lit est banal et n'est pas une fraude.
 *
 * La borne basse écarte 0, `null` coercé, et les epoch en secondes qu'un store
 * plus ancien aurait pu déposer (2001-09-09 en ms, soit avant l'existence du
 * site : aucune donnée légitime ne tombe avant).
 */
const CLOCK_SKEW_MS = 60_000;
const EPOCH_FLOOR = 1_000_000_000_000; // 2001-09-09

export function sane(ts: unknown, now = Date.now()): number | null {
  const t = Number(ts);
  if (!Number.isFinite(t)) return null;
  if (t < EPOCH_FLOOR) return null;
  if (t > now + CLOCK_SKEW_MS) return null;
  return t;
}

/** L'heure locale (0-23) d'un horodatage. */
export function hourOf(ts: number): number {
  return new Date(ts).getHours();
}

/** La minute locale (0-59). */
export function minuteOf(ts: number): number {
  return new Date(ts).getMinutes();
}

/**
 * MINUIT PILE, à la minute et non à la seconde.
 *
 * « Lancer un épisode à 00 h 00 pile » à la seconde exacte est hors de portée :
 * la sauvegarde de position est throttlée à 3 s dans le lecteur, si bien que
 * l'horodatage qu'on lit n'est jamais celui du geste mais celui du tick suivant.
 * Un badge inatteignable n'est pas un badge difficile, c'est un badge cassé. La
 * minute 00:00 est la fenêtre que le libellé promet en pratique.
 */
export function isMidnightSharp(ts: number): boolean {
  const d = new Date(ts);
  return d.getHours() === 0 && d.getMinutes() === 0;
}

/**
 * Une plage d'heures locales, bornes incluses côté début, exclues côté fin.
 *
 * LA FENÊTRE PEUT TRAVERSER MINUIT, et c'est le cas normal pour un site d'anime :
 * « entre 23 h et 2 h » est une soirée, pas une erreur de saisie. Quand `from >
 * to` on teste donc l'union des deux morceaux au lieu de l'intervalle vide qu'un
 * `h >= from && h < to` naïf produirait.
 *
 * On compare des HEURES, pas des instants : la fenêtre n'appartient à aucune
 * date, donc la question « quel jour ? » ne se pose jamais et le passage de
 * minuit ne scinde rien.
 */
export function inHourWindow(ts: number, from: number, to: number): boolean {
  const h = hourOf(ts);
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** Le mois (1-12) et le jour du mois, en local — « le 31 octobre ». */
export function monthDay(ts: number): { month: number; day: number } {
  const d = new Date(ts);
  return { month: d.getMonth() + 1, day: d.getDate() };
}

/** Samedi ou dimanche, au sens du calendrier local. */
export function isWeekend(ts: number): boolean {
  const wd = new Date(ts).getDay();
  return wd === 0 || wd === 6;
}

/**
 * LA NUIT N'EST PAS UN JOUR : la grappe d'activité, et pourquoi elle existe.
 *
 * « 12 épisodes dans la même nuit » se joue à cheval sur minuit — commencer à
 * 23 h et finir à 3 h est UNE nuit et deux dates. Compter par `dayKey`
 * couperait la séance en deux et ne donnerait jamais le badge à qui le mérite
 * le plus franchement.
 *
 * On regroupe donc les horodatages en GRAPPES : deux visionnages appartiennent
 * à la même séance si moins de `gapMs` les sépare. Le trou par défaut est de
 * 2 h — assez pour une pause repas ou un épisode qu'on relance, trop court pour
 * relier la soirée de mardi à celle de mercredi.
 *
 * Rend les grappes dans l'ordre, chacune avec ses horodatages triés : de quoi
 * mesurer aussi bien « 12 d'un trait » (taille) que « 6 h d'affilée » (durée).
 */
export function clusters(stamps: number[], gapMs = 2 * 3_600_000): number[][] {
  const sorted = [...stamps].sort((a, b) => a - b);
  const out: number[][] = [];
  let run: number[] = [];
  for (const t of sorted) {
    if (run.length && t - run[run.length - 1] > gapMs) {
      out.push(run);
      run = [];
    }
    run.push(t);
  }
  if (run.length) out.push(run);
  return out;
}

/**
 * La plus longue série de jours consécutifs présente dans un ensemble de jours.
 *
 * Prend des `dayKey` et non des horodatages : c'est ce qui rend la fonction
 * insensible au changement d'heure (cf. `dayDiff`) et au fuseau dans lequel la
 * série a été constituée. Un utilisateur qui déménage d'un continent à l'autre
 * ne perd pas sa série — au pire il gagne un jour à la charnière, ce qui est le
 * bon sens du doute pour une récompense.
 */
export function longestRun(days: Iterable<string>): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev && dayDiff(prev, d) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/**
 * La série qui court MAINTENANT, telle qu'on l'affiche.
 *
 * Une série n'est vivante que si le dernier jour compté est aujourd'hui ou hier
 * — hier parce que la journée n'est pas finie et qu'on ne casse pas une série à
 * 00 h 01. Même règle que `liveStreak` de lib/stats/streak.ts, appliquée ici à
 * l'ensemble des jours plutôt qu'au compteur mémorisé, pour que le badge puisse
 * être recalculé de zéro à partir des seuls horodatages.
 */
export function currentRun(days: Iterable<string>, today = dayKey()): number {
  const set = new Set(days);
  if (!set.size) return 0;
  let cursor = set.has(today) ? today : dayKeyPlus(today, -1);
  if (!set.has(cursor)) return 0;
  let n = 0;
  while (set.has(cursor)) {
    n += 1;
    cursor = dayKeyPlus(cursor, -1);
  }
  return n;
}

/**
 * Combien d'horodatages tombent dans la meilleure fenêtre glissante de `ms`.
 *
 * « 20 épisodes vus en 24 h » et « 50 en 7 jours » sont des fenêtres GLISSANTES,
 * pas des cases du calendrier : 10 épisodes le lundi soir et 10 le mardi matin
 * font bien vingt épisodes en vingt-quatre heures, alors qu'aucun des deux jours
 * civils n'en compte vingt. Compter par `dayKey` refuserait le badge à un
 * marathon qui traverse minuit — exactement la façon dont on regarde.
 */
export function bestWindow(stamps: number[], ms: number): number {
  const sorted = [...stamps].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > ms) lo += 1;
    const n = hi - lo + 1;
    if (n > best) best = n;
  }
  return best;
}
