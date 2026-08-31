import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { listLabel, STATUS_TO_LIST } from "@/components/anime/v2/helpers";
import {
  currentlyWatching,
  decadeCounts,
  entryTitle,
  favoriteShowcase,
  formatCounts,
  genreCounts,
  plannedPool,
  scoreHistogram,
  statusCounts,
  studioRanks,
  STATUS_COLOR,
  type StatusKey,
} from "@/lib/profile/insights";
import type { ProfileCharacter, ProfileEntry } from "@/lib/profile/types";
import { Bar, Column, EmptyBlock } from "./common";

/**
 * Les widgets alimentés par la LISTE du profil.
 *
 * Chacun reçoit les entrées déjà normalisées et se contente de peindre. Quand
 * sa matière manque — une liste locale ne porte ni genre, ni format, ni studio —
 * il rend `EmptyBlock` avec la raison, jamais un classement bâti sur rien.
 *
 * Les images sont celles du site (couvertures AniList portées par les entrées) :
 * aucun emplacement à remplir à la main.
 */

const FORMAT_COLOR: Record<string, string> = {
  TV: "#3B82F6",
  TV_SHORT: "#60A5FA",
  MOVIE: "#A855F7",
  OVA: "#22c55e",
  ONA: "#94a3b8",
  SPECIAL: "#f59e0b",
  MUSIC: "#ec4899",
};

/* ── Favoris ─────────────────────────────────────────────────────────── */

