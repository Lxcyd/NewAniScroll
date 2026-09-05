import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AdjustmentsHorizontalIcon,
  ArrowUpTrayIcon,
  FilmIcon,
  MagnifyingGlassIcon,
  MusicalNoteIcon,
  PhotoIcon,
  ScissorsIcon,
  SparklesIcon,
  SpeakerWaveIcon,
  Squares2X2Icon,
  SwatchIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";

import PlateBackground from "@/components/profile/PlateBackground";
import { ACCENT_PRESETS, useAccent } from "@/lib/prefs/accentColor";
import {
  DRESSING_KINDS,
  MAX_BLUR,
  clampBlur,
  emptyDressing,
  isHexColor,
  type Dressing,
  type DressingKind,
} from "@/lib/profile/dressing";
import type { BannerOption } from "@/lib/profile/types";

/**
 * Le studio : l'écran plein où l'on habille son profil.
 *
 * Deux partis pris, tenus depuis les maquettes et à ne pas défaire par
 * commodité :
 *
 *   1. L'APERÇU EST L'ÉCRAN. Pas une vignette dans un coin : le profil occupe
 *      tout le fond, à taille réelle, et c'est lui qu'on regarde. Tout le reste
 *      flotte par-dessus et peut disparaître. Une grille de propositions à
 *      droite a existé dans une première version — elle doublait ce que la
 *      palette montre déjà et mangeait le coin du profil qu'on vient voir.
 *
 *   2. UN SEUL MENU. Les huit boutons du dock ouvrent le MÊME objet, une
 *      palette de recherche cadrée sur le type cliqué. La recherche continue
 *      d'y traverser les autres types : taper « chainsaw » depuis « Clip »
 *      remonte aussi sa bannière et son opening. C'est ce qui évite huit
 *      panneaux à apprendre.
 *
 * Rien n'est écrit tant qu'« Appliquer » n'est pas cliqué : le brouillon vit
 * ici, et l'aperçu le montre. Fermer sans appliquer ne change rien — la leçon
 * du premier sélecteur, où cliquer une vignette sauvegardait aussitôt et où le
 * premier retour d'usage a été « la bannière a changé toute seule ».
 */

export type StudioAnime = {
  mediaId: number;
  title: string;
  cover?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Les titres à proposer, préféré en tête (la tête du classement). */
  animes: StudioAnime[];
  /** L'habillage épinglé, ou null quand le profil suit son anime préféré. */
  value: Dressing | null;
  /** Ce que l'automatique donne — sert d'aperçu quand rien n'est épinglé. */
  auto: { url: string | null; source: BannerOption["source"] | null; title: string | null };
  identity: { name: string; avatar: string | null };
  /**
   * Les chiffres du profil, tels que l'en-tête les affiche (heroStats).
   * L'aperçu les montre dans ses trois cartes : ce sont elles qui rendent le
   * flou visible, et de VRAIS chiffres dedans valent mieux que trois barres —
   * on juge alors la lisibilité qu'on aura, pas celle d'un gabarit.
   */
  stats?: Array<{ key: string; label: string; value: string }>;
  /** `null` dépingle et rend le profil à son anime préféré. */
  onApply: (value: Dressing | null) => void;
};

/* Les illustrations qui remplissent une plaque large. Une pochette portrait n'en
   est pas une : elle est proposée sous « Image », où elle est portée floutée. */
const WIDE = new Set<BannerOption["source"]>(["background", "thumb", "anilist", "banner"]);

const KIND_ICON: Record<DressingKind, typeof PhotoIcon> = {
  color: SwatchIcon,
  banner: PhotoIcon,
  anim: SparklesIcon,
  image: Squares2X2Icon,
  video: FilmIcon,
  oped: MusicalNoteIcon,
  clip: ScissorsIcon,
  upload: ArrowUpTrayIcon,
};

/** Une entrée de la palette. `run` est ce que ⏎ ou le clic déclenche. */
type Row = {
  key: string;
  label: string;
  hint?: string | null;
  thumb?: string | null;
  color?: string | null;
  icon?: typeof PhotoIcon;
  disabled?: boolean;
  selected?: boolean;
  run?: () => void;
};

