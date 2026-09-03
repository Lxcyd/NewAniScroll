import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { HeartIcon } from "@heroicons/react/24/solid";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { listLabel, STATUS_TO_LIST, LIST_COLORS } from "@/components/anime/v2/helpers";
import { scoreBucket } from "@/lib/profile/insights";
import type { ProfileEntry } from "@/lib/profile/types";

/**
 * The list half of a profile: status filter + one section per status.
 *
 * Source-agnostic on purpose — it is handed already-normalised entries
 * (lib/profile/types.ts), so the AniList profile, an AniScroll account's
 * profile and the local /me profile all render through this one component and
 * cannot drift apart.
 */

const STATUS_ORDER = [
  "CURRENT",
  "REPEATING",
  "COMPLETED",
  "PAUSED",
  "PLANNING",
  "DROPPED",
];

/**
 * SUR QUOI LA LISTE S'OUVRE, quand on n'y arrive pas par l'onglet mais par un
 * clic ailleurs — une colonne de l'histogramme des notes.
 *
 * Un objet et pas deux props : il est REJOUÉ à chaque fois que l'appelant en
 * pose un nouveau (c'est son identité qui le dit), y compris quand la note
 * demandée est la même que la précédente. Deux props séparées auraient laissé
 * un second clic sur la même colonne sans effet.
 */
export type ListFocus = { status?: string | null; score?: number | null };

