import Image from "next/image";
import Link from "next/link";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { listLabel, STATUS_TO_LIST } from "@/components/anime/v2/helpers";
import { previewAnchor } from "@/lib/preview/anchor";
import { useDragScroll } from "@/lib/ui/dragScroll";
import {
  currentlyWatching,
  decadeCounts,
  formatCounts,
  genreCounts,
  scoreHistogram,
  showcaseFor,
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

/**
 * La vitrine : une bande d'affiches qui se tire à la souris.
 *
 * ELLE SE DIMENSIONNE TOUTE SEULE, sans pixel fixe. L'affiche prend la hauteur
 * qui reste sous le titre, et sa largeur en découle par son rapport 2:3 ; la
 * carte fait la largeur de son affiche. Le bloc va donc de 1×2 à 2×4 : à une
 * ligne les affiches sont petites, à deux lignes elles sont grandes, et rien
 * n'est à recalculer. Seul l'ÉCART entre elles est seuillé, pour rester
 * proportionnel à leur taille (cf. `.as-fav-row` dans globals.css).
 *
 * TOUTES LES CARTES FONT LA MÊME TAILLE. La rangée du titre a une hauteur
 * FIXE de deux lignes, pleines ou non : sans elle, un titre court laissait son
 * affiche descendre plus bas que celle d'à côté, et la bande ondulait.
 *
 * DEUX LIGNES DE TITRE, ET PLUS DE COMPTE D'ÉPISODES. Le titre était coupé à
 * une ligne, ce qui à cette largeur laissait « Kimetsu no Yaiba: M… » —
 * méconnaissable. La ligne libérée vient du nombre d'épisodes, qui ne disait
 * rien sur une vitrine de favoris : la note, elle, reste sur l'affiche.
 *
 * Le glissement est CELUI du carrousel de recommandations, littéralement (cf.
 * lib/ui/dragScroll.ts), les flèches sont les siennes, et le survol lève la même
 * bande-annonce que partout ailleurs sur le site — une seule propriété à poser
 * (`previewAnchor`), pas de composant à envelopper.
 */
export function FavoritesBlock({
  entries,
  /** La liste mise en vitrine (cf. FAVORITE_SOURCES). Défaut : les favoris. */
  source = "favourites",
  /** La plage de notes retenue, et si les titres sans note en font partie. */
  scores = [0, 10],
  unrated = false,
  /** Réglable : la bande-annonce au survol. */
  trailer = true,
  /** En mode réorganisation, les flèches céderaient la place à la roue et au
   *  moins qui occupent ce coin — et le contenu est inerte de toute façon. */
  editing = false,
}: {
  entries: ProfileEntry[];
  source?: string;
  scores?: [number, number];
  unrated?: boolean;
  trailer?: boolean;
  editing?: boolean;
}) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const [lo, hi] = scores;
  const shown = useMemo(
    () => showcaseFor(entries, source, 20, [lo, hi], unrated),
    [entries, source, lo, hi, unrated],
  );
  const { ref, onClickCapture } = useDragScroll<HTMLDivElement>();

  if (!shown.length)
    return (
      <EmptyBlock
        note={t(
          source === "favourites"
            ? "profile.blocks.favorites.empty"
            : "profile.blocks.favorites.emptyList",
        )}
      />
    );

  /* Les flèches sautent d'un peu moins que la largeur visible : il reste une
     affiche de l'écran précédent, qui dit qu'on n'a pas sauté dans le vide. */
  const nudge = (dir: number) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="relative h-full">
      {/* LES FLÈCHES DU CARROUSEL DE RECOMMANDATIONS, dans l'en-tête du bloc.
          Elles sont posées en NÉGATIF au-dessus du contenu parce que l'en-tête
          appartient à la grille et non au bloc : le bloc ne reçoit que sa boîte
          de contenu, et remonter de 38 px l'amène au milieu du titre, à droite,
          là où le carrousel les met. */}
      {!editing ? (
        <div className="absolute -top-[38px] right-0 z-10 flex gap-1.5">
          {[-1, 1].map((dir) => (
            <button
              key={dir}
              type="button"
              onClick={() => nudge(dir)}
              aria-label={t(dir < 0 ? "anime.prev" : "anime.next")}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.06] text-white/60 ring-1 ring-white/10 transition-colors hover:bg-white/[0.12] hover:text-white"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3">
                <polyline points={dir < 0 ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
              </svg>
            </button>
          ))}
        </div>
      ) : null}

      <div
        ref={ref}
        onClickCapture={onClickCapture}
        /* `-my-2 py-2` : la carte du widget coupe ce qui dépasse, et sans ces
           huit pixels de marge intérieure l'affiche qui grandit au survol serait
           rognée en haut et en bas. Le `-my-2` les reprend sur la mise en page,
           donc rien ne bouge tant qu'on ne survole rien. */
        className="as-fav-row as-noscroll -my-2 flex h-full cursor-grab select-none overflow-x-auto overflow-y-hidden py-2"
      >
        {shown.map((e) => (
          <Link
            key={e.mediaId}
            href={animeHref(e.mediaId, clickTarget)}
            draggable={false}
            {...(trailer ? previewAnchor(e.mediaId) : {})}
          /* UNE GRILLE À DEUX RANGÉES, ET SURTOUT PAS UNE COLONNE FLEX.
             L'affiche n'a pas de largeur à elle : elle la tient de sa HAUTEUR,
             par son rapport 2:3. Encore faut-il que cette hauteur soit
             définie — `h-full` dans une rangée `minmax(0,1fr)` l'est, alors
             qu'un `flex-1` ne l'est pas au moment où le navigateur calcule la
             largeur intrinsèque de la colonne. Écrite en flex, la carte se
             réduisait à zéro pixel de large et la vitrine était vide. */
            /* La rangee du titre a une hauteur FIXE de deux lignes (2.2rem a
               ce corps), remplies ou non : c'est ce qui donne a toutes les
               cartes exactement la meme taille, qu'un titre tienne sur une
               ligne ou sur deux. */
            className="group grid h-full shrink-0 grid-rows-[minmax(0,1fr)_2rem] gap-1.5"
          >
            {/* PAS DE `shadow-poster` ICI. Cette ombre — 32 px de flou noir à
                55 % — est faite pour une affiche posée sur une page claire ou
                sur une illustration. Sur le fond presque noir d'un widget elle
                ne se lit pas comme une ombre mais comme une BOÎTE NOIRE autour
                de chaque affiche, d'autant plus visible que les affiches sont
                petites et serrées. */}
            <div
              className="relative h-full overflow-hidden rounded-xl bg-as-card transition-transform duration-200 group-hover:scale-[1.05]"
              style={{ aspectRatio: "2 / 3" }}
            >
              {e.cover ? (
                <Image src={e.cover} alt="" fill sizes="240px" className="object-cover" />
              ) : null}
              {e.score ? (
                <span className="absolute right-1.5 top-1.5 rounded-md bg-black/75 px-1.5 py-0.5 font-karla text-[11px] font-bold text-as-score">
                  ★ {e.score}
                </span>
              ) : null}
            </div>
            {/* `w-0 min-w-full` : le titre se replie sur la largeur de l'affiche
                au lieu d'imposer la sienne a la carte. Un pourcentage de
                min-width compte pour zero dans le calcul de largeur
                intrinseque — c'est justement ce qu'on veut — alors qu'un simple
                `w-full` y laisserait passer la largeur du texte, et un titre
                long elargirait sa carte au point de rendre la bande
                irreguliere. */}
            <p className="line-clamp-2 w-0 min-w-full text-[12px] font-semibold leading-[1.15] text-white">
              {pickTitle(e.title, titlePref)}
            </p>
          </Link>
        ))}
      </div>
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
      {/* Le radar prend toute la hauteur offerte : dans un bloc 2×2 comme dans
          le panneau des statistiques, c'est la figure qu'on vient lire. */}
      <svg viewBox="0 0 200 192" className="h-full w-auto shrink-0">
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
