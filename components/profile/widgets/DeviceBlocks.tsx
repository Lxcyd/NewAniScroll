import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
     le titre passe sur DEUX lignes au lieu d'être coupé — dans la plus petite
     taille c'est le cas courant, et un titre tronqué n'est pas reconnaissable. */
  return (
    <div className="flex h-full min-w-0 items-center gap-4">
      <Link
        href={href}
        className="group relative aspect-video h-full max-h-[10rem] w-auto max-w-[46%] shrink-0 overflow-hidden rounded-2xl bg-as-card"
      >
        {art ? <Image src={art} alt="" fill sizes="320px" className="object-cover" /> : null}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-action shadow-glow transition-transform duration-200 group-hover:scale-110">
            {/* Le triangle du lecteur (vidstack, `PlayButton.Play`) plutôt qu'un
                polygone à trois sommets : ses coins sont arrondis, et c'est le
                même glyphe que celui sur lequel on retombe en arrivant. */}
            <svg viewBox="0 0 32 32" fill="currentColor" className="h-5 w-5 text-white">
              <path d="M10.6667 6.6548C10.6667 6.10764 11.2894 5.79346 11.7295 6.11862L24.377 15.4634C24.7377 15.7298 24.7377 16.2692 24.3771 16.5357L11.7295 25.8813C11.2895 26.2065 10.6667 25.8923 10.6667 25.3451L10.6667 6.6548Z" />
            </svg>
          </span>
        </span>
        <span className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
          <span className="block h-full bg-action" style={{ width: `${row.pct}%` }} />
        </span>
      </Link>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <Link href={href} className="min-w-0">
          <h3 className="line-clamp-2 font-outfit text-base font-bold leading-snug text-white transition-colors hover:text-action sm:text-lg">
            {row.animeTitle || `#${row.aniId}`}
          </h3>
        </Link>
        <p className="mt-1.5 line-clamp-1 font-karla text-[13px] text-white/50">
          {row.minutesLeft != null
            ? t(other ? "profile.blocks.resume.lineOther" : "profile.blocks.resume.line", {
                episode: row.episode,
                minutes: row.minutesLeft,
              })
            : t("profile.blocks.resume.lineNoTime", { episode: row.episode })}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            href={href}
            className="inline-flex items-center gap-2 rounded-full bg-action px-4 py-2 font-karla text-xs font-bold text-white shadow-glow transition-transform hover:scale-105"
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
            aria-label={t("profile.blocks.resume.info")}
            title={t("profile.blocks.resume.info")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white/55 ring-1 ring-white/15 transition-colors hover:text-white hover:ring-white/35"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className="h-4 w-4"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11.5v4.5" />
              <path d="M12 8h.01" />
            </svg>
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