export function FavoritesBlock({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const shown = useMemo(() => favoriteShowcase(entries, 10), [entries]);

  if (!shown.length) return <EmptyBlock note={t("profile.blocks.favorites.empty")} />;

  return (
    <div className="flex h-full gap-3.5 overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-white/10">
      {shown.map((e) => (
        <Link
          key={e.mediaId}
          href={animeHref(e.mediaId, clickTarget)}
          className="grid h-full shrink-0 grid-rows-[minmax(0,1fr)_auto] gap-2"
        >
          <div className="relative h-full overflow-hidden rounded-xl bg-as-card shadow-poster transition-transform duration-200 hover:-translate-y-1.5" style={{ aspectRatio: "2 / 3" }}>
            {e.cover ? (
              <Image src={e.cover} alt="" fill sizes="160px" className="object-cover" />
            ) : null}
            {e.score ? (
              <span className="absolute right-2 top-2 rounded-md bg-black/75 px-1.5 py-0.5 font-karla text-[11px] font-bold text-as-score">
                ★ {e.score}
              </span>
            ) : null}
          </div>
          <div className="max-w-[9.5rem]">
            <p className="truncate text-[13px] font-semibold text-white">
              {pickTitle(e.title, titlePref)}
            </p>
            <p className="mt-0.5 truncate font-karla text-[11px] text-white/40">
              {e.total ? t("profile.blocks.favorites.meta", { count: e.total }) : "—"}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}

/* ── Répartition par statut ──────────────────────────────────────────── */

export function StatusesBlock({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const rows = useMemo(() => statusCounts(entries), [entries]);
  if (!rows.length) return <EmptyBlock note={t("profile.blocks.statuses.empty")} />;
  const max = Math.max(...rows.map((r) => r.count));

  return (
    <div className="grid h-full content-start gap-2.5 overflow-y-auto pr-1">
      {rows.map((r) => {
        const color = STATUS_COLOR[r.key as StatusKey] || "#6b7280";
        return (
          <div key={r.key} className="flex items-center gap-2.5">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: color, boxShadow: `0 0 10px ${color}55` }}
            />
            <span className="flex-1 truncate text-[13px] text-white/70">
              {listLabel(t, STATUS_TO_LIST[r.key] || r.key)}
            </span>
            <span className="w-24 shrink-0">
              <Bar pct={(r.count / max) * 100} color={color} />
            </span>
            <span className="w-8 shrink-0 text-right font-karla text-xs font-bold text-white">
              {r.count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Notes attribuées ────────────────────────────────────────────────── */

export function ScoresBlock({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const bins = useMemo(() => scoreHistogram(entries), [entries]);
  if (!bins.length) return <EmptyBlock note={t("profile.blocks.scores.empty")} />;
  const max = Math.max(...bins);

  return (
    <div className="flex h-full items-end gap-1.5">
      {bins.map((n, i) => (
        <Column key={i} pct={(n / max) * 100} label={String(i + 1)} />
      ))}
    </div>
  );
}

/* ── Genres (radar) ──────────────────────────────────────────────────── */

/**
 * Un radar plutôt qu'un classement : la forme se compare d'un coup d'œil, ce
 * qu'une liste de barres ne permet pas. En SVG pur — aucune librairie de
 * graphes n'entre dans le bundle pour huit points.
 */
export function GenresBlock({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const genres = useMemo(() => genreCounts(entries, 8), [entries]);
  if (genres.length < 3) return <EmptyBlock note={t("profile.blocks.genres.empty")} />;

  const max = Math.max(...genres.map((g) => g.count));
  const n = genres.length;
  const cx = 100;
  const cy = 96;
  const R = 72;
  const point = (i: number, r: number) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };
  const shape = genres
    .map((g, i) => point(i, (g.count / max) * R).join(","))
    .join(" ");

  return (
    <div className="flex h-full items-center justify-center gap-4">
      <svg viewBox="0 0 200 192" className="h-full max-h-[15rem] w-auto shrink-0">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <polygon
            key={f}
            points={genres.map((_, i) => point(i, R * f).join(",")).join(" ")}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="1"
          />
        ))}
        {genres.map((_, i) => {
          const [x, y] = point(i, R);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,0.06)" />;
        })}
        <polygon
          points={shape}
          fill="var(--brand-primary, #E94560)"
          fillOpacity="0.28"
          stroke="var(--brand-primary, #E94560)"
          strokeWidth="2"
        />
        {genres.map((g, i) => {
          const [x, y] = point(i, (g.count / max) * R);
          return <circle key={g.key} cx={x} cy={y} r="2.5" fill="var(--brand-primary, #E94560)" />;
        })}
      </svg>
      <ul className="grid min-w-0 gap-1.5 font-karla text-[11px]">
        {genres.map((g) => (
          <li key={g.key} className="flex items-baseline gap-2">
            <span className="truncate text-white/60">{g.label}</span>
            <span className="ml-auto shrink-0 font-bold text-white/80">{g.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Formats & décennies ─────────────────────────────────────────────── */

export function FormatsBlock({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const formats = useMemo(() => formatCounts(entries), [entries]);
  const decades = useMemo(() => decadeCounts(entries), [entries]);
  if (!formats.length) return <EmptyBlock note={t("profile.blocks.formats.empty")} />;
  const decMax = decades.length ? Math.max(...decades.map((d) => d.count)) : 1;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <div>
        <div className="mb-3 flex h-2.5 overflow-hidden rounded-full">
          {formats.map((f) => (
            <span
              key={f.key}
              style={{ flex: f.count, background: FORMAT_COLOR[f.key] || "rgba(255,255,255,0.18)" }}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-3 font-karla text-[11px] text-white/50">
          {formats.map((f) => (
            <span key={f.key} className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ background: FORMAT_COLOR[f.key] || "rgba(255,255,255,0.18)" }}
              />
              {f.label} {f.count}
            </span>
          ))}
        </div>
      </div>

      {decades.length ? (
        <div className="min-h-0 flex-1">
          <p className="mb-3 font-karla text-[10px] font-bold uppercase tracking-[0.12em] text-white/40">
            {t("profile.blocks.formats.decades")}
          </p>
          <div className="flex h-24 items-end gap-2.5">
            {decades.map((d) => (
              <div key={d.key} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                <span className="font-karla text-[11px] font-bold text-white/55">{d.count}</span>
                <div
                  className="w-full rounded-t-md"
                  style={{
                    height: `${Math.max(4, (d.count / decMax) * 100)}%`,
                    background: "linear-gradient(180deg,#3B82F6, rgba(59,130,246,0.18))",
                  }}
                />
                <span className="font-karla text-[10px] text-white/35">{d.label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Studios ─────────────────────────────────────────────────────────── */

export function StudiosBlock({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const ranks = useMemo(() => studioRanks(entries).slice(0, 6), [entries]);
  if (!ranks.length) return <EmptyBlock note={t("profile.blocks.studios.empty")} />;

  return (
    <div className="grid h-full content-start gap-3 overflow-y-auto pr-1">
      {ranks.map((s, i) => (
        <div key={s.name} className="flex items-center gap-3">
          <span className="w-4 shrink-0 font-karla text-[11px] font-bold text-white/30">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">
            {s.name}
          </span>
          <span className="shrink-0 font-karla text-[11px] text-white/35">
            {t("profile.blocks.studios.titles", { count: s.count })}
          </span>
          <span className="w-16 shrink-0">
            <Bar
              pct={s.score ? ((s.score - 5) / 5) * 100 : 2}
              color="linear-gradient(90deg,#FFD700,#b8860b)"
            />
          </span>
          <span className="w-9 shrink-0 text-right font-karla text-[13px] font-bold text-as-score">
            {s.score != null ? String(s.score).replace(".", ",") : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Saison en cours ─────────────────────────────────────────────────── */

export function SeasonBlock({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const items = useMemo(() => currentlyWatching(entries, 6), [entries]);
  if (!items.length) return <EmptyBlock note={t("profile.blocks.season.empty")} />;

  return (
    <div className="grid h-full grid-cols-1 content-start gap-2.5 overflow-y-auto pr-1 sm:grid-cols-2">
      {items.map((e) => {
        const pct = e.total ? Math.min(100, Math.round((e.progress / e.total) * 100)) : null;
        return (
          <Link
            key={e.mediaId}
            href={animeHref(e.mediaId, clickTarget)}
            className="flex items-center gap-3 rounded-2xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-white/[0.06] transition-colors hover:ring-action/40"
          >
            {e.cover ? (
              <Image
                src={e.cover}
                alt=""
                width={38}
                height={38}
                className="h-[38px] w-[38px] shrink-0 rounded-[9px] object-cover"
              />
            ) : (
              <span className="h-[38px] w-[38px] shrink-0 rounded-[9px] bg-white/10" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-white">
                {pickTitle(e.title, titlePref)}
              </span>
              <span className="mt-0.5 block font-karla text-[11px] text-white/40">
                {t("profile.blocks.season.progress", {
                  progress: e.progress,
                  total: e.total ?? "?",
                })}
              </span>
              {pct !== null ? (
                <span className="mt-2 block">
                  <Bar pct={pct} />
                </span>
              ) : null}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/* ── Roulette du soir ────────────────────────────────────────────────── */

export function RouletteBlock({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const pool = useMemo(() => plannedPool(entries), [entries]);
  const [n, setN] = useState(0);

  if (!pool.length) return <EmptyBlock note={t("profile.blocks.roulette.empty")} />;
  const pick = pool[n % pool.length];

  return (
    <div className="flex h-full items-center gap-4">
      <div className="min-w-0 flex-1">
        <p className="font-karla text-[11px] text-white/40">
          {t("profile.blocks.roulette.from", { count: pool.length })}
        </p>
        <Link
          href={animeHref(pick.mediaId, clickTarget)}
          className="mt-1.5 block truncate font-outfit text-xl font-bold tracking-tight text-white hover:text-action"
        >
          {pickTitle(pick.title, titlePref)}
        </Link>
        <button
          type="button"
          onClick={() => setN((v) => v + 1 + Math.floor(Math.random() * 3))}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-action px-4 py-2.5 font-karla text-xs font-bold text-white shadow-glow transition-transform hover:scale-105"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3.5 w-3.5">
            <path d="M21 12a9 9 0 11-3-6.7" />
            <polyline points="21 4 21 9 16 9" />
          </svg>
          {t("profile.blocks.roulette.spin")}
        </button>
      </div>
      <Link
        href={animeHref(pick.mediaId, clickTarget)}
        className="relative w-20 shrink-0 overflow-hidden rounded-xl bg-as-card"
        style={{ aspectRatio: "2 / 3" }}
      >
        {pick.cover ? (
          <Image src={pick.cover} alt="" fill sizes="96px" className="object-cover" />
        ) : (
          <span className="flex h-full items-center justify-center font-outfit text-2xl font-bold text-white/25">
            {entryTitle(pick).charAt(0)}
          </span>
        )}
      </Link>
    </div>
  );
}

/* ── Personnages favoris ─────────────────────────────────────────────── */

export function CharactersBlock({ characters }: { characters: ProfileCharacter[] }) {
  const { t } = useTranslation();
  if (!characters.length) return <EmptyBlock note={t("profile.blocks.characters.empty")} />;

  return (
    <div className="grid h-full auto-rows-min grid-cols-3 gap-3 overflow-y-auto pr-1 sm:grid-cols-6">
      {characters.slice(0, 12).map((c) => (
        <div key={c.id} className="grid justify-items-center gap-2 text-center">
          <div className="w-full overflow-hidden rounded-full bg-as-card ring-2 ring-white/[0.08]" style={{ aspectRatio: "1" }}>
            {c.image ? (
              <Image src={c.image} alt={c.name} width={96} height={96} className="h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="w-full min-w-0">
            <p className="truncate text-xs font-semibold text-white">{c.name}</p>
            {c.from ? (
              <p className="truncate font-karla text-[10px] text-white/35">{c.from}</p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
