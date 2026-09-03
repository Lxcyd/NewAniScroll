import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractSeasonFromTitle } from "@/components/anime/v2/helpers";
import { readHistory, watchHref } from "@/lib/profile/history";
import { decorateRows, type ActivityRow } from "@/lib/profile/activity";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import type { ProfileTitle } from "@/lib/profile/types";
import { readProgressMap, PROGRESS_EVENT } from "@/lib/watch/progress";
import { Bar, EmptyBlock, useAgo } from "./common";

/**
 * Les deux widgets d'activité de lecture.
 *
 * DEUX SOURCES, ET LA BONNE SE CHOISIT PAR `rows`.
 *
 * Sans `rows`, ils lisent le localStorage de CET appareil, au montage et jamais
 * au rendu serveur : localStorage n'existe pas là-bas, et un premier rendu qui
 * invente des lignes puis les remplace est exactement le clignotement qu'on
 * évite ailleurs. D'où `loaded`, et un bloc vide — pas un état vide — tant
 * qu'on ne sait pas. C'est le cas du propriétaire chez lui, où la lecture en
 * cours doit se mettre à jour vivante (PROGRESS_EVENT), et celui du profil
 * local d'un invité, qui n'a pas de compte.
 *
 * Avec `rows`, ils affichent ce que le rendu serveur a reconstruit depuis la
 * sauvegarde de compte du PROPRIÉTAIRE (lib/profile/activity.ts). C'est ce qui
 * permet enfin de les montrer à un visiteur : jusqu'ici ils lui auraient servi
 * sa propre lecture sous le nom d'un autre.
 */

