/**
 * Où en est un badge : (courant, objectif), ou `null`.
 *
 * Un COUPLE et non un booléen, parce que l'onglet montre une barre : c'est lui
 * qui permet d'écrire « 9 / 10 » sur le badge des dix épisodes, et de choisir
 * quel palier d'une échelle afficher.
 *
 * ── LE CONTRAT DU `null` ─────────────────────────────────────────────────────
 * `null` veut dire « on ne peut pas encore le savoir », et jamais « zéro ». Il
 * sort quand la donnée nécessaire n'est pas là : la liste ne porte pas encore
 * les genres, le vocabulaire du catalogue n'a pas été récupéré, les favoris
 * vivent sur un compte AniList qui n'est pas lié. L'interface affiche alors
 * « pas encore mesurable » au lieu d'une barre à 0 %, parce qu'une barre à 0 %
 * est un CHIFFRE FAUX : elle dit « tu n'en as aucun » là où la vérité est
 * « je ne sais pas ». C'est la règle posée en tête de lib/profile/insights.ts
 * et de lib/profile/blocks.ts, appliquée aux badges.
 *
 * ── CE QUE `measure` NE FAIT PAS ─────────────────────────────────────────────
 * Elle ne dit pas si le badge est OBTENU. Un badge obtenu le reste même si son
 * compteur redescend (cf. l'invariant 1 de store.ts) : c'est l'état persisté
 * qui fait foi, et `measure` ne sert qu'à la progression de ce qui ne l'est pas
 * encore.
 */

import type { BadgeDef } from "./catalog";
import { WORKS } from "./works";
import type { Derived } from "./derive";
import type { BadgeState } from "./store";

/** (courant, objectif). `null` = pas mesurable pour l'instant. */
export type Progress = [number, number] | null;

/** Un fait binaire : 1 si vrai, 0 sinon, sur un objectif de 1. */
const bool = (v: boolean): Progress => [v ? 1 : 0, 1];
/** Une mesure qui peut être indisponible. */
const maybe = (v: number | null, n: number): Progress => (v == null ? null : [v, n]);

