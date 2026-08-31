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

  return (
    <Link href={watchHref(row)} className="flex h-full items-center gap-4">
      <div className="relative h-full max-h-[7.5rem] w-[13.5rem] shrink-0 overflow-hidden rounded-2xl bg-as-card">
        {art ? <Image src={art} alt="" fill sizes="240px" className="object-cover" /> : null}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-action shadow-glow">
            <svg viewBox="0 0 24 24" fill="#fff" className="h-4 w-4">
              <polygon points="6 4 20 12 6 20" />
            </svg>
          </span>
        </span>
        <span className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
          <span className="block h-full bg-action" style={{ width: `${row.pct}%` }} />
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate font-outfit text-lg font-bold text-white">
          {row.animeTitle || `#${row.aniId}`}
        </p>
        <p className="mt-1.5 font-karla text-[13px] text-white/50">
          {row.minutesLeft != null
            ? t(other ? "profile.blocks.resume.lineOther" : "profile.blocks.resume.line", {
                episode: row.episode,
                minutes: row.minutesLeft,
              })
            : t("profile.blocks.resume.lineNoTime", { episode: row.episode })}
        </p>
        <span className="mt-3.5 inline-flex items-center gap-2 rounded-full bg-action px-4 py-2 font-karla text-xs font-bold text-white shadow-glow">
          {t(other ? "profile.blocks.resume.ctaOther" : "profile.blocks.resume.cta")}
        </span>
      </div>
    </Link>
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