function useHistory(limit: number): { rows: ActivityRow[]; loaded: boolean } {
  const [state, setState] = useState<{ rows: ActivityRow[]; loaded: boolean }>({
    rows: [],
    loaded: false,
  });
  useEffect(() => {
    const read = () =>
      setState({
        rows: decorateRows(readHistory(limit), readProgressMap()),
        loaded: true,
      });
    read();
    window.addEventListener(PROGRESS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PROGRESS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [limit]);
  return state;
}

/** Les lignes servies s'il y en a, sinon celles de l'appareil. */
function useRows(served: ActivityRow[] | undefined, limit: number) {
  const local = useHistory(limit);
  return served ? { rows: served, loaded: true } : local;
}

/**
 * Le numéro de saison d'une entrée, comme la fiche l'affiche.
 *
 * D'ABORD LE TITRE, ENSUITE LE RÉSEAU. `extractSeasonFromTitle` est pure et
 * gratuite ; elle suffit pour « Vinland Saga Season 2 ». Elle ne peut rien pour
 * « Kimetsu no Yaiba: Yuukaku-hen », dont le nom ne porte aucun numéro — et
 * c'est justement le cas courant, puisque beaucoup de franchises nomment leurs
 * saisons par leur arc.
 *
 * Le numéro vient alors de /api/v2/seasons/[id], la MÊME source que le sélecteur
 * de saison du lecteur et que le « · S3 » de la fiche — donc le même numéro,
 * ce qui est tout l'intérêt : deux comptages différents du même anime sur deux
 * écrans du site seraient pires que pas de numéro du tout. La réponse est en
 * cache d'edge pour une journée et ne coûte pas de commande Upstash.
 *
 * Comme la fiche (cf. Hero.tsx), le numéro ne s'affiche que si la franchise a
 * PLUSIEURS saisons : « Saison 1 » sur une œuvre unique n'apprend rien.
 */
function useSeasonNumber(aniId: number | null, title: string | null): number | null {
  const fromTitle = title ? extractSeasonFromTitle({ romaji: title }) : null;
  const [fetched, setFetched] = useState<number | null>(null);

  useEffect(() => {
    setFetched(null);
    if (!aniId || fromTitle != null) return;
    let cancelled = false;
    fetch(`/api/v2/seasons/${aniId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (cancelled || !Array.isArray(list) || list.length < 2) return;
        const mine = list.find((s) => Number(s?.id) === aniId);
        if (mine?.number > 0) setFetched(Number(mine.number));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [aniId, fromTitle]);

  return fromTitle ?? fetched;
}

export type ActivityProps = {
  /** L'activité du propriétaire, venue du rendu serveur. Absent : cet appareil. */
  rows?: ActivityRow[];
  /** Les textes qui tutoient le lecteur ne valent pas sur le profil d'un autre. */
  other?: boolean;
  /**
   * LES VARIANTES DE TITRE, par `mediaId`, pour suivre la préférence du site.
   *
   * L'historique du lecteur n'enregistre qu'UNE chaîne (`aniTitle`) : celle qui
   * s'affichait au moment de la lecture. Elle ne peut donc pas suivre le réglage
   * « romaji / anglais » — l'anime restait écrit dans la langue d'alors, seul
   * endroit du site à ne pas obéir au réglage.
   *
   * Les variantes existent pourtant déjà à côté, dans la liste du profil. On les
   * passe en table plutôt que d'aller les redemander au réseau : c'est gratuit,
   * et ça ne dépend pas d'AniList au moment du rendu.
   *
   * Absent, ou anime hors liste (un titre regardé sans être ajouté) : on retombe
   * sur la chaîne de l'historique, qui vaut toujours mieux qu'un numéro.
   */
  titles?: Map<number, ProfileTitle | null>;
};

/**
 * LES VARIANTES D'UN ANIME QUI N'EST PAS DANS LA LISTE.
 *
 * La table venue du profil couvre presque tout : on regarde généralement ce
 * qu'on a ajouté. Presque. Un titre essayé sans être ajouté n'y figure pas, et
 * il restait alors écrit dans la langue de l'historique — d'où deux titres en
 * deux langues sur la même carte, ce qui se lit comme un bug et en est un.
 *
 * `/api/v2/media/[id]` porte les quatre variantes. Il est SANS SESSION donc
 * partagé par le cache d'edge, et il est servi par le cache à trois étages
 * (mémoire → AniList → Turso) : il répond même quand AniList est coupé.
 *
 * DEUX BORNES, parce que la réponse est grosse (~30 ko) pour un titre :
 *   — on n'appelle QUE pour les lignes que la liste ne résout pas ;
 *   — le résultat est gardé pour la session, donc une même ligne ne le
 *     redemande pas à chaque rendu, ni deux widgets pour le même anime.
 *
 * Si un jour l'appel se voit, la vraie économie est ailleurs : le lecteur a
 * l'objet `title` complet sous la main quand il écrit l'historique, et n'en
 * garde qu'une chaîne. L'y écrire rendrait ce détour inutile — pour les
 * lectures à venir seulement, d'où ce repli qui, lui, vaut aussi pour le passé.
 */
const remoteTitles = new Map<number, ProfileTitle | null>();

function useRemoteTitle(aniId: number, needed: boolean): ProfileTitle | null {
  const [found, setFound] = useState<ProfileTitle | null>(
    () => remoteTitles.get(aniId) ?? null,
  );

  useEffect(() => {
    if (!needed || !aniId || remoteTitles.has(aniId)) return;
    let cancelled = false;
    fetch(`/api/v2/media/${aniId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((media) => {
        const title = (media?.title ?? null) as ProfileTitle | null;
        // Mémorisé même quand c'est `null` : un anime sans titre connu ne doit
        // pas être redemandé à chaque montage de la ligne.
        remoteTitles.set(aniId, title);
        if (!cancelled && title) setFound(title);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [aniId, needed]);

  return found;
}

/** Le titre d'une ligne, dans la langue réglée quand on la connaît. */
function useRowTitle(titles: ActivityProps["titles"]) {
  const pref = useTitlePref();
  return (row: { aniId: number; animeTitle: string | null }, remote?: ProfileTitle | null) => {
    const known = titles?.get(row.aniId) ?? remote;
    if (known) return pickTitle(known, pref);
    return row.animeTitle || `#${row.aniId}`;
  };
}

/* ── Reprendre la lecture ────────────────────────────────────────────── */

export function ResumeBlock({
  rows: served,
  other,
  titles,
  /* Réglable depuis la roue dentée du bloc, en mode réorganisation (cf.
     lib/profile/blocks.ts). Allumée par défaut. */
  ambient = true,
}: ActivityProps & { ambient?: boolean } = {}) {
  const { t } = useTranslation();
  const rowTitle = useRowTitle(titles);
  const { rows, loaded } = useRows(served, 12);

  /* Le dernier épisode COMMENCÉ mais pas fini. Proposer de « reprendre » un
     épisode terminé enverrait au générique de fin ; l'épisode suivant serait la
     bonne suite, et c'est une autre question (on ne sait pas ici s'il existe). */
  const row = rows.find((r) => !r.done && r.pct > 0);
  /* Avant les sorties anticipées : un hook ne se saute pas. */
  const season = useSeasonNumber(row?.aniId ?? null, row?.animeTitle ?? null);
  /* Même repli que la liste voisine : un anime absent de la liste n'a pas de
     variantes, et resterait écrit dans la langue de l'historique. */
  const remoteTitle = useRemoteTitle(
    row?.aniId ?? 0,
    !!row && !titles?.get(row.aniId),
  );

  if (!loaded) return <div className="h-full" />;
  if (!row)
    return (
      <EmptyBlock
        note={t(other ? "profile.blocks.resume.emptyOther" : "profile.blocks.resume.empty")}
      />
    );

  const art = row.image || row.cover;
  const href = watchHref(row);

  /* LE BLOC TIENT DE 1×2 À 2×4 (hauteur × largeur, cf. lib/profile/blocks.ts),
     donc rien ici n'est en pixels fixes. La vignette tire sa largeur de la
     hauteur offerte (16/9), plafonnée pour ne pas manger la colonne de texte ;
     le titre va jusqu'à TROIS lignes au lieu d'être coupé — dans la plus petite
     taille c'est le cas courant, et un titre tronqué n'est pas reconnaissable. */
  return (
    <div className="flex h-full min-w-0 items-center gap-4">
      <div className="relative aspect-video h-full w-auto max-w-[48%] shrink-0">
        {/* LA LUMIÈRE D'AMBIANCE.
            Même principe que le lecteur et que la carte de survol (cf.
            TrailerAmbient) : des copies concentriques de la vignette, chacune
            plus large et beaucoup plus pâle, floutées EN UN SEUL passage sur la
            pile — un flou par calque coûterait quatre fois plus au compositeur
            pour la même image (le flou et la multiplication d'opacité sont tous
            deux linéaires).

            LE PAS EST GROS, ET C'EST LE POINT. Une première version montait de
            6 % par calque : à cette échelle, TOUT le halo tombait derrière la
            vignette, qui est opaque, et il n'en dépassait que la frange du flou
            — « à peine visible, on dirait qu'elle n'est pas là ». Ce qui éclaire
            n'est pas le flou, c'est la surface de lumière qui SORT de la
            vignette : à 18 % de pas, le calque le plus large déborde de ~55 px
            de chaque côté, largement de quoi remplir le padding de la carte et
            border la colonne de texte.

            La carte, elle, coupe à son bord (`overflow-hidden`) — c'est ce qui
            empêche la lueur d'aller trop loin et de baigner les widgets
            voisins. */}
        {art && ambient ? (
          <div
            className="pointer-events-none absolute inset-0"
            aria-hidden
            /* Tamisée : le halo doit se deviner derrière la vignette, pas
               éclairer la carte. C'est l'OPACITÉ qui a baissé (0.9 → 0.55) et
               pas la portée — l'étalement à 18 % de pas est ce qui la rend
               visible, le baisser la ferait à nouveau disparaître sous la
               vignette. */
            style={{ filter: "blur(34px) saturate(1.6)" }}
          >
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="absolute inset-0"
                style={{ transform: `scale(${1 + i * 0.18})`, opacity: 0.55 * Math.pow(0.6, i) }}
              >
                {/* Même src et même `sizes` que la vignette : c'est la même URL
                    optimisée, donc le cache du navigateur, pas un téléchargement
                    de plus par calque. */}
                <Image src={art} alt="" fill sizes="320px" className="object-cover" />
              </div>
            ))}
          </div>
        ) : null}

        <Link
          href={href}
          className="group absolute inset-0 overflow-hidden rounded-2xl bg-as-card"
        >
          {art ? <Image src={art} alt="" fill sizes="320px" className="object-cover" /> : null}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="as-widget-play flex h-11 w-11 items-center justify-center rounded-full bg-action shadow-glow transition-transform duration-200 group-hover:scale-110">
              {/* LE TRIANGLE DU LECTEUR, au trait près : celui du bouton de
                  démarrage d'UniversalPlayer et de la vignette de l'épisode en
                  cours. Coins arrondis, et surtout centré par son CENTRE DE
                  GRAVITÉ — un triangle dont la boîte est centrée paraît poussé à
                  gauche, son aire étant massée du côté de l'arête arrière. D'où
                  le `translate(1.8 0)`, qui vient du même dessin et n'est pas à
                  recalculer ici (cf. UniversalPlayer.tsx). */}
              <svg viewBox="0 0 20 20" fill="#fff" className="h-5 w-5">
                <g transform="translate(1.8 0)">
                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                </g>
              </svg>
            </span>
          </span>
          <span className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
            <span className="block h-full bg-action" style={{ width: `${row.pct}%` }} />
          </span>
        </Link>
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <Link href={href} className="min-w-0">
          <h3 className="as-widget-lead line-clamp-3 font-outfit text-lg font-bold leading-snug text-white transition-colors hover:text-action">
            {rowTitle(row, remoteTitle)}
          </h3>
        </Link>
        <p className="as-widget-sub mt-1.5 line-clamp-1 font-karla text-[13px] text-white/50">
          {season != null
            ? t("profile.blocks.resume.seasonEp", { season, episode: row.episode })
            : t("profile.blocks.resume.ep", { episode: row.episode })}
        </p>

        {/* LA PAIRE DE BOUTONS DU HERO D'ACCUEIL, en plus petit : même pilule
            pleine à gauche, même pilule translucide bordée à droite, même
            glyphe « info » plein. Le `outline-none focus-visible:outline-none`
            en vient aussi, et il n'est pas décoratif : sans lui, le contour de
            focus bleu du navigateur cerne la pilule dès qu'on l'active à la
            souris.
            Le libellé, lui, ne vient PAS de `anime.moreInfoCta` : le hero écrit
            ses deux boutons en capitales, et cette paire-ci se lit à côté de
            « Reprendre ».
            `h-9` sur les deux : sans hauteur commune, l'icône de gauche fait
            grandir la seule pilule qui en porte une, et les deux boutons ne
            s'alignent plus. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            href={href}
            className="as-widget-btn inline-flex h-9 items-center gap-2 rounded-full bg-action px-4 font-outfit text-xs font-bold leading-none tracking-wide text-white shadow-glow outline-none transition-transform hover:scale-105 focus:outline-none focus-visible:outline-none"
          >
            {t(other ? "profile.blocks.resume.ctaOther" : "profile.blocks.resume.cta")}
          </Link>
          {/* La fiche, à côté de « reprendre » : le bloc envoie sinon toujours au
              même endroit, et « c'est quoi déjà ? » n'a pas de réponse sans
              quitter le profil. */}
          <Link
            /* La FICHE, pas `animeHref` : avec la préférence « clic = lecture »
               ce dernier renverrait vers un épisode, c'est-à-dire là où mène
               déjà tout le reste du bloc. */
            href={`/en/anime/${row.aniId}`}
            className="as-widget-btn inline-flex h-9 items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-4 font-outfit text-xs font-bold leading-none tracking-wide text-white outline-none backdrop-blur-sm transition-colors hover:bg-white/20 focus:outline-none focus-visible:outline-none"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5 shrink-0">
              <path d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z" />
            </svg>
            {t("profile.blocks.resume.info")}
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ── Vu récemment ────────────────────────────────────────────────────── */

export function RecentsBlock({ rows: served, other, titles }: ActivityProps = {}) {
  const { t } = useTranslation();
  const ago = useAgo();
  const rowTitle = useRowTitle(titles);
  const { rows, loaded } = useRows(served, 12);

  if (!loaded) return <div className="h-full" />;
  if (!rows.length)
    return (
      <EmptyBlock
        note={t(other ? "profile.blocks.recents.emptyOther" : "profile.blocks.recents.empty")}
      />
    );

  return (
    <div className="grid h-full content-start gap-2 overflow-y-auto pr-1">
      {rows.map((r) => (
        <RecentRow
          key={`${r.aniId}:${r.episode}`}
          row={r}
          ago={ago}
          t={t}
          known={titles?.get(r.aniId) ?? null}
          rowTitle={rowTitle}
        />
      ))}
    </div>
  );
}

/**
 * UNE LIGNE DE L'HISTORIQUE, et pourquoi c'est un composant à part.
 *
 * Le numéro de saison peut demander un appel réseau (`useSeasonNumber`), donc un
 * hook — et un hook ne s'appelle pas dans un `map`. Chaque ligne est donc son
 * propre composant, ce qui lui donne au passage son propre cycle de vie : une
 * saison qui arrive ne rerend que sa ligne.
 *
 * CE QUE LA LIGNE DIT, dans cet ordre :
 *   1. l'anime ;
 *   2. « Saison 2 · Épisodes 1–6 » — la saison quand la franchise en a
 *      plusieurs, et la SÉRIE consécutive qu'on vient d'enchaîner plutôt que le
 *      seul dernier épisode (cf. `runFrom`) ;
 *   3. le titre du DERNIER épisode vu, celui sur lequel la série s'arrête ;
 *   4. quand, et où on en est — « il y a 2 jours · 8 min restantes ».
 *
 * La barre reprend l'avancement du dernier épisode : c'est celui qu'on
 * reprendrait en cliquant, donc celui dont l'avancement veut dire quelque chose.
 */
function RecentRow({
  row: r,
  ago,
  t,
  known,
  rowTitle,
}: {
  row: ActivityRow;
  ago: (at: number) => string;
  t: (key: string, opts?: Record<string, unknown>) => string;
  /** Les variantes que la liste du profil connaît déjà, `null` sinon. */
  known: ProfileTitle | null;
  rowTitle: (
    row: { aniId: number; animeTitle: string | null },
    remote?: ProfileTitle | null,
  ) => string;
}) {
  /* Le réseau n'est sollicité que pour ce que la liste ne résout pas. */
  const remote = useRemoteTitle(r.aniId, !known);
  const title = rowTitle(r, remote);
  /* La saison se cherche sur le titre DE L'HISTORIQUE et pas sur celui qu'on
     affiche : `extractSeasonFromTitle` lit « Season 2 » ou « 2nd Season », des
     tournures qui vivent dans le romaji d'AniList. Un titre anglais traduit peut
     ne plus les porter, et on perdrait la saison en changeant de langue. */
  const season = useSeasonNumber(r.aniId, r.animeTitle);
  const art = r.image || r.cover;
  const range = r.runFrom < r.episode;
  const where = season != null
    ? range
      ? t("profile.blocks.recents.seasonEpRange", {
          season,
          from: r.runFrom,
          to: r.episode,
        })
      : t("profile.blocks.recents.seasonEp", { season, episode: r.episode })
    : range
      ? t("profile.blocks.recents.epRange", { from: r.runFrom, to: r.episode })
      : t("profile.blocks.recents.ep", { episode: r.episode });

  /* « Terminé » l'emporte sur les minutes restantes : à la fin d'un épisode il
     en reste zéro, et « 0 min restantes » est une façon inutilement laborieuse
     de dire qu'on l'a fini. */
  const state = r.done
    ? t("profile.blocks.recents.done")
    : r.minutesLeft != null && r.minutesLeft > 0
      ? t("profile.blocks.recents.left", { minutes: r.minutesLeft })
      : null;

  return (
    <Link
      href={watchHref(r)}
      className="flex items-center gap-3.5 rounded-2xl bg-white/[0.03] p-2 ring-1 ring-white/[0.06] transition-colors hover:bg-action/10 hover:ring-action/30"
    >
      <div className="relative h-[66px] w-[118px] shrink-0 overflow-hidden rounded-xl bg-as-card">
        {art ? <Image src={art} alt="" fill sizes="160px" className="object-cover" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-white">{title}</p>
        <p className="mt-0.5 truncate font-karla text-xs text-white/70">{where}</p>
        {/* PAS DE TITRE D'ÉPISODE. Il a été essayé et retiré : il n'est pas
            traduit — il arrive de la source de lecture, en anglais, quel que
            soit le réglage de langue — et sur une ligne qui nomme déjà l'anime,
            la saison et les épisodes, il ajoutait une quatrième ligne pour un
            renseignement qu'on ne cherche pas dans un historique. */}
        <p className="mt-0.5 font-karla text-[11px] text-white/35">
          {r.at ? ago(r.at) : "—"}
          {state ? ` · ${state}` : ""}
        </p>
        <span className="mt-1.5 block">
          <Bar pct={r.done ? 100 : r.pct} />
        </span>
      </div>
    </Link>
  );
}