export default function ProfileList({
  entries,
  emptyAction,
  focus,
}: {
  entries: ProfileEntry[];
  /** Rendered under the "nothing here" message (a link to go and watch). */
  emptyAction?: React.ReactNode;
  focus?: ListFocus | null;
}) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const [filter, setFilter] = useState(focus?.status || "all");
  const [score, setScore] = useState<number | null>(focus?.score ?? null);

  useEffect(() => {
    if (!focus) return;
    setFilter(focus.status || "all");
    setScore(focus.score ?? null);
  }, [focus]);

  /* LA NOTE FILTRE AVANT LE GROUPEMENT, donc les sections, les compteurs des
     pastilles et l'état vide décrivent tous la même sélection. Le palier vient
     de `scoreBucket`, partagé avec l'histogramme : un 6,7 tombe ici dans la
     colonne où il était dessiné là-bas. */
  const shown = useMemo(
    () =>
      score == null
        ? entries
        : entries.filter((e) => e.score && scoreBucket(e.score) === score),
    [entries, score],
  );

  const groups = useMemo(() => {
    const byStatus: Record<string, ProfileEntry[]> = {};
    for (const e of shown) {
      (byStatus[e.status || "PLANNING"] ||= []).push(e);
    }
    return STATUS_ORDER.map((s) => ({ status: s, entries: byStatus[s] || [] })).filter(
      (g) => g.entries.length > 0,
    );
  }, [shown]);

  const visible = filter === "all" ? groups : groups.filter((g) => g.status === filter);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-5 py-20 text-center">
        <p className="text-lg font-bold">{t("myList.empty")}</p>
        {emptyAction}
      </div>
    );
  }

  return (
    <>
      <div className="mb-8 flex flex-wrap gap-2">
        {/* LA NOTE EN COURS, EN PREMIÈRE PASTILLE ET DÉTACHABLE.
            On arrive ici avec un filtre qu'on n'a pas posé sur cet onglet : la
            pastille est ce qui le DIT, et la croix ce qui le défait. Sans elle,
            une liste de six titres passerait pour la liste entière.
            Elle est en OR, la couleur des notes partout ailleurs, pour ne pas se
            confondre avec les pastilles de statut. */}
        {score != null ? (
          <button
            onClick={() => setScore(null)}
            title={t("myList.clearScore")}
            className="inline-flex items-center gap-2 rounded-full bg-as-score/15 px-3.5 py-1.5 text-sm font-medium text-as-score ring-1 ring-as-score/40 transition-colors hover:bg-as-score/25"
          >
            <span>★ {String(score).replace(".", ",")}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" className="h-3 w-3">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        ) : null}
        <Chip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={`${t("profile.showAll")} (${shown.length})`}
        />
        {groups.map((g) => {
          const label = STATUS_TO_LIST[g.status] || g.status;
          return (
            <Chip
              key={g.status}
              active={filter === g.status}
              onClick={() => setFilter(g.status)}
              color={LIST_COLORS[label]}
              label={`${listLabel(t, label)} (${g.entries.length})`}
            />
          );
        })}
      </div>

      {/* Une liste bien remplie peut n'avoir aucun titre à CETTE note : le vide
          doit alors nommer son filtre, sinon il se lit comme une liste vide. */}
      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-white/60">
            {t("myList.noneAtScore", { score: String(score).replace(".", ",") })}
          </p>
          <button
            onClick={() => setScore(null)}
            className="rounded-lg px-4 py-2 text-sm ring-1 ring-action transition-colors hover:bg-action/10"
          >
            {t("myList.clearScore")}
          </button>
        </div>
      ) : null}

      <div className="grid gap-10">
        {visible.map((g) => {
          const label = STATUS_TO_LIST[g.status] || g.status;
          const color = LIST_COLORS[label] || "#6b7280";
          return (
            <section key={g.status} id={g.status.toLowerCase()}>
              <h2 className="mb-3 flex items-center gap-2.5">
                <span
                  className="h-6 w-1 rounded-full"
                  style={{ background: color, boxShadow: `0 0 12px ${color}66` }}
                />
                <span className="font-outfit text-lg font-bold">
                  {listLabel(t, label)}
                </span>
                <span className="text-xs text-white/35">{g.entries.length}</span>
              </h2>
              <div className="overflow-hidden rounded-xl bg-white/[0.03] ring-1 ring-white/[0.07]">
                {g.entries.map((e) => (
                  <Row key={e.mediaId} entry={e} color={color} href={animeHref(e.mediaId, clickTarget)} title={pickTitle(e.title, titlePref)} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function Chip({
  active,
  onClick,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-action text-white shadow-glow"
          : "bg-white/5 text-white/60 ring-1 ring-white/10 hover:bg-white/10 hover:text-white"
      }`}
    >
      {color && !active ? (
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      ) : null}
      {label}
    </button>
  );
}

function Row({
  entry,
  color,
  href,
  title,
}: {
  entry: ProfileEntry;
  color: string;
  href: string;
  title: string;
}) {
  // The bar is the honest one: no total means no bar, rather than a full one.
  const pct =
    entry.total && entry.total > 0
      ? Math.min(100, Math.round((entry.progress / entry.total) * 100))
      : null;

  return (
    <Link
      href={href}
      className="group relative flex items-center gap-3 border-b border-white/[0.04] px-3 py-2.5 transition-colors last:border-0 hover:bg-white/[0.06]"
    >
      {entry.cover ? (
        <Image
          src={entry.cover}
          alt=""
          width={40}
          height={56}
          className="h-14 w-10 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="h-14 w-10 shrink-0 rounded-md bg-white/10" />
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium group-hover:text-action">{title}</p>
        <div className="mt-1.5 flex items-center gap-2">
          {pct !== null ? (
            <span className="h-1 w-full max-w-[9rem] overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full"
                style={{ width: `${pct}%`, background: color }}
              />
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] text-white/40">
            {entry.total ? `${entry.progress}/${entry.total}` : entry.progress}
          </span>
        </div>
      </div>

      {entry.repeat ? (
        <span className="shrink-0 text-[11px] text-white/35" title={`×${entry.repeat}`}>
          ↻{entry.repeat}
        </span>
      ) : null}
      {entry.favourite ? (
        <HeartIcon className="h-4 w-4 shrink-0 text-action" />
      ) : null}
      {entry.score ? (
        <span className="shrink-0 rounded-md bg-as-score/10 px-2 py-1 text-xs font-bold text-as-score">
          {entry.score}
        </span>
      ) : (
        <span className="w-9 shrink-0" />
      )}
    </Link>
  );
}