type Section = { title: string; rows: Row[] };

/** Ce que la palette montre : un type de fond, ou la musique. */
type PaletteScope = DressingKind | "music";

type ThemeRow = {
  slug: string;
  kind: "op" | "ed";
  song: string | null;
  artists: string[];
  /* `episodes` est du texte libre côté AnimeThemes ("1-13", "2, 5") : on
     l'affiche tel quel, il situe un ED parmi douze. */
  video: { url: string; episodes?: string | null } | null;
  videoNc: { url: string; episodes?: string | null } | null;
  /** Version COMPLÈTE sur YouTube, attachée par /api/v2/themes/{id} depuis la
      table oped_youtube. Absent tant que le morceau n'a pas été résolu — le
      profil retombe alors sur les 90 s d'AnimeThemes. */
  youtubeId?: string | null;
};

export default function BannerStudio({
  open,
  onClose,
  animes,
  value,
  auto,
  identity,
  stats,
  onApply,
}: Props) {
  const { t } = useTranslation();
  const accent = useAccent();

  const [draft, setDraft] = useState<Dressing>(() => value ?? emptyDressing());
  const [scope, setScope] = useState<PaletteScope | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  /** L'anime dans lequel la palette cherche. */
  const [animeId, setAnimeId] = useState<number | null>(null);
  const [art, setArt] = useState<BannerOption[]>([]);
  const [themes, setThemes] = useState<ThemeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const search = useRef<HTMLInputElement | null>(null);
  /* Une palette rouverte ne doit pas resservir la liste de l'anime précédent
     pendant que la nouvelle charge — d'où le cache, par anime, pour la durée de
     l'écran seulement. */
  const artCache = useRef(new Map<number, BannerOption[]>());
  const themeCache = useRef(new Map<number, ThemeRow[]>());

  /* Rouvrir repart de ce que le profil porte VRAIMENT, pas d'un brouillon
     abandonné la fois d'avant. */
  useEffect(() => {
    if (!open) return;
    setDraft(value ?? emptyDressing());
    setScope(null);
    setQuery("");
    setAnimeId(value?.animeId ?? animes[0]?.mediaId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (animeId == null && animes.length) setAnimeId(animes[0].mediaId);
  }, [animes, animeId]);

  /* L'écran est plein : la page en dessous ne doit pas défiler sous lui, sinon
     fermer le studio rend un profil qui a bougé tout seul. */
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const currentAnime = animes.find((a) => a.mediaId === animeId) ?? null;

  /* « chainsawman » doit trouver « Chainsaw Man » : on compare sans espaces ni
     ponctuation, sinon un titre en deux mots ne se tape qu'avec son espace. */
  const fold = (s: string) =>
    s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

  /* En mode musique, taper un nom d'anime liste SES musiques directement, sans
     l'étape « basculer puis regarder ». Le reste des modes garde la bascule
     explicite : là on choisit une illustration, on ne cherche pas un titre. */
  const searchedAnime = useMemo(() => {
    if (scope !== "music") return null;
    const q = fold(query);
    if (q.length < 3) return null;
    return animes.find((a) => fold(a.title).includes(q)) ?? null;
  }, [scope, query, animes]);

  const listedAnime = searchedAnime ?? currentAnime;
  const listedAnimeId = listedAnime?.mediaId ?? animeId;

  /* Les illustrations d'un anime : le même point d'entrée, partagé et mis en
     cache à la périphérie, que celui dont le profil tire déjà sa plaque —
     ouvrir le studio sur son propre profil ne coûte donc en général rien. */
  useEffect(() => {
    if (!open || animeId == null) return;
    if (scope !== "banner" && scope !== "image") return;
    const hit = artCache.current.get(animeId);
    if (hit) {
      setArt(hit);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`/api/v2/profile-banner?anime=${animeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive) return;
        const options: BannerOption[] = Array.isArray(json?.options) ? json.options : [];
        artCache.current.set(animeId, options);
        setArt(options);
      })
      .catch(() => alive && setArt([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, animeId, scope]);

  /* Openings et endings — AnimeThemes, via le proxy que la fiche anime utilise
     déjà pour son menu OP/ED. */
  useEffect(() => {
    if (!open || listedAnimeId == null) return;
    if (scope !== "oped" && scope !== "music") return;
    const hit = themeCache.current.get(listedAnimeId);
    if (hit) {
      setThemes(hit);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`/api/v2/themes/${listedAnimeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive) return;
        const list: ThemeRow[] = Array.isArray(json?.themes) ? json.themes : [];
        themeCache.current.set(listedAnimeId, list);
        setThemes(list);
      })
      .catch(() => alive && setThemes([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, listedAnimeId, scope]);

  const patch = useCallback(
    (next: Partial<Dressing>) => setDraft((d) => ({ ...d, ...next })),
    [],
  );

  const openScope = useCallback((s: PaletteScope) => {
    setScope(s);
    setQuery("");
    setCursor(0);
    requestAnimationFrame(() => search.current?.focus());
  }, []);

  /* ── Ce que la palette liste ─────────────────────────────────────────── */
  const sections: Section[] = useMemo(() => {
    if (!scope) return [];
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    const out: Section[] = [];
    const ready = DRESSING_KINDS.find((k) => k.id === scope)?.ready ?? true;

    if (scope !== "music" && !ready) {
      out.push({
        title: t(`profile.studioKind_${scope}`),
        rows: [
          {
            key: "soon",
            label: t(`profile.studioSoon_${scope}`),
            hint: t("profile.studioSoonHint"),
            icon: KIND_ICON[scope as DressingKind],
            disabled: true,
          },
        ],
      });
    }

    if (scope === "color") {
      const rows: Row[] = [
        {
          key: "theme",
          label: t("profile.studioColorTheme"),
          hint: accent,
          color: accent,
          selected: draft.kind === "color" && draft.color === accent,
          run: () =>
            patch({ kind: "color", color: accent, url: null, source: null, animeId: null, title: null }),
        },
        ...ACCENT_PRESETS.filter((c) => c !== accent).map((c) => ({
          key: c,
          label: t("profile.studioColorPreset"),
          hint: c,
          color: c,
          selected: draft.kind === "color" && draft.color === c,
          run: () =>
            patch({ kind: "color", color: c, url: null, source: null, animeId: null, title: null }),
        })),
      ];
      out.push({ title: t("profile.studioColorSection"), rows: rows.filter((r) => match(r.hint || "")) });
    }

    if (scope === "banner") {
      const rows = art
        .filter((o) => WIDE.has(o.source))
        .map((o) => ({
          key: o.url,
          label: currentAnime?.title || "",
          hint: o.likes > 0 ? `♥ ${o.likes}` : t(`profile.artKind_${o.source}`),
          thumb: o.url,
          selected: draft.url === o.url,
          run: () =>
            patch({
              kind: "banner" as const,
              url: o.url,
              color: null,
              source: o.source,
              animeId: currentAnime?.mediaId ?? null,
              title: currentAnime?.title ?? null,
            }),
        }));
      out.push({
        title: t("profile.studioArtOf", { title: currentAnime?.title ?? "—" }),
        rows,
      });
    }

    if (scope === "image") {
      /* Les pochettes : elles sont déjà en main (la liste les porte), donc
         cette section ne coûte aucune requête. Portées floutées et
         sur-dimensionnées, comme le fait déjà la plaque de dernier recours. */
      const rows = animes.filter((a) => a.cover && match(a.title)).map((a) => ({
        key: `cover-${a.mediaId}`,
        label: a.title,
        hint: t("profile.artPoster"),
        thumb: a.cover!,
        selected: draft.url === a.cover,
        run: () =>
          patch({
            kind: "image" as const,
            url: a.cover!,
            color: null,
            source: "cover" as const,
            animeId: a.mediaId,
            title: a.title,
          }),
      }));
      out.push({ title: t("profile.studioCovers"), rows });
    }

    if (scope === "oped" || scope === "music") {
      const rows: Row[] = themes
        /* Quand la requête DÉSIGNE l'anime, elle ne doit pas filtrer ses
           pistes : « chainsawman » ne figure dans aucun titre de chanson, et
           filtrer dessus viderait la liste qu'on vient d'aller chercher. */
        .filter(
          (th) =>
            !!searchedAnime ||
            match(`${th.slug} ${th.song || ""} ${th.artists.join(" ")}`),
        )
        .map((th) => {
          const url = th.videoNc?.url || th.video?.url || null;
          const label = th.song || th.slug;
          const artist = th.artists[0] || null;
          /* AnimeThemes donne les épisodes en texte libre ("1-13", "2, 5"),
             c'est l'info qui situe un ED parmi douze. */
          const episodes = th.videoNc?.episodes || th.video?.episodes || null;
          return {
            key: `${th.slug}-${url || "none"}`,
            label,
            hint: [
              th.slug.toUpperCase(),
              artist,
              episodes ? t("profile.studioMusicEpisodes", { episodes }) : null,
            ]
              .filter(Boolean)
              .join(" · "),
            icon: MusicalNoteIcon,
            disabled: !url,
            selected:
              scope === "music" ? draft.music?.url === url : draft.url === url,
            run: url
              ? () =>
                  scope === "music"
                    ? patch({
                        music: {
                          url,
                          title: label,
                          artist,
                          slug: th.slug.toUpperCase(),
                          /* La version complète quand elle a été résolue, sinon
                             null : le profil retombe sur les 90 s d'AnimeThemes
                             plutôt que de ne rien jouer. */
                          videoId: th.youtubeId ?? null,
                        },
                      })
                    : patch({
                        kind: "oped" as const,
                        url,
                        color: null,
                        source: null,
                        animeId: currentAnime?.mediaId ?? null,
                        title: currentAnime?.title ?? null,
                      })
              : undefined,
          };
        });
      if (scope === "music" && draft.music) {
        rows.unshift({
          key: "no-music",
          label: t("profile.studioMusicOff"),
          hint: null,
          icon: SpeakerWaveIcon,
          disabled: false,
          selected: false,
          run: () => patch({ music: null }),
        });
      }
      out.push({
        title: t(
          scope === "music" ? "profile.studioMusicOf" : "profile.studioThemesOf",
          { title: listedAnime?.title ?? "—" },
        ),
        rows,
      });
    }

    /* La recherche traverse les types : c'est ce que la palette apporte de plus
       qu'un panneau, et le seul endroit où l'on passe d'un anime à l'autre. */
    const others = animes
      .filter(
        (a) =>
          a.mediaId !== listedAnimeId &&
          (match(a.title) || (fold(query).length >= 3 && fold(a.title).includes(fold(query)))),
      )
      .slice(0, 8)
      .map((a) => ({
        key: `anime-${a.mediaId}`,
        label: a.title,
        hint: t("profile.studioSwitchAnime"),
        thumb: a.cover ?? null,
        run: () => setAnimeId(a.mediaId),
      }));
    if (others.length) out.push({ title: t("profile.studioOtherAnime"), rows: others });

    return out.filter((s) => s.rows.length > 0);
  }, [scope, query, art, themes, animes, animeId, currentAnime, searchedAnime,
      listedAnime, listedAnimeId, draft, accent, patch, t]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  useEffect(() => setCursor(0), [scope, query, animeId]);

  /* ── Clavier ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        /* Échap ferme la palette d'abord, l'écran ensuite : sinon un menu ouvert
           par erreur coûte tout le brouillon. */
        if (scope) setScope(null);
        else onClose();
        return;
      }
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openScope(scope ?? "banner");
        return;
      }
      if (!scope) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(flat.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter") {
        const row = flat[cursor];
        if (row && !row.disabled && row.run) {
          e.preventDefault();
          row.run();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, scope, flat, cursor, onClose, openScope]);

  if (!open) return null;

  const pinned = !!value;
  /* Ce que l'aperçu montre : le brouillon dès qu'il a quelque chose, sinon la
     plaque automatique — pour que l'écran ne s'ouvre jamais sur du vide. */
  const shown: Dressing =
    draft.url || draft.color
      ? draft
      : { ...draft, kind: "banner", url: auto.url, source: auto.source };
  const cardAlpha = draft.blur > 0 ? 0.34 : 0.62;

  let index = -1;

  return (
    /* Au-dessus de la barre de navigation, qui est en z-[9999] : sans cela
       elle recouvrait la barre du studio, et « Appliquer » se trouvait sous le
       menu du site. C'est le même étage que les autres écrans pleins du site
       (ChangelogButton, ReportModal). */
    <div className="fixed inset-0 z-[10000] overflow-hidden bg-primary text-white">
      {/* ── L'aperçu, à taille réelle ─────────────────────────────────── */}
      <div className="absolute inset-0">
        <PlateBackground dressing={shown} fallback={shown.source === "cover"} />
        {/* Le voile : lourd en haut pour porter la barre — il n'y a plus de
            navigation derrière elle — lourd en bas pour porter le dock, et
            presque rien au milieu, là où l'on regarde l'image. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(6,7,10,.82) 0%, rgba(6,7,10,.25) 14%, rgba(6,7,10,.18) 52%, rgba(6,7,10,.88) 100%)",
          }}
        />
      </div>

      <div className="absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 px-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
          <div className="rounded-full bg-gradient-to-br from-as-accent to-as-accent2 p-[3px] shadow-glow">
            {identity.avatar ? (
              <Image
                src={identity.avatar}
                alt=""
                width={128}
                height={128}
                className="h-28 w-28 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-full bg-primary text-4xl font-bold text-white/80">
                {identity.name.charAt(0).toUpperCase() || "?"}
              </div>
            )}
          </div>
          <p
            className="font-outfit text-5xl font-bold leading-none"
            style={{ textShadow: "0 2px 18px rgba(0,0,0,.75)" }}
          >
            {identity.name}
          </p>
          {/* Les trois cartes existent pour UNE raison : montrer le flou. C'est
              le seul réglage dont l'effet ne se voit pas sur le fond. */}
          <div className="grid w-full grid-cols-3 gap-3">
            {(stats && stats.length
              ? stats
              : [
                  { key: "a", label: t("profile.statAnime"), value: "—" },
                  { key: "b", label: t("profile.statEpisodes"), value: "—" },
                  { key: "c", label: t("profile.statWatched"), value: "—" },
                ]
            )
              .slice(0, 3)
              .map((s) => (
                <div
                  key={s.key}
                  className="rounded-[20px] px-4 py-3.5 text-left ring-1 ring-white/15"
                  style={{
                    background: `linear-gradient(145deg, rgba(20,22,28,${cardAlpha}), rgba(12,13,16,${cardAlpha - 0.14}))`,
                    backdropFilter: `blur(${draft.blur}px)`,
                    WebkitBackdropFilter: `blur(${draft.blur}px)`,
                  }}
                >
                  <p className="text-[10px] uppercase tracking-[.12em] text-white/45">
                    {s.label}
                  </p>
                  <p className="mt-0.5 font-outfit text-2xl font-bold leading-tight">
                    {s.value}
                  </p>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* ── Barre du haut ─────────────────────────────────────────────── */}
      <div className="absolute inset-x-0 top-0 z-30 flex items-center gap-3 px-4 py-4 md:px-6">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[.12em] text-white/75 ring-1 ring-white/15 backdrop-blur-md">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {t("profile.studioLive")}
        </span>
        <h2
          className="font-outfit text-lg font-bold"
          style={{ textShadow: "0 2px 14px rgba(0,0,0,.85)" }}
        >
          {t("profile.studioTitle")}
        </h2>
        <span className="hidden truncate text-xs text-white/55 sm:block">
          {draft.title || t("profile.studioPreviewNote")}
        </span>
        <span className="flex-1" />
        {pinned ? (
          <button
            type="button"
            onClick={() => onApply(null)}
            className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            {t("profile.bannerReset")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="rounded-full bg-black/50 px-3 py-1.5 text-[11px] font-bold text-white/80 ring-1 ring-white/15 backdrop-blur-md transition-colors hover:bg-black/70"
        >
          {t("common.cancel", { defaultValue: "Annuler" })}
        </button>
        <button
          type="button"
          disabled={!draft.url && !draft.color}
          onClick={() => onApply(draft)}
          className="rounded-full bg-action px-4 py-1.5 text-[11px] font-bold text-white transition-transform hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
        >
          {t("profile.bannerApply")}
        </button>
      </div>

      {/* ── La palette, ancrée sur le bouton cliqué ───────────────────── */}
      {scope ? (
        <>
          <button
            type="button"
            aria-label={t("common.close", { defaultValue: "Close" })}
            onClick={() => setScope(null)}
            className="absolute inset-0 z-20 cursor-default bg-gradient-to-t from-black/80 via-black/40 to-transparent"
          />
          {/* L'ancre : la palette sort du dock, pas de nulle part. Sans elle le
              lien entre le bouton cliqué et le menu qui s'ouvre se perd. */}
          <div className="absolute inset-x-0 bottom-[7.1rem] z-40 flex justify-center">
            <span className="h-4 w-4 rotate-45 border-b border-r border-white/15 bg-[#17181d]" />
          </div>
          <div className="absolute inset-x-0 bottom-[7.6rem] z-30 flex justify-center px-4">
            <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-[#17181d] shadow-[0_24px_60px_rgba(0,0,0,.7)] ring-1 ring-white/15">
              <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-3">
                <MagnifyingGlassIcon className="h-5 w-5 shrink-0 text-white/45" />
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-action px-2.5 py-1 text-[11px] font-bold text-white">
                  {t(`profile.studioKind_${scope}`)}
                </span>
                <input
                  ref={search}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("profile.studioSearch")}
                  className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
                />
                <button
                  type="button"
                  onClick={() => setScope(null)}
                  className="shrink-0 rounded-lg p-1 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                  aria-label={t("common.close", { defaultValue: "Close" })}
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="max-h-[42vh] overflow-y-auto p-2">
                {loading && flat.length === 0 ? (
                  <div className="space-y-1.5 p-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="h-11 animate-pulse rounded-lg bg-white/5" />
                    ))}
                  </div>
                ) : flat.length === 0 ? (
                  <p className="px-3 py-8 text-center text-sm text-white/45">
                    {t("profile.studioNoResult")}
                  </p>
                ) : (
                  sections.map((s) => (
                    <div key={s.title}>
                      <p className="px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-[.13em] text-white/35">
                        {s.title}
                      </p>
                      {s.rows.map((row) => {
                        index += 1;
                        const active = index === cursor;
                        const Icon = row.icon;
                        return (
                          <button
                            key={row.key}
                            type="button"
                            disabled={row.disabled}
                            onMouseMove={() => setCursor(flat.indexOf(row))}
                            onClick={() => row.run?.()}
                            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                              row.disabled
                                ? "cursor-not-allowed opacity-45"
                                : active
                                  ? "bg-action/20 ring-1 ring-action/60"
                                  : "hover:bg-white/[0.07]"
                            }`}
                          >
                            {row.thumb ? (
                              <span className="relative h-8 w-14 shrink-0 overflow-hidden rounded bg-black/50">
                                <Image src={row.thumb} alt="" fill sizes="56px" className="object-cover" />
                              </span>
                            ) : row.color ? (
                              <span
                                className="h-7 w-7 shrink-0 rounded-full ring-1 ring-white/20"
                                style={{ background: row.color }}
                              />
                            ) : Icon ? (
                              <Icon className="h-5 w-5 shrink-0 text-white/55" />
                            ) : null}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-white/90">{row.label}</span>
                              {row.hint ? (
                                <span className="block truncate text-[11px] text-white/40">{row.hint}</span>
                              ) : null}
                            </span>
                            {row.selected ? (
                              <CheckIcon className="h-4 w-4 shrink-0 text-action" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>

              <div className="flex items-center gap-3 border-t border-white/10 bg-black/25 px-4 py-2">
                <span className="font-mono text-[10px] text-white/35">
                  {t("profile.studioKeys")}
                </span>
                <span className="flex-1" />
                {scope === "color" ? (
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] text-white/60">
                    {t("profile.studioColorCustom")}
                    <input
                      type="color"
                      value={isHexColor(draft.color) ? draft.color : accent}
                      onChange={(e) =>
                        patch({
                          kind: "color",
                          color: e.target.value,
                          url: null,
                          source: null,
                          animeId: null,
                          title: null,
                        })
                      }
                      className="h-7 w-10 cursor-pointer rounded border border-white/20 bg-transparent"
                    />
                  </label>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* ── Le dock ───────────────────────────────────────────────────── */}
      <div className="absolute inset-x-0 bottom-5 z-30 flex justify-center px-3">
        <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl bg-[#15161d]/90 p-2 shadow-[0_18px_44px_rgba(0,0,0,0.6)] ring-1 ring-white/10 backdrop-blur-xl scrollbar-hide">
          {DRESSING_KINDS.map(({ id }) => {
            const Icon = KIND_ICON[id];
            const on = scope === id || (!scope && draft.kind === id && (draft.url || draft.color));
            return (
              <button
                key={id}
                type="button"
                onClick={() => openScope(id)}
                title={t(`profile.studioKind_${id}`)}
                aria-label={t(`profile.studioKind_${id}`)}
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors ${
                  on
                    ? "bg-action text-white"
                    : "text-white/55 hover:bg-white/[0.08] hover:text-white"
                }`}
              >
                <Icon className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.7} />
              </button>
            );
          })}

          <span className="mx-1.5 h-7 w-px shrink-0 bg-white/10" />

          <button
            type="button"
            onClick={() => openScope("music")}
            className={`flex w-48 shrink-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors ${
              scope === "music" ? "bg-white/[0.10]" : "hover:bg-white/[0.06]"
            }`}
          >
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                draft.music ? "bg-action/20 text-action" : "bg-white/[0.07] text-white/45"
              }`}
            >
              <SpeakerWaveIcon className="h-4 w-4" strokeWidth={1.7} />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-outfit text-[12px] font-bold text-white">
                {draft.music ? draft.music.title : t("profile.studioMusicNone")}
              </span>
              <span className="block truncate font-karla text-[10.5px] leading-snug text-white/40">
                {draft.music
                  ? [draft.music.artist, draft.music.slug].filter(Boolean).join(" · ")
                  : t("profile.studioMusicAdd")}
              </span>
            </span>
          </button>

          <span className="mx-1.5 h-7 w-px shrink-0 bg-white/10" />

          {/* Le curseur du flou reprend `as-range` : même rail, même pastille
              cerclée d'accent que les réglages de widget. Il n'a qu'une poignée,
              donc on lui rend le clic sur le rail (`pointer-events-auto`), que la
              version à deux poignées doit, elle, désactiver pour ne pas se voler
              les clics. */}
          <label className="flex w-44 shrink-0 flex-col gap-1.5 px-1.5">
            <span className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-karla text-[11px] font-bold uppercase tracking-[.08em] text-white/45">
                <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" strokeWidth={2} />
                {t("profile.studioBlur")}
              </span>
              <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-karla text-[11px] font-bold text-white/80">
                {draft.blur} px
              </span>
            </span>
            <span className="as-range relative block h-3.5 w-full">
              <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/12" />
              <span
                className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-action"
                style={{ width: `${(draft.blur / MAX_BLUR) * 100}%` }}
              />
              <input
                type="range"
                min={0}
                max={MAX_BLUR}
                value={draft.blur}
                onChange={(e) => patch({ blur: clampBlur(e.target.value) })}
                /* En ligne, et pas une classe : `.as-range input[type=range]`
                   coupe les clics avec une spécificité qu'un utilitaire seul ne
                   dépasse pas. */
                style={{ pointerEvents: "auto" }}
                aria-label={t("profile.studioBlur")}
              />
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