export function measure(def: BadgeDef, d: Derived, state: BadgeState): Progress {
  const m = def.metric;
  const n = m.n;

  switch (m.k) {
    /* ── Compteurs ─────────────────────────────────────────────────────────── */
    case "count":
      switch (m.of) {
        case "episodes": return [d.episodes, n];
        /* Les minutes sont ARRONDIES VERS LE BAS : afficher « 600 / 600 » sur un
           badge non obtenu parce qu'il manque quatre secondes serait pire que
           d'afficher 599. */
        case "minutes": return [Math.floor(d.minutes), n];
        case "completed": return [d.completedCount, n];
        case "streak": return [d.streak, n];
        case "rated": return [d.rated, n];
        case "rewatched": return [d.rewatched, n];
        case "favourites": return maybe(d.favourites, n);
        /* « Obtenir 50 badges » se compte sur les badges NON SECRETS : les
           secrets ont leur propre compteur, et ils sont annoncés « hors total »
           dans le catalogue. Les faire compter ici contredirait cette promesse. */
        case "badges": return [countGot(state, d, false), n];
        default: return null;
      }

    /* ── Gestes ────────────────────────────────────────────────────────────── */
    case "flag": return bool(d.facts.flags[String(m.name)] != null);
    case "counter": return [d.facts.counters[String(m.name)]?.n ?? 0, n];

    /* ── Rythme de visionnage ──────────────────────────────────────────────── */
    case "window":
      return [m.ms === 86_400_000 ? d.best24h : d.best7d, n];
    case "night": return [d.biggestNight, n];
    case "session":
      return [
        Math.floor(m.weekend ? d.longestWeekendSession : d.longestSession),
        n,
      ];

    /* ── Heure locale ──────────────────────────────────────────────────────── */
    case "hourWindow": return bool(d.inHours(Number(m.from), Number(m.to)));
    case "midnight": return bool(d.midnight);
    case "onDate": {
      const ids = d.animeOnDate(Number(m.month), Number(m.day));
      if (!ids.length) return [0, 1];
      /* Le badge demande un anime D'UN GENRE ce jour-là. Sans les genres on ne
         peut pas trancher : plutôt que de l'accorder à tort (n'importe quel
         anime le 31 octobre), on dit qu'on ne sait pas. */
      const genre = m.genre ? String(m.genre) : null;
      if (!genre) return bool(true);
      const hits = d.completed.filter(
        (e) => ids.includes(e.mediaId) && e.genres?.includes(genre),
      );
      if (hits.length) return bool(true);
      const known = d.completed.some((e) => ids.includes(e.mediaId) && e.genres?.length);
      return known ? [0, 1] : null;
    }

    /* ── Métadonnées d'œuvre ───────────────────────────────────────────────── */
    case "genre": return maybe(d.genre(String(m.name)), n);
    case "tag": return maybe(d.tag(String(m.name)), n);
    case "format": return maybe(d.format(String(m.name)), n);
    case "yearBefore": return maybe(d.before(Number(m.year)), n);
    case "decades": return maybe(d.decades(Number(m.from)), n);
    case "studio": return maybe(d.topStudio, n);
    case "studioNamed": return maybe(d.studioNamed(String(m.name)), n);
    case "popularityUnder": return maybe(d.underPopularity(Number(m.max)), n);
    case "alphabet": return [d.initials, n];
    case "titleLength": return bool(d.longestTitle > Number(m.min));
    case "franchise": return maybe(d.franchiseOf(Number(m.seasons)), n);

    /* ── Cibles qui dépendent des données ──────────────────────────────────── */
    case "allGenres":
      return d.genresCovered == null || !d.vocabGenres
        ? null
        : [d.genresCovered, d.vocabGenres];
    case "allTags":
      return d.tagsCovered == null || !d.vocabTags ? null : [d.tagsCovered, d.vocabTags];
    case "hosts":
      /* La cible est le nombre de lecteurs que le site PROPOSE aujourd'hui
         (lib/hostRegistry.js). Elle bouge quand un lecteur meurt ou renaît, et
         c'est voulu : « tous les lecteurs » veut dire tous ceux qui existent,
         pas une liste figée dans le catalogue. */
      return d.hostsTotal ? [d.hostsUsed, d.hostsTotal] : null;

    /* ── Œuvres nommées ────────────────────────────────────────────────────── */
    case "works": {
      const w = WORKS[String(m.key)];
      if (!w) return null;
      const done = w.ids.filter((id) => d.completedIds.has(id)).length;
      return w.mode === "any" ? [Math.min(done, 1), 1] : [done, w.ids.length];
    }
    case "worksEpisodes": {
      const w = WORKS[String(m.key)];
      if (!w) return null;
      let seen = 0;
      for (const id of w.ids) seen += d.perAnime.get(id)?.size ?? 0;
      return [seen, n];
    }

    /* ── Faits composés ────────────────────────────────────────────────────── */
    case "neverSkipOp": return bool(d.neverSkippedOp);
    case "repeatSame":
      /* AniList compte les RE-visionnages : terminer trois fois, c'est `repeat`
         à deux. Compter `repeat >= 3` donnerait le badge au quatrième tour. */
      return [Math.min(d.mostRepeats + 1, Number(m.times)), Number(m.times)];
    case "accountAge": return maybe(d.accountAgeDays, n);

    /* ── La collection se regarde elle-même ────────────────────────────────── */
    case "rarityCount":
      return [countGot(state, d, null, String(m.rarity)), n];
    case "secretCount":
      return [countGot(state, d, true), n];
    case "allBadges": {
      /* « Tous les AUTRES badges » : la cible s'exclut elle-même, sinon elle
         serait inatteignable — il faudrait l'avoir pour l'obtenir. Les secrets
         n'en font pas partie, ils sont hors total. */
      const target = d.mainCount - 1;
      return target > 0 ? [countGot(state, d, false), target] : null;
    }

    /* ── Accordés de l'extérieur ───────────────────────────────────────────── */
    case "granted":
      /* Équipe, bêta : ils ne se mesurent pas, ils se donnent. Leur progression
         n'est donc pas « 0 / 1 » mais « on ne peut pas savoir ». */
      return null;

    default:
      return null;
  }
}

/**
 * Combien de badges obtenus, filtrés par secret et/ou par rareté.
 *
 * `secret` : `true` = seulement les secrets, `false` = seulement les autres,
 * `null` = les deux.
 */
function countGot(
  state: BadgeState,
  d: Derived,
  secret: boolean | null,
  rarity?: string,
): number {
  let n = 0;
  for (const id of Object.keys(state.got)) {
    const def = d.defs[id];
    if (!def) continue;
    if (secret !== null && !!def.secret !== secret) continue;
    if (rarity && def.rarity !== rarity) continue;
    n += 1;
  }
  return n;
}
