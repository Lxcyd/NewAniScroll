import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractSeasonFromTitle } from "@/components/anime/v2/helpers";
import { readHistory, watchHref } from "@/lib/profile/history";
import { decorateRows, type ActivityRow } from "@/lib/profile/activity";
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
};

/* ── Reprendre la lecture ────────────────────────────────────────────── */

export function ResumeBlock({ rows: served, other }: ActivityProps = {}) {
  const { t } = useTranslation();
  const { rows, loaded } = useRows(served, 12);

  /* Le dernier épisode COMMENCÉ mais pas fini. Proposer de « reprendre » un
     épisode terminé enverrait au générique de fin ; l'épisode suivant serait la
     bonne suite, et c'est une autre question (on ne sait pas ici s'il existe). */
  const row = rows.find((r) => !r.done && r.pct > 0);
  /* Avant les sorties anticipées : un hook ne se saute pas. */
  const season = useSeasonNumber(row?.aniId ?? null, row?.animeTitle ?? null);

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
        {/* LA LUMIÈRE D'AMBIANCE, en petit.
            Même principe que le lecteur et que la carte de survol (cf.
            TrailerAmbient) : des copies concentriques de la vignette, chacune un
            peu plus large et beaucoup plus pâle, floutées EN UN SEUL passage sur
            la pile — un flou par calque coûterait trois fois plus au compositeur
            pour la même image (le flou et la multiplication d'opacité sont tous
            deux linéaires).
            Elle est volontairement COURTE : trois calques et 6 % de pas, là où le
            lecteur en empile cinq. Le bloc voisine avec du texte et d'autres
            widgets ; une lueur qui porte loin les baignerait au lieu d'éclairer
            la vignette. */}
        {art ? (
          <div
            className="pointer-events-none absolute inset-0"
            aria-hidden
            style={{ filter: "blur(26px) saturate(1.7)" }}
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="absolute inset-0"
                style={{ transform: `scale(${1 + i * 0.06})`, opacity: 0.5 * Math.pow(0.6, i) }}
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
            {row.animeTitle || `#${row.aniId}`}
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

export function RecentsBlock({ rows: served, other }: ActivityProps = {}) {
  const { t } = useTranslation();
  const ago = useAgo();
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
      {rows.map((r) => {
        const art = r.image || r.cover;
        return (
          <Link
            key={`${r.aniId}:${r.episode}`}
            href={watchHref(r)}
            className="flex items-center gap-3.5 rounded-2xl bg-white/[0.03] p-2 ring-1 ring-white/[0.06] transition-colors hover:bg-action/10 hover:ring-action/30"
          >
            <div className="relative h-[66px] w-[118px] shrink-0 overflow-hidden rounded-xl bg-as-card">
              {art ? <Image src={art} alt="" fill sizes="160px" className="object-cover" /> : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">
                {r.animeTitle || `#${r.aniId}`}
              </p>
              <p className="mt-1 font-karla text-xs text-white/45">
                {t("profile.blocks.recents.line", {
                  episode: r.episode,
                  when: r.at ? ago(r.at) : "—",
                })}
              </p>
              <span className="mt-2 block">
                <Bar pct={r.done ? 100 : r.pct} />
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
