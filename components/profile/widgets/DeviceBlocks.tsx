import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { readHistory, watchHref, type HistoryRow } from "@/lib/profile/history";
import { getProgress, isCompleted, PROGRESS_EVENT } from "@/lib/watch/progress";
import { Bar, EmptyBlock, useAgo } from "./common";

/**
 * Les widgets nourris par ce que CET appareil a lu.
 *
 * Ils ne décrivent donc que le visiteur lui-même : lib/profile/blocks.ts les
 * marque `device` et ils ne sont proposés que sur son propre profil. Les
 * afficher sur le profil d'un autre montrerait notre historique sous son nom.
 *
 * La lecture se fait au montage, jamais au rendu serveur : localStorage n'existe
 * pas là-bas, et un premier rendu qui invente des lignes puis les remplace est
 * exactement le clignotement qu'on évite ailleurs. D'où `loaded`, et un bloc
 * vide — pas un état vide — tant qu'on ne sait pas.
 */

type Row = HistoryRow & { pct: number; minutesLeft: number | null; done: boolean };

function decorate(row: HistoryRow): Row {
  const p = getProgress(row.aniId, row.episode);
  const pct =
    p && p.duration > 0 ? Math.min(100, Math.round((p.time / p.duration) * 100)) : 0;
  const minutesLeft =
    p && p.duration > 0 ? Math.max(0, Math.round((p.duration - p.time) / 60)) : null;
  return { ...row, pct, minutesLeft, done: isCompleted(p) };
}

function useHistory(limit: number): { rows: Row[]; loaded: boolean } {
  const [state, setState] = useState<{ rows: Row[]; loaded: boolean }>({
    rows: [],
    loaded: false,
  });
  useEffect(() => {
    const read = () =>
      setState({ rows: readHistory(limit).map(decorate), loaded: true });
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

/* ── Reprendre la lecture ────────────────────────────────────────────── */

export function ResumeBlock() {
  const { t } = useTranslation();
  const { rows, loaded } = useHistory(12);

  /* Le dernier épisode COMMENCÉ mais pas fini. Proposer de « reprendre » un
     épisode terminé enverrait au générique de fin ; l'épisode suivant serait la
     bonne suite, et c'est une autre question (on ne sait pas ici s'il existe). */
  const row = rows.find((r) => !r.done && r.pct > 0);
  if (!loaded) return <div className="h-full" />;
  if (!row) return <EmptyBlock note={t("profile.blocks.resume.empty")} />;

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
            ? t("profile.blocks.resume.line", {
                episode: row.episode,
                minutes: row.minutesLeft,
              })
            : t("profile.blocks.resume.lineNoTime", { episode: row.episode })}
        </p>
        <span className="mt-3.5 inline-flex items-center gap-2 rounded-full bg-action px-4 py-2 font-karla text-xs font-bold text-white shadow-glow">
          {t("profile.blocks.resume.cta")}
        </span>
      </div>
    </Link>
  );
}

/* ── Vu récemment ────────────────────────────────────────────────────── */

export function RecentsBlock() {
  const { t } = useTranslation();
  const ago = useAgo();
  const { rows, loaded } = useHistory(12);

  if (!loaded) return <div className="h-full" />;
  if (!rows.length) return <EmptyBlock note={t("profile.blocks.recents.empty")} />;

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
