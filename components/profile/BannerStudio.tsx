import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  SpeakerXMarkIcon,
  Squares2X2Icon,
  SwatchIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { CheckIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/solid";

import PlateBackground from "@/components/profile/PlateBackground";
import ColorPicker from "@/components/shared/ColorPicker";
import { ACCENT_PRESETS, useAccent } from "@/lib/prefs/accentColor";
import { PREVIEW_DEFAULT_VOLUME } from "@/lib/prefs/previewVolume";
import {
  DRESSING_KINDS,
  MAX_BLUR,
  clampBlur,
  clampFade,
  emptyDressing,
  fadeGain,
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

/** Les hachures de ce qui est écarté d'un extrait — jaunes, comme les poignées
    qui les délimitent : c'est la même information, elle a la même couleur. Le
    trait est épais et espacé, sinon la rayure se referme en aplat sur un rail
    de 8 px de haut et ne se lit plus comme une rayure. */
const HATCH =
  "repeating-linear-gradient(-45deg, rgba(250,204,21,.5) 0 3px, rgba(250,204,21,0) 3px 8px)";

/** Le fondu qu'on pose quand on active la bascule — plus court, on entend encore
    le raccord ; plus long, il mange le refrain d'un extrait de vingt secondes. */
const DEFAULT_FADE = 1.5;

/** m:ss — un générique dure une minute et demie, l'heure n'a pas lieu d'être. */
const clock = (s: number) =>
  Number.isFinite(s) && s > 0
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
    : "0:00";

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

/** Une section liste des `rows`, OU porte un bloc à elle (`node`) : le
    sélecteur de couleur n'est pas une ligne qu'on parcourt aux flèches, mais il
    appartient bien à l'onglet Couleur. */
type Section = { title: string; rows: Row[]; node?: ReactNode };

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

  /* L'écoute, dans le menu Musique. Elle ne sert qu'à choisir : le lecteur vit
     avec le menu et s'arrête en même temps que lui, puisqu'il en est retiré du
     DOM. C'est le fichier d'AnimeThemes qui est écouté ici — le rip de 90 s —
     même quand le profil jouera ensuite la version complète depuis YouTube. */
  const preview = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [len, setLen] = useState(0);
  /** Vrai tant qu'on tient le rail : le glissement déplace alors l'écoute. */
  const seeking = useRef(false);
  /** Ce qui est déjà chargé, 0 à 1 : la part du rail où sauter est instantané. */
  const [buf, setBuf] = useState(0);
  /** Le fichier a repris la main sur la lecture — on attend des données. */
  const [buffering, setBuffering] = useState(false);
  /**
   * Le volume de l'ESSAI seulement — le profil garde le sien, les deux ne sont
   * pas liés. Il part du niveau des bandes-annonces au survol : c'est du son
   * qu'on n'a pas vraiment demandé, il doit s'entendre comme une ambiance et
   * non comme une annonce.
   */
  const [vol, setVol] = useState(PREVIEW_DEFAULT_VOLUME);
  const lastVol = useRef(PREVIEW_DEFAULT_VOLUME);
  /** La poignée d'extrait en cours de déplacement, s'il y en a une. */
  const [grab, setGrab] = useState<"from" | "to" | null>(null);
  /* Cliquer une piste doit la faire entendre — mais la source ne change qu'au
     rendu suivant, d'où le drapeau plutôt qu'un `play()` immédiat sur l'ancien
     fichier. */
  const [wantPlay, setWantPlay] = useState(false);

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

  /* Le volume est posé sur l'élément et non sur la source : il survit donc au
     changement de morceau, comme dans n'importe quel lecteur. */
  useEffect(() => {
    if (preview.current) preview.current.volume = vol;
  }, [vol, draft.music?.url]);

  /** La durée du fondu de l'extrait, en secondes — 0 quand la coupe est franche. */
  const fadeSec = draft.music?.fade ?? 0;

  /** La position d'un clic sur un rail, 0 à 1. */
  const railAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  /**
   * La boucle de l'extrait, tenue à l'image près.
   *
   * `timeupdate` ne parle que toutes les 250 ms environ : en s'en servant pour
   * reboucler, on entendait à chaque tour jusqu'à un quart de seconde de ce
   * qu'on venait justement d'exclure, et le retour tombait à un endroit
   * différent à chaque fois. Une boucle d'animation regarde soixante fois par
   * seconde — le raccord se fait au même endroit, et la barre avance sans
   * saccade au passage. Elle ne tourne que pendant la lecture.
   *
   * Rien à précharger pour autant : `preload="auto"` télécharge le fichier
   * depuis son premier octet, donc le début de l'extrait est en mémoire bien
   * avant le premier tour de boucle.
   */
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = preview.current;
      if (el) {
        const f = draft.music?.from ?? 0;
        const end = draft.music?.to ?? 0;
        if (end > f && el.currentTime >= end) el.currentTime = f;
        setAt(el.currentTime);
        /* Le fondu se pose ici, dans la boucle qui tient déjà le raccord : le
           volume réglé donne le PLAFOND, le fondu le rabaisse aux extrémités. */
        const g = fadeGain(el.currentTime, f, end || el.duration || 0, fadeSec);
        const want = vol * g;
        if (Math.abs(el.volume - want) > 0.005) el.volume = want;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, draft.music?.from, draft.music?.to, fadeSec, vol]);

  useEffect(() => {
    const el = preview.current;
    if (!el || !wantPlay) return;
    setWantPlay(false);
    /* Le rail appartient au nouveau morceau : garder la position et la mémoire
       tampon du précédent, c'est afficher une seconde de mensonge. */
    setAt(0);
    setBuf(0);
    el.currentTime = draft.music?.from ?? 0;
    void el.play().catch(() => setPlaying(false));
  }, [wantPlay, draft.music?.url]);

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
      /* En pastilles à la suite, comme le choix du thème dans les réglages :
         huit couleurs empilées en huit lignes, c'était huit fois « Couleur du
         site » à lire pour choisir ce qui se voit d'un coup d'œil. Même taille,
         même anneau blanc sur la couleur retenue qu'aux réglages. */
      const swatches = [accent, ...ACCENT_PRESETS.filter((c) => c !== accent)].filter((c) =>
        match(c),
      );
      /* Un seul bloc pour tout l'onglet : le carré à gauche, et à sa droite les
         couleurs de base, le mur de nuances et la valeur. Le sélecteur en
         pleine largeur faisait 700 px de haut dans un panneau qui en offre 390
         — ici l'ensemble tient sous 250. */
      const baseSwatches = swatches.length ? (
        <div>
          <p className="pb-2 font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/35">
            {t("profile.studioColorSection")}
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            {swatches.map((c) => {
              const on = draft.kind === "color" && draft.color?.toLowerCase() === c.toLowerCase();
              return (
                <button
                  key={c}
                  type="button"
                  title={c === accent ? `${t("profile.studioColorTheme")} · ${c}` : c}
                  aria-label={c}
                  onClick={() =>
                    patch({ kind: "color", color: c, url: null, source: null, animeId: null, title: null })
                  }
                  className={`h-9 w-9 rounded-full transition-transform hover:scale-110 ${
                    on ? "ring-2 ring-white ring-offset-2 ring-offset-[#15161d]" : ""
                  }`}
                  style={{ background: c }}
                />
              );
            })}
          </div>
        </div>
      ) : null;
      out.push({
        title: "",
        rows: [],
        node: (
          <ColorPicker
            wide
            header={baseSwatches}
            value={isHexColor(draft.color) ? draft.color! : accent}
            onChange={(hex) =>
              patch({ kind: "color", color: hex, url: null, source: null, animeId: null, title: null })
            }
          />
        ),
      });
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
                    ? (patch({
                        music: {
                          url,
                          title: label,
                          artist,
                          slug: th.slug.toUpperCase(),
                          cover: listedAnime?.cover ?? null,
                          /* Un morceau qu'on vient de choisir est entier : le
                             découpage se fait ensuite, aux poignées. */
                          from: null,
                          to: null,
                          /* Le fondu SURVIT au changement de morceau : c'est un
                             goût d'écoute, pas une propriété de la piste. */
                          fade: fadeSec,
                          /* La version complète quand elle a été résolue, sinon
                             null : le profil retombe sur les 90 s d'AnimeThemes
                             plutôt que de ne rien jouer. */
                          videoId: th.youtubeId ?? null,
                        },
                      }),
                      /* Choisir une piste, c'est l'écouter : sans cela il
                         fallait appliquer pour savoir ce qu'on avait pris. */
                      setWantPlay(true))
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
       qu'un panneau, et le seul endroit où l'on passe d'un anime à l'autre.
       Mais elle ne se montre plus QU'À LA RECHERCHE : un onglet qui s'ouvre ne
       doit contenir que ce qu'il annonce — une liste d'animés sous les couleurs
       n'appartenait pas à l'onglet « Couleur ». Elle reste donc là où elle sert,
       sous une frappe, et jamais dans un onglet qui ne cherche pas d'anime. */
    const others = (!q || scope === "color" ? [] : animes)
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

    return out.filter((s) => s.rows.length > 0 || s.node);
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

  /* ── L'extrait ──────────────────────────────────────────────────────
     Sans découpe, l'extrait vaut tout le fichier : les bornes ne sont écrites
     dans le brouillon qu'à partir du moment où on y a touché. */
  const from = draft.music?.from ?? 0;
  const to = draft.music?.to ?? len;
  const pct = (s: number) => (len ? Math.min(100, Math.max(0, (s / len) * 100)) : 0);

  /** Poser l'écoute à une fraction du rail, en la gardant DANS l'extrait : le
      son entendu doit être celui qui sera joué sur le profil. */
  const seek = (ratio: number) => {
    const el = preview.current;
    if (!el || !len) return;
    const p = Math.min(to, Math.max(from, ratio * len));
    el.currentTime = p;
    setAt(p);
  };

  /** Déplacer une borne. La seconde borne ne bouge pas, mais elle repousse la
      première : un extrait plus court que trois secondes ne s'entend pas. */
  const setTrim = (edge: "from" | "to", raw: number) => {
    if (!draft.music || !len) return;
    const MIN = 3;
    const s = Math.min(len, Math.max(0, raw));
    const next =
      edge === "from"
        ? { from: Math.max(0, Math.min(s, to - MIN)), to }
        : { from, to: Math.min(len, Math.max(s, from + MIN)) };
    patch({ music: { ...draft.music, ...next } });
    /* La tête de lecture doit rester DANS l'extrait, sinon on entend du son qui
       ne sera jamais joué sur le profil. */
    const el = preview.current;
    if (el && (el.currentTime < next.from || el.currentTime > next.to)) {
      el.currentTime = next.from;
      setAt(next.from);
    }
  };

  /* L'onglet Couleur ne cherche rien : ses couleurs sont toutes à l'écran. */
  const searchable = scope !== "color";
  const ScopeIcon = !scope || scope === "music" ? SpeakerWaveIcon : KIND_ICON[scope];

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
            presque rien au milieu, là où l'on regarde l'image.

            Sur un APLAT DE COULEUR il s'allège de moitié : la barre et le dock
            portent leur propre fond depuis qu'ils sont opaques, et une couleur
            vue à travers un voile à 0,88 n'est plus la couleur qu'on vient de
            choisir — l'aperçu doit montrer ce qui sera appliqué. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              shown.kind === "color"
                ? "linear-gradient(to bottom, rgba(6,7,10,.5) 0%, rgba(6,7,10,.12) 14%, rgba(6,7,10,.08) 52%, rgba(6,7,10,.5) 100%)"
                : "linear-gradient(to bottom, rgba(6,7,10,.82) 0%, rgba(6,7,10,.25) 14%, rgba(6,7,10,.18) 52%, rgba(6,7,10,.88) 100%)",
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
          {/* Plus AUCUNE ancre en pointe sous le panneau : la flèche visait un
              bouton qui bouge d'un onglet à l'autre, donc elle en désignait un
              autre une fois sur deux. Le panneau se tient à distance du dock et
              se laisse lire seul. */}
          {/* `pointer-events-none` sur la bande, `auto` sur le panneau : sans
              cela, cliquer À CÔTÉ du panneau — la bande le traverse d'un bord à
              l'autre de l'écran — tombait sur ce conteneur et non sur le voile
              en dessous, et le menu ne se fermait pas. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-[10rem] z-30 flex justify-center px-4">
            <div className="pointer-events-auto w-full max-w-3xl overflow-hidden rounded-2xl bg-[#15161d] shadow-[0_28px_70px_rgba(0,0,0,.75)] ring-1 ring-white/10">
              <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3.5">
                {/* L'onglet Couleur n'a rien à chercher : ses couleurs tiennent
                    toutes à l'écran. Il porte donc son titre, pas un champ qui
                    ne filtrerait rien. */}
                {searchable ? (
                  <>
                    <MagnifyingGlassIcon className="h-5 w-5 shrink-0 text-white/45" />
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-action px-3 py-1 font-karla text-[12px] font-bold text-white">
                      {t(`profile.studioKind_${scope}`)}
                    </span>
                    <input
                      ref={search}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("profile.studioSearch")}
                      className="min-w-0 flex-1 bg-transparent font-karla text-[15px] text-white outline-none placeholder:text-white/35"
                    />
                  </>
                ) : (
                  <>
                    <ScopeIcon className="h-5 w-5 shrink-0 text-white/45" />
                    <h2 className="min-w-0 flex-1 font-outfit text-[15px] font-bold text-white">
                      {t(`profile.studioKind_${scope}`)}
                    </h2>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setScope(null)}
                  className="shrink-0 rounded-lg p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                  aria-label={t("common.close", { defaultValue: "Close" })}
                >
                  <XMarkIcon className="h-[1.15rem] w-[1.15rem]" />
                </button>
              </div>

              <div className="max-h-[54vh] overflow-y-auto p-2.5">
                {loading && flat.length === 0 ? (
                  <div className="space-y-1.5 p-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
                    ))}
                  </div>
                ) : sections.length === 0 ? (
                  <p className="px-3 py-10 text-center font-karla text-[15px] text-white/45">
                    {t("profile.studioNoResult")}
                  </p>
                ) : (
                  sections.map((s, i) => (
                    <div key={s.title || `sec-${i}`}>
                      {/* Un bloc peut porter son propre intitulé (le sélecteur de
                          couleur nomme lui-même ses deux moitiés) : on ne lui en
                          impose pas un second. */}
                      {s.title ? (
                        <p className="px-3 pb-1.5 pt-3 font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/35">
                          {s.title}
                        </p>
                      ) : null}
                      {s.node ? <div className="px-1 pb-1">{s.node}</div> : null}
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
                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                              row.disabled
                                ? "cursor-not-allowed opacity-45"
                                : active
                                  ? /* Le survol (et la navigation au clavier,
                                       qui partagent ce curseur) pose une BOÎTE
                                       GRISE, pas un cadre rose : le rose disait
                                       « choisi » alors que la coche, elle, le
                                       dit déjà — deux marques pour deux états
                                       différents rendaient la ligne survolée
                                       indiscernable de la ligne active. */
                                    "bg-white/[0.09]"
                                  : ""
                            }`}
                          >
                            {row.thumb ? (
                              <span className="relative h-9 w-16 shrink-0 overflow-hidden rounded-md bg-black/50">
                                <Image src={row.thumb} alt="" fill sizes="64px" className="object-cover" />
                              </span>
                            ) : row.color ? (
                              <span
                                className="h-8 w-8 shrink-0 rounded-full ring-1 ring-white/20"
                                style={{ background: row.color }}
                              />
                            ) : Icon ? (
                              <Icon className="h-5 w-5 shrink-0 text-white/55" />
                            ) : null}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-outfit text-[14px] font-bold text-white/90">
                                {row.label}
                              </span>
                              {row.hint ? (
                                <span className="block truncate font-karla text-[12px] text-white/40">
                                  {row.hint}
                                </span>
                              ) : null}
                            </span>
                            {row.selected ? (
                              <CheckIcon className="h-[1.15rem] w-[1.15rem] shrink-0 text-action" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>

              {/* ── L'écoute ──────────────────────────────────────────────
                  `select-none` sur tout le pied : un glissé qui commence sur le
                  rail et finit sur le titre surlignait le texte au passage, et
                  le curseur d'interdiction du glisser-déposer apparaissait
                  par-dessus. */}
              {scope === "music" && draft.music ? (
                <div className="flex select-none items-center gap-3 border-t border-white/[0.07] bg-black/25 px-4 py-3">
                  {/* La pochette EST le bouton, comme dans un lecteur de
                      musique : l'image porte le triangle, au lieu d'une pastille
                      rose posée à côté qui doublait la mise. */}
                  <button
                    type="button"
                    onClick={() => {
                      const el = preview.current;
                      if (!el) return;
                      if (el.paused) {
                        if (el.currentTime < from || el.currentTime > to) el.currentTime = from;
                        void el.play().catch(() => setPlaying(false));
                      } else el.pause();
                    }}
                    aria-label={t(playing ? "profile.studioMusicPause" : "profile.studioMusicPlay")}
                    className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-black/50 ring-1 ring-white/10"
                  >
                    {draft.music.cover ? (
                      <Image src={draft.music.cover} alt="" fill sizes="44px" className="object-cover" />
                    ) : null}
                    <span className="absolute inset-0 grid place-items-center bg-black/45 text-white transition-colors group-hover:bg-black/60">
                      {buffering ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      ) : playing ? (
                        <PauseIcon className="h-5 w-5 drop-shadow" />
                      ) : (
                        <PlayIcon className="ml-0.5 h-5 w-5 drop-shadow" />
                      )}
                    </span>
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-outfit text-[13px] font-bold text-white">
                      {draft.music.title}
                      {draft.music.videoId ? (
                        <span className="ml-2 rounded bg-white/[0.08] px-1.5 py-0.5 align-middle font-karla text-[10px] font-bold uppercase tracking-[.08em] text-white/45">
                          {t("profile.studioMusicFull")}
                        </span>
                      ) : null}
                    </p>
                    {/* Le rail découpe l'extrait AUTANT qu'il montre la lecture.
                        Les deux poignées jaunes bornent ce qui sera joué sur le
                        profil ; entre elles, le rose dit où en est l'écoute.
                        Cliquer dans le rail déplace la lecture, saisir une
                        poignée déplace la borne — d'où le `data-grab` : sans
                        lui, attraper une poignée aurait aussi fait sauter le
                        son à cet endroit. */}
                    <div className="mt-2 flex items-center gap-2">
                      <span className="w-9 shrink-0 text-right font-mono text-[10px] text-white/40">
                        {clock(at)}
                      </span>
                      {/* Le rail s'écoute EN GLISSANT, pas seulement au clic :
                          chercher un refrain, c'est balayer le morceau, et un
                          rail qui ne répond qu'au relâchement oblige à cliquer
                          dix fois pour trouver le bon endroit. Le pointeur est
                          capturé, donc le geste survit à une sortie du rail —
                          sans quoi il s'interrompait au premier écart vertical.
                          `data-grab` laisse les poignées à leur propre geste.

                          Le « on tient » vit dans une RÉFÉRENCE et non dans un
                          état : les remplissages du rail se redessinent à chaque
                          image pendant le glissement, et le gestionnaire de
                          `pointermove` lisait un état d'avant le rendu — le
                          geste mourait dès qu'il partait de la zone jouée, celle
                          qui bouge le plus. */}
                      <div
                        onPointerDown={(e) => {
                          if ((e.target as HTMLElement).dataset.grab) return;
                          /* Sans ça, le navigateur voit un glissé de SÉLECTION
                             (le pied du panneau est du texte) et affiche son
                             curseur d'interdiction par-dessus le geste. */
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          seeking.current = true;
                          seek(railAt(e));
                        }}
                        onPointerMove={(e) => {
                          if (seeking.current && e.buttons & 1) seek(railAt(e));
                        }}
                        onPointerUp={() => {
                          seeking.current = false;
                        }}
                        onPointerCancel={() => {
                          seeking.current = false;
                        }}
                        className="relative h-2 flex-1 cursor-pointer touch-none rounded-full bg-white/[0.09]"
                      >
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-white/[0.14]"
                          style={{ width: `${buf * 100}%` }}
                        />
                        {/* Ce qui NE SERA PAS joué part en hachures : une zone
                            simplement plus sombre se confond avec un rail vide,
                            alors qu'une rayure dit « écarté » sans légende.
                            Elles se posent sur le gris clair de la mémoire
                            tampon, TOUJOURS, et non sur ce qui est réellement
                            chargé : le bord du tampon y dessinait une marche,
                            c'est-à-dire un chargement à moitié fait dans une
                            zone qui ne sera jamais jouée. */}
                        {from > 0 ? (
                          <span
                            className="absolute inset-y-0 left-0 rounded-l-full bg-white/[0.14]"
                            style={{ width: `${pct(from)}%`, backgroundImage: HATCH }}
                          />
                        ) : null}
                        {to < len ? (
                          <span
                            className="absolute inset-y-0 right-0 rounded-r-full bg-white/[0.14]"
                            style={{ left: `${pct(to)}%`, backgroundImage: HATCH }}
                          />
                        ) : null}
                        {/* L'extrait retenu, éclairci entre ses deux bornes. */}
                        <span
                          className="absolute inset-y-0 rounded-full bg-white/[0.18]"
                          style={{ left: `${pct(from)}%`, right: `${100 - pct(to)}%` }}
                        />
                        <span
                          className="absolute inset-y-0 rounded-full bg-action"
                          style={{
                            left: `${pct(from)}%`,
                            right: `${100 - pct(Math.min(Math.max(at, from), to))}%`,
                          }}
                        />
                        {([
                          ["from", from] as const,
                          ["to", to] as const,
                        ]).map(([edge, value]) => (
                          <span
                            key={edge}
                            data-grab="1"
                            role="slider"
                            tabIndex={0}
                            aria-label={t(
                              edge === "from" ? "profile.studioMusicFrom" : "profile.studioMusicTo",
                            )}
                            aria-valuemin={0}
                            aria-valuemax={Math.round(len)}
                            aria-valuenow={Math.round(value)}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              e.currentTarget.setPointerCapture(e.pointerId);
                              setGrab(edge);
                            }}
                            onPointerMove={(e) => {
                              if (grab !== edge || !len) return;
                              const r = e.currentTarget.parentElement!.getBoundingClientRect();
                              const s = ((e.clientX - r.left) / r.width) * len;
                              setTrim(edge, s);
                            }}
                            onPointerUp={() => setGrab(null)}
                            onKeyDown={(e) => {
                              const step = e.shiftKey ? 5 : 1;
                              if (e.key === "ArrowLeft") setTrim(edge, value - step);
                              else if (e.key === "ArrowRight") setTrim(edge, value + step);
                              else return;
                              e.preventDefault();
                            }}
                            className="absolute top-1/2 h-4 w-[7px] -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none rounded-full bg-[#facc15] shadow-[0_1px_4px_rgba(0,0,0,.6)] outline-none ring-offset-2 ring-offset-[#15161d] focus-visible:ring-2 focus-visible:ring-[#facc15]"
                            style={{ left: `${pct(value)}%` }}
                          />
                        ))}
                      </div>
                      <span className="w-9 shrink-0 font-mono text-[10px] text-white/40">
                        {clock(len)}
                      </span>

                      {/* Le fondu, en une seule bascule et non deux : « entrée »
                          et « sortie » séparés, c'est deux réglages pour un seul
                          geste — on veut que la boucle ne claque pas, pas régler
                          chaque bout. Un défaut d'1,5 s, assez pour effacer le
                          raccord sans manger le refrain. */}
                      <button
                        type="button"
                        onClick={() =>
                          draft.music &&
                          patch({
                            music: {
                              ...draft.music,
                              fade: clampFade(fadeSec > 0 ? 0 : DEFAULT_FADE),
                            },
                          })
                        }
                        aria-pressed={fadeSec > 0}
                        title={t("profile.studioMusicFadeHint")}
                        className={`h-6 shrink-0 rounded-full px-2.5 font-karla text-[11px] font-bold uppercase tracking-[.06em] ring-1 transition-colors ${
                          fadeSec > 0
                            ? "bg-action/20 text-white ring-action/50"
                            : "bg-white/[0.07] text-white/45 ring-white/[0.06] hover:text-white"
                        }`}
                      >
                        {t("profile.studioMusicFade")}
                      </button>

                      {/* Le volume dans sa propre pastille : posé à même le pied
                          du panneau, il flottait entre le minutage et le bord et
                          on ne voyait pas où commençait la commande. Le fond la
                          délimite, comme les pastilles de valeur des réglages de
                          widget. Le haut-parleur coupe et rétablit — c'est le
                          geste qu'on cherche en premier, et il évite d'avoir à
                          viser le zéro du rail. */}
                      <div className="flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-2 ring-1 ring-white/[0.06]">
                      <button
                        type="button"
                        onClick={() =>
                          setVol((v) => {
                            /* Rétablir rend le niveau qu'on avait réglé, pas un
                               volume plein qui ferait sursauter. */
                            if (v > 0) {
                              lastVol.current = v;
                              return 0;
                            }
                            return lastVol.current;
                          })
                        }
                        aria-label={t(vol > 0 ? "profile.studioMusicMute" : "profile.studioMusicUnmute")}
                        className="shrink-0 text-white/45 transition-colors hover:text-white"
                      >
                        {vol > 0 ? (
                          <SpeakerWaveIcon className="h-4 w-4" />
                        ) : (
                          <SpeakerXMarkIcon className="h-4 w-4" />
                        )}
                      </button>
                      {/* Le curseur de volume est celui du site : remplissage à
                          l'accent, pastille blanche cerclée d'accent — le même
                          que le lecteur vidéo et que le flou du dock. Une barre
                          pleine sans pastille ne disait pas qu'elle se prend en
                          main. Le rail est ici à 4 px et non 3 : la pastille qui
                          l'enferme est courte, et un trait de 3 px au milieu de
                          28 px de fond se lisait comme une grosse boîte autour
                          d'un fil. */}
                      <div
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setVol(railAt(e));
                        }}
                        onPointerMove={(e) => {
                          if (e.buttons & 1) setVol(railAt(e));
                        }}
                        role="slider"
                        tabIndex={0}
                        aria-label={t("profile.studioMusicVolume")}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(vol * 100)}
                        onKeyDown={(e) => {
                          const step = e.shiftKey ? 0.2 : 0.05;
                          if (e.key === "ArrowLeft") setVol((v) => Math.max(0, v - step));
                          else if (e.key === "ArrowRight") setVol((v) => Math.min(1, v + step));
                          else return;
                          e.preventDefault();
                        }}
                        className="relative h-4 w-[72px] shrink-0 cursor-pointer touch-none rounded-full outline-none"
                      >
                        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/12" />
                        <span
                          className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-action"
                          style={{ width: `${vol * 100}%` }}
                        />
                        <span
                          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-action bg-white shadow-[0_1px_4px_rgba(0,0,0,.5)]"
                          style={{ left: `${vol * 100}%` }}
                        />
                      </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {/* ── Le lecteur ────────────────────────────────────────────────────
          Il vit ICI, à la racine de l'écran, et non dans le menu Musique.
          Deux raisons, et la seconde est la plus visible :

          1. Un élément démonté puis remonté RECHARGE sa source. Tant que le
             lecteur appartenait au menu, refermer et rouvrir celui-ci jetait la
             lecture en cours et redemandait le fichier. Ici il traverse
             l'ouverture et la fermeture sans rien perdre.
          2. Le dock affiche la progression, donc il lui faut un lecteur qui
             tourne encore quand le menu est fermé.

          `preload="auto"` et pas `metadata` : en « metadata » le navigateur n'a
          que l'en-tête, et chaque saut dans le morceau redemandait sa plage au
          serveur avant de reprendre. Un générique pèse ~2 Mo — chargé une fois,
          il ne fait plus jamais attendre. */}
      {draft.music ? (
        <audio
          ref={preview}
          src={draft.music.url}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onCanPlay={() => setBuffering(false)}
          onLoadedMetadata={(e) => setLen(e.currentTarget.duration || 0)}
          /* Le suivi fin appartient à la boucle d'animation ci-dessus ; celui-ci
             ne sert qu'à l'arrêt, où il n'y a pas de boucle qui tourne. */
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          onProgress={(e) => {
            const el = e.currentTarget;
            const b = el.buffered;
            setBuf(b.length && el.duration ? b.end(b.length - 1) / el.duration : 0);
          }}
        />
      ) : null}

      {/* ── Le dock ───────────────────────────────────────────────────── */}
      <div className="absolute inset-x-0 bottom-6 z-30 flex justify-center px-3">
        <div className="flex max-w-full items-center gap-1.5 overflow-x-auto rounded-[1.5rem] bg-[#15161d]/90 p-3 shadow-[0_18px_44px_rgba(0,0,0,0.6)] ring-1 ring-white/10 backdrop-blur-xl scrollbar-hide">
          {DRESSING_KINDS.map(({ id }) => {
            const Icon = KIND_ICON[id];
            /* Le rose dit UNIQUEMENT « ce menu est ouvert ». Il disait aussi
               « c'est le type du brouillon », et une fois le menu refermé un
               bouton restait allumé sans rien désigner d'ouvert. */
            const on = scope === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => openScope(id)}
                title={t(`profile.studioKind_${id}`)}
                aria-label={t(`profile.studioKind_${id}`)}
                className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl transition-colors ${
                  on
                    ? "bg-action text-white"
                    : "text-white/55 hover:bg-white/[0.08] hover:text-white"
                }`}
              >
                <Icon className="h-[1.4rem] w-[1.4rem]" strokeWidth={1.7} />
              </button>
            );
          })}

          <span className="mx-2 h-8 w-px shrink-0 bg-white/10" />

          {/* Deux commandes, pas une. La pochette lance et arrête ; le texte
              ouvre le menu. Un seul bouton pour les deux gestes obligeait à
              ouvrir le menu pour couper le son, ce qui est l'inverse de ce
              qu'on veut d'un lecteur. Ils ne peuvent pas être imbriqués — un
              bouton dans un bouton n'existe pas en HTML — d'où la boîte. */}
          <div
            className={`relative flex w-56 shrink-0 items-center gap-3 rounded-2xl px-2.5 py-3 transition-colors ${
              /* Le survol allume le MÊME fond que l'ouverture, en plus discret :
                 sans lui, le seul bloc cliquable du dock qui ne réagissait pas
                 au passage de la souris était celui qui en a le plus l'air. */
              scope === "music" ? "bg-white/[0.10]" : "hover:bg-white/[0.06]"
            }`}
          >
            {draft.music ? (
              <button
                type="button"
                onClick={() => {
                  const el = preview.current;
                  if (!el) return;
                  if (el.paused) {
                    if (el.currentTime < from || el.currentTime > to) el.currentTime = from;
                    void el.play().catch(() => setPlaying(false));
                  } else el.pause();
                }}
                aria-label={t(playing ? "profile.studioMusicPause" : "profile.studioMusicPlay")}
                className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-black/50"
              >
                {draft.music.cover ? (
                  <Image src={draft.music.cover} alt="" fill sizes="44px" className="object-cover" />
                ) : null}
                <span className="absolute inset-0 grid place-items-center bg-black/45 text-white transition-colors group-hover:bg-black/65">
                  {buffering ? (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : playing ? (
                    <PauseIcon className="h-4 w-4 drop-shadow" />
                  ) : (
                    <PlayIcon className="ml-0.5 h-4 w-4 drop-shadow" />
                  )}
                </span>
              </button>
            ) : (
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/[0.07] text-white/45">
                <SpeakerWaveIcon className="h-5 w-5" strokeWidth={1.7} />
              </span>
            )}
            <button
              type="button"
              onClick={() => openScope("music")}
              className="min-w-0 flex-1 rounded-lg text-left"
            >
              <span className="block truncate font-outfit text-[13.5px] font-bold text-white">
                {draft.music ? draft.music.title : t("profile.studioMusicNone")}
              </span>
              <span className="block truncate font-karla text-[11.5px] leading-snug text-white/40">
                {draft.music
                  ? [draft.music.artist, draft.music.slug].filter(Boolean).join(" · ")
                  : t("profile.studioMusicAdd")}
              </span>
              {/* La progression sous le texte, donc alignée sur lui et à droite
                  de la pochette — elle appartient au titre qu'elle suit, pas au
                  bloc entier. Elle ne montre QUE l'extrait retenu : c'est lui
                  qui tourne. */}
              {draft.music && to > from ? (
                <span className="mt-1.5 block h-[3px] w-full overflow-hidden rounded-full bg-white/12">
                  <span
                    className="block h-full rounded-full bg-action"
                    style={{
                      width: `${((Math.min(Math.max(at, from), to) - from) / (to - from)) * 100}%`,
                    }}
                  />
                </span>
              ) : null}
            </button>
          </div>

          <span className="mx-2 h-8 w-px shrink-0 bg-white/10" />

          {/* Le curseur du flou reprend `as-range` : même rail, même pastille
              cerclée d'accent que les réglages de widget. Il n'a qu'une poignée,
              donc on lui rend le clic sur le rail (`pointer-events-auto`), que la
              version à deux poignées doit, elle, désactiver pour ne pas se voler
              les clics. */}
          <label className="flex w-52 shrink-0 flex-col gap-2 px-2">
            <span className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-karla text-[12px] font-bold uppercase tracking-[.08em] text-white/45">
                <AdjustmentsHorizontalIcon className="h-4 w-4" strokeWidth={2} />
                {t("profile.studioBlur")}
              </span>
              <span className="rounded-md bg-white/[0.07] px-2 py-0.5 font-karla text-[12px] font-bold text-white/80">
                {draft.blur} px
              </span>
            </span>
            <span className="as-range relative block h-4 w-full">
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
