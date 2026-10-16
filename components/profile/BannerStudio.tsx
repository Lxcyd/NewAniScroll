import Image from "next/image";
import { audioFirst } from "@/lib/animethemes/audioUrl";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/* Le recalage du défilement doit passer avant que l'écran ne se peigne ; côté
   serveur, `useLayoutEffect` ne fait qu'avertir. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;
import { useTranslation } from "react-i18next";
import {
  AdjustmentsHorizontalIcon,
  ArrowUpTrayIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUturnLeftIcon,
  ArrowsUpDownIcon,
  Bars4Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilmIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  MusicalNoteIcon,
  PlusIcon,
  PhotoIcon,
  QueueListIcon,
  RectangleGroupIcon,
  RectangleStackIcon,
  ScissorsIcon,
  SparklesIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  Squares2X2Icon,
  SwatchIcon,
  TrophyIcon,
  ViewColumnsIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { CheckIcon, HeartIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/solid";

import type { TrailerRemote } from "@/components/profile/PlateBackground";
import YouTubeMusic, { type MusicMedia } from "@/components/profile/YouTubeMusic";
import type { StudioBridge } from "@/components/profile/ProfileHero";
import { FrameTileImage } from "@/components/profile/FramedAvatar";
import LayoutThumb from "@/components/profile/LayoutThumb";
import BadgePicker from "@/components/profile/BadgePicker";
import { FEATURED_MAX } from "@/components/profile/FeaturedBadges";
import { BY_ID, RARITY_ORDER, type Rarity } from "@/lib/badges/catalog";
import { RING_HUE, ringSwatch } from "@/components/profile/badges/rarity";
import { Dropdown } from "@/components/profile/WidgetSettings";
import type { FrameCollection } from "@/lib/profile/frames";
import { collectArtworks, customListColor, LIST_COLORS, listLabel, STATUS_TO_LIST } from "@/components/anime/v2/helpers";
import { Range as ScoreRange } from "@/components/profile/WidgetSettings";
import { customListNames, entryTitle } from "@/lib/profile/insights";
import {
  clampWallSpeed,
  defaultWall,
  inList,
  wallCandidates,
  wallEntries,
  WALL_DIRS,
  WALL_SPEED_MAX,
  WALL_SPEED_MIN,
  type DressingWall,
} from "@/lib/profile/wall";
import { fetchFanarts, useFanarts } from "@/lib/hooks/useFanarts";
import { fetchTmdbArtworks, useTmdbArtworks } from "@/lib/hooks/useTmdbArtworks";
import { fetchPage, useWallhaven } from "@/lib/hooks/useWallhaven";
import { byQuality } from "@/lib/images/artQuality";
import ColorPicker from "@/components/shared/ColorPicker";
import {
  clampPatternSpeed,
  clampPatternZoom,
  PATTERN_IDS,
  PATTERN_SPEED_MAX,
  PATTERN_SPEED_MIN,
  PATTERN_ZOOM_MAX,
  PATTERN_ZOOM_MIN,
  PATTERN_ZOOM_STEP,
  patternBackground,
} from "@/lib/profile/patterns";
import { ACCENT_PRESETS, useAccent } from "@/lib/prefs/accentColor";
import { PREVIEW_DEFAULT_VOLUME } from "@/lib/prefs/previewVolume";
import {
  DEFAULT_VIDEO_FADE,
  DRESSING_KINDS,
  HERO_LAYOUTS,
  MAX_BLUR,
  SCALE_MAX,
  SCALE_MIN,
  clampScale,
  clampBlur,
  clampFade,
  emptyDressing,
  fadeGain,
  hasOwnPlate,
  isHexColor,
  isVideoKind,
  pleineTaille,
  type Dressing,
  type DressingKind,
  type HeroLayout,
} from "@/lib/profile/dressing";
import type { BannerOption, ProfileEntry } from "@/lib/profile/types";

/**
 * Le studio : l'écran plein où l'on habille son profil.
 *
 * Deux partis pris, tenus depuis les maquettes et à ne pas défaire par
 * commodité :
 *
 *   1. L'APERÇU EST LE PROFIL. Plus d'écran à part : depuis le 09/10/2026 le
 *      studio est fusionné avec le mode réorganisation des widgets. La VRAIE
 *      page recule dans un cadre (« mode scène », ProfileStage) et montre le
 *      brouillon (via `onDraft`, cf. `previewBanner` dans ProfileHero) ; les
 *      outils occupent la marge libérée, rien ne flotte plus par-dessus le
 *      profil. La flèche rend au profil sa taille et ne garde qu'une pilule.
 *      Une grille de propositions à droite a existé dans une première
 *      version — elle doublait ce que la palette montre déjà.
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

/** La recherche d'animés du studio chez AniList : le strict nécessaire pour
    une ligne (titre, affiche). Le reste vient de la fiche quand on l'ouvre. */
const STUDIO_SEARCH = `query ($search: String) {
  Page(perPage: 12) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
      id
      title { userPreferred english romaji }
      coverImage { medium }
    }
  }
}`;

export type StudioAnime = {
  mediaId: number;
  title: string;
  cover?: string | null;
  /** Identifiant YouTube de la bande-annonce, quand AniList en connaît une. */
  trailer?: string | null;
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
  /** `stats` : les quatre chiffres du haut de profil, déjà formatés — les
      vignettes d'agencement les écrivent à leur place. */
  identity: { name: string; avatar: string | null; stats?: string[] };
  /** `null` dépingle et rend le profil à son anime préféré. */
  onApply: (value: Dressing | null) => void;
  /** Le brouillon, à chaque changement : la page le montre en direct. */
  onDraft?: (draft: Dressing) => void;
  /** Le lecteur du fond vidéo vit dans la page (ProfileHero), pas ici. */
  bridge?: StudioBridge;
  /** Réduit ou non : la page sort de la scène quand le studio est réduit. */
  onMini?: (mini: boolean) => void;
  /** La liste du profil : le mur d'animés y prend ses affiches. */
  entries?: ProfileEntry[];
  /** Les badges obtenus (id → date) : le menu Badges y choisit les cinq mis en avant. */
  earned?: Record<string, number> | null;
};

/** L'icône de l'agencement : UNE pour tous (16/10/2026), quatre tuiles
    (Material Symbols « grid_view », choisie par Luc). Une par agencement
    (lignes, cercle, colonnes, devanture…) ne se lisait jamais comme la forme
    qu'elle voulait évoquer ; le nom écrit à côté suffit à les distinguer. */
function LayoutIcon({ className }: { className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" className={className} aria-hidden>
      <path d="M200-520q-33 0-56.5-23.5T120-600v-160q0-33 23.5-56.5T200-840h160q33 0 56.5 23.5T440-760v160q0 33-23.5 56.5T360-520H200Zm0 400q-33 0-56.5-23.5T120-200v-160q0-33 23.5-56.5T200-440h160q33 0 56.5 23.5T440-360v160q0 33-23.5 56.5T360-120H200Zm400-400q-33 0-56.5-23.5T520-600v-160q0-33 23.5-56.5T600-840h160q33 0 56.5 23.5T840-760v160q0 33-23.5 56.5T760-520H600Zm0 400q-33 0-56.5-23.5T520-200v-160q0-33 23.5-56.5T600-440h160q33 0 56.5 23.5T840-360v160q0 33-23.5 56.5T760-120H600ZM200-600h160v-160H200v160Zm400 0h160v-160H600v160Zm0 400h160v-160H600v160Zm-400 0h160v-160H200v160Zm400-400Zm0 240Zm-240 0Zm0-240Z" />
    </svg>
  );
}

const KIND_ICON: Record<DressingKind, typeof PhotoIcon> = {
  color: SwatchIcon,
  wall: RectangleGroupIcon,
  banner: PhotoIcon,
  anim: SparklesIcon,
  /* Une image, pas une grille : c'est l'icône du groupe « Fond » du dock
     (image, bannière, mur), le premier choix qu'on y fait (16/10/2026). */
  image: PhotoIcon,
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

/**
 * La position de lecture telle que le studio l'AFFICHE, au dixième de seconde.
 * Les boucles de lecture tournent à chaque image (raccord et fondu l'exigent),
 * mais une position brute changeait l'état à chaque image : le studio entier se
 * rendait soixante fois par seconde tant qu'un fond vidéo jouait, et la scène
 * saccadait en reculant. Arrondie, la valeur ne change que dix fois par seconde
 * et React ignore les rendus intermédiaires — sur un rail de générique, un
 * dixième de seconde ne se voit pas.
 */
const railTime = (s: number) => Math.round(s * 10) / 10;

/* Les comptes d'illustrations par animé et par type (/api/v2/art-counts),
   pour la session : un studio rouvert ne les redemande pas. */
let ART_TYPES: Record<number, Record<string, number>> = {};
const ART_DEMANDES = new Set<number>();

/* LA VIGNETTE D'UNE TUILE fanart.tv. Le proxy sert l'image entière
   (1920×1080, ~115 Ko) et, sous `/preview/`, une réduction de 200×112
   (4,7 Ko) : trop petite pour la tuile, elle tient lieu de fond flou le temps
   que l'image arrive — et c'est elle qu'on précharge en premier. */
const apercuDe = (url: string | null | undefined): string | null =>
  url && /^https:\/\/fanart-proxy\.[^/]+\/fanart\//.test(url)
    ? url.replace("/fanart/", "/preview/")
    : null;

/* Les images déjà demandées au navigateur pendant la session : une URL ne part
   qu'une fois, même si l'on rouvre l'animé. */
const PRECHARGEES = new Set<string>();
/** Téléchargements de préchargement simultanés : assez pour remplir la file
    vite, pas assez pour voler la bande passante des tuiles visibles. */
const PRECHARGE_PARALLELE = 4;
/** La taille de page de /api/v2/wallhaven (PAR_PAGE de lib/wallhaven/artworks.ts). */
const WALL_PAR_PAGE = 24;

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
  /** Pastille de nature — OP en accent, ED en bleu, comme sur la fiche anime. */
  chip?: { text: string; op: boolean; color?: string } | null;
  thumb?: string | null;
  /** Vignette carrée (pochette d'un générique) plutôt qu'en paysage. */
  square?: boolean;
  color?: string | null;
  icon?: typeof PhotoIcon;
  disabled?: boolean;
  selected?: boolean;
  /** Une ligne d'accordéon (fermée) : un chevron au bout dit qu'elle se déplie. */
  expand?: boolean;
  /** La vignette est une affiche : en portrait, pas en 16/9. */
  cover?: boolean;
  /** Grisée sans être désactivée : rien à y prendre, mais on peut l'ouvrir. */
  dim?: boolean;
  /** Survol prolongé : précharge ce que le clic ouvrira (`null` à la sortie). */
  hover?: (on: boolean) => void;
  run?: () => void;
};

/** Une section liste des `rows`, OU porte un bloc à elle (`node`) : le
    sélecteur de couleur n'est pas une ligne qu'on parcourt aux flèches, mais il
    appartient bien à l'onglet Couleur. */
type Section = {
  title: string;
  rows: Row[];
  node?: ReactNode;
  /** Le bloc prend toute la hauteur que la colonne laisse (le sélecteur de
      couleur) : le menu est rempli, sans barre de défilement. */
  grow?: boolean;
  /** Avec `grow` : le bloc tient DANS la colonne (`min-h-0`) et fait défiler
      son propre contenu, au lieu d'allonger la colonne (le mur d'animés). */
  fill?: boolean;
  /* Les illustrations se rendent EN GRILLE, cote a cote et en grand : une
     image ne se choisit pas a son nom (elles n'en ont pas), elle se choisit a
     l'oeil, et une vignette de 64 px posee au bout d'une ligne ne permet pas de
     voir ce qu'on prend. */
  grid?: boolean;
  /* La grille de l'onglet Bannière. Les tuiles carrées de la grille normale
     conviennent à une image de page ; une bande de 1000×185 y apparaissait en
     filet au milieu de deux tiers de noir, et on ne distinguait pas deux
     bannières l'une de l'autre. Moins de colonnes, au format de ce qu'elles
     montrent. */
  bande?: boolean;
  /* L'animé ouvert de l'accordéon : ses sections (en-tête, puces, grille,
     « montrer plus ») se suivent dans UN même cadre teinté, pour qu'on voie où
     sa galerie commence et où reprend la liste. */
  panel?: boolean;
  /** Une grille tronquée : un fondu sur sa dernière rangée porte le bouton
      qui la déroule. */
  fondu?: { label: string; run: () => void };
  /** La grille continue d'elle-même : un repère sous sa dernière rangée
      demande la suite quand il approche de l'écran. */
  suite?: () => void;
};

/** Ce que la palette montre : un type de fond, ou la musique. */
type PaletteScope = DressingKind | "music" | "layout" | "frame" | "badges";

/** Les tris de la grille des cadres. Les quatre premiers gardent les sections
    par collection ; les trois derniers mettent tout À PLAT, une seule grille. */
type FrameSort =
  | "recent"
  | "oldest"
  | "collection"
  | "biggest"
  | "name"
  | "name_desc"
  | "random";
const FRAME_SORTS: FrameSort[] = ["recent", "oldest", "collection", "biggest", "name", "name_desc", "random"];

/** Un ordre « au hasard » STABLE : le même tirage tant qu'on ne relance pas,
    sans quoi la grille se rebattrait à chaque frappe dans la recherche. */
function shuffleKey(asset: string, seed: number): number {
  let h = seed | 0;
  for (let i = 0; i < asset.length; i++) h = Math.imul(h ^ asset.charCodeAt(i), 16777619);
  return h >>> 0;
}
/* Le menu ouvert à gauche de la scène, retenu d'une édition à l'autre sur cet
   appareil. Une commodité : sans stockage, on retombe sur Image. */
const LAST_SCOPE_KEY = "as-studio-scope";
const SCOPES: PaletteScope[] = [
  "color", "banner", "image", "wall", "video", "oped", "upload",
  "music", "layout", "frame", "badges",
];

/** Le dock regroupe les fonds de même nature : un bouton par groupe, et un
    onglet par fond dans l'en-tête du menu quand le groupe en compte plusieurs.
    Le bouton porte le nom et l'icône du premier. */
const DOCK_GROUPS: DressingKind[][] = [
  ["color"],
  /* Le mur d'animés à côté des images : c'est un fond fixe lui aussi, fait
     d'affiches au lieu d'une illustration. */
  ["image", "banner", "wall"],
  ["video", "oped"],
  ["upload"],
];
const groupOf = (k: PaletteScope | null) =>
  DOCK_GROUPS.find((g) => g.includes(k as DressingKind)) ?? null;
function readLastScope(): PaletteScope {
  try {
    const v = localStorage.getItem(LAST_SCOPE_KEY) as PaletteScope | null;
    if (v && SCOPES.includes(v)) return v;
  } catch {
    /* stockage refusé : le défaut */
  }
  return "image";
}
function writeLastScope(s: PaletteScope) {
  try {
    localStorage.setItem(LAST_SCOPE_KEY, s);
  } catch {
    /* stockage refusé : rien à retenir */
  }
}

/* LE CACHE MUSIQUE SURVIT AU RECHARGEMENT (16/10/2026). Génériques et
   pochettes d'un anime ne bougent pas d'un jour à l'autre : rouvrir le studio,
   ou un anime déjà vu, ne refait plus aucune requête. Sept jours, cent
   cinquante animés au plus (les plus anciens sortent). */
const MUSIC_KEY = "as-music-cache-v1";
const MUSIC_TTL = 7 * 24 * 3600 * 1000;
type MusicStore = Record<string, { t?: ThemeRow[]; c?: Record<string, string | null>; at: number }>;
function readMusicStore(): MusicStore {
  try {
    const raw = JSON.parse(localStorage.getItem(MUSIC_KEY) || "{}") as MusicStore;
    const now = Date.now();
    for (const k of Object.keys(raw)) if (!(now - raw[k].at < MUSIC_TTL)) delete raw[k];
    return raw;
  } catch {
    return {};
  }
}
function writeMusicStore(store: MusicStore) {
  try {
    const keys = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
    for (const k of keys.slice(150)) delete store[k];
    localStorage.setItem(MUSIC_KEY, JSON.stringify(store));
  } catch {
    /* stockage plein ou refusé : le cache reste en mémoire */
  }
}

/* LA DENSITÉ DE LA GRILLE D'ILLUSTRATIONS (Image, Bannière) : une image par
   rangée pour bien voir, deux ou trois pour comparer, beaucoup pour balayer.
   Retenue par navigateur, comme le dernier onglet. */
type Densite = 1 | 2 | 3;
const DENSITE_KEY = "aniscroll:studioDensite";
function readDensite(): Densite {
  try {
    const v = Number(localStorage.getItem(DENSITE_KEY));
    if (v === 1 || v === 2 || v === 3) return v;
  } catch {
    /* stockage refusé : le défaut */
  }
  return 2;
}
function writeDensite(d: Densite) {
  try {
    localStorage.setItem(DENSITE_KEY, String(d));
  } catch {
    /* stockage refusé : rien à retenir */
  }
}
/** L'icône d'une densité : la grille qu'elle produit, en d×d carrés. */
function DensiteIcon({ d, className }: { d: Densite; className?: string }) {
  const gap = 1.6;
  const c = (16 - gap * (d - 1)) / d;
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      {Array.from({ length: d * d }, (_, i) => (
        <rect
          key={i}
          x={(i % d) * (c + gap)}
          y={Math.floor(i / d) * (c + gap)}
          width={c}
          height={c}
          rx={d === 1 ? 2.5 : 1.2}
        />
      ))}
    </svg>
  );
}

/* LA TAILLE DES LIGNES du choix des animés du mur : petite pour balayer 685
   titres, grande pour reconnaître les affiches. Retenue par navigateur, comme
   la densité de la grille. */
type TailleLigne = 1 | 2 | 3;
const TAILLE_LIGNE_KEY = "aniscroll:wallRowSize";
function readTailleLigne(): TailleLigne {
  try {
    const v = Number(localStorage.getItem(TAILLE_LIGNE_KEY));
    if (v === 1 || v === 2 || v === 3) return v;
  } catch {
    /* stockage refusé : le défaut */
  }
  return 2;
}
function writeTailleLigne(v: TailleLigne) {
  try {
    localStorage.setItem(TAILLE_LIGNE_KEY, String(v));
  } catch {
    /* stockage refusé : rien à retenir */
  }
}
/** Affiche et texte de chaque taille : 1 petite, 2 moyenne, 3 grande. */
const LIGNE: Record<TailleLigne, { cover: string; sizes: string; text: string }> = {
  1: { cover: "h-9 w-[26px]", sizes: "26px", text: "text-[12px]" },
  2: { cover: "h-16 w-[46px]", sizes: "46px", text: "text-[13.5px]" },
  3: { cover: "h-28 w-20", sizes: "80px", text: "text-[15px]" },
};
/** L'icône d'une taille : la FORME de la liste qu'elle donne — des lignes
    serrées, une liste à vignettes, des cartes empilées. (Une loupe disait
    « zoom » sans dire sur quoi.) */
const LIGNE_ICON: Record<TailleLigne, typeof PhotoIcon> = {
  1: Bars4Icon,
  2: QueueListIcon,
  3: RectangleStackIcon,
};
const FRAME_COLS_MIN = 3;
const FRAME_COLS_MAX = 10;

/** L'icône du cadre d'avatar : un portrait dans des coins de cadrage (Material
    Symbols). Même signature que les icônes Heroicons du dock. */
function FrameIcon({ className }: { className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" className={className} aria-hidden>
      <path d="M480-480q-51 0-85.5-34.5T360-600q0-50 34.5-85t85.5-35q50 0 85 35t35 85q0 51-35 85.5T480-480Zm0-80q17 0 28.5-11.5T520-600q0-17-11.5-28.5T480-640q-17 0-28.5 11.5T440-600q0 17 11.5 28.5T480-560ZM240-280v-36q0-21 10.5-39.5T279-385q46-27 96.5-41T480-440q54 0 104.5 14t96.5 41q18 11 28.5 29.5T720-316v36q0 17-11.5 28.5T680-240H280q-17 0-28.5-11.5T240-280Zm160-70q-39 10-74 30h308q-35-20-74-30t-80-10q-41 0-80 10Zm80-250Zm80 280h74-308 234ZM160-80q-33 0-56.5-23.5T80-160v-120q0-17 11.5-28.5T120-320q17 0 28.5 11.5T160-280v120h120q17 0 28.5 11.5T320-120q0 17-11.5 28.5T280-80H160ZM80-680v-120q0-33 23.5-56.5T160-880h120q17 0 28.5 11.5T320-840q0 17-11.5 28.5T280-800H160v120q0 17-11.5 28.5T120-640q-17 0-28.5-11.5T80-680ZM800-80H680q-17 0-28.5-11.5T640-120q0-17 11.5-28.5T680-160h120v-120q0-17 11.5-28.5T840-320q17 0 28.5 11.5T880-280v120q0 33-23.5 56.5T800-80Zm0-600v-120H680q-17 0-28.5-11.5T640-840q0-17 11.5-28.5T680-880h120q33 0 56.5 23.5T880-800v120q0 17-11.5 28.5T840-640q-17 0-28.5-11.5T800-680Z" />
    </svg>
  );
}

type ThemeRow = {
  slug: string;
  kind: "op" | "ed";
  song: string | null;
  artists: string[];
  /* `episodes` est du texte libre côté AnimeThemes ("1-13", "2, 5") : on
     l'affiche tel quel, il situe un ED parmi douze. */
  video: { url: string; episodes?: string | null; audio?: string | null } | null;
  videoNc: { url: string; episodes?: string | null; audio?: string | null } | null;
  /** Version COMPLÈTE sur YouTube, attachée par /api/v2/themes/{id} depuis la
      table oped_youtube. Absent tant que le morceau n'a pas été résolu — le
      profil retombe alors sur les 90 s d'AnimeThemes. */
  youtubeId?: string | null;
};

/** Les comptes de génériques déjà reçus, et ceux en route : pour la session. */
const musicCountsSeen: Record<number, number> = {};
const musicCountsAsked = new Set<number>();

export default function BannerStudio({
  open,
  onClose,
  animes,
  value,
  auto,
  identity,
  onApply,
  onDraft,
  bridge,
  onMini,
  entries = [],
  earned = null,
}: Props) {
  const { t } = useTranslation();
  const accent = useAccent();

  const [draft, setDraft] = useState<Dressing>(() => value ?? emptyDressing());
  const [scope, setScope] = useState<PaletteScope | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  /* L'onglet VISÉ, pour la pastille : elle glisse au clic, pendant que le
     contenu du nouvel onglet se prépare en arrière-plan (`startTransition`). */
  const [tabVise, setTabVise] = useState<PaletteScope | null>(null);
  /** Le menu VISÉ depuis la barre du bas : le liseré y va tout de suite. */
  const [barVise, setBarVise] = useState<PaletteScope | null>(null);
  /* LA LIGNE DU CURSEUR NE S'ALLUME QU'AU CLAVIER. Le curseur vaut 0 par
     défaut, et la souris ne le déplace plus (le survol est en CSS) : la
     première ligne restait allumée comme si on la survolait (15/10/2026). Les
     flèches l'allument, le premier mouvement de souris l'éteint. */
  const [clavier, setClavier] = useState(false);
  /** L'anime dans lequel la palette cherche. */
  const [animeId, setAnimeId] = useState<number | null>(null);
  const [art, setArt] = useState<BannerOption[]>([]);
  const [themes, setThemes] = useState<ThemeRow[]>([]);
  /** Le catalogue des cadres, chargé à la première ouverture de l'onglet. */
  const [frames, setFrames] = useState<FrameCollection[] | null>(null);
  /** Tri de la grille des cadres (cf. FRAME_SORTS), et le menu qui le choisit. */
  const [frameSort, setFrameSort] = useState<FrameSort>("recent");
  /** Le filtre de rareté du menu Badges (le tri, lui, est fixe : les plus rares d'abord). */
  const [badgeRarity, setBadgeRarity] = useState<"all" | Rarity>("all");
  const [frameSortOpen, setFrameSortOpen] = useState(false);
  /** Le tirage du tri « au hasard » : rechoisir ce tri relance la donne. */
  const [frameSeed, setFrameSeed] = useState(1);
  const frameSortRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!frameSortOpen) return;
    const close = (e: PointerEvent) => {
      if (!frameSortRef.current?.contains(e.target as Node)) setFrameSortOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [frameSortOpen]);
  /** Cases par ligne : moins = plus grandes. */
  const [frameCols, setFrameCols] = useState(4);
  /* LES CADRES SE MONTENT PAR LOTS. 688 cases d'un coup figeaient l'onglet
     au clic ; on monte un écran, puis le reste par paquets dans les temps
     morts (transition : un clic ou une frappe passe devant). */
  const FRAME_FIRST = 48;
  const [frameBudget, setFrameBudget] = useState(FRAME_FIRST);
  const frameTotal = frames?.reduce((n, c) => n + c.frames.length, 0) ?? 0;
  useEffect(() => {
    setFrameBudget(FRAME_FIRST);
  }, [scope, query, frameSort, frameSeed]);
  useEffect(() => {
    if (scope !== "frame" || !frameTotal || frameBudget >= frameTotal) return;
    return whenIdle(() => startTransition(() => setFrameBudget((b) => b + 120)), 300);
  }, [scope, frameTotal, frameBudget]);
  /** La densité du menu Badges, au bouton de la galerie : 1 = un par ligne
      (en liste), 2 = 3, 3 = 5. */
  const [badgeDens, setBadgeDens] = useState<Densite>(2);
  const badgeCols = badgeDens === 1 ? 1 : badgeDens === 2 ? 3 : 5;
  const [loading, setLoading] = useState(false);
  const search = useRef<HTMLInputElement | null>(null);
  /* Une palette rouverte ne doit pas resservir la liste de l'anime précédent
     pendant que la nouvelle charge — d'où le cache, par anime, pour la durée de
     l'écran seulement. */
  const artCache = useRef(new Map<number, BannerOption[]>());
  /* La galerie du profil d'un anime, partagée entre l'ouverture et le
     préchargement au survol : une requête en vol n'est pas relancée. Un échec
     se range comme « rien », sinon la planche attendrait indéfiniment une
     réponse qui ne viendra pas. */
  const artEnVol = useRef(new Map<number, Promise<BannerOption[]>>());
  const profileArt = (id: number): Promise<BannerOption[]> => {
    const hit = artCache.current.get(id);
    if (hit) return Promise.resolve(hit);
    const vol = artEnVol.current.get(id);
    if (vol) return vol;
    const p = fetch(`/api/v2/profile-banner?anime=${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => (Array.isArray(json?.options) ? (json.options as BannerOption[]) : []))
      .catch(() => [] as BannerOption[])
      .then((options) => {
        artCache.current.set(id, options);
        artEnVol.current.delete(id);
        return options;
      });
    artEnVol.current.set(id, p);
    return p;
  };
  /* Le nombre d'illustrations de chaque animé déjà ouvert, une fois toutes ses
     sources arrivées — par onglet (`image:123`, `banner:123`) : on ne le sait
     qu'après l'avoir ouvert une fois. Sonder toute la liste d'avance coûterait
     une requête par anime et par source. Zéro grise la ligne. */
  const artCompte = useRef(new Map<string, number>());
  /* Ce que la grille de l'animé ouvert tient CACHÉ (sous le fondu), écrit par
     le mémo des sections : la file de préchargement le lit après le rendu. */
  const aPrecharger = useRef<{ id: number | null; urls: string[] }>({ id: null, urls: [] });
  const themeCache = useRef(new Map<number, ThemeRow[]>());
  /** Pochette par slug (« OP1 » → URL Deezer, ou null), par anime. */
  const [coverState, setCoverState] = useState<{ id: number | null; covers: Record<string, string | null> }>({
    id: null,
    covers: {},
  });
  const coverCache = useRef(new Map<number, Record<string, string | null>>());
  const musicStore = useRef<MusicStore | null>(null);
  /* Relu une fois, au premier usage (le rendu serveur n'a pas de stockage). */
  const store = () => {
    if (!musicStore.current) {
      musicStore.current = readMusicStore();
      for (const [k, v] of Object.entries(musicStore.current)) {
        if (v.t && !themeCache.current.has(+k)) themeCache.current.set(+k, v.t);
        if (v.c && !coverCache.current.has(+k)) coverCache.current.set(+k, v.c);
      }
    }
    return musicStore.current;
  };
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remember = useCallback((id: number, part: { t?: ThemeRow[]; c?: Record<string, string | null> }) => {
    if (part.t) themeCache.current.set(id, part.t);
    if (part.c) coverCache.current.set(id, part.c);
    const st = store();
    st[id] = { ...st[id], ...part, at: Date.now() };
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => writeMusicStore(st), 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* Les génériques d'un anime, une seule requête en vol par anime. La réponse
     porte aussi les pochettes quand /api/v2/theme-covers a déjà fini cet anime
     (`coversDone`) : on les range, et la seconde requête n'a pas lieu. */
  const themesInflight = useRef(new Map<number, Promise<ThemeRow[]>>());
  const loadThemes = useCallback((id: number): Promise<ThemeRow[]> => {
    store();
    const hit = themeCache.current.get(id);
    if (hit) return Promise.resolve(hit);
    const going = themesInflight.current.get(id);
    if (going) return going;
    const p = fetch(`/api/v2/themes/${id}?v=4`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        /* Une panne n'est pas « aucun générique » : rien n'est retenu. */
        if (!json) return [] as ThemeRow[];
        const list: ThemeRow[] = Array.isArray(json.themes) ? json.themes : [];
        if (json.coversDone && json.covers) remember(id, { t: list, c: json.covers });
        else remember(id, { t: list });
        return list;
      })
      .catch(() => [] as ThemeRow[])
      .finally(() => themesInflight.current.delete(id));
    themesInflight.current.set(id, p);
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remember]);
  /* L'anime dont on liste les musiques, tel qu'on l'AFFICHE. Il ne vient pas
     toujours de `animes` : le sélecteur de saison peut mener sur une saison que
     l'utilisateur n'a pas dans sa liste, et cette saison a quand même une
     affiche et un titre à montrer. */
  const [meta, setMeta] = useState<StudioAnime | null>(null);
  const metaCache = useRef(new Map<number, StudioAnime>());
  /** Les autres saisons de la même franchise, pour le menu déroulant. */
  const [seasons, setSeasons] = useState<Array<{ id: number; label: string }>>([]);
  const seasonCache = useRef(new Map<number, Array<{ id: number; label: string }>>());

  /* L'écoute, dans le menu Musique. Elle ne sert qu'à choisir : le lecteur vit
     avec le menu et s'arrête en même temps que lui, puisqu'il en est retiré du
     DOM. On écoute ce que le profil jouera : le fichier d'AnimeThemes (90 s),
     ou la vidéo YouTube quand la musique en a une (version complète, lien
     collé, bande-annonce) — d'où un type commun aux deux lecteurs. */
  const preview = useRef<MusicMedia | null>(null);
  /** La version complète qu'on a quittée pour la version TV, par fichier :
      revenir à « Complète » la retrouve, même collée à la main. */
  const [fullFor, setFullFor] = useState<Record<string, string>>({});
  /** Le champ « lien YouTube » du pied : ouvert ou non, et ce qu'on y tape. */
  const [ytLink, setYtLink] = useState<string | null>(null);
  const [ytBad, setYtBad] = useState(false);
  /** Le lecteur de musique posé SUR la barre du bas, à la place des menus —
      comme le rail de la vidéo (`barVideo`). */
  const [barMusic, setBarMusic] = useState(false);
  /* La copie de la barre reste montée le temps qu'elle sorte (500 ms), puis
     disparaît : deux lecteurs montés, et le champ du lien (autoFocus)
     prenait le focus dans celui qu'on ne voit pas. */
  const [barMusicMounted, setBarMusicMounted] = useState(false);
  /** La hauteur du lecteur au pied du menu, pour animer sa fermeture. */
  const [footH, setFootH] = useState(0);
  useEffect(() => {
    if (barMusic) {
      setBarMusicMounted(true);
      return;
    }
    const id = window.setTimeout(() => setBarMusicMounted(false), 520);
    return () => window.clearTimeout(id);
  }, [barMusic]);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [len, setLen] = useState(0);
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
  /* Cliquer une piste doit la faire entendre — mais la source ne change qu'au
     rendu suivant, d'où le drapeau plutôt qu'un `play()` immédiat sur l'ancien
     fichier. */
  const [wantPlay, setWantPlay] = useState(false);

  /* ── La bande-annonce ────────────────────────────────────────────────────
     Elle se découpe comme un morceau, et sur le MÊME aperçu : ce qui joue en
     fond de l'écran est déjà la vidéo, il n'y a donc pas de second lecteur à
     monter — le pied du panneau ne fait que la piloter (PlateBackground rend
     la télécommande, et rapporte la position que le lecteur annonce). */
  const ownRemote = useRef<TrailerRemote | null>(null);
  const remote = bridge?.remote ?? ownRemote;
  const [vAt, setVAt] = useState(0);
  const [vLen, setVLen] = useState(0);
  const [vPlaying, setVPlaying] = useState(false);
  const onVideoProgress = useCallback(
    (at: number, duration: number, playing: boolean) => {
      setVAt(railTime(at));
      setVLen(duration);
      setVPlaying(playing);
    },
    [],
  );
  useEffect(() => {
    if (!bridge) return;
    bridge.progress.current = onVideoProgress;
    return () => {
      bridge.progress.current = null;
    };
  }, [bridge, onVideoProgress]);

  /** Réduit : le profil reprend sa taille, il ne reste qu'une pilule. */
  const [mini, setMini] = useState(false);
  const miniOut = useRef(onMini);
  miniOut.current = onMini;
  useEffect(() => {
    if (open) miniOut.current?.(mini);
  }, [open, mini]);

  /* Rouvrir repart de ce que le profil porte VRAIMENT, pas d'un brouillon
     abandonné la fois d'avant. */
  useEffect(() => {
    if (!open) return;
    setDraft(value ?? emptyDressing());
    /* Le menu de gauche est ouvert d'entrée — il l'est toujours — sur le
       dernier choisi, et sur Image la toute première fois. */
    setScope(readLastScope());
    setPick(null);
    setMini(false);
    setQuery("");
    setAnimeId(value?.animeId ?? animes[0]?.mediaId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (animeId == null && animes.length) setAnimeId(animes[0].mediaId);
  }, [animes, animeId]);

  /* La page montre le brouillon : elle le reçoit à chaque changement. Plus de
     verrou de défilement — le profil sous le dock EST l'aperçu, on le parcourt. */
  const draftOut = useRef(onDraft);
  draftOut.current = onDraft;
  useEffect(() => {
    if (open) draftOut.current?.(draft);
  }, [open, draft]);

  const currentAnime = animes.find((a) => a.mediaId === animeId) ?? null;

  /* « chainsawman » doit trouver « Chainsaw Man » : on compare sans espaces ni
     ponctuation, sinon un titre en deux mots ne se tape qu'avec son espace. */
  const fold = (s: string) =>
    s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

  /* CHERCHER HORS DE SA LISTE (14/10/2026). Les onglets Image et Bannière ne
     proposaient que les animés de la liste : impossible de poser une
     illustration d'un titre qu'on n'a pas noté. Dès trois lettres, la frappe
     part aussi chez AniList — DEPUIS LE NAVIGATEUR, comme la page de
     recherche, donc sans invocation de fonction ni file d'attente du limiteur
     partagé du site. `vus` garde l'identité de chaque titre trouvé : la ligne
     ouverte doit survivre à une recherche qui ne la trouve plus. */
  const [found, setFound] = useState<StudioAnime[]>([]);
  const vus = useRef(new Map<number, StudioAnime>());
  useEffect(() => {
    const q = query.trim();
    if ((scope !== "image" && scope !== "banner" && scope !== "music") || fold(q).length < 3) {
      setFound([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      fetch("https://graphql.anilist.co/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: STUDIO_SEARCH, variables: { search: q } }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          if (!alive) return;
          const media: Array<{
            id: number;
            title?: { userPreferred?: string; english?: string; romaji?: string };
            coverImage?: { medium?: string };
          }> = json?.data?.Page?.media ?? [];
          const out = media.map((m) => ({
            mediaId: m.id,
            title: m.title?.userPreferred || m.title?.english || m.title?.romaji || `#${m.id}`,
            cover: m.coverImage?.medium ?? null,
          }));
          for (const a of out) vus.current.set(a.mediaId, a);
          setFound(out);
        })
        .catch(() => alive && setFound([]));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `fold` est une fonction pure redéfinie à chaque rendu : hors dépendances.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, query]);

  /* Les comptes d'illustrations, par animé et par type, pour le sous-titre des
     lignes — en UNE requête pour toute la liste (cf. /api/v2/art-counts), puis
     une par recherche pour les titres qu'elle ajoute. Demandés DÈS L'OUVERTURE
     du studio, pas au passage sur l'onglet : la réponse est là quand on y
     arrive. Gardés au niveau du module, un studio rouvert les a d'emblée. */
  const [artTypes, setArtTypes] = useState(ART_TYPES);
  useEffect(() => {
    if (!open) return;
    const ids = [...animes, ...found]
      .map((a) => a.mediaId)
      .filter((id) => !ART_DEMANDES.has(id));
    if (!ids.length) return;
    for (const id of ids) ART_DEMANDES.add(id);
    const tri = [...new Set(ids)].sort((a, b) => a - b);
    // La route borne à 40 ids par appel.
    for (let i = 0; i < tri.length; i += 40)
      fetch(`/api/v2/art-counts?ids=${tri.slice(i, i + 40).join(",")}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          if (!json?.counts) return;
          ART_TYPES = { ...ART_TYPES, ...json.counts };
          setArtTypes(ART_TYPES);
        })
        .catch(() => {});
  }, [open, animes, found]);

  /* L'anime OUVERT, dans les onglets qui se parcourent en deux écrans —
     Vidéo, Bannière et Image. `null` : on est encore devant la liste des
     animés. Un seul état pour les trois : un seul onglet est ouvert à la fois,
     et `openScope` le remet à zéro.

     POURQUOI DEUX ÉCRANS. La liste des animés d'abord, ses illustrations
     ensuite, comme partout ailleurs sur le site. L'onglet Bannière ne montrait
     que les illustrations d'UN anime — celui du profil — et rien ne permettait
     d'en atteindre un autre : la recherche filtrait des images qui n'ont pas de
     nom, donc elle ne trouvait rien. */
  const [pick, setPick] = useState<number | null>(null);
  /* L'accordéon des onglets Image et Bannière : la ligne de la liste qui est
     ouverte (voir `ouvert`), et sa galerie déroulée en entier ou non. */
  const [artRoot, setArtRoot] = useState<number | null>(null);
  const [artAll, setArtAll] = useState(false);
  /* Lue après le montage : le rendu serveur ne connaît pas le stockage. */
  const [densite, setDensite] = useState<Densite>(2);
  useEffect(() => setDensite(readDensite()), []);
  /* L'ACCORDÉON NE DOIT PAS FAIRE SAUTER LA COLONNE. Ouvrir un animé replie
     celui d'avant ; s'il était plus haut, tout ce qui suit remontait de la
     hauteur de sa galerie et la ligne cliquée filait hors de vue. On note où
     était la ligne au clic, et on recale le défilement après le rendu pour
     qu'elle — ou l'en-tête qui la remplace — reste sous le pointeur. */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const holdAnchor = useCallback((key: string) => {
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-anchor="${key}"]`);
    anchor.current = el ? { key, top: el.getBoundingClientRect().top } : null;
  }, []);
  useBeforePaint(() => {
    const a = anchor.current;
    const box = scrollerRef.current;
    if (!a || !box) return;
    anchor.current = null;
    const el = box.querySelector<HTMLElement>(`[data-anchor="${a.key}"]`);
    if (el) box.scrollTop += el.getBoundingClientRect().top - a.top;
  });
  /* Musique y est depuis le 16/10/2026 : même accordéon que Image — la liste
     des animés (et la recherche AniList), un anime ouvert déplie ses
     génériques sous sa ligne. */
  const twoScreens = scope === "video" || scope === "banner" || scope === "image" || scope === "music";

  const listedAnime = twoScreens
    ? (meta?.mediaId === pick
        ? meta
        : animes.find((a) => a.mediaId === pick) ?? (pick != null ? vus.current.get(pick) : undefined)) ?? null
    : currentAnime;
  const listedAnimeId = twoScreens ? pick : listedAnime?.mediaId ?? animeId;

  /* TOUTE la galerie de l'anime ouvert, et pas seulement les formats larges :
     ce sont les deux memes points d'entree que l'onglet Illustrations de la
     fiche anime (fanart.tv puis TMDB), avec leurs propres memos — ouvrir ici un
     titre deja consulte ne coute donc rien. `bannerOptions` seul en laissait la
     moitie dehors : il ne collecte que les types larges, pas les affiches, les
     logos, les clear arts, ni le fonds TMDB.
     `null` hors de ces deux onglets : les hooks ne demandent alors rien. */
  const galerieId = scope === "banner" || scope === "image" ? pick : null;
  const { fanarts, loading: fanartsLoading } = useFanarts(galerieId);
  const { tmdbArts } = useTmdbArtworks(galerieId ?? 0);
  /* Wallhaven, la troisieme source — mais seulement pour l'onglet Image : elle
     sert des fonds d'ecran en 16/9, et n'a a peu pres rien en bande (mesure le
     10/09/2026 : 10 resultats en 21/9 et 32/9 sur One Piece, contre 506 au
     total). Depuis le 13/09/2026 ce n'est plus une question de quota — la
     lecture vient de `wallhaven_image`, remplie depuis le poste, et non plus
     d'un appel sortant contre les 45 requetes/minute de l'IP de la lambda.
     C'est desormais une question de pertinence : l'onglet Banniere n'a rien a
     tirer d'un catalogue en 16/9. */
  const {
    wallpapers,
    hasMore: wallHasMore,
    loading: wallLoading,
    loadMore: loadMoreWall,
    facettes,
    facette,
    setFacette,
  } = useWallhaven(scope === "image" ? galerieId ?? 0 : 0);

  /* Les illustrations d'un anime : le même point d'entrée, partagé et mis en
     cache à la périphérie, que celui dont le profil tire déjà sa plaque —
     ouvrir le studio sur son propre profil ne coûte donc en général rien. */
  useEffect(() => {
    if (!open || listedAnimeId == null) return;
    if (scope !== "banner" && scope !== "image") return;
    const cible = listedAnimeId;
    const hit = artCache.current.get(cible);
    if (hit) {
      setArt(hit);
      /* Une requête interrompue par ce changement d'anime ne passe plus par
         son `finally` : sans cette ligne, `loading` restait vrai pour de bon. */
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    profileArt(cible)
      .then((options) => alive && setArt(options))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // `profileArt` ne lit que des refs : identité stable dans les faits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listedAnimeId, scope]);

  /* Les deux hôtes d'images de la galerie que `_document` ne prépare pas
     (fanart-proxy y est déjà) : la connexion TLS se fait pendant qu'on choisit
     un anime, pas au moment où les tuiles la demandent. Une fois par page. */
  useEffect(() => {
    if (!open) return;
    for (const href of ["https://image.tmdb.org", "https://th.wallhaven.cc"]) {
      if (document.head.querySelector(`link[rel="preconnect"][href="${href}"]`)) continue;
      const l = document.createElement("link");
      l.rel = "preconnect";
      l.href = href;
      document.head.appendChild(l);
    }
  }, [open]);

  /* PRÉCHARGER AU SURVOL. Une ligne survolée 150 ms est presque toujours la
     prochaine cliquée : ses sources partent alors, et le clic trouve les mémos
     des hooks (et `artCache`) déjà remplis. Un passage rapide de la souris sur
     la liste ne déclenche rien. Seulement les routes de l'onglet — Wallhaven
     n'existe que pour Image — et toutes sont en cache d'edge. */
  const survol = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchArt = useCallback(
    (id: number | null) => {
      if (survol.current) clearTimeout(survol.current);
      survol.current = null;
      if (id == null) return;
      survol.current = setTimeout(() => {
        void fetchFanarts(id);
        void fetchTmdbArtworks(id);
        if (scope === "image") void fetchPage(id, "tout", 1);
        void profileArt(id);
      }, 150);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope],
  );

  /* MUSIQUE : LE SURVOL PRÉPARE L'OUVERTURE. Même délai que les images
     (150 ms, un passage de souris ne coûte rien) : la liste des génériques et
     la première vague de pochettes arrivent dans les caches, et les images
     sont déjà téléchargées par le navigateur — l'accordéon s'ouvre plein. Une
     seule fois par anime. */
  const musicAsked = useRef(new Set<number>());
  const warmMusic = useCallback(
    async (id: number) => {
      if (musicAsked.current.has(id)) return;
      musicAsked.current.add(id);
      await loadThemes(id);
      let covers = coverCache.current.get(id);
      if (!covers) {
        const json = await fetch(`/api/v2/theme-covers/${id}?v=4`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        covers = json?.covers ?? undefined;
        if (json?.covers && !json.partial) remember(id, { c: json.covers });
      }
      for (const u of Object.values(covers ?? {})) if (u) new window.Image().src = u;
    },
    [loadThemes, remember],
  );
  const prefetchMusic = useCallback(
    (id: number | null) => {
      if (survol.current) clearTimeout(survol.current);
      survol.current = null;
      if (id == null || musicAsked.current.has(id)) return;
      survol.current = setTimeout(() => void warmMusic(id), 150);
    },
    [warmMusic],
  );
  /* À l'ouverture du menu Musique, les six premiers animés de la liste se
     préparent dans les temps morts, l'un après l'autre : les plus probables
     s'ouvrent pleins, et leur ligne affiche déjà son nombre de génériques.
     Six seulement — chaque anime neuf coûte une invocation ; les autres
     passent par le survol. */
  useEffect(() => {
    if (!open || scope !== "music") return;
    const ids = animes.slice(0, 6).map((a) => a.mediaId);
    let alive = true;
    let cancel = () => {};
    let i = 0;
    const step = () => {
      if (!alive || i >= ids.length) return;
      const id = ids[i++];
      cancel = whenIdle(() => void warmMusic(id).finally(step), 1500);
    };
    step();
    return () => {
      alive = false;
      cancel();
    };
  }, [open, scope, animes, warmMusic]);

  /* Un anime ouvert SANS générique : est-il seulement sorti ? « Aucun
     générique connu » se lisait comme un manque du site sur un titre annoncé
     (Boku no Kokoro no Yabai Yatsu 3rd Season, 16/10/2026). Une requête, et
     seulement dans ce cas-là. */
  const [notAired, setNotAired] = useState<Record<number, boolean>>({});

  /* Le nombre de génériques de CHAQUE ligne du menu Musique, sans avoir à
     l'ouvrir : une requête groupée par paquet de 100 (/api/v2/theme-counts,
     un seul appel AnimeThemes). Gardé pour la session (`musicCountsSeen`),
     comme les génériques eux-mêmes. */
  const [musicCounts, setMusicCounts] = useState<Record<number, number>>(() => ({ ...musicCountsSeen }));
  useEffect(() => {
    if (!open || (scope !== "music" && barVise !== "music")) return;
    const ids = [...animes, ...found]
      .map((a) => a.mediaId)
      .filter((id) => !(id in musicCountsSeen) && !musicCountsAsked.has(id) && !themeCache.current.has(id));
    if (!ids.length) return;
    for (const id of ids) musicCountsAsked.add(id);
    for (let i = 0; i < ids.length; i += 100) {
      const lot = ids.slice(i, i + 100);
      fetch(`/api/v2/theme-counts?ids=${lot.sort((a, b) => a - b).join(",")}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const c: Record<number, number> = d?.counts ?? {};
          if (!Object.keys(c).length) {
            for (const id of lot) musicCountsAsked.delete(id);
            return;
          }
          Object.assign(musicCountsSeen, c);
          setMusicCounts((m) => ({ ...m, ...c }));
        })
        .catch(() => {
          for (const id of lot) musicCountsAsked.delete(id);
        });
    }
  }, [open, scope, barVise, animes, found]);
  useEffect(() => {
    if (!open || scope !== "music" || pick == null || pick in notAired) return;
    if (themeCache.current.get(pick)?.length !== 0) return;
    let alive = true;
    const id = pick;
    fetch(`/api/v2/media/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => alive && setNotAired((s) => ({ ...s, [id]: m?.status === "NOT_YET_RELEASED" })))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, pick, themes]);

  /* L'identité de l'anime listé : prise dans la liste de l'utilisateur quand
     elle s'y trouve, sinon demandée au site. Une saison atteinte par le menu
     déroulant n'est pas forcément dans sa liste — sans ce repli, l'en-tête
     serait vide sur la moitié des franchises. */
  /* Les cadres : une seule requête, au premier passage sur l'onglet. La réponse
     est la même pour tout le monde et cachée au bord (/api/v2/avatar-frames),
     et la table se met à jour seule chaque nuit avec la boutique Discord. */
  /* Demandée dès l'ouverture du studio, dans un temps mort : l'onglet trouve
     le catalogue prêt au lieu d'attendre le réseau au clic. Visé tout de suite
     (clic dans la barre), la requête part sans attendre. Une seule fois. */
  const framesAsked = useRef(false);
  useEffect(() => {
    if (!open || frames || framesAsked.current) return;
    const go = () => {
      if (framesAsked.current) return;
      framesAsked.current = true;
      fetch("/api/v2/avatar-frames")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setFrames(Array.isArray(d?.collections) ? d.collections : []))
        .catch(() => setFrames([]));
    };
    if (scope === "frame" || barVise === "frame") {
      go();
      return;
    }
    return whenIdle(go, 2000);
  }, [open, scope, barVise, frames]);

  useEffect(() => {
    if (!open || listedAnimeId == null) return;
    /* Bannière et Image en sont depuis qu'elles se parcourent par anime : leur
       en-tête porte la même affiche et le même sélecteur de saison, et une
       saison atteinte par ce sélecteur n'est pas forcément dans la liste. */
    if (scope === "color" || scope === "layout" || scope === "frame" || scope === "badges" || scope === "wall" || !scope) return;
    const known = animes.find((a) => a.mediaId === listedAnimeId);
    /* Une saison connue de la liste peut n'avoir aucune bande-annonce SUE : le
       cache d'animés ne l'avait pas au rendu de la page. On la redemande alors
       au site, qui la lit dans le même cache mais à jour. */
    /* La musique aussi la veut : la bande-annonce se prend comme musique. */
    if (known && ((scope !== "video" && scope !== "music") || known.trailer)) {
      setMeta(known);
      return;
    }
    const hit = metaCache.current.get(listedAnimeId);
    if (hit) {
      setMeta(hit);
      return;
    }
    let alive = true;
    fetch(`/api/v2/media/${listedAnimeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (!alive || !m) return;
        const row: StudioAnime = {
          mediaId: listedAnimeId,
          title: m.title?.english || m.title?.romaji || m.title?.userPreferred || `#${listedAnimeId}`,
          cover: m.coverImage?.large || m.coverImage?.extraLarge || (known?.cover ?? null),
          /* Seulement YouTube : AniList publie aussi des identifiants
             Dailymotion, qu'un embed YouTube transformerait en vidéo absente. */
          trailer:
            m.trailer?.site === "youtube" && m.trailer?.id
              ? String(m.trailer.id)
              : known?.trailer ?? null,
        };
        metaCache.current.set(listedAnimeId, row);
        setMeta(row);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, scope, listedAnimeId, animes]);

  /* Les saisons de la franchise — la même liste, au même point d'entrée, que le
     sélecteur de saison de la page de visionnage. */
  useEffect(() => {
    if (!open || listedAnimeId == null) return;
    if (scope !== "oped" && scope !== "music" && scope !== "video") return;
    const hit = seasonCache.current.get(listedAnimeId);
    if (hit) {
      setSeasons(hit);
      return;
    }
    let alive = true;
    fetch(`/api/v2/seasons/${listedAnimeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        const rows = list
          .filter((s) => Number.isFinite(s?.id) && s?.label)
          .map((s) => ({ id: Number(s.id), label: String(s.label) }));
        /* Le cache est posé sur l'anime DEMANDÉ comme sur chacune des saisons
           trouvées : la liste est la même pour toute la franchise, donc passer
           d'une saison à l'autre ne redemande rien. */
        seasonCache.current.set(listedAnimeId, rows);
        for (const r of rows) seasonCache.current.set(r.id, rows);
        setSeasons(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, scope, listedAnimeId]);

  /* Openings et endings — AnimeThemes, via le proxy que la fiche anime utilise
     déjà pour son menu OP/ED. */
  useEffect(() => {
    if (!open || listedAnimeId == null) return;
    if (scope !== "oped" && scope !== "music") return;
    store();
    const hit = themeCache.current.get(listedAnimeId);
    if (hit) {
      setThemes(hit);
      return;
    }
    let alive = true;
    setLoading(true);
    /* `?v=4` (dans loadThemes) : les réponses d'avant, gardées un jour par le
       navigateur, n'ont ni le lien audio ni les pochettes jointes. */
    loadThemes(listedAnimeId)
      .then((list) => alive && setThemes(list))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listedAnimeId, scope]);

  /* La pochette de chaque générique (/api/v2/theme-covers). Une requête à
     part, lancée une fois les thèmes là : la liste n'attend jamais les images,
     et la note reste en place tant qu'une pochette manque. Un anime à
     vingt-cinq génériques se résout en plusieurs fois : tant que la réponse est
     `partial`, on redemande la suite (8 fois au plus), et les pochettes
     arrivent par vagues. */
  useEffect(() => {
    /* Lancée EN MÊME TEMPS que la liste des génériques, pas après : la route
       relit elle-même les thèmes, et attendre les uns pour demander les autres
       ajoutait un aller-retour complet avant la première pochette. */
    if (!open || listedAnimeId == null) return;
    if (scope !== "oped" && scope !== "music") return;
    const id = listedAnimeId;
    store();
    const hit = coverCache.current.get(id);
    if (hit) {
      setCoverState({ id, covers: hit });
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCoverState({ id, covers: {} });
    const ask = (round: number) =>
      fetch(`/api/v2/theme-covers/${id}?v=4`)
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          if (!alive || !json?.covers) return;
          const partial = !!json.partial && round < 8;
          /* Partielle : seulement les pochettes trouvées. Un `null` y veut dire
             « pas encore cherché », et l'affiche de repli s'afficherait trop
             tôt. */
          const covers: Record<string, string | null> = partial
            ? Object.fromEntries(Object.entries(json.covers as Record<string, string | null>).filter(([, v]) => v))
            : json.covers;
          setCoverState({ id, covers });
          if (partial) timer = setTimeout(() => ask(round + 1), 400);
          else remember(id, { c: covers });
        })
        .catch(() => {});
    /* La réponse des génériques porte peut-être déjà les pochettes : on
       l'attend un quart de seconde au plus avant de les demander à part. */
    void Promise.race([loadThemes(id), new Promise((r) => setTimeout(r, 250))]).then(() => {
      if (!alive) return;
      const ready = coverCache.current.get(id);
      if (ready) setCoverState({ id, covers: ready });
      else void ask(1);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
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
  }, [vol, draft.music?.url, draft.music?.videoId]);

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
        setAt(railTime(el.currentTime));
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
  }, [wantPlay, draft.music?.url, draft.music?.videoId]);

  const openScope = useCallback((s: PaletteScope) => {
    /* La barre réagit au clic (`barVise`, urgent) ; le menu lui-même se prépare
       en arrière-plan. Monter les 688 cases des cadres bloquait le clic, le
       liseré et la barre le temps du rendu. */
    setBarVise(s);
    writeLastScope(s);
    setMini(false);
    startTransition(() => {
      setScope(s);
      setQuery("");
      setCursor(0);
      /* Un onglet à deux écrans s'ouvre TOUJOURS sur la liste des animés :
         rouvrir un menu et tomber sur le titre d'avant, c'est se demander où
         est passée la liste. */
      setPick(null);
    });
    requestAnimationFrame(() => search.current?.focus());
  }, []);

  /* Les chiffres arrivent dans un tableau neuf à chaque rendu de la page : la
     clé en texte évite de recalculer toute la palette pour rien. */
  const statsKey = identity.stats?.join("\u0001") ?? "";

  /* ── Ce que la palette liste ─────────────────────────────────────────── */
  const sections: Section[] = useMemo(() => {
    if (!scope) return [];
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    const out: Section[] = [];
    const ready = DRESSING_KINDS.find((k) => k.id === scope)?.ready ?? true;

    /* ── Le mur d'animés ───────────────────────────────────────────────────
       Un seul bloc de réglages : ce qu'on y met (listes, notes) et comment ça
       bouge. Chaque geste PORTE le mur — pas de bouton « valider » à trouver
       après avoir tout réglé, la page change sous la main. */
    if (scope === "wall") {
      const wall = draft.wall ?? defaultWall();
      return [
        {
          title: "",
          rows: [],
          /* Toute la hauteur de la colonne : la carte des animés prend ce que
             les réglages laissent. */
          grow: true,
          fill: true,
          node: (
            <WallPanel
              entries={entries}
              wall={wall}
              worn={draft.kind === "wall"}
              onChange={(next) =>
                patch({
                  kind: "wall",
                  wall: next,
                  url: null,
                  color: null,
                  pattern: null,
                  trailerId: null,
                  videoFrom: null,
                  videoTo: null,
                  source: null,
                  animeId: null,
                  title: null,
                })
              }
              t={t}
            />
          ),
        },
      ];
    }

    /* ── Les cadres d'avatar ──────────────────────────────────────────────
       Une section par collection de la boutique Discord, la plus récente en
       tête (ordre de la table). Les tuiles montrent le cadre SUR l'avatar du
       profil : un cadre seul, sur fond noir, ne dit pas comment il habille.
       La recherche passe par le nom du cadre ET de sa collection — « arcane »
       sort toute la collection. Retour anticipé : les sections d'animés qui
       suivent n'ont rien à faire dans cet onglet. */
    if (scope === "frame") {
      if (!frames)
        return [
          {
            title: "",
            rows: [],
            node: (
              <div role="status" className="flex flex-col items-center gap-3 py-10 font-karla text-[12px] font-bold text-white/45">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-action" />
                {t("profile.studioFrameLoading")}
              </div>
            ),
          },
        ];
      const tile = (asset: string | null, label: string) => {
        const on = (draft.frame ?? null) === asset;
        return (
          <button
            key={asset ?? "none"}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={on}
            onClick={() => patch({ frame: asset })}
            className={`relative grid aspect-square place-items-center rounded-xl transition-colors ${
              on ? "bg-action/20 ring-2 ring-action" : "bg-white/[0.04] ring-1 ring-white/10 hover:bg-white/[0.08]"
            }`}
          >
            <span className="relative h-[58%] w-[58%] overflow-hidden rounded-full bg-primary">
              {/* Un <img> nu et non un <Image> Next : la même URL ×688, chargée
                  une fois par le navigateur, sans 688 composants à monter. */}
              {identity.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={identity.avatar} alt="" decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
              ) : null}
            </span>
            {/* La case « aucun cadre » n'a plus de croix : l'avatar nu dit déjà
                ce qu'elle fait, et la croix se lisait comme « supprimer ». */}
            {asset ? (
              /* Miniature fixe tout de suite, animée dès que la case est à
                 l'écran (cf. FrameTileImage). */
              <FrameTileImage
                asset={asset}
                /* 256 px quand les cases sont grandes (4 par ligne ou moins). */
                size={frameCols <= 4 ? 256 : 160}
                className="pointer-events-none absolute left-1/2 top-1/2 h-[70%] w-[70%] -translate-x-1/2 -translate-y-1/2"
              />
            ) : null}
          </button>
        );
      };
      /* Le nombre de colonnes est un réglage (boutons − / + de l'en-tête) : une
         classe Tailwind ne se calcule pas, d'où le style en ligne. */
      const grid = (children: ReactNode) => (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${frameCols}, minmax(0, 1fr))` }}
        >
          {children}
        </div>
      );
      if (!q) out.push({ title: t("profile.studioFrameNone"), rows: [], node: grid(tile(null, t("profile.studioFrameNone"))) });
      /* Le lot monté jusqu'ici (cf. frameBudget) : les sections suivantes
         arrivent aux prochains temps morts. */
      let left = frameBudget;
      const take = <T,>(list: T[]) => {
        const kept = list.slice(0, Math.max(0, left));
        left -= kept.length;
        return kept;
      };
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
      if (frameSort === "name" || frameSort === "name_desc" || frameSort === "random") {
        /* À plat : on cherche un cadre précis sans savoir sa collection, ou on
           se laisse surprendre. */
        const all = frames.flatMap((c) => (match(c.name) ? c.frames : c.frames.filter((f) => match(f.name))));
        if (frameSort === "random") all.sort((a, b) => shuffleKey(a.asset, frameSeed) - shuffleKey(b.asset, frameSeed));
        else all.sort((a, b) => (frameSort === "name" ? byName(a, b) : byName(b, a)));
        if (all.length) out.push({ title: t("profile.studioFrameAll"), rows: [], node: grid(take(all).map((f) => tile(f.asset, f.name))) });
      } else {
        /* La table range les collections de la plus récente à la plus ancienne. */
        const cols =
          frameSort === "collection"
            ? [...frames].sort(byName)
            : frameSort === "oldest"
              ? [...frames].reverse()
              : frameSort === "biggest"
                ? [...frames].sort((a, b) => b.frames.length - a.frames.length)
                : frames;
        for (const c of cols) {
          const hit = match(c.name) ? c.frames : c.frames.filter((f) => match(f.name));
          if (!hit.length) continue;
          if (left <= 0) break;
          out.push({ title: c.name, rows: [], node: grid(take(hit).map((f) => tile(f.asset, f.name))) });
        }
      }
      if (!out.length) out.push({ title: t("profile.studioNoResult"), rows: [], node: <span /> });
      return out;
    }

    /* ── Les badges mis en avant ──────────────────────────────────────────
       Les badges OBTENUS, toujours les plus rares d'abord, filtrables par
       rareté (menu au-dessus de la grille), cherchables par leur nom, et posés au glisser-déposer sur trois
       places — l'ordre dans lequel ils s'alignent à côté du pseudo. Le clic
       reste un raccourci (cf. BadgePicker). */
    if (scope === "badges") {
      const chosen = (draft.badges ?? []).filter((id) => BY_ID[id] && earned?.[id]);
      const nameOf = (id: string) => t(`badges.${id}.name`);
      const rank = (id: string) => RARITY_ORDER.indexOf(BY_ID[id].rarity);
      const all = Object.keys(earned ?? {}).filter((id) => BY_ID[id]);
      if (!all.length) {
        return [{ title: t("profile.studioBadgesNone"), rows: [], node: <span /> }];
      }
      const at = (id: string) => earned?.[id] ?? 0;
      const owned = all
        .filter((id) => match(nameOf(id)) && (badgeRarity === "all" || BY_ID[id].rarity === badgeRarity))
        .sort((a, b) => rank(b) - rank(a) || at(b) - at(a));
      return [
        {
          title: t("profile.studioBadgesSection"),
          rows: [],
          /* Toute la hauteur de la colonne, et c'est la GRILLE qui défile
             (cf. BadgePicker) : le titre, la consigne, les trois places et le
             menu de rareté restent en place pendant qu'on cherche un badge. */
          grow: true,
          fill: true,
          node: (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <BadgePicker
                /* La taille des badges SUR LE PROFIL — même curseur que les
                   tailles d'avatar et de pseudo (`as-range`), double-clic = 100 %. */
                footer={
                  <div className="grid gap-1.5 pt-1">
                    <span className="flex items-center justify-between font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/45">
                      {t("profile.studioBadgeScale", "Taille sur le profil")}
                      <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 normal-case tracking-normal text-white/80">
                        {draft.badgeScale ?? 100} %
                      </span>
                    </span>
                    <span className="as-range relative block h-4 w-full">
                      <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.14]" />
                      <span
                        className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-action"
                        style={{
                          width: `${(((draft.badgeScale ?? 100) - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100}%`,
                        }}
                      />
                      <input
                        type="range"
                        min={SCALE_MIN}
                        max={SCALE_MAX}
                        step={5}
                        value={draft.badgeScale ?? 100}
                        onChange={(e) => patch({ badgeScale: clampScale(e.target.value) })}
                        onDoubleClick={() => patch({ badgeScale: 100 })}
                        style={{ pointerEvents: "auto" }}
                        aria-label={t("profile.studioBadgeScale", "Taille sur le profil")}
                      />
                    </span>
                  </div>
                }
                hint={
                  <p className="text-xs leading-relaxed text-white/55">
                    {t("profile.studioBadgesHint", { max: FEATURED_MAX })}
                  </p>
                }
                owned={owned}
                chosen={chosen}
                cols={badgeCols}
                onChange={(next) => patch({ badges: next })}
                nameOf={nameOf}
                t={t}
                toolbar={
                  <>
                    {/* Le même menu de rareté que l'onglet Badges : pastilles
                        aux couleurs des anneaux, « Toutes » en roue. */}
                    <div className="relative z-20 flex items-center gap-2">
                      <Dropdown
                        className="as-dd-full w-[200px]"
                        label={t("badges.ui.rarityFilter.label")}
                        value={badgeRarity}
                        choices={[
                          {
                            value: "all",
                            label: t("badges.ui.rarityFilter.all"),
                            swatch: `conic-gradient(${RARITY_ORDER.map((r) => RING_HUE[r]).join(", ")}, ${RING_HUE.c})`,
                            /* La lueur de la roue, comme dans l'onglet Badges : une
                               ombre par rareté, décalée vers l'angle où la roue
                               porte sa couleur, à 22 % pour que leur somme vaille
                               la lueur d'une seule pastille (cf. ProfileBadges). */
                            glow: RARITY_ORDER.map((r, i) => {
                              const a = (i / RARITY_ORDER.length) * 2 * Math.PI;
                              return `${(Math.sin(a) * 1.5).toFixed(1)}px ${(-Math.cos(a) * 1.5).toFixed(1)}px 6px ${RING_HUE[r]}38`;
                            }).join(", "),
                          },
                          ...[...RARITY_ORDER].reverse().map((r) => ({
                            value: r,
                            label: t(`badges.ui.rarity.${r}`),
                            color: RING_HUE[r],
                            swatch: ringSwatch(r),
                          })),
                        ]}
                        onPick={(v) => setBadgeRarity(v as "all" | Rarity)}
                      />
                      {/* La disposition, tout à droite : le bouton de densité de
                          la galerie d'illustrations — un bouton, trois crans
                          (1, 3, 5 par ligne), la grille de l'icône dit le cran. */}
                      <button
                        type="button"
                        onClick={() => setBadgeDens((d) => ((d % 3) + 1) as Densite)}
                        title={t(`profile.studioDensite_${badgeDens}`)}
                        aria-label={t(`profile.studioDensite_${badgeDens}`)}
                        className="group ml-auto grid h-[2.35rem] w-[2.35rem] shrink-0 place-items-center rounded-xl bg-white/[0.04] text-white/60 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.08] hover:text-white"
                      >
                        <span className="grid place-items-center transition-transform duration-150 group-active:scale-90">
                          <span
                            className="grid place-items-center transition-transform duration-300 ease-[cubic-bezier(.3,.7,.2,1)]"
                            style={{ transform: `rotate(${(badgeDens - 1) * 90}deg)` }}
                          >
                            <DensiteIcon d={badgeDens} className="h-4 w-4" />
                          </span>
                        </span>
                      </button>
                    </div>
                    {owned.length ? null : (
                      <p className="px-2 py-6 text-center font-karla text-sm text-white/45">
                        {t("profile.studioNoResult")}
                      </p>
                    )}
                  </>
                }
              />
            </div>
          ),
        },
      ];
    }

    /* ── Les agencements ──────────────────────────────────────────────────
       Cinq dispositions du même matériel, en vignettes : un plan de la page
       entière en squelette gris (LayoutThumb). Le plan dit où tombe chaque
       pièce ; la page, derrière, montre le résultat en direct. */
    if (scope === "layout") {
      const current = draft.layout ?? "band";
      /* Une ligne par agencement, les unes sous les autres : la vignette à
         gauche, son nom et sa phrase à droite. Dans la colonne de la scène les
         cinq lignes se partagent TOUTE la hauteur du menu (`grow`), et la
         vignette grandit avec sa ligne en gardant son format. Réduit, le studio
         n'a pas de hauteur à donner : les lignes prennent celle de leur
         vignette. */
      const tall = !mini;
      /* La taille de l'avatar et du pseudo : un facteur sur les tailles de
         l'agencement, le même curseur que le flou (`as-range`). */
      const scaleSlider = (key: "avatarScale" | "nameScale", label: string) => {
        const v = draft[key] ?? 100;
        return (
          <div key={key} className="grid gap-1.5">
            <span className="flex items-center justify-between font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/45">
              {label}
              <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 normal-case tracking-normal text-white/80">
                {v} %
              </span>
            </span>
            <span className="as-range relative block h-4 w-full">
              <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.14]" />
              <span
                className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-action"
                style={{ width: `${((v - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100}%` }}
              />
              <input
                type="range"
                min={SCALE_MIN}
                max={SCALE_MAX}
                step={5}
                value={v}
                onChange={(e) => patch({ [key]: clampScale(e.target.value) })}
                onDoubleClick={() => patch({ [key]: 100 })}
                style={{ pointerEvents: "auto" }}
                aria-label={label}
              />
            </span>
          </div>
        );
      };
      out.push({
        /* Sans intitulé : le menu s'appelle déjà « Agencement » (16/10/2026). */
        title: "",
        rows: [],
        grow: true,
        fill: true,
        node: (
          <div className={`flex flex-col gap-4 ${tall ? "min-h-0 flex-1" : ""}`}>
          <div className="grid grid-cols-2 gap-4 px-1">
            {scaleSlider("avatarScale", t("profile.studioAvatarScale"))}
            {scaleSlider("nameScale", t("profile.studioNameScale"))}
          </div>
          <div
            className={`grid gap-2 ${tall ? "min-h-0 flex-1" : ""}`}
            style={tall ? { gridTemplateRows: `repeat(${HERO_LAYOUTS.length}, minmax(4.5rem, 1fr))` } : undefined}
          >
            {HERO_LAYOUTS.map((id) => {
              const on = current === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => patch({ layout: id })}
                  className={`group flex min-h-0 items-stretch gap-3 rounded-xl p-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                    on ? "bg-action/15 ring-2 ring-action" : "bg-white/[0.03] ring-1 ring-white/10 hover:bg-white/[0.07]"
                  }`}
                >
                  <span
                    className={`block shrink-0 transition-transform duration-200 group-hover:scale-[1.02] ${
                      tall ? "aspect-[16/10] h-full max-w-[55%]" : "w-36"
                    }`}
                  >
                    <LayoutThumb
                      layout={id}
                      avatar={identity.avatar}
                      name={identity.name}
                      stats={statsKey ? statsKey.split("\u0001") : undefined}
                      fill={tall}
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-1 pr-1">
                    <span
                      className={`flex items-center justify-between gap-2 font-karla text-[15px] font-bold ${
                        on ? "text-white" : "text-white/80"
                      }`}
                    >
                      {t(`profile.studioLayout_${id}`)}
                    </span>
                    <span className="text-xs leading-snug text-white/50">
                      {t(`profile.studioLayoutHint_${id}`)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          </div>
        ),
      });
    }

    if (scope !== "music" && scope !== "layout" && !ready) {
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
          {/* Une seule rangée de colonnes égales : en `flex-wrap`, la dernière
              pastille tombait seule sur une seconde ligne dès que la colonne
              rétrécissait. */}
          <div
            className="grid items-center gap-2"
            style={{ gridTemplateColumns: `repeat(${swatches.length}, minmax(0, 1fr))` }}
          >
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
                  className={`aspect-square w-full max-w-9 justify-self-center rounded-full transition-transform hover:scale-110 ${
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
      /* Les motifs, dessinés dans la couleur courante : on choisit sur le rendu
         réel, pas sur une vignette générique. « Aucun » rend l'aplat. */
      const tint = isHexColor(draft.color) ? draft.color! : accent;
      const current = draft.kind === "color" ? draft.pattern ?? null : null;
      const zoom = clampPatternZoom(draft.patternZoom);
      const speed = clampPatternSpeed(draft.patternSpeed);
      const withPattern: Partial<Dressing> = current
        ? {}
        : { kind: "color", color: tint, pattern: PATTERN_IDS[0], url: null, source: null, animeId: null, title: null };
      out.push({
        title: t("profile.studioPatternSection"),
        rows: [],
        grow: true,
        node: (
          <div className={`grid gap-2.5 ${!mini && scope ? "min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto]" : ""}`}>
          {/* Les vignettes prennent la place que le sélecteur de couleur laisse
              dans la colonne (PatternGrid) : rien à faire défiler. */}
          <PatternGrid count={PATTERN_IDS.length + 1} fill={!mini && !!scope}>
            {[null, ...PATTERN_IDS].map((id) => {
              const name = id ? t(`profile.studioPatterns.${id}`) : t("profile.studioPatternNone");
              return (
                <button
                  key={id ?? "none"}
                  type="button"
                  title={name}
                  aria-label={name}
                  aria-pressed={current === id}
                  onClick={() =>
                    patch({ kind: "color", color: tint, pattern: id, url: null, source: null, animeId: null, title: null })
                  }
                  /* La vignette choisie : une bordure `action` de 2 px, À
                     L'INTÉRIEUR (`ring-inset`). L'anneau blanc fin d'avant se
                     perdait dans les motifs ; un anneau extérieur décalé, lui,
                     débordait sur les voisines (l'écart n'est que de 6 px). */
                  className={`aspect-[3/2] rounded-md transition-transform hover:scale-[1.04] ${
                    current === id
                      ? /* « Aucun motif » est un aplat de la couleur : une
                           bordure `action` s'y fondrait, elle y est blanche. */
                        `ring-2 ring-inset ${id ? "ring-action" : "ring-white"}`
                      : "ring-1 ring-white/10"
                  }`}
                  style={{ background: id ? patternBackground(id, tint, 1.5) : tint }}
                />
              );
            })}
          </PatternGrid>
          {/* Toujours affichés ET actifs. Grisés sur l'aplat, ils passaient pour
              cassés (13/10/2026) : sur l'aplat, toucher un réglage pose donc le
              premier motif, pour que le geste ait un effet visible. */}
          {(
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 px-1">
              {/* Les deux réglages CÔTE À CÔTE, chacun sa moitié : sur deux
                  lignes, l'œil faisait l'aller-retour d'un bout à l'autre de la
                  colonne. Ils passent l'un sous l'autre si la place manque. */}
              <div className="flex min-w-[12rem] flex-1 items-center gap-2.5">
                {/* Zoom au dixième : un pas de ×0,5 sautait trop d'un coup. */}
                <span className="font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/35">
                  {t("profile.studioPatternZoom")}
                </span>
                <StudioRange
                  value={zoom}
                  min={PATTERN_ZOOM_MIN}
                  max={PATTERN_ZOOM_MAX}
                  step={PATTERN_ZOOM_STEP}
                  onChange={(v) => patch({ ...withPattern, patternZoom: clampPatternZoom(v) })}
                  label={t("profile.studioPatternZoom")}
                />
                <span className="w-14 shrink-0 rounded-md bg-white/[0.07] py-0.5 text-center font-karla text-[11px] font-bold tabular-nums text-white/80">
                  ×{zoom.toFixed(1)}
                </span>
              </div>
              <div className="flex min-w-[15rem] flex-1 items-center gap-2.5">
                {/* L'intitulé, PUIS l'interrupteur : on lit ce qu'on bascule. */}
                <span className="font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/35">
                  {t("profile.studioPatternAnim")}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!draft.patternAnim}
                  aria-label={t("profile.studioPatternAnim")}
                  title={t("profile.studioPatternAnim")}
                  onClick={() => patch({ ...withPattern, patternAnim: !draft.patternAnim })}
                  className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${
                    draft.patternAnim ? "bg-action" : "bg-white/[0.16]"
                  }`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                      draft.patternAnim ? "translate-x-[14px]" : ""
                    }`}
                  />
                </button>
                {/* La vitesse ne sert qu'animé : grisée sinon, mais à sa place,
                    pour que la ligne ne saute pas quand on bascule. */}
                <div
                  className={`flex min-w-0 flex-1 items-center gap-2.5 ${
                    draft.patternAnim ? "" : "pointer-events-none opacity-35"
                  }`}
                >
                  <StudioRange
                    value={speed}
                    min={PATTERN_SPEED_MIN}
                    max={PATTERN_SPEED_MAX}
                    step={1}
                    onChange={(v) => patch({ patternSpeed: clampPatternSpeed(v) })}
                    label={t("profile.studioPatternSpeed")}
                  />
                  <span className="w-14 shrink-0 rounded-md bg-white/[0.07] py-0.5 text-center font-karla text-[11px] font-bold tabular-nums text-white/80">
                    {speed} px/s
                  </span>
                </div>
              </div>
            </div>
          )}
          </div>
        ),
      });
    }

    /* ── Les illustrations ────────────────────────────────────────────────
       Bannière et Image marchent comme l'onglet Vidéo : la liste des animés,
       puis les illustrations de celui qu'on ouvre. Elles montraient jusqu'ici
       les seules illustrations de l'anime du PROFIL, sans aucun moyen d'en
       atteindre un autre — la recherche filtrait des images, qui n'ont pas de
       nom, donc elle ne rendait jamais rien.

       Et elles sont RANGÉES PAR NATURE, sous les noms que la fiche anime leur
       donne déjà (`anime.artType.*`) : un visuel clé, une miniature et une
       miniature de saison n'ont ni le même cadrage ni le même usage, et une
       grille indistincte obligeait à les reconnaître à l'œil. */
    if (scope === "banner" || scope === "image") {
      /* CHAQUE ONGLET NE MONTRE QUE CE QU'IL SAIT PORTER, et `familles` fait
         les deux choses à la fois : elle dit ce qui entre et dans quel ordre.
         Les deux onglets ont d'abord tout montré, au motif qu'« il en manque »
         — mais tout montrer a son propre défaut : une bande de profil fait
         1900 px de large pour 300 de haut, et une affiche 2:3 ou un disque
         rond n'y entrent que rognés au point de ne plus rien représenter.

         Bannière : les seuls formats en bande. Image : la pleine page, d'où
         sortent les formats qui n'y tiennent pas, pour DEUX raisons distinctes.

         Le cadrage : une affiche 2:3, un disque rond, une bande de 1000×185
         n'entrent dans une pleine page que rognés au point de ne plus rien
         représenter. Le fond transparent : clear art, logo et art de personnage
         sont des calques faits pour être POSÉS sur une image, pas pour en être
         une — ils donnaient une plaque vide avec un titre ou un personnage qui
         flotte au milieu.

         Et la résolution, traitée juste en dessous. */
      const LARGE: string[] = ["banner", "seasonbanner", "anilist"];
      /* LA PLEINE PAGE NE DESCEND PAS SOUS LE FULL HD, et c'est un critere de
         qualite a part entiere : une plaque de profil fait ~1900 px de large,
         donc une image plus etroite y est AGRANDIE, et un agrandissement ne
         s'ameliore jamais. La miniature et la miniature de saison font
         1000x562 par specification fanart.tv — 1,9x d'etirement. Elles
         sortent.
         Restent les deux formats qui tiennent : `background` (1920x1080 pile,
         impose par fanart.tv) et `wallpaper`, en tete parce que c'est le seul
         a monter AU-DESSUS — jusqu'a 7680x4320.
         L'onglet Illustrations de la fiche, lui, garde tout : on y parcourt
         des illustrations, on n'y choisit pas un fond. Une miniature de
         1000x562 y est parfaitement legitime a sa taille. */
      const PLEIN: string[] = ["wallpaper", "background"];
      const familles = scope === "banner" ? LARGE : PLEIN;

      /* EN ACCORDÉON (13/10/2026) : la liste des animés reste à l'écran, et
         celui qu'on ouvre déplie sa galerie SOUS SA LIGNE. Plus d'aller-retour
         entre deux écrans pour comparer deux titres. Un seul ouvert à la fois :
         la galerie tient sur les sources d'UN anime (`pick`). `artRoot` garde la
         ligne ouverte quand le sélecteur de saison fait changer `pick` vers une
         saison absente de la liste. */
      const ouvert = pick == null ? null : artRoot ?? pick;
      /* Ta liste d'abord, puis ce qu'AniList trouve en plus ; et la ligne
         ouverte reste, même quand la recherche ne la trouve plus. */
      const dansListe = new Set(animes.map((a) => a.mediaId));
      const liste = animes.filter((a) => match(a.title) || a.mediaId === ouvert);
      const ailleurs = found.filter((a) => !dansListe.has(a.mediaId));
      const ouvertAilleurs =
        ouvert != null && !dansListe.has(ouvert) && !ailleurs.some((a) => a.mediaId === ouvert)
          ? vus.current.get(ouvert)
          : undefined;
      liste.push(...(ouvertAilleurs ? [ouvertAilleurs] : []), ...ailleurs);
      const ligne = (a: StudioAnime): Row => {
        /* Le compte exact une fois l'animé ouvert, sinon celui de la route
           groupée, réduit aux types que l'onglet garde. */
        const types = artTypes[a.mediaId];
        const n =
          artCompte.current.get(`${scope}:${a.mediaId}`) ??
          (types ? familles.reduce((s, f) => s + (types[f] || 0), 0) : undefined);
        const vide = n === 0;
        return {
        key: `anime-art-${a.mediaId}`,
        label: a.title,
        hint: vide
          ? t("profile.studioNoArt")
          : n != null
            ? t("profile.studioArtCount", { count: n })
            : dansListe.has(a.mediaId)
              ? null
              : t("profile.studioNotInList"),
        thumb: a.cover ?? null,
        cover: true,
        dim: vide,
        hover: (on) => prefetchArt(on ? a.mediaId : null),
        selected: draft.animeId === a.mediaId && !!draft.url,
        expand: false,
        run: () => {
          holdAnchor(`anime-art-${a.mediaId}`);
          setPick(a.mediaId);
          setArtRoot(a.mediaId);
          setArtAll(false);
          setCursor(0);
        },
        };
      };
      const at = ouvert == null ? -1 : liste.findIndex((a) => a.mediaId === ouvert);
      const gal: Section[] = [];
      if (pick != null) {
        const cible = listedAnime;
        /* Trois provenances pour une seule galerie : fanart.tv (tous ses
           types), TMDB (fonds, affiches, logos — il couvre les titres que
           fanart.tv ignore), et ce que le profil connaît déjà de cet anime (la
           bannière AniList et son affiche). Dédoublonnage par URL : les trois
           se recoupent, et fanart.tv passe en premier parce que ses lignes sont
           classées par votes. */
        const vues = new Set<string>();
        /* DEUX URL PAR IMAGE, et c'est tout l'objet de `plein`. TMDB sert ses
           galeries en `w780` — une vignette — et l'image entiere sous
           `original`. Poser la vignette en fond de profil, c'est etirer 780 px
           sur 1900 : mesure du 08/09/2026, w780 = 780x439 pour 81 Ko quand
           l'original fait 1920x1080 pour 165 Ko. La tuile garde la vignette (on
           en affiche des centaines), le fond prend l'image.
           fanart.tv n'a pas ce probleme : son proxy sert deja le 1920x1080,
           simplement transcode en WebP. */
        /* `width`/`height` ne sont renseignes que par Wallhaven, seule source a
           les declarer. Ailleurs ils restent absents et `artPixels` deduit la
           resolution du type, ce que la specification de fanart.tv rend exact
           (cf. lib/images/artQuality.ts). */
        const galerie: Array<{
          url: string;
          plein: string;
          type: string;
          likes: number;
          width?: number;
          height?: number;
          /** La provenance, qui ordonne la planche : 0 fanart.tv, 1 TMDB,
              2 Wallhaven, 3 la galerie du profil. */
          src: number;
        }> = [];
        let src = 0;
        const ajouter = (
          url: string | null | undefined,
          type: string,
          likes = 0,
          plein?: string | null,
          width?: number,
          height?: number,
        ) => {
          if (!url || vues.has(url)) return;
          vues.add(url);
          galerie.push({ url, plein: plein || url, type, likes, width, height, src });
        };
        for (const a of collectArtworks(fanarts)) ajouter(a.url, a.type, a.likes || 0);
        src = 1;
        for (const a of tmdbArts) ajouter(a.url, a.type, a.likes || 0, a.fullUrl);
        /* Wallhaven en dernier : ses images sont trouvees par recherche texte
           et non par identifiant, donc ce sont les seules des trois qui
           puissent appartenir a un autre anime. La vignette pour la tuile, le
           fichier entier pour le fond — jusqu'a 7680x4320, ce qu'aucune des
           deux autres sources ne propose. */
        src = 2;
        for (const w of wallpapers)
          ajouter(w.url, w.type, w.likes || 0, w.fullUrl, w.width, w.height);
        /* Lu dans le cache, par l'id ouvert, et non dans `art` : ce dernier
           garde la réponse de l'anime PRÉCÉDENT jusqu'à l'arrivée de la
           nouvelle, et ses images s'affichaient sous le nouveau titre. `art`
           reste en dépendance : c'est lui qui annonce l'arrivée. */
        src = 3;
        for (const o of artCache.current.get(pick) ?? []) {
          ajouter(o.url, o.source === "cover" ? "poster" : o.source, o.likes || 0);
        }
        /* L'affiche de la liste arrive en `medium` — 230 px de large. La
           galerie la montre telle quelle (c'est une tuile) mais ce qui part en
           fond passe par la meme regle que partout ailleurs. */
        ajouter(cible?.cover, "poster", 0, pleineTaille(cible?.cover ?? null));

        /* Où se pose une image qu'on choisit : en bande ou en pleine page. La
           réponse tient dans `source`, que le profil relit ensuite (plateMode)
           — les formats que le stockage ne connaît pas se rangent donc sous le
           plus proche qu'il connaisse. */
        const rangement: Record<string, BannerOption["source"]> = {
          background: "background",
          thumb: "thumb",
          seasonthumb: "seasonthumb",
          banner: "banner",
          seasonbanner: "seasonbanner",
          anilist: "anilist",
          poster: "cover",
          seasonposter: "cover",
        };

        /* UNE SEULE GRILLE, sans intitulés. Le classement par nature reste,
           mais il ne se lit plus : il ne sert qu'à décider ce qui vient en
           premier — les formats de l'onglet, puis tout le reste. Des en-têtes
           tous les quatre images hachaient la planche en tranches, et on ne
           choisit pas une image à sa dénomination : on la reconnaît. */
        const rang = new Map(familles.map((f, i) => [f, i]));
        const rows = galerie
          /* Le filtre est ici, et pas au moment de collecter : les trois
             provenances se dédoublonnent par URL, et une même image peut
             arriver sous deux noms de type selon la source. On collecte tout,
             on ne montre que ce que l'onglet porte. */
          .filter((o) => rang.has(o.type))
          .sort(
            /* LE FORMAT D'ABORD, LA QUALITE ENSUITE — et non l'inverse. Ici,
               contrairement a l'onglet Illustrations de la fiche, le
               regroupement par nature est ce qui rend la planche lisible : on
               choisit un fond de profil dans une famille, pas dans un
               classement. `byQuality` departage a l'interieur d'une famille, ou
               il se reduit exactement aux votes tant que les dimensions sont
               fixes (fanart.tv) et classe les fonds d'ecran Wallhaven par
               resolution reelle entre eux. */
            /* FANART.TV EN TÊTE (14/10/2026, demande de Luc) : ses fonds
               sont faits pour un titre précis et classés par votes, là où
               Wallhaven est trouvé par recherche texte. Le format ordonnait
               seul, et `wallpaper` venant avant `background`, Wallhaven
               passait devant toute la galerie fanart.tv. La provenance
               d'abord, puis le format, puis la qualité. */
            (a, b) => a.src - b.src || rang.get(a.type)! - rang.get(b.type)! || byQuality(a, b),
          )
          .map((o) => ({
            key: o.url,
            label: cible?.title || "",
            /* Pas de compte de votes sur la tuile : il ne sert qu'au tri. */
            hint: null,
            thumb: o.url,
            selected: draft.url === o.url,
            run: () =>
              patch({
                kind: scope as "banner" | "image",
                url: o.plein,
                color: null,
                /* Où se pose l'image — bandeau ou pleine page — reste décidé
                   par sa nature, même si elle ne s'affiche plus. */
                source: rangement[o.type] ?? "background",
                animeId: cible?.mediaId ?? null,
                title: cible?.title ?? null,
              }),
          }));
        /* LE COMPTE DU TITRE, pas de ce qui est chargé : Wallhaven arrive par
           pages de 24, et compter les lignes reçues donnait « 29 » dans
           l'en-tête quand la liste, elle, annonçait « 140 » (15/10/2026). Le
           même calcul sert à l'en-tête, au fondu et au sous-titre de la ligne. */
        const total =
          scope === "image"
            ? galerie.filter((o) => rang.has(o.type) && o.type !== "wallpaper").length +
              Math.max(facettes.tout, wallpapers.length)
            : rows.length;

        /* L'en-tête de l'animé ouvert EST sa ligne de l'accordéon : un clic
           dessus le replie. */
        gal.push({
          title: "",
          node: (
            <AnimeHead
              anime={cible}
              count={total}
              countKey="profile.studioArtCount"
              seasons={seasons}
              current={pick}
              onPick={(id) => {
                setPick(id);
                setArtAll(false);
                setCursor(0);
              }}
              anchor={`anime-art-${ouvert}`}
              onClose={() => {
                holdAnchor(`anime-art-${ouvert}`);
                setPick(null);
                setCursor(0);
              }}
              t={t}
            />
          ),
          rows: [],
        });
        /* La planche apparaît dès que fanart.tv est là, sans attendre la
           galerie du profil (/api/v2/profile-banner, la plus lente : elle passe
           par AniList). Celle-ci n'apporte que la bannière AniList et l'affiche,
           rangées en DERNIER par `rang`, ou des doublons de fanart.tv écartés
           par URL : leur arrivée allonge la planche sans la réordonner.
           fanart.tv en échec (`null` sans requête en vol) : on attend alors la
           galerie du profil avant de conclure qu'il n'y a rien. */
        const enRoute = fanartsLoading || (fanarts == null && !artCache.current.has(pick));
        const complet = !enRoute && !loading && artCache.current.has(pick) && !wallLoading;
        /* Wallhaven se déroule par pages de 24 : compté à son total (`tout`),
           comme le fait la route groupée, et non à ce qui est déjà chargé. */
        if (complet)
          artCompte.current.set(`${scope}:${pick}`, total);
        if (rows.length && !enRoute) {
          /* TRIER LES FONDS D'ÉCRAN PAR NATURE, avant la grille.

             Ce sont les seules images de la planche qui portent des facettes :
             elles viennent des tags Wallhaven, et ni fanart.tv ni TMDB n'ont de
             vocabulaire. C'est ici qu'elles servent le plus — on ouvre le studio
             pour choisir UNE image, et pouvoir dire « des illustrations, pas des
             captures » ou « avec le personnage » est exactement la question
             qu'on se pose à ce moment-là.

             Une rangée de puces, pas cinq lignes : dans l'accordéon, chaque
             ligne de plus repousse les animés suivants hors de vue. Seulement
             celles qui mènent quelque part — une facette vide ne ferait rien. */
          if (scope === "image" && facettes.tout > 0) {
            const proposables = (
              ["tout", "illustration", "capture", "personnage", "paysage"] as const
            ).filter((f) => f === "tout" || facettes[f] > 0);
            if (proposables.length > 1) {
              gal.push({
                title: "",
                rows: [],
                node: (
                  <div className="flex flex-wrap gap-1.5 px-1 pt-1">
                    {proposables.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFacette(f)}
                        aria-pressed={facette === f}
                        className={`rounded-full px-2.5 py-1 font-karla text-[12px] font-bold transition-colors ${
                          facette === f
                            ? "bg-action text-white"
                            : "bg-white/[0.06] text-white/65 hover:text-white"
                        }`}
                      >
                        {t(`anime.artFacet.${f}`)}
                        <span className="ml-1 opacity-60">{facettes[f]}</span>
                      </button>
                    ))}
                  </div>
                ),
              });
            }
          }
          /* Six images d'abord : l'animé ouvert ne doit pas chasser les
             suivants de la colonne. Le reste se déroule sur demande. */
          /* Trois rangées, quelle que soit la densité. */
          const APERCU = mini ? 6 : densite * 3;
          const court = !artAll && rows.length > APERCU;
          /* PAS DE TROU EN BAS DE LA GRILLE. Tant qu'il reste des images à
             charger, on n'en montre qu'un multiple du nombre de colonnes : la
             dernière rangée est pleine, et l'image en trop arrive avec la page
             suivante. Dans la colonne, 2 tuiles par rangée (1 en bande) ; en
             pleine largeur la grille passe de 2 à 4 colonnes, d'où 12, qui
             tombe juste dans les trois cas. */
          const cols = mini ? 12 : densite;
          const encore = !court && wallHasMore;
          const montre = court
            ? rows.slice(0, APERCU)
            : encore
              ? rows.slice(0, Math.max(cols, rows.length - (rows.length % cols)))
              : rows;
          aPrecharger.current = {
            id: pick,
            urls: rows.slice(montre.length).flatMap((r) => (r.thumb ? [r.thumb] : [])),
          };
          gal.push({
            title: "",
            rows: montre,
            grid: true,
            bande: scope === "banner",
            /* La suite se devine sous un fondu posé sur la dernière rangée
               (choix n° 01 de l'artefact « Bouton Montrer plus », 14/10) : une
               pilule sous la grille se lisait comme un élément de plus. Le
               même fondu déroule ensuite Wallhaven, page par page (onglet
               Image seulement : c'est le seul qui l'interroge). */
            fondu: court
              ? {
                  label: t("profile.studioArtSeeAll", { count: total - APERCU }),
                  run: () => setArtAll(true),
                }
              : undefined,
            /* UN SEUL CLIC (15/10/2026). Une fois déroulée, la grille ne
               redemande plus rien : Wallhaven continue au défilement, page
               après page. La page suivante est déjà préchargée (cf. la file
               de préchargement), elle arrive donc sans attente. */
            suite: encore
              ? () => {
                  if (!wallLoading) loadMoreWall();
                }
              : undefined,
          });
        } else if (!complet)
          /* Les sources sont encore en route : des cases qui attendent, au
             format de l'onglet, plutôt qu'un « aucune illustration » qui
             mentirait pendant une seconde. */
          gal.push({
            title: "",
            rows: [],
            node: (
              <div className={`grid gap-2 px-0 pb-2 ${scope === "banner" ? "grid-cols-1" : "grid-cols-2"}`}>
                {Array.from({ length: scope === "banner" ? 3 : 6 }, (_, i) => (
                  <div
                    key={i}
                    className={`animate-pulse rounded-xl bg-white/[0.05] ${
                      scope === "banner" ? "aspect-[1000/185]" : "aspect-video"
                    }`}
                  />
                ))}
              </div>
            ),
          });
        else
          gal.push({
            title: "",
            rows: [
              {
                key: "no-art",
                label: t("profile.studioNoArtHere"),
                hint: t("profile.studioNoArtHereHint"),
                icon: PhotoIcon,
                disabled: true,
              },
            ],
          });
      }
      for (const s of gal) s.panel = true;
      const titre = t(`profile.studioKind_${scope}`);
      if (at < 0) out.push(...gal, { title: titre, rows: liste.map(ligne) });
      else
        out.push(
          { title: titre, rows: liste.slice(0, at).map(ligne) },
          ...gal,
          { title: "", rows: liste.slice(at + 1).map(ligne) },
        );
    }

    /* ── Les bandes-annonces ──────────────────────────────────────────────
       Elles arrivent avec la liste (une ligne de plus dans la requête AniList
       déjà faite), donc cette section ne coûte aucune requête non plus. Tous
       les titres qui en ont une sont proposés — c'est la seule source de fond
       animé qui existe aujourd'hui pour n'importe quel anime, là où les
       génériques dépendent de la couverture d'AnimeThemes. */
    if (scope === "video") {
      /* DEUX ÉCRANS, et c'est délibéré : on choisit d'abord un ANIME, puis une
         de ses vidéos. Le raccourci — une ligne par anime qui applique
         directement sa bande-annonce — ne tenait que tant qu'il n'y avait
         qu'une vidéo par titre ; il n'aurait plus de place le jour où un titre
         en a deux, et il ne laissait pas atteindre les saisons absentes de la
         liste, que le sélecteur de saison de l'écran suivant, lui, atteint. */
      if (pick == null) {
        const rows = animes
          .filter((a) => a.trailer && match(a.title))
          .map((a) => ({
            key: `anime-video-${a.mediaId}`,
            label: a.title,
            hint: t("profile.studioSeeVideos"),
            thumb: a.cover ?? null,
            selected: draft.animeId === a.mediaId && !!draft.trailerId,
            run: () => {
              setPick(a.mediaId);
              setQuery("");
              setCursor(0);
            },
          }));
        /* Une liste locale ne porte pas de bandes-annonces : elle n'a jamais vu
           AniList. Le dire vaut mieux qu'un panneau vide, qui se lit comme une
           panne. */
        out.push({
          title: t("profile.studioTrailers"),
          rows: rows.length
            ? rows
            : [
                {
                  key: "no-trailer",
                  label: t("profile.studioNoTrailer"),
                  hint: t("profile.studioNoTrailerHint"),
                  icon: FilmIcon,
                  disabled: true,
                },
              ],
        });
      } else {
        const picked = listedAnime;
        const trailer = picked?.trailer ?? null;
        const rows: Row[] = [
          {
            key: "video-back",
            label: t("profile.studioAllAnimes"),
            icon: ArrowUturnLeftIcon,
            run: () => {
              setPick(null);
              setQuery("");
              setCursor(0);
            },
          },
        ];
        rows.push(
          trailer
            ? {
                key: `trailer-${trailer}`,
                label: t("profile.artTrailer"),
                hint: picked?.title ?? null,
                icon: FilmIcon,
                selected: draft.trailerId === trailer,
                run: () =>
                  patch({
                    kind: "video" as const,
                    /* Pas d'`url` : une bande-annonce se joue par son lecteur
                       YouTube, jamais comme un fichier (cf. `trailerId`). */
                    url: null,
                    trailerId: trailer,
                    /* Une vidéo qu'on vient de choisir est entière : le
                       découpage se fait ensuite, aux poignées — et les bornes
                       de la précédente n'ont aucun sens sur celle-ci. */
                    videoFrom: null,
                    videoTo: null,
                    color: null,
                    source: null,
                    animeId: picked?.mediaId ?? null,
                    title: picked?.title ?? null,
                  }),
              }
            : {
                key: "no-video",
                label: t("profile.studioNoVideoHere"),
                hint: t("profile.studioNoVideoHereHint"),
                icon: FilmIcon,
                disabled: true,
              },
        );
        out.push({
          title: "",
          node: (
            <AnimeHead
              anime={picked}
              count={trailer ? 1 : 0}
              countKey="profile.studioVideoCount"
              seasons={seasons}
              current={pick}
              onPick={(id) => {
                setPick(id);
                setCursor(0);
              }}
              t={t}
            />
          ),
          rows,
        });
      }
    }

    if (scope === "oped" || scope === "music") {
      /* Musique : les génériques de l'anime OUVERT, lus dans le cache par son
         id — `themes` garde ceux du précédent jusqu'à l'arrivée des nouveaux,
         et ils s'afficheraient sous le mauvais titre (même piège que `art`). */
      const liste = scope === "music" ? (pick != null ? themeCache.current.get(pick) ?? null : null) : themes;
      /* Les pochettes de CET anime seulement : l'état garde celles du
         précédent le temps d'une requête, et « OP1 » est un slug commun. */
      const themeCovers = coverState.id === listedAnimeId ? coverState.covers : {};
      const rows: Row[] = (liste ?? [])
        /* En Musique la frappe cherche un ANIME : elle ne filtre pas les
           pistes de celui qu'on ouvre — « chainsawman » ne figure dans aucun
           titre de chanson, et la liste se viderait. */
        .filter(
          (th) =>
            scope === "music" ||
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
            /* Le slug quitte la ligne de détail pour devenir une pastille de
               couleur — c'est ainsi que la fiche anime distingue un opening
               d'un ending, et le studio n'a aucune raison de le dire autrement. */
            chip: { text: th.slug.toUpperCase(), op: th.kind === "op" },
            hint: [artist, episodes ? t("profile.studioMusicEpisodes", { episodes }) : null]
              .filter(Boolean)
              .join(" · "),
            icon: MusicalNoteIcon,
            /* Rien trouvé nulle part (la route a répondu `null`) : l'affiche
               de l'anime, pour qu'aucune ligne ne reste sans image. Pas avant
               la réponse — l'affiche clignoterait avant la vraie pochette. */
            thumb:
              th.slug in themeCovers
                ? (themeCovers[th.slug] ?? (meta?.mediaId === listedAnimeId ? meta : listedAnime)?.cover ?? null)
                : null,
            square: true,
            disabled: !url,
            selected:
              scope === "music"
                ? !!draft.music?.url &&
                  [url, th.videoNc?.audio, th.video?.audio].includes(draft.music.url)
                : draft.url === url,
            run: url
              ? () =>
                  scope === "music"
                    ? (patch({
                        music: {
                          /* L'OGG d'AnimeThemes, pas la vidéo : 2 Mo au lieu
                             de 47 pour le même son (Cyberpunk OP1). */
                          url: th.videoNc?.audio || th.video?.audio || url,
                          title: label,
                          artist,
                          slug: th.slug.toUpperCase(),
                          /* La pochette du morceau quand Deezer l'a, sinon
                             l'affiche de l'anime. */
                          cover: themeCovers[th.slug] ?? (meta?.mediaId === listedAnimeId ? meta : listedAnime)?.cover ?? null,
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
                        /* Entier, comme une bande-annonce qu'on vient de
                           choisir : les bornes du générique précédent n'ont
                           aucun sens sur celui-ci. */
                        videoFrom: null,
                        videoTo: null,
                        color: null,
                        source: null,
                        animeId: currentAnime?.mediaId ?? null,
                        title: currentAnime?.title ?? null,
                      })
              : undefined,
          };
        });
      if (scope === "music") {
        /* EN ACCORDÉON, COMME IMAGE (16/10/2026) : ta liste, puis ce
           qu'AniList trouve en plus dès trois lettres ; l'anime ouvert déplie
           ses génériques sous sa ligne, avec leurs pochettes. Il n'y avait
           avant qu'UN anime à la fois, et l'atteindre demandait de taper son
           nom exact. */
        if (draft.music)
          out.push({
            title: "",
            rows: [
              {
                key: "no-music",
                label: t("profile.studioMusicOff"),
                hint: draft.music.title,
                icon: SpeakerWaveIcon,
                run: () => patch({ music: null }),
              },
            ],
          });
        const ouvert = pick == null ? null : artRoot ?? pick;
        const dansListe = new Set(animes.map((a) => a.mediaId));
        const tous = animes.filter((a) => match(a.title) || a.mediaId === ouvert);
        const ailleurs = found.filter((a) => !dansListe.has(a.mediaId));
        const ouvertAilleurs =
          ouvert != null && !dansListe.has(ouvert) && !ailleurs.some((a) => a.mediaId === ouvert)
            ? vus.current.get(ouvert)
            : undefined;
        tous.push(...(ouvertAilleurs ? [ouvertAilleurs] : []), ...ailleurs);
        const ligne = (a: StudioAnime): Row => {
          /* Le compte exact une fois les génériques ouverts, sinon celui de
             la requête groupée. */
          const g = themeCache.current.get(a.mediaId)?.length ?? musicCounts[a.mediaId];
          /* Des « songs » et non des génériques (16/10/2026) : la
             bande-annonce compte, puisqu'elle se prend comme les autres. */
          const n = g == null ? g : g + (a.trailer ? 1 : 0);
          return {
            key: `anime-music-${a.mediaId}`,
            label: a.title,
            hint:
              n === 0
                ? t("profile.studioMusicNoneHere")
                : n != null
                  ? t("profile.studioMusicCount", { count: n })
                  : dansListe.has(a.mediaId)
                    ? null
                    : t("profile.studioNotInList"),
            thumb: a.cover ?? null,
            cover: true,
            dim: n === 0,
            hover: (on) => prefetchMusic(on ? a.mediaId : null),
            expand: false,
            run: () => {
              holdAnchor(`anime-music-${a.mediaId}`);
              setPick(a.mediaId);
              setArtRoot(a.mediaId);
              setCursor(0);
            },
          };
        };
        const at = ouvert == null ? -1 : tous.findIndex((a) => a.mediaId === ouvert);
        const gal: Section[] = [];
        if (pick != null) {
          gal.push({
            title: "",
            rows: [],
            node: (
              <AnimeHead
                anime={meta?.mediaId === pick ? meta : listedAnime}
                count={
                  (liste?.length ?? 0) +
                  ((meta?.mediaId === pick ? meta : listedAnime)?.trailer ? 1 : 0)
                }
                seasons={seasons}
                current={pick}
                onPick={(id) => {
                  setPick(id);
                  setCursor(0);
                }}
                anchor={`anime-music-${ouvert}`}
                onClose={() => {
                  holdAnchor(`anime-music-${ouvert}`);
                  setPick(null);
                  setCursor(0);
                }}
                t={t}
              />
            ),
          });
          /* La bande-annonce se prend aussi comme musique (16/10/2026) : en
             tête, avant les génériques, et même quand l'anime n'en a aucun —
             c'est souvent le seul son d'un titre pas encore diffusé. */
          const vu = meta?.mediaId === pick ? meta : listedAnime;
          const pv = vu?.trailer ?? null;
          if (pv)
            gal.push({
              title: "",
              rows: [
                {
                  key: `music-trailer-${pv}`,
                  label: "Trailer",
                  /* TRL, en vert : ni opening (accent) ni ending (bleu). */
                  chip: { text: "TRL", op: false, color: "#4ade80" },
                  hint: vu?.title ?? null,
                  icon: FilmIcon,
                  thumb: `https://i.ytimg.com/vi/${pv}/mqdefault.jpg`,
                  square: true,
                  selected: !draft.music?.url && draft.music?.videoId === pv,
                  run: () => {
                    patch({
                      music: {
                        url: "",
                        title: "Trailer",
                        artist: vu?.title ?? null,
                        slug: "TRL",
                        /* La vignette du trailer, la même que sa ligne : l'affiche
                           de `vu` pouvait être celle d'un autre anime (16/10/2026). */
                        cover: `https://i.ytimg.com/vi/${pv}/mqdefault.jpg`,
                        from: null,
                        to: null,
                        fade: fadeSec,
                        videoId: pv,
                      },
                    });
                    setWantPlay(true);
                  },
                },
              ],
            });
          if (liste == null)
            /* Les génériques sont en route : des lignes qui attendent, plutôt
               qu'un « aucun générique » qui mentirait une seconde. */
            gal.push({
              title: "",
              rows: [],
              node: (
                <div className="grid gap-2 px-2 pb-2">
                  {Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="h-10 w-10 animate-pulse rounded-md bg-white/[0.06]" />
                      <div className="h-3 flex-1 animate-pulse rounded bg-white/[0.05]" />
                    </div>
                  ))}
                </div>
              ),
            });
          else
            gal.push({
              title: "",
              rows: rows.length
                ? rows
                : [
                    {
                      key: "no-theme",
                      label: t(notAired[pick] ? "profile.studioMusicNotAired" : "profile.studioMusicNoneHere"),
                      icon: MusicalNoteIcon,
                      disabled: true,
                    },
                  ],
            });
        }
        for (const s of gal) s.panel = true;
        const titre = t("profile.studioKind_music");
        if (at < 0) out.push(...gal, { title: titre, rows: tous.map(ligne) });
        else
          out.push(
            { title: titre, rows: tous.slice(0, at).map(ligne) },
            ...gal,
            { title: "", rows: tous.slice(at + 1).map(ligne) },
          );
        return out.filter((s) => s.rows.length > 0 || s.node);
      }
      /* L'anime se présente en TÊTE DE LISTE, avec son affiche, son titre et
         ses saisons — au lieu du seul intitulé en petites capitales qui tenait
         ce rôle. Trois choses qu'on cherchait ailleurs y sont réunies : de quel
         anime on parle, combien il a de génériques, et comment atteindre ceux
         d'une autre saison sans repasser par la recherche. */
      out.push({
        title: "",
        node: (
          <AnimeHead
            anime={meta ?? listedAnime}
            count={themes.length}
            seasons={seasons}
            current={listedAnimeId}
            onPick={(id) => {
              setAnimeId(id);
              setQuery("");
              setCursor(0);
            }}
            t={t}
          />
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
    /* Pas dans Image ni Bannière : leur accordéon liste déjà les animés
       trouvés, cette section les y montrait une seconde fois. */
    const others = (!q || scope === "color" || scope === "image" || scope === "banner" ? [] : animes)
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
        /* Choisir un anime EFFACE la recherche. La frappe qui a servi à le
           trouver n'a aucune raison de filtrer ensuite ses génériques : on
           tapait « one », on tombait sur One-Punch Man, et le panneau ne
           montrait que les thèmes dont le titre contient « one » — c'est-à-dire
           presque rien. La liste s'ouvre donc entière. */
        run: () => {
          setAnimeId(a.mediaId);
          setQuery("");
          setCursor(0);
          search.current?.focus();
        },
      }));
    if (others.length) out.push({ title: t("profile.studioOtherAnime"), rows: others });

    return out.filter((s) => s.rows.length > 0 || s.node);
  }, [scope, query, art, fanarts, tmdbArts, wallpapers, wallHasMore, wallLoading,
    loadMoreWall, facettes, facette, setFacette, themes, animes, animeId, currentAnime,
      listedAnime, listedAnimeId, meta, seasons, pick, fadeSec, draft,
      accent, patch, t, frames, frameBudget, coverState, prefetchMusic, notAired, identity.avatar, identity.name, statsKey, earned, badgeRarity, badgeCols, frameSort, frameSeed, frameCols, mini,
      artRoot, artAll, loading, fanartsLoading, holdAnchor, found, artTypes, musicCounts, prefetchArt, densite,
      entries]);

  /* « VOIR LES N AUTRES » INSTANTANÉ. Au clic, la liste est déjà là ; ce qui
     manquait, ce sont les images — le navigateur ne les demandait qu'à
     l'affichage. Elles partent donc d'avance, une fois les tuiles visibles
     servies (au repos du navigateur) : d'abord les vignettes `/preview/` de
     fanart.tv (~5 Ko), pour que la grille soit pleine même sur un clic
     rapide, puis les images entières. Quatre à la fois au plus. Puis, onglet
     Image, la page Wallhaven suivante et ses vignettes : son MEMO est celui
     que relit `loadMore`, le clic suivant n'attend plus le réseau.
     Rien côté Vercel pour les images (fanart-proxy, TMDB, Wallhaven) ; la
     page Wallhaven est en cache d'edge. Seulement pour l'animé OUVERT : la
     file s'arrête dès qu'il change. */
  useEffect(() => {
    const cible = aPrecharger.current;
    if (pick == null || cible.id !== pick) return;
    const file = [
      ...cible.urls.flatMap((u) => {
        const a = apercuDe(u);
        return a ? [a] : [];
      }),
      ...cible.urls,
    ].filter((u) => !PRECHARGEES.has(u));
    let alive = true;
    let wallDemandee = false;
    const suivant = () => {
      if (!alive) return;
      const u = file.shift();
      if (u) {
        PRECHARGEES.add(u);
        const img = new window.Image();
        img.decoding = "async";
        img.onload = img.onerror = suivant;
        img.src = u;
        return;
      }
      /* La file est vide : une page Wallhaven d'avance, une seule. */
      if (wallDemandee || scope !== "image" || !wallHasMore || wallLoading) return;
      wallDemandee = true;
      const page = Math.ceil(wallpapers.length / WALL_PAR_PAGE) + 1;
      fetchPage(pick, facette, page).then((p) => {
        if (!alive) return;
        file.push(...p.arts.map((a) => a.url).filter((x) => !PRECHARGEES.has(x)));
        for (let k = 0; k < PRECHARGE_PARALLELE; k++) suivant();
      });
    };
    const lancer = () => {
      for (let k = 0; k < PRECHARGE_PARALLELE; k++) suivant();
    };
    const ric = typeof window.requestIdleCallback === "function";
    const h = ric ? window.requestIdleCallback(lancer, { timeout: 1500 }) : window.setTimeout(lancer, 400);
    return () => {
      alive = false;
      if (ric) window.cancelIdleCallback(h);
      else window.clearTimeout(h);
    };
  }, [sections, pick, scope, wallHasMore, wallLoading, wallpapers.length, facette]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  useEffect(() => setCursor(0), [scope, query, animeId]);
  useEffect(() => {
    if (tabVise && tabVise === scope) setTabVise(null);
  }, [tabVise, scope]);
  useEffect(() => {
    if (barVise && barVise === scope) setBarVise(null);
  }, [barVise, scope]);
  const barScope = barVise ?? scope;

  /* ── Clavier ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        /* Échap ne ferme RIEN : le menu de gauche est toujours ouvert (il n'y a
           pas d'état « sans menu » dans la scène), et Échap sert aussi aux
           champs des widgets (renommage). Coûter tout le brouillon sur une
           touche est exclu. */
        return;
      }
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openScope(scope ?? "banner");
        return;
      }
      if (!scope) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") setClavier(true);
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

  /* La barre du bas bascule sur le rail de la vidéo dès qu'on en CHOISIT une :
     les menus glissent hors du bandeau, une flèche à droite les rappelle. Le
     choix seul déclenche la bascule — rouvrir le studio sur une vidéo déjà
     portée laisse les menus en place. */
  const videoKey =
    draft.kind === "video" || isVideoKind(draft.kind) ? draft.trailerId || draft.url || "" : "";
  const [barVideo, setBarVideo] = useState(false);
  /* Un autre menu que Musique ramène les menus sur la barre. */
  useEffect(() => {
    if (scope && scope !== "music") setBarMusic(false);
  }, [scope]);
  const lastVideo = useRef(videoKey);
  useEffect(() => {
    if (videoKey && videoKey !== lastVideo.current) setBarVideo(true);
    if (!videoKey) setBarVideo(false);
    lastVideo.current = videoKey;
  }, [videoKey]);

  if (!open) return null;

  const pinned = !!value;
  /* Ce que l'aperçu montre : le brouillon dès qu'il a quelque chose, sinon la
     plaque automatique — pour que l'écran ne s'ouvre jamais sur du vide. */
  /* Une bande-annonce est un fond à part entière, sans `url` ni couleur : sans
     elle dans ce test, l'aperçu retombait sur la bannière automatique et le
     studio montrait autre chose que ce qu'on venait de choisir. */
  const shown: Dressing =
    hasOwnPlate(draft)
      ? draft
      : { ...draft, kind: "banner", url: auto.url, source: auto.source };

  /* « Enregistrer » ferme l'édition dans tous les cas. Rien n'a changé : rien à
     écrire. Un brouillon sans fond à lui (on n'a touché qu'au cadre, au flou ou
     à l'agencement) épingle la plaque automatique avec ces réglages — c'est ce
     que la page montrait, et l'ancien bouton grisé perdait ces réglages-là en
     silence maintenant qu'on les règle directement sur le profil. */
  const changed = JSON.stringify(draft) !== JSON.stringify(value ?? emptyDressing());
  const finish = () => {
    if (changed && hasOwnPlate(shown)) onApply(shown);
    else onClose();
  };

  let index = -1;

  /* ── L'extrait ──────────────────────────────────────────────────────
     Sans découpe, l'extrait vaut tout le fichier : les bornes ne sont écrites
     dans le brouillon qu'à partir du moment où on y a touché. */
  const from = draft.music?.from ?? 0;
  const to = draft.music?.to ?? len;
  const pct = (s: number) => (len ? Math.min(100, Math.max(0, (s / len) * 100)) : 0);

  /* ── La source : version TV ou version complète ─────────────────────
     Un générique a deux sources possibles : le rip d'AnimeThemes (90 s, la
     version télé) et la version COMPLÈTE sur YouTube, quand le résolveur l'a
     trouvée — ou quand on colle soi-même le lien. Le choix se fait au pied du
     menu ; changer de source remet les bornes à zéro, les deux durées n'ayant
     rien de commun. */
  const tvUrl = draft.music?.url || "";
  let knownFull: string | null = null;
  if (tvUrl)
    for (const list of themeCache.current.values())
      for (const th of list)
        if (!knownFull && [th.videoNc?.audio, th.video?.audio, th.videoNc?.url, th.video?.url].includes(tvUrl))
          knownFull = th.youtubeId ?? null;
  const fullId = (tvUrl && draft.music?.videoId) || fullFor[tvUrl] || knownFull;
  const setSource = (full: boolean) => {
    if (!draft.music) return;
    const cur = draft.music.videoId;
    if (!full && cur && tvUrl) setFullFor((m) => ({ ...m, [tvUrl]: cur }));
    patch({ music: { ...draft.music, videoId: full ? fullId || null : null, from: null, to: null } });
    setAt(0);
    setLen(0);
    setWantPlay(true);
  };
  /** Un lien YouTube collé (watch, youtu.be, shorts, embed) ou l'identifiant nu. */
  const applyLink = () => {
    const raw = (ytLink ?? "").trim();
    const m =
      /(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(raw) ??
      /^([A-Za-z0-9_-]{11})$/.exec(raw);
    if (!m || !draft.music) {
      setYtBad(true);
      return;
    }
    const id = m[1];
    if (tvUrl) setFullFor((f) => ({ ...f, [tvUrl]: id }));
    patch({ music: { ...draft.music, videoId: id, from: null, to: null } });
    setYtLink(null);
    setYtBad(false);
    setAt(0);
    setLen(0);
    setWantPlay(true);
  };

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
    /* L'écoute suit la borne qu'on tire, comme pour la vidéo : on entend
       l'endroit exact où l'extrait commence ou s'arrête. */
    const el = preview.current;
    if (el) {
      const p = edge === "from" ? next.from : Math.max(next.from, next.to - 0.1);
      el.currentTime = p;
      setAt(p);
    }
  };

  /* ── L'extrait du fond vidéo ─────────────────────────────────────────────
     Les mêmes bornes que la musique, pour LES DEUX sortes de vidéo : la
     bande-annonce YouTube et le générique d'AnimeThemes. La durée ne vient pas
     de nous mais du lecteur — tant qu'il n'a rien dit, le rail n'a pas
     d'échelle et ne se dessine pas. */
  const videoDraft = !!draft.trailerId || (isVideoKind(draft.kind) && !!draft.url);
  const vFrom = draft.videoFrom ?? 0;
  const vTo = draft.videoTo ?? vLen;

  /* L'anime de la vidéo EN COURS, qui n'est pas forcément celui que la liste
     montre : on peut revenir à « tous les animés » sans rien changer au
     brouillon, et le pied doit continuer de dire de quoi il parle. */
  const trailerAnime =
    animes.find((a) => a.mediaId === draft.animeId) ?? listedAnime ?? null;

  /** Poser la lecture de la vidéo, en la gardant DANS l'extrait. */
  const vSeek = (ratio: number) => {
    if (!vLen) return;
    const p = Math.min(vTo, Math.max(vFrom, ratio * vLen));
    remote.current?.seek(p);
    setVAt(p);
  };

  /** Déplacer une borne de la vidéo. Trois secondes au minimum, comme
      pour la musique : plus court, le fond n'est plus qu'un battement. */
  const setVTrim = (edge: "from" | "to", raw: number) => {
    if (!videoDraft || !vLen) return;
    const MIN = 3;
    const s = Math.min(vLen, Math.max(0, raw));
    const next =
      edge === "from"
        ? { videoFrom: Math.max(0, Math.min(s, vTo - MIN)), videoTo: vTo }
        : { videoFrom: vFrom, videoTo: Math.min(vLen, Math.max(s, vFrom + MIN)) };
    patch(next);
    /* La vidéo suit la borne qu'on tire : on voit le plan exact où l'extrait
       commence ou s'arrête. Pour la fin, un dixième avant — posée PILE sur la
       borne, la boucle du fond la renverrait aussitôt au début. */
    const p =
      edge === "from"
        ? next.videoFrom
        : Math.max(next.videoFrom, next.videoTo - 0.1);
    remote.current?.seek(p);
    setVAt(p);
  };

  /* Pendant qu'on tire une borne, la lecture se fige sur le plan de la borne ;
     au lâcher, elle repart. Après la borne de fin, on reprend trois secondes
     avant : on voit la fin de l'extrait PUIS la reprise de la boucle. */
  const grabVTrim = (edge: "from" | "to", held: boolean) => {
    if (held) {
      remote.current?.pause();
      return;
    }
    if (edge === "to") {
      const p = Math.max(vFrom, vTo - 3);
      remote.current?.seek(p);
      setVAt(p);
    }
    remote.current?.play();
  };
  const grabTrim = (edge: "from" | "to", held: boolean) => {
    const el = preview.current;
    if (!el) return;
    if (held) {
      el.pause();
      return;
    }
    if (edge === "to") {
      const p = Math.max(from, to - 3);
      el.currentTime = p;
      setAt(p);
    }
    void el.play().catch(() => setPlaying(false));
  };

  /* L'onglet Couleur ne cherche rien : ses couleurs sont toutes à l'écran. Les
     agencements non plus — ils sont cinq, en vignettes, et un champ de recherche
     au-dessus de cinq vignettes est un aveu de liste trop longue. */
  const searchable = scope !== "color" && scope !== "layout" && scope !== "wall";
  /** Tous les menus s'ouvrent dans la colonne de gauche de la scène — et il y
      en a toujours un d'ouvert, sauf quand le studio est réduit. */
  const inColumn = !mini && !!scope;
  /** On regarde des illustrations : le panneau prend toute la place qu'il peut. */
  const galerieOuverte = (scope === "banner" || scope === "image") && pick != null;
  const ScopeIcon =
    !scope || scope === "music"
      ? SpeakerWaveIcon
      : scope === "layout"
        ? LayoutIcon
        : scope === "frame"
          ? FrameIcon
          : scope === "badges"
            ? TrophyIcon
            : KIND_ICON[scope];

  /* Les pièces que la scène et la pilule réduite partagent. */
  const liveBadge = (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/40 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[.12em] text-white/75 ring-1 ring-white/15">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      {t("profile.studioLive")}
    </span>
  );
  const cancelButton = (
    <button
      type="button"
      onClick={onClose}
      className="shrink-0 rounded-full bg-black/40 px-3 py-1.5 text-[11px] font-bold text-white/80 ring-1 ring-white/15 transition-colors hover:bg-black/70"
    >
      {t("common.cancel", { defaultValue: "Annuler" })}
    </button>
  );
  const saveButton = (
    <button
      type="button"
      onClick={finish}
      className="shrink-0 rounded-full bg-action px-4 py-1.5 text-[11px] font-bold text-white transition-transform hover:scale-105"
    >
      {t("profile.studioSave")}
    </button>
  );
  const sizeToggle = (
    <button
      type="button"
      onClick={() => {
        /* Réduire referme tout ; revenir en scène rouvre le menu des fonds. */
        setScope(mini ? readLastScope() : null);
        setMini(!mini);
      }}
      title={t(mini ? "profile.studioExpand" : "profile.studioCollapse")}
      aria-label={t(mini ? "profile.studioExpand" : "profile.studioCollapse")}
      aria-expanded={!mini}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
    >
      <ChevronDownIcon
        className={`h-4 w-4 transition-transform ${mini ? "rotate-180" : ""}`}
        strokeWidth={2.2}
      />
    </button>
  );

  /* ── L'extrait du fond vidéo ──────────────────────────────
      Le même pied, le même rail et le même geste que la musique —
      c'est le même besoin : une bande-annonce commence par un logo
      de studio, un opening par un carton de titre, et ce n'est pas
      ce qu'on veut voir tourner en fond de profil.

      Il sert les DEUX onglets vidéo, et c'est voulu : « Vidéo » et
      « Intro / Outro » ne diffèrent que par la provenance du plan
      (un lecteur YouTube d'un côté, un fichier d'AnimeThemes de
      l'autre) ; le geste de découpe, lui, est le même, et le
      plateau les pilote déjà tous les deux par la même
      télécommande.

      Pas de volume ici : le fond de profil est muet par principe —
      c'est la musique qui a le droit de faire du bruit.

      Il vit dans la BARRE DU BAS, sous le cadre où la vidéo tourne :
      choisir une vidéo y pousse les menus hors du bandeau (10/10). */
  const videoBar =
    (scope === "video" || scope === "oped") && videoDraft ? (
    <div className="flex h-full min-w-0 flex-1 select-none items-center gap-3 pl-4 pr-2">
      <button
        type="button"
        onClick={() =>
          vPlaying ? remote.current?.pause() : remote.current?.play()
        }
        aria-label={t(vPlaying ? "profile.studioVideoPause" : "profile.studioVideoPlay")}
        className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-black/50 ring-1 ring-white/10"
      >
        {trailerAnime?.cover ? (
          <Image src={trailerAnime.cover} alt="" fill sizes="44px" className="object-cover" />
        ) : null}
        <span className="absolute inset-0 grid place-items-center bg-black/45 text-white transition-colors group-hover:bg-black/60">
          {vPlaying ? (
            <PauseIcon className="h-5 w-5 drop-shadow" />
          ) : (
            <PlayIcon className="ml-0.5 h-5 w-5 drop-shadow" />
          )}
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate font-outfit text-[13px] font-bold text-white">
          {draft.title || t("profile.artTrailer")}
          <span className="ml-2 rounded bg-white/[0.08] px-1.5 py-0.5 align-middle font-karla text-[10px] font-bold uppercase tracking-[.08em] text-white/45">
            {t(draft.trailerId ? "profile.artTrailer" : "profile.studioKind_oped")}
          </span>
        </p>
        <div className="mt-2 flex items-center gap-2">
          <span className="w-9 shrink-0 text-right font-mono text-[10px] text-white/40">
            {clock(vAt)}
          </span>
          <TrimRail
            len={vLen}
            from={vFrom}
            to={vTo}
            at={vAt}
            onSeek={vSeek}
            onTrim={setVTrim}
            onGrab={grabVTrim}
            t={t}
          />
          <span className="w-9 shrink-0 font-mono text-[10px] text-white/40">
            {clock(vLen)}
          </span>

          {/* Le fondu AU NOIR, à la reprise de la boucle. Même
              bascule que celle de la musique, et même défaut d'une
              seconde et demie une fois allumée — sauf qu'ici elle
              naît allumée : un fond qui reboucle sous les yeux de
              qui lit la page saute à chaque tour, et la coupe
              franche y est la gêne plutôt que l'exception. */}
          <button
            type="button"
            onClick={() =>
              patch({
                videoFade: clampFade(
                  (draft.videoFade ?? 0) > 0 ? 0 : DEFAULT_VIDEO_FADE,
                ),
              })
            }
            aria-pressed={(draft.videoFade ?? 0) > 0}
            title={t("profile.studioVideoFadeHint")}
            className={`h-6 shrink-0 rounded-full px-2.5 font-karla text-[11px] font-bold uppercase tracking-[.06em] ring-1 transition-colors ${
              (draft.videoFade ?? 0) > 0
                ? "bg-action/20 text-white ring-action/50"
                : "bg-white/[0.07] text-white/45 ring-white/[0.06] hover:text-white"
            }`}
          >
            {t("profile.studioMusicFade")}
          </button>
        </div>
      </div>
    </div>
    ) : null;
  const showVideo = barVideo && !!videoBar;

  /* Le lecteur de musique — pochette, titre, version, rail des bornes, fondu,
     volume. Le même au pied du menu Musique et posé sur la barre du bas. */
  const musicPlayer = draft.music ? (
    <>
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
                    {ytLink !== null ? (
                      /* Coller sa propre version : le résolveur peut ne pas
                         l'avoir trouvée, ou avoir pris la mauvaise. */
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          applyLink();
                        }}
                        className="flex items-center gap-2"
                      >
                        <input
                          autoFocus
                          value={ytLink}
                          onChange={(e) => {
                            setYtLink(e.target.value);
                            setYtBad(false);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setYtLink(null);
                            }
                          }}
                          placeholder={t("profile.studioMusicLinkPh")}
                          className={`h-7 min-w-0 flex-1 rounded-md bg-white/[0.07] px-2.5 font-karla text-[12px] text-white outline-none ring-1 placeholder:text-white/30 ${
                            ytBad ? "ring-red-400/70" : "ring-white/10 focus:ring-action/60"
                          }`}
                        />
                        <button
                          type="submit"
                          className="h-7 shrink-0 rounded-md bg-action px-3 font-karla text-[11px] font-bold text-white"
                        >
                          {t("profile.studioMusicLinkOk")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setYtLink(null)}
                          aria-label={t("profile.studioMusicLinkCancel")}
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/45 hover:text-white"
                        >
                          <XMarkIcon className="h-4 w-4" />
                        </button>
                      </form>
                    ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="min-w-0 flex-1 truncate font-outfit text-[13px] font-bold text-white">
                        {draft.music.title}
                      </p>
                      {/* Version TV / complète : seulement pour un générique
                          (la bande-annonce n'a que sa vidéo). « Complète »
                          sans version connue ouvre directement le champ du
                          lien. */}
                      {tvUrl ? (
                        <div className="flex h-6 shrink-0 items-center rounded-full bg-white/[0.07] p-0.5 ring-1 ring-white/[0.06]">
                          {([false, true] as const).map((full) => {
                            const on = full === !!draft.music?.videoId;
                            return (
                              <button
                                key={String(full)}
                                type="button"
                                onClick={() => {
                                  if (on) return;
                                  if (full && !fullId) setYtLink("");
                                  else setSource(full);
                                }}
                                aria-pressed={on}
                                title={full ? t("profile.studioMusicFull") : undefined}
                                className={`h-5 rounded-full px-2.5 font-karla text-[10.5px] font-bold uppercase tracking-[.06em] transition-colors ${
                                  on ? "bg-action text-white" : "text-white/45 hover:text-white"
                                }`}
                              >
                                {t(full ? "profile.studioMusicSrcFull" : "profile.studioMusicSrcTv")}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                    )}
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
                      <TrimRail
                        len={len}
                        from={from}
                        to={to}
                        at={at}
                        buf={buf}
                        onSeek={seek}
                        onTrim={setTrim}
                        onGrab={grabTrim}
                        t={t}
                      />
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
    </>
  ) : null;
  const showMusic = barMusic && !!musicPlayer && !showVideo;

  return (
    <>
    {/* Réduite, la pilule flotte sur le profil rendu à sa taille : cette cale
        lui garde sa place sous le pied de page. En scène, le profil défile
        dans son cadre et n'en a pas besoin. */}
    {mini ? <div aria-hidden className="h-20" /> : null}
    {/* Au-dessus de la scène (ProfileStage, z-[10002]) et de la barre de
        navigation. Le conteneur couvre la fenêtre mais ne capte RIEN : le
        profil reste cliquable, ses widgets déplaçables. */}
    <div className="pointer-events-none fixed inset-0 z-[10003] overflow-hidden text-white">
      {/* ── La palette, ancrée sur le bouton cliqué ───────────────────── */}
      {scope ? (
        <>
          {/* Le menu des fonds vit dans sa colonne, à côté du profil : pas de
              voile, on regarde le résultat en choisissant. Les autres menus
              (musique, agencement, cadre) restent des fenêtres posées sur le
              cadre, et se ferment d'un clic à côté. */}
          {inColumn ? null : (
          <button
            type="button"
            aria-label={t("common.close", { defaultValue: "Close" })}
            onClick={() => setScope(null)}
            className="pointer-events-auto absolute inset-0 z-20 cursor-default bg-gradient-to-t from-black/80 via-black/40 to-transparent"
          />
          )}
          {/* Plus AUCUNE ancre en pointe sous le panneau : la flèche visait un
              bouton qui bouge d'un onglet à l'autre, donc elle en désignait un
              autre une fois sur deux. Le panneau se tient à distance du dock et
              se laisse lire seul. */}
          {/* `pointer-events-none` sur la bande, `auto` sur le panneau : sans
              cela, cliquer À CÔTÉ du panneau — la bande le traverse d'un bord à
              l'autre de l'écran — tombait sur ce conteneur et non sur le voile
              en dessous, et le menu ne se fermait pas. */}
          {/* LE PANNEAU S'ELARGIT POUR LES IMAGES. Trois colonnes de vignettes
              dans 768 px, ce sont des timbres-poste ; le reste des onglets, lui,
              est fait de lignes de texte et n'a rien a gagner a s'etaler. */}
          <div
            className={
              inColumn
                ? `pointer-events-none absolute bottom-[22px] left-[var(--as-scene-menu-left)] top-[var(--as-scene-top)] z-30 flex w-[var(--as-scene-menu-w)] ${
                    "as-scene-ui-left"
                  }`
                : "pointer-events-none absolute bottom-[calc(100%_-_var(--as-scene-frame-bottom)_+_0.75rem)] left-[var(--as-scene-frame-left)] right-[var(--as-scene-frame-right)] z-30 flex justify-center"
            }
          >
            <div
              className={`pointer-events-auto relative w-full overflow-hidden rounded-2xl bg-[#15161d] shadow-[0_28px_70px_rgba(0,0,0,.75)] ring-1 ring-white/10 ${
                inColumn
                  ? "flex flex-col bg-[#15161d]"
                  : galerieOuverte
                    ? "max-w-6xl"
                    : scope === "frame"
                      ? "max-w-5xl"
                      : "max-w-3xl"
              }`}
            >
              <div className="relative z-10 flex items-center gap-3 border-b border-white/[0.07] px-4 py-3.5">
                {/* L'onglet Couleur n'a rien à chercher : ses couleurs tiennent
                    toutes à l'écran. Il porte donc son titre, pas un champ qui
                    ne filtrerait rien. */}
                {searchable ? (
                  <>
                    <MagnifyingGlassIcon className="h-5 w-5 shrink-0 text-white/45" />
                    {/* Plus de pastille du menu (rose) avant le champ : la
                        barre du bas dit déjà quel menu est ouvert (16/10/2026). */}
                    <input
                      ref={search}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t(
                        scope === "frame"
                          ? "profile.studioFrameSearch"
                          : scope === "badges"
                            ? "profile.studioBadgesSearch"
                            : "profile.studioSearch",
                      )}
                      className="min-w-0 flex-1 bg-transparent font-karla text-[15px] text-white outline-none placeholder:text-white/35"
                    />
                    {/* Les réglages de la grille des cadres : le tri, et la
                        taille des cases (− = plus de cases par ligne, donc plus
                        petites ; + = moins de cases, plus grandes). */}
                    {scope === "frame" ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        {/* Un menu plutôt qu'une rangée de boutons : sept tris
                            ne tiennent pas à côté de la recherche. */}
                        <div ref={frameSortRef} className="relative">
                          <button
                            type="button"
                            aria-haspopup="listbox"
                            aria-expanded={frameSortOpen}
                            title={t("profile.studioFrameSortLabel")}
                            onClick={() => setFrameSortOpen((o) => !o)}
                            className="flex h-7 items-center gap-1.5 rounded-full bg-white/[0.06] pl-2.5 pr-2 font-karla text-[11px] font-bold text-white/80 ring-1 ring-white/10 transition-colors hover:text-white"
                          >
                            <ArrowsUpDownIcon className="h-3.5 w-3.5" />
                            {t(`profile.studioFrameSort_${frameSort}`)}
                            <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${frameSortOpen ? "rotate-180" : ""}`} />
                          </button>
                          {frameSortOpen ? (
                            <ul
                              role="listbox"
                              aria-label={t("profile.studioFrameSortLabel")}
                              className="absolute right-0 top-full z-30 mt-1.5 min-w-[11rem] rounded-xl bg-[#14141c] p-1 shadow-xl ring-1 ring-white/10"
                            >
                              {FRAME_SORTS.map((s) => (
                                <li key={s}>
                                  <button
                                    type="button"
                                    role="option"
                                    aria-selected={frameSort === s}
                                    onClick={() => {
                                      if (s === "random") setFrameSeed((n) => n + 1);
                                      setFrameSort(s);
                                      setFrameSortOpen(false);
                                    }}
                                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left font-karla text-[12px] font-bold transition-colors ${
                                      frameSort === s ? "bg-action/20 text-white" : "text-white/65 hover:bg-white/[0.06] hover:text-white"
                                    }`}
                                  >
                                    {t(`profile.studioFrameSort_${s}`)}
                                    {frameSort === s ? <CheckIcon className="h-3.5 w-3.5 text-action" /> : null}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          title={t("profile.studioFrameSmaller")}
                          aria-label={t("profile.studioFrameSmaller")}
                          disabled={frameCols >= FRAME_COLS_MAX}
                          onClick={() => setFrameCols((c) => Math.min(FRAME_COLS_MAX, c + 1))}
                          className="grid h-7 w-7 place-items-center rounded-full bg-white/[0.06] text-white/70 ring-1 ring-white/10 transition-colors hover:text-white disabled:opacity-30"
                        >
                          <MinusIcon className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          title={t("profile.studioFrameBigger")}
                          aria-label={t("profile.studioFrameBigger")}
                          disabled={frameCols <= FRAME_COLS_MIN}
                          onClick={() => setFrameCols((c) => Math.max(FRAME_COLS_MIN, c - 1))}
                          className="grid h-7 w-7 place-items-center rounded-full bg-white/[0.06] text-white/70 ring-1 ring-white/10 transition-colors hover:text-white disabled:opacity-30"
                        >
                          <PlusIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <ScopeIcon className="h-5 w-5 shrink-0 text-white/45" />
                    <h2 className="min-w-0 flex-1 font-outfit text-[15px] font-bold text-white">
                      {t(`profile.studioKind_${scope}`)}
                    </h2>
                  </>
                )}
                {/* Pas de croix dans la colonne : on y change de menu, on ne
                    la vide pas. */}
                <button
                  type="button"
                  onClick={() => setScope(null)}
                  className={`shrink-0 rounded-lg p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white ${
                    inColumn ? "hidden" : ""
                  }`}
                  aria-label={t("common.close", { defaultValue: "Close" })}
                >
                  <XMarkIcon className="h-[1.15rem] w-[1.15rem]" />
                </button>
              </div>

              {/* Les onglets d'un groupe du dock (Image / Bannière…), en
                  sélecteur pleine largeur. Changer d'onglet garde la recherche
                  et l'animé choisi : ses images et ses bannières sont la même
                  galerie. */}
              {(groupOf(scope)?.length ?? 0) > 1 ? (
                /* `pb-2.5` : un espace fixe entre les onglets et la grille, qui
                   ne part pas au défilement (le padding du défileur, lui, s'en
                   va avec la première rangée). */
                <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-2.5">
                  <div
                    role="tablist"
                    className="relative flex min-w-0 flex-1 gap-1 rounded-xl bg-white/[0.04] p-1 ring-1 ring-white/[0.06]"
                  >
                    {/* LA PASTILLE GLISSE d'un onglet à l'autre au lieu de
                        sauter. Transition simple, sans condition
                        `prefers-reduced-motion` : ce poste répond `reduce`, et
                        ce n'est qu'un déplacement court. */}
                    <span
                      aria-hidden
                      className="absolute bottom-1 left-1 top-1 rounded-lg bg-white/[0.1] transition-transform duration-300 ease-[cubic-bezier(.3,.7,.2,1)]"
                      style={{
                        width: `calc((100% - 0.5rem - ${(groupOf(scope)!.length - 1) * 0.25}rem) / ${groupOf(scope)!.length})`,
                        transform: `translateX(calc(${Math.max(0, groupOf(scope)!.indexOf((tabVise ?? scope) as DressingKind))} * (100% + 0.25rem)))`,
                      }}
                    />
                    {groupOf(scope)!.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="tab"
                        aria-selected={(tabVise ?? scope) === k}
                        onClick={() => {
                          if ((tabVise ?? scope) === k) return;
                          setTabVise(k);
                          writeLastScope(k);
                          startTransition(() => {
                            setScope(k);
                            setCursor(0);
                            if (k === "video" || k === "oped") setPick(null);
                          });
                        }}
                        className={`relative min-w-0 flex-1 truncate rounded-lg py-1.5 font-karla text-[12px] font-bold transition-colors duration-300 group ${
                          (tabVise ?? scope) === k ? "text-white" : "text-white/40 hover:text-white/75"
                        }`}
                      >
                        {/* Le libellé actif grossit d'un cheveu en s'allumant. */}
                        <span
                          className={`inline-block transition-transform duration-300 ${
                            (tabVise ?? scope) === k ? "scale-105" : "scale-100"
                          } group-active:scale-95`}
                        >
                          {t(`profile.studioKind_${k}`)}
                        </span>
                      </button>
                    ))}
                  </div>
                  {groupOf(scope)?.includes("image") ? (
                    /* Trois états en un bouton : 1 → 2 → 3 → 1. L'icône montre
                       la grille affichée MAINTENANT, et tourne en changeant.
                       Il reste MONTÉ dans tout le groupe et se replie sur le
                       Mur d'animés, qui n'a pas de grille : il glisse et
                       s'efface au lieu de disparaître d'un coup (la largeur
                       et la marge rattrapent l'écart du `gap-2`). */
                    <span
                      aria-hidden={!((tabVise ?? scope) === "image" || (tabVise ?? scope) === "banner")}
                      className={`grid shrink-0 place-items-center overflow-hidden transition-[width,margin,opacity,transform] duration-300 ease-[cubic-bezier(.3,.7,.2,1)] ${
                        (tabVise ?? scope) === "image" || (tabVise ?? scope) === "banner"
                          ? "ml-0 w-[2.35rem] scale-100 opacity-100"
                          : "pointer-events-none -ml-2 w-0 scale-75 opacity-0"
                      }`}
                    >
                    <button
                      tabIndex={(tabVise ?? scope) === "image" || (tabVise ?? scope) === "banner" ? 0 : -1}
                      type="button"
                      onClick={() => {
                        const d = (densite === 3 ? 1 : densite + 1) as Densite;
                        /* LE REGARD RESTE SUR LA MÊME IMAGE (15/10/2026). La
                           grille se réorganise, et la galerie déroulée se
                           repliait : on perdait l'image qu'on regardait. On
                           garde le dépliage, et on ancre la première tuile
                           visible — après le rendu, le défilement est recalé
                           pour qu'elle reste à la même hauteur à l'écran
                           (`holdAnchor`, le mécanisme de l'accordéon). */
                        const box = scrollerRef.current;
                        if (box) {
                          const haut = box.getBoundingClientRect().top;
                          const tuile = [...box.querySelectorAll<HTMLElement>('[data-anchor^="tuile:"]')].find(
                            (el) => el.getBoundingClientRect().bottom > haut + 8,
                          );
                          if (tuile) holdAnchor(tuile.dataset.anchor!);
                        }
                        setDensite(d);
                        writeDensite(d);
                      }}
                      title={t(`profile.studioDensite_${densite}`)}
                      aria-label={t(`profile.studioDensite_${densite}`)}
                      className="grid h-[2.35rem] w-[2.35rem] shrink-0 place-items-center rounded-xl bg-white/[0.04] text-white/60 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.08] hover:text-white group"
                    >
                      {/* Ce qui bouge au clic est DEDANS : un bouton qui rétrécit
                          sous le pointeur perd le clic relâché sur son bord. */}
                      <span className="grid place-items-center transition-transform duration-150 group-active:scale-90">
                        <span
                          className="grid place-items-center transition-transform duration-300 ease-[cubic-bezier(.3,.7,.2,1)]"
                          style={{ transform: `rotate(${(densite - 1) * 90}deg)` }}
                        >
                          <DensiteIcon d={densite} className="h-4 w-4" />
                        </span>
                      </span>
                    </button>
                    </span>
                  ) : null}
                </div>
              ) : null}

              {/* La barre de défilement partagée du site (`as-scroller`) : sur
                  une liste de cadres aussi longue, il faut voir où l'on en est. */}
              <div
                ref={scrollerRef}
                onPointerMove={clavier ? () => setClavier(false) : undefined}
                className={`as-scroller overflow-y-auto p-2.5 ${
                  inColumn ? "flex min-h-0 flex-1 flex-col" : "max-h-[52vh]"
                }`}
                /* La place du lecteur de musique posé par-dessus le bas. */
                style={scope === "music" && draft.music && !barMusic ? { marginBottom: footH } : undefined}
              >
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
                    <div
                      /* Les sections de l'animé ouvert changent de clé avec
                         lui : elles se remontent, et rejouent leur entrée. */
                      key={s.panel ? `ouvert-${pick}-${i}` : s.title || `sec-${i}`}
                      /* Pas de `min-h-0` : le sélecteur ne doit jamais être
                         comprimé sous sa hauteur utile — s'il manque de la
                         place, la colonne défile au lieu de tout tasser. */
                      className={
                        s.panel
                          ? "as-acc-in " + /* Un seul cadre pour les sections consécutives de
                               l'animé ouvert : bords hauts sur la première,
                               bas sur la dernière. */
                            `border-x px-1 ${
                              sections[i - 1]?.panel ? "" : "mt-1 rounded-t-2xl border-t pt-1"
                            } ${sections[i + 1]?.panel ? "" : "mb-2 rounded-b-2xl border-b pb-1"}`
                          : s.grow && inColumn
                            ? `flex flex-1 flex-col ${s.fill ? "min-h-0" : ""}`
                            : undefined
                      }
                      style={
                        s.panel
                          ? {
                              borderColor: `color-mix(in srgb, ${accent} 40%, transparent)`,
                              background: `color-mix(in srgb, ${accent} 7%, transparent)`,
                            }
                          : undefined
                      }
                    >
                      {/* Un bloc peut porter son propre intitulé (le sélecteur de
                          couleur nomme lui-même ses deux moitiés) : on ne lui en
                          impose pas un second. */}
                      {s.title ? (
                        <p className="px-3 pb-1.5 pt-3 font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/35">
                          {s.title}
                        </p>
                      ) : null}
                      {s.node ? (
                        /* Cadres : hors écran, une collection n'est ni mise en page
                           ni peinte (`content-visibility`), elle ne coûte qu'à
                           l'approche. Pas ailleurs : le confinement rogne ce qui
                           déborde (glisser-déposer des badges). `pt-[3px]` garde
                           l'anneau de la case choisie hors de la rognure. */
                        <div
                          className={`px-1 pb-1 ${
                            s.grow && inColumn
                              ? `flex flex-1 flex-col ${s.fill ? "min-h-0" : ""}`
                              : scope === "frame"
                                ? "pt-[3px] [contain-intrinsic-size:auto_240px] [content-visibility:auto]"
                                : ""
                          }`}
                        >
                          {s.node}
                        </div>
                      ) : null}
                      {s.grid ? (
                        /* LA GRILLE D'ILLUSTRATIONS. Les mêmes `rows`, donc le
                           même curseur clavier et la même coche que partout
                           ailleurs — seule la mise en page change. `contain` et
                           non `cover` : une affiche est en portrait, un visuel
                           clé en 16/9, et recadrer pour aligner les tuiles
                           montrerait de chaque image ce qu'on n'a pas choisi. */
                        <div className="relative">
                        {/* PAS de clé par densité : elle remontait toutes
                            les tuiles à chaque changement — les images
                            clignotaient, rejouaient leur entrée, et l'image
                            regardée se perdait (15/10/2026). */}
                        <div
                          className={`grid gap-2 px-1 pb-2 ${
                            inColumn
                              ? densite === 1
                                ? "grid-cols-1"
                                : densite === 2
                                  ? "grid-cols-2"
                                  : "grid-cols-3"
                              : s.bande
                                ? "grid-cols-1 lg:grid-cols-2"
                                : densite === 1
                                  ? "grid-cols-1 sm:grid-cols-2"
                                  : densite === 2
                                    ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
                                    : "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"
                          }`}
                        >
                          {s.rows.map((row, j) => {
                            index += 1;
                            const active = clavier && index === cursor;
                            /* LA VIGNETTE D'ABORD. Une tuile fanart.tv charge
                               l'image entière (1920×1080, ~115 Ko, 0,86 s
                               mesuré) ; le même proxy sert sous `/preview/`
                               une réduction de 200×112 (4,7 Ko, 0,45 s). Trop
                               petite pour la tuile, elle tient lieu de fond
                               flou le temps que l'image arrive par-dessus. */
                            const apercu = apercuDe(row.thumb);
                            return (
                              <button
                                key={row.key}
                                data-anchor={`tuile:${row.key}`}
                                type="button"
                                onClick={() => row.run?.()}
                                title={row.hint || row.label}
                                style={{
                                  /* Une cascade courte : chaque tuile 30 ms
                                     après la précédente, plafonnée pour qu'une
                                     page de 24 ne traîne pas. */
                                  ["--i" as string]: Math.min(j % 24, 8),
                                  ...(apercu
                                    ? { backgroundImage: `url("${apercu}")`, backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
                                    : {}),
                                }}
                                /* La tuile prend le FORMAT de ce qu'elle
                                   montre : 1000×185 pour une bande — la mesure
                                   de fanart.tv, et le plus étroit des deux, de
                                   sorte qu'une bannière AniList (1900×400) y
                                   entre entière avec un filet de noir plutôt
                                   que l'inverse. */
                                className={`as-tile-in group relative overflow-hidden rounded-xl bg-black/40 ring-1 transition-colors ${
                                  /* 16/9 : le format de presque toute la pleine page (fonds
                                     fanart.tv en 1920×1080, Wallhaven, TMDB) —
                                     plus de bandes noires autour. */
                                  s.bande ? "aspect-[1000/185]" : "aspect-video"
                                } ${
                                  row.selected
                                    ? "ring-2 ring-action"
                                    : active
                                      ? "ring-white/35"
                                      : "ring-white/10"
                                }`}
                              >
                                {row.thumb ? (
                                  <Image
                                    src={row.thumb}
                                    alt=""
                                    fill
                                    sizes={
                                      s.bande
                                        ? "(min-width: 1024px) 45vw, 90vw"
                                        : "(min-width: 1024px) 20vw, 40vw"
                                    }
                                    /* Les six premières sont celles qu'on voit
                                       en ouvrant : pas de chargement paresseux,
                                       et la priorité réseau. */
                                    loading={j < 6 ? "eager" : "lazy"}
                                    fetchPriority={j < 6 ? "high" : "auto"}
                                    onLoad={(e) => e.currentTarget.setAttribute("data-loaded", "")}
                                    className="as-tile-img object-contain transition-transform duration-300 group-hover:scale-[1.03]"
                                  />
                                ) : null}
                                {row.selected ? (
                                  <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-action text-white">
                                    <CheckIcon className="h-4 w-4" />
                                  </span>
                                ) : null}
                                {row.hint ? (
                                  <span className="absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 font-karla text-[10px] font-bold text-white/80">
                                    {row.hint}
                                  </span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                        {s.suite ? <Suite onVisible={s.suite} root={scrollerRef} /> : null}
                        {s.fondu ? (
                          /* Le fondu finit sur le fond du cadre de l'animé
                             ouvert (l'accent à 7 % sur la colonne), pour que
                             la dernière rangée s'y efface sans liseré. */
                          <div
                            /* Hauteur FIXE, à peu près une rangée de tuiles :
                               en pourcentage de la grille, le fondu grandissait
                               avec elle et, une fois dépliée, noyait plusieurs
                               rangées dont la dernière entièrement — un grand
                               vide au-dessus du libellé. */
                            className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center ${
                              s.bande ? "h-14" : densite === 1 ? "h-40" : densite === 2 ? "h-28" : "h-20"
                            }`}
                            style={{
                              background: `linear-gradient(to bottom, transparent, color-mix(in srgb, ${accent} 7%, #15161d) 92%)`,
                            }}
                          >
                            <button
                              type="button"
                              onClick={s.fondu.run}
                              key={s.fondu.label}
                              className="as-fondu-cta group pointer-events-auto rounded-full px-3 pb-0.5 pt-1.5 font-outfit text-[13.5px] font-bold text-white/90 transition-colors duration-200 hover:text-white"
                            >
                              <span className="flex items-center gap-1.5 transition-transform duration-200 group-hover:translate-y-0.5 group-active:scale-95">
                                {s.fondu.label}
                                <span className="as-nudge inline-grid">
                                  <ChevronRightIcon className="h-3.5 w-3.5 rotate-90" strokeWidth={2.4} />
                                </span>
                              </span>
                            </button>
                          </div>
                        ) : null}
                        </div>
                      ) : null}
                      {s.grid ? null : s.rows.map((row) => {
                        index += 1;
                        const active = clavier && index === cursor;
                        const Icon = row.icon;
                        return (
                          <button
                            key={row.key}
                            data-anchor={row.key}
                            type="button"
                            disabled={row.disabled}
                            onPointerEnter={row.hover ? () => row.hover!(true) : undefined}
                            onPointerLeave={row.hover ? () => row.hover!(false) : undefined}
                            onClick={() => row.run?.()}
                            /* TOUTE LA LISTE EST LÀ, mais le navigateur ne
                               peint que les lignes à l'écran : `content-
                               visibility` saute les autres et leur réserve
                               leur hauteur, donc la barre de défilement est
                               juste dès le départ. (Des tranches chargées au
                               défilement la faisaient remonter à chaque
                               arrivée, 15/10/2026.) Les affiches hors écran,
                               elles, ne sont pas demandées (next/image paresseux). */
                            style={{
                              contentVisibility: "auto",
                              /* La hauteur du CONTENU, sans le rembourrage
                                 (`py-2`, ajouté par-dessus) : 72 px réservés
                                 en faisaient 88, et la liste raccourcissait
                                 en défilant. */
                              containIntrinsicSize: row.cover ? "auto 56px" : "auto 40px",
                            }}
                            className={`group flex w-full items-center gap-3 rounded-xl px-3 text-left transition-colors ${
                              row.cover ? "py-2" : "py-2.5"
                            } ${row.dim ? "opacity-40 grayscale" : ""} ${
                              row.disabled
                                ? "cursor-not-allowed opacity-45"
                                : active
                                  ? /* Le survol (et la navigation au clavier,
                                       qui partagent ce curseur) pose une BOÎTE
                                       GRISE, pas un cadre rose : le rose disait
                                       « choisi » alors que la coche, elle, le
                                       dit déjà — deux marques pour deux états
                                       différents rendaient la ligne survolée
                                       indiscernable de la ligne active. Le survol est en CSS :
                                       il écrivait le curseur à chaque ligne traversée. */
                                    "bg-white/[0.09]"
                                  : "hover:bg-white/[0.09]"
                            }`}
                          >
                            {row.thumb ? (
                              <span
                                className={`relative shrink-0 overflow-hidden rounded-md bg-black/50 ${
                                  row.square ? "h-10 w-10" : row.cover ? "h-14 w-10" : "h-9 w-16"
                                }`}
                              >
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
                              <span className="flex min-w-0 items-center gap-2">
                                {/* La pastille EST le repère : on cherche « le
                                    deuxième ending », pas un titre de chanson.
                                    Mêmes couleurs que la fiche anime — l'accent
                                    du site pour un opening, son bleu pour un
                                    ending. Les valeurs sont écrites ici et non
                                    prises à `--accent-soft` : cette variable
                                    appartient au module CSS de la fiche anime et
                                    ne vaut rien hors de lui. */}
                                {row.chip ? (
                                  <span
                                    className="shrink-0 rounded font-karla text-[10px] font-bold leading-none tracking-[.03em]"
                                    style={{
                                      padding: "3px 5px",
                                      background: row.chip.color
                                        ? `color-mix(in srgb, ${row.chip.color} 16%, transparent)`
                                        : row.chip.op
                                          ? `color-mix(in srgb, ${accent} 16%, transparent)`
                                          : "rgba(120,140,255,0.14)",
                                      color: row.chip.color ?? (row.chip.op ? accent : "#8a9bff"),
                                    }}
                                  >
                                    {row.chip.text}
                                  </span>
                                ) : null}
                                <span className="truncate font-outfit text-[14px] font-bold text-white/90">
                                  {row.label}
                                </span>
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
                            {row.expand === false ? (
                              <ChevronRightIcon className="h-4 w-4 shrink-0 text-white/35 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/60" strokeWidth={2.2} />
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
              {/* Posé sur la barre, le lecteur PART PAR LA DROITE (et en revient).
                 Il est posé PAR-DESSUS le bas de la liste, qui ne bouge jamais :
                 en glissant, il la découvre au fur et à mesure — pas de fondu,
                 pas de hauteur qui se referme (demande de Luc, 16/10/2026).
                 Fond opaque, sinon la liste se lirait à travers. La marge du
                 bas de la liste (`footH`) n'existe que tant qu'il est là. */}
              {scope === "music" && draft.music ? (
                <div
                  aria-hidden={barMusic}
                  ref={(el) => {
                    if (el && el.offsetHeight && el.offsetHeight !== footH) setFootH(el.offsetHeight);
                  }}
                  className={`absolute inset-x-0 bottom-0 z-20 flex select-none items-center gap-3 border-t border-white/[0.07] bg-[#101116] px-4 py-3 transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] ${
                    barMusic ? "pointer-events-none translate-x-full" : "translate-x-0"
                  }`}
                >
                  {musicPlayer}
                  {/* La flèche de droite pose ce lecteur SUR la barre du bas,
                      à la place des menus (comme le rail de la vidéo) : on
                      écoute et on règle les bornes en regardant le profil. */}
                  <button
                    type="button"
                    /* Le menu RESTE ouvert dans sa colonne : le fermer vidait
                       la colonne et perdait l'anime ouvert (16/10/2026). */
                    onClick={() => setBarMusic(true)}
                    aria-label={t("profile.studioMusicToBar")}
                    title={t("profile.studioMusicToBar")}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <ChevronRightIcon className="h-4 w-4" strokeWidth={2.2} />
                  </button>
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
      {draft.music?.videoId ? (
        /* La vidéo YouTube (version complète, lien collé, bande-annonce). Le
           lecteur officiel reste VISIBLE tant qu'il joue — même règle que sur
           le profil (voir YouTubeMusic) ; à l'arrêt il s'efface, sans être
           démonté pour ne pas recharger. */
        <div
          className={`pointer-events-auto fixed bottom-[124px] right-4 z-[10004] overflow-hidden rounded-xl bg-black/80 shadow-2xl ring-1 ring-white/15 transition-opacity ${
            /* La bande-annonce ne joue QUE son son, comme un générique
               (demande de Luc, 16/10/2026) : pas de carte vidéo pour elle.
               Elle se reconnaît à son `url` vide. */
            (playing || buffering) && draft.music.url ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <YouTubeMusic
            ref={preview}
            videoId={draft.music.videoId}
            className="block h-[200px] w-[200px]"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => setBuffering(false)}
            onDuration={(d) => {
              setLen(d);
              /* Le lecteur ne dit pas ce qu'il a chargé : tout le rail est
                 « prêt », YouTube rattrape les sauts tout seul. */
              setBuf(1);
            }}
            onTime={(x) => setAt(x)}
            onError={() => {
              setPlaying(false);
              setBuffering(false);
            }}
          />
        </div>
      ) : draft.music ? (
        <audio
          ref={(el) => {
            preview.current = el;
          }}
          src={audioFirst(draft.music.url)}
          onError={(e) => {
            const url = draft.music?.url;
            if (url && e.currentTarget.src !== url) e.currentTarget.src = url;
          }}
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

      {/* ── La scène ──────────────────────────────────────────────────────
          Le profil recule, puis glisse à droite (ProfileStage). La place
          libérée porte : en haut le titre et la validation ; à gauche le MENU
          DES FONDS — les sortes de fond, puis la palette de celle ouverte ;
          en bas, sous le cadre, une boîte par réglage du profil (agencement,
          cadre, musique, flou). La flèche rend au profil sa taille réelle et
          ne laisse qu'une pilule. Les colonnes reprennent la géométrie de
          globals.css (`--as-scene-dock-*`) : 27 vw à gauche, 2 vw à droite. */}
      {mini ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-3">
          <div className="as-scene-pill pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-[#15161d]/90 py-1.5 pl-3 pr-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.6)] ring-1 ring-white/10 backdrop-blur-xl">
            {liveBadge}
            <span className="font-outfit text-sm font-bold">{t("profile.studioTitle")}</span>
            <span className="w-2" />
            {cancelButton}
            {saveButton}
            {sizeToggle}
          </div>
        </div>
      ) : (
        <>
          <div className="as-scene-ui as-scene-ui-top pointer-events-auto absolute inset-x-0 top-0 z-30 flex h-[var(--as-scene-top)] items-center gap-2 pl-[var(--as-scene-menu-left)] pr-[var(--as-scene-frame-right)]">
            {liveBadge}
            <h2 className="font-outfit text-lg font-bold">{t("profile.studioTitle")}</h2>
            <span className="hidden min-w-0 truncate text-xs text-white/45 md:block">
              {draft.title || t("profile.studioDockNote")}
            </span>
            <span className="min-w-[1rem] flex-1" />
            {pinned ? (
              <button
                type="button"
                onClick={() => onApply(null)}
                className="hidden shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold text-white/60 transition-colors hover:bg-white/10 hover:text-white sm:block"
              >
                {t("profile.bannerReset")}
              </button>
            ) : null}
            {cancelButton}
            {saveButton}
            {sizeToggle}
          </div>

          {/* LA barre du bas, sous le cadre : TOUS les menus y sont, et celui
              qui est ouvert à gauche y est allumé. La colonne de gauche n'est
              jamais vide — on y change de menu, on ne la ferme pas. */}
          <div className="as-scene-ui as-scene-ui-bottom pointer-events-none absolute bottom-[22px] left-[var(--as-scene-frame-left)] right-[var(--as-scene-frame-right)] top-[var(--as-scene-frame-bottom)] z-30 flex items-stretch pt-3.5">
          {/* Hauteur imposée par la scène (BOTTOM_BAR) : le bas du bandeau tombe
              au même niveau que le bas de la colonne de gauche (22 px). */}
          <div className="pointer-events-auto relative h-full w-full overflow-hidden rounded-2xl bg-[#15161d] shadow-[0_18px_44px_rgba(0,0,0,0.5)] ring-1 ring-white/10">
          {/* Le rail de la vidéo entre par la gauche pendant que les menus
              sortent par la droite ; il ne reste d'eux que la flèche. */}
          <div
            aria-hidden={!showVideo}
            className={`absolute inset-0 flex items-stretch transition-[transform,opacity] duration-500 ease-[cubic-bezier(.22,1,.36,1)] ${
              showVideo ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-full opacity-0"
            }`}
          >
            {videoBar}
            <button
              type="button"
              onClick={() => setBarVideo(false)}
              tabIndex={showVideo ? 0 : -1}
              title={t("profile.studioShowMenus")}
              aria-label={t("profile.studioShowMenus")}
              className="grid w-12 shrink-0 place-items-center border-l border-white/[0.08] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <ChevronLeftIcon className="h-5 w-5" strokeWidth={2} />
            </button>
          </div>
          <div
            aria-hidden={!showMusic}
            className={`absolute inset-0 flex items-stretch transition-[transform,opacity] duration-500 ease-[cubic-bezier(.22,1,.36,1)] ${
              showMusic ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-full opacity-0"
            }`}
          >
            <div className="flex h-full min-w-0 flex-1 select-none items-center gap-3 pl-4 pr-3">
              {/* Rendu aussi pendant qu'il glisse vers la sortie. */}
              {barMusic || barMusicMounted ? musicPlayer : null}
            </div>
            <button
              type="button"
              onClick={() => setBarMusic(false)}
              tabIndex={showMusic ? 0 : -1}
              title={t("profile.studioShowMenus")}
              aria-label={t("profile.studioShowMenus")}
              className="grid w-12 shrink-0 place-items-center border-l border-white/[0.08] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <ChevronLeftIcon className="h-5 w-5" strokeWidth={2} />
            </button>
          </div>
          <div
            aria-hidden={showVideo || showMusic}
            className={`flex h-full w-full items-stretch divide-x divide-white/[0.08] transition-[transform,opacity] duration-500 ease-[cubic-bezier(.22,1,.36,1)] ${
              showVideo || showMusic ? "pointer-events-none translate-x-full opacity-0" : "translate-x-0 opacity-100"
            }`}
          >
            <SceneBox
              label={t("profile.studioBackground")}
              active={DRESSING_KINDS.some((k) => k.id === barScope)}
              fit
            >
              {DOCK_GROUPS.map((kinds) => {
                const id = kinds[0];
                const Icon = KIND_ICON[id];
                const on = kinds.includes(scope as DressingKind);
                /* Le point dit « c'est le fond porté » ; le rose, « ce menu est
                   ouvert ». Les deux ne désignent pas toujours la même case. */
                const worn =
                  !!draft.kind && kinds.includes(draft.kind) && hasOwnPlate(draft);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      /* Rappuyer sur le fond vidéo ouvert ramène son rail. */
                      if (on && videoBar) setBarVideo(true);
                      /* Le groupe s'ouvre sur l'onglet du fond porté s'il en
                         fait partie, sinon sur le premier ; ouvert, il revient
                         à la liste de son onglet. */
                      else
                        openScope(
                          on
                            ? (scope as DressingKind)
                            : draft.kind && kinds.includes(draft.kind)
                              ? draft.kind
                              : id,
                        );
                    }}
                    title={t(`profile.studioKind_${id}`)}
                    aria-label={t(`profile.studioKind_${id}`)}
                    aria-pressed={on}
                    className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors ${
                      on
                        ? "bg-action text-white shadow-[0_6px_18px_rgba(233,69,96,.35)]"
                        : "text-white/55 hover:bg-white/[0.08] hover:text-white"
                    }`}
                  >
                    <Icon className="h-5 w-5" strokeWidth={1.7} />
                    {worn ? (
                      <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    ) : null}
                  </button>
                );
              })}
            </SceneBox>
            <SceneBox label={t("profile.studioKind_layout")} active={barScope === "layout"} onOpen={() => openScope("layout")}>
              <button
                type="button"
                onClick={() => openScope("layout")}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <LayoutIcon className="h-6 w-6 shrink-0 text-white/75" strokeWidth={1.6} />
                <span className="truncate font-outfit text-[13.5px] font-bold">
                  {t(`profile.studioLayout_${draft.layout ?? "band"}`)}
                </span>
              </button>
            </SceneBox>

            <SceneBox label={t("profile.studioFrameSection")} active={barScope === "frame"} onOpen={() => openScope("frame")}>
              <button
                type="button"
                onClick={() => openScope("frame")}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <FrameIcon className="h-6 w-6 shrink-0 text-white/75" />
                <span className="truncate font-outfit text-[13.5px] font-bold">
                  {draft.frame ? t("profile.studioFrameOn") : t("profile.studioFrameNone")}
                </span>
              </button>
              {/* Retirer le cadre sans rouvrir sa grille. */}
              {draft.frame ? (
                <button
                  type="button"
                  onClick={() => patch({ frame: null })}
                  title={t("profile.studioFrameRemove")}
                  aria-label={t("profile.studioFrameRemove")}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              ) : null}
            </SceneBox>

            <SceneBox label={t("profile.studioKind_badges")} active={barScope === "badges"} onOpen={() => openScope("badges")}>
              <button
                type="button"
                onClick={() => openScope("badges")}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <TrophyIcon className="h-6 w-6 shrink-0 text-white/75" strokeWidth={1.6} />
                {/* Un libellé, pas de compteur. */}
                <span className="truncate font-outfit text-[13.5px] font-bold">
                  {t("profile.studioBadgesSection")}
                </span>
              </button>
            </SceneBox>

            <SceneBox label={t("profile.studioKind_music")} active={barScope === "music"} grow onOpen={() => openScope("music")}>
              {/* Deux commandes, pas une : la pochette lance et arrête, le
                  texte ouvre le menu (un bouton dans un bouton n'existe pas). */}
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
                  className="group relative h-10 w-10 shrink-0 overflow-hidden rounded-xl bg-black/50"
                >
                  {draft.music.cover ? (
                    <Image src={draft.music.cover} alt="" fill sizes="40px" className="object-cover" />
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
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.07] text-white/45">
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
                {draft.music && to > from ? (
                  <span className="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-white/12">
                    <span
                      className="block h-full rounded-full bg-action"
                      style={{
                        width: `${((Math.min(Math.max(at, from), to) - from) / (to - from)) * 100}%`,
                      }}
                    />
                  </span>
                ) : null}
              </button>
            </SceneBox>

            {/* Le curseur du flou reprend `as-range`, celui des réglages de
                widget. Une seule poignée : on lui rend le clic sur le rail. */}
            <SceneBox
              label={t("profile.studioBlur")}
              extra={
                <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-karla text-[11px] font-bold text-white/80">
                  {draft.blur} px
                </span>
              }
            >
              <span className="as-range relative block h-4 w-full">
                <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.14]" />
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
                  /* En ligne : `.as-range input[type=range]` coupe les clics
                     avec une spécificité qu'un utilitaire seul ne dépasse pas. */
                  style={{ pointerEvents: "auto" }}
                  aria-label={t("profile.studioBlur")}
                />
              </span>
            </SceneBox>
          </div>
          </div>
          </div>
        </>
      )}
    </div>
    </>
  );
}

/**
 * LES RÉGLAGES DU MUR D'ANIMÉS, en trois cartes qui répondent chacune à UNE
 * question : qu'est-ce que le mur montre maintenant (l'aperçu et le geste qui
 * le porte), qu'est-ce qui y entre (les listes, la note), et comment il bouge.
 * Des cartes et non des intitulés à la suite : la première version empilait
 * cinq titres de même poids, et l'œil ne savait pas où finissait le filtre et
 * où commençait l'animation (15/10/2026).
 *
 * LES LISTES SONT UN MENU DÉROULANT À CASES. Les pastilles prenaient trois
 * lignes dès qu'on avait quelques listes personnalisées, et repoussaient tout
 * le reste. Le bouton fermé résume le choix ; ouvert, il montre toutes les
 * listes avec leur couleur et leur nombre. Elles se COMBINENT (union) ; aucune
 * cochée = toute la liste.
 */
function WallPanel({
  entries,
  wall,
  worn,
  onChange,
  t,
}: {
  entries: ProfileEntry[];
  wall: DressingWall;
  /** Le mur est le fond du brouillon. */
  worn: boolean;
  onChange: (next: DressingWall) => void;
  t: (key: string, opts?: any) => string;
}) {
  const set = (p: Partial<DressingWall>) => onChange({ ...wall, ...p });
  const shown = useMemo(() => wallEntries(entries, wall), [entries, wall]);
  const candidats = useMemo(() => wallCandidates(entries, wall), [entries, wall]);
  const exclus = useMemo(() => new Set(wall.excluded ?? []), [wall.excluded]);
  const [choix, setChoix] = useState(false);
  const [cherche, setCherche] = useState("");
  const [taille, setTaille] = useState<TailleLigne>(() => readTailleLigne());
  /* La liste du sélecteur : par titre, pas dans l'ordre mélangé du mur — on y
     cherche un animé, on ne le regarde pas défiler. */
  const trouves = useMemo(() => {
    const q = cherche.trim().toLowerCase();
    return candidats
      .map((e) => ({ e, titre: entryTitle(e) }))
      .filter(({ titre }) => !q || titre.toLowerCase().includes(q))
      .sort((a, b) => a.titre.localeCompare(b.titre));
  }, [candidats, cherche]);
  const exclure = (ids: number[], off: boolean) => {
    const next = new Set(exclus);
    for (const id of ids) {
      if (off) next.add(id);
      else next.delete(id);
    }
    set({ excluded: [...next] });
  };
  const withCover = useMemo(() => entries.filter((e) => !!e.cover), [entries]);
  const lists = useMemo(() => {
    const all = [
      "favourites",
      ...Object.values(STATUS_TO_LIST),
      ...customListNames(entries).map((n) => `custom:${n}`),
    ];
    return all
      .map((id) => ({ id, n: withCover.filter((e) => inList(e, id)).length }))
      .filter((l) => l.n > 0 || wall.lists.includes(l.id));
  }, [entries, withCover, wall.lists]);
  const toggle = (id: string) =>
    set({ lists: wall.lists.includes(id) ? wall.lists.filter((l) => l !== id) : [...wall.lists, id] });

  /* Le menu se ferme au clic dehors et sur Échap — et Échap ne remonte pas :
     le studio, lui, n'a rien à fermer sur cette touche. */
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);

  const meta = (id: string) => {
    const custom = id.startsWith("custom:") ? id.slice("custom:".length) : null;
    return {
      label:
        id === "favourites"
          ? t("profile.widgets.options.sourceFavourites")
          : custom ?? listLabel(t as any, id),
      color: id === "favourites" ? null : custom ? customListColor(custom) : LIST_COLORS[id],
      custom: !!custom,
    };
  };
  const dot = (id: string) => {
    const m = meta(id);
    return id === "favourites" ? (
      <HeartIcon className="h-3 w-3 shrink-0 text-action" />
    ) : (
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: m.color ?? "#fff" }} />
    );
  };
  /* Le résumé du bouton fermé : le nom quand il n'y en a qu'une, les pastilles
     et le nombre au-delà — trois noms ne tiennent pas sur la ligne. */
  const resume =
    wall.lists.length === 0 ? (
      <span className="truncate">{t("profile.studioWallAll")}</span>
    ) : wall.lists.length === 1 ? (
      <span className="flex min-w-0 items-center gap-1.5">
        {dot(wall.lists[0])}
        <span className="truncate">{meta(wall.lists[0]).label}</span>
      </span>
    ) : (
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 -space-x-0.5">{wall.lists.slice(0, 4).map((l) => <span key={l} className="grid h-3 w-3 place-items-center">{dot(l)}</span>)}</span>
        <span className="truncate">{t("profile.studioWallListsN", { count: wall.lists.length })}</span>
      </span>
    );

  const sw = (on: boolean, flip: () => void, label: string) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={flip}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${on ? "bg-action" : "bg-white/[0.16]"}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-[14px]" : ""
        }`}
      />
    </button>
  );
  /** Une carte : un en-tête (icône, titre, et à droite de quoi le piloter). */
  const card = (icon: ReactNode, title: string, body: ReactNode, aside?: ReactNode) => (
    <section className="shrink-0 rounded-xl bg-white/[0.03] ring-1 ring-white/[0.07]">
      <header className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <span className="text-white/45">{icon}</span>
        <h3 className="min-w-0 flex-1 font-outfit text-[13px] font-bold text-white/90">{title}</h3>
        {aside}
      </header>
      <div className="flex flex-col gap-4 p-3">{body}</div>
    </section>
  );
  const label = (text: string) => (
    <p className="pb-1.5 font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/35">{text}</p>
  );
  const row = (id: string, n: number) => {
    const on = wall.lists.includes(id);
    return (
      <button
        key={id}
        type="button"
        role="menuitemcheckbox"
        aria-checked={on}
        onClick={() => toggle(id)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left font-karla text-[12.5px] font-bold text-white/80 transition-colors hover:bg-white/[0.06] hover:text-white"
      >
        <span
          className={`grid h-4 w-4 shrink-0 place-items-center rounded-[5px] ring-1 transition-colors ${
            on ? "bg-action ring-action" : "ring-white/25"
          }`}
        >
          {on ? <CheckIcon className="h-3 w-3 text-white" /> : null}
        </span>
        {dot(id)}
        <span className="min-w-0 flex-1 truncate">{meta(id).label}</span>
        <span className="tabular-nums text-white/35">{n}</span>
      </button>
    );
  };
  const statuts = lists.filter((l) => !meta(l.id).custom);
  const perso = lists.filter((l) => meta(l.id).custom);
  const DIR_ICON = { up: ArrowUpIcon, down: ArrowDownIcon, alt: ArrowsUpDownIcon } as const;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-1">
      {/* 1. LES ANIMÉS DU MUR. La carte prend toute la hauteur que les deux
          autres laissent : fermée, une mosaïque des affiches qui y passent ;
          ouverte, la liste complète, avec une recherche et une case par animé
          pour en retirer un ou le remettre. */}
      <section className="flex min-h-[10rem] flex-1 flex-col overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/[0.07]">
        {/* PLUS D'EN-TÊTE (15/10/2026) : le compte est sur le bouton du menu
            (685/685), et « Fond actuel » ne disait rien qu'on ne voie déjà sur
            le profil. Restent les deux choses qui servent : porter le mur tant
            qu'il ne l'est pas, et le message d'un mur vide ou retouché. */}
        {!worn ? (
          <button
            type="button"
            onClick={() => onChange(wall)}
            className="group mx-3 mt-3 rounded-lg bg-action px-3.5 py-2 font-karla text-[12.5px] font-bold text-white transition-[filter] hover:brightness-110"
          >
            <span className="inline-block transition-transform duration-150 group-active:scale-95">
              {t("profile.studioWallUse")}
            </span>
          </button>
        ) : null}
        {shown.length === 0 || candidats.length > shown.length ? (
          <p className="mx-3 mt-2.5 font-karla text-[11.5px] leading-snug text-white/45">
            {shown.length === 0
              ? t("profile.studioWallEmpty")
              : t("profile.studioWallRemoved", { count: candidats.length - shown.length })}
          </p>
        ) : null}

        {/* Le bouton du menu : la mosaïque (fermé) ou la liste (ouvert). */}
        <button
          type="button"
          aria-expanded={choix}
          onClick={() => {
            setChoix((o) => !o);
            setCherche("");
          }}
          /* DEUX LIGNES, et la seconde dit à quoi sert le menu : « Choisir les
             animés » seul ne laissait pas deviner qu'on pouvait en retirer un
             par un en le déroulant (15/10/2026). */
          className={`group mx-3 mt-3 flex items-center gap-2.5 rounded-lg px-3 py-2 text-left font-karla ring-1 transition-colors ${
            choix ? "bg-action/[0.12] ring-action/40" : "bg-white/[0.05] ring-white/10 hover:bg-white/[0.08]"
          }`}
        >
          <Squares2X2Icon className="h-4 w-4 shrink-0 text-white/55" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-bold text-white/90">{t("profile.studioWallPick")}</span>
            <span className="block text-[11px] leading-snug text-white/45">
              {t(choix ? "profile.studioWallPickClose" : "profile.studioWallPickHint")}
            </span>
          </span>
          <span className="tabular-nums text-white/40">
            {shown.length}/{candidats.length}
          </span>
          <ChevronDownIcon
            className={`h-4 w-4 shrink-0 text-white/50 transition-transform duration-200 ${choix ? "rotate-180" : ""}`}
          />
        </button>

        {choix ? (
          <div className="as-acc-in mt-2 flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 px-3 pb-2">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-black/25 px-2.5 ring-1 ring-white/[0.08] focus-within:ring-action/60">
                <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-white/40" />
                <input
                  autoFocus
                  value={cherche}
                  onChange={(e) => setCherche(e.target.value)}
                  placeholder={t("profile.studioSearch")}
                  className="min-w-0 flex-1 bg-transparent font-karla text-[13px] text-white outline-none placeholder:text-white/35"
                />
                {cherche ? (
                  <button
                    type="button"
                    onClick={() => setCherche("")}
                    aria-label={t("common.close", { defaultValue: "Close" })}
                    className="text-white/40 hover:text-white"
                  >
                    <XMarkIcon className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
              {/* Tout cocher / tout décocher porte sur ce que la recherche
                  montre : « naruto » puis « Aucun » retire toute la franchise. */}
              <button
                type="button"
                onClick={() => exclure(trouves.map((x) => x.e.mediaId), false)}
                className="shrink-0 rounded-md px-2 py-1 font-karla text-[11.5px] font-bold text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                {t("profile.studioWallAllOn")}
              </button>
              <button
                type="button"
                onClick={() => exclure(trouves.map((x) => x.e.mediaId), true)}
                className="shrink-0 rounded-md px-2 py-1 font-karla text-[11.5px] font-bold text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                {t("profile.studioWallAllOff")}
              </button>
              {/* Trois tailles en un bouton : petite → moyenne → grande →
                  petite. L'icône montre la taille AFFICHÉE. */}
              <button
                type="button"
                onClick={() => {
                  const v = (taille === 3 ? 1 : taille + 1) as TailleLigne;
                  setTaille(v);
                  writeTailleLigne(v);
                }}
                title={t(`profile.studioWallRowSize_${taille}`)}
                aria-label={t(`profile.studioWallRowSize_${taille}`)}
                className="group grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-white/60 ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] hover:text-white"
              >
                {/* Ce qui bouge au clic est DEDANS : un bouton qui rétrécit
                    sous le pointeur perd le clic relâché sur son bord. */}
                <span className="grid place-items-center transition-transform duration-150 group-active:scale-90">
                  {(() => {
                    const Icon = LIGNE_ICON[taille];
                    return <Icon className="h-[1.1rem] w-[1.1rem]" strokeWidth={2} />;
                  })()}
                </span>
              </button>
            </div>
            <p className="px-3 pb-1.5 font-karla text-[11px] text-white/40">
              {t("profile.studioWallPickHelp")}
            </p>
            <div className="as-scroller min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
              {trouves.length === 0 ? (
                <p className="px-3 py-6 text-center font-karla text-[13px] text-white/40">
                  {t("profile.studioNoResult")}
                </p>
              ) : (
                trouves.map(({ e, titre }) => {
                  const on = !exclus.has(e.mediaId);
                  return (
                    <button
                      key={e.mediaId}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => exclure([e.mediaId], on)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/[0.05]"
                    >
                      <span
                        className={`grid h-4 w-4 shrink-0 place-items-center rounded-[5px] ring-1 transition-colors ${
                          on ? "bg-action ring-action" : "ring-white/25"
                        }`}
                      >
                        {on ? <CheckIcon className="h-3 w-3 text-white" /> : null}
                      </span>
                      <span
                        className={`relative ${LIGNE[taille].cover} shrink-0 overflow-hidden rounded bg-white/[0.06] transition-[opacity,width,height] duration-200 ${
                          on ? "" : "opacity-35"
                        }`}
                      >
                        {e.cover ? <Image src={e.cover} alt="" fill sizes={LIGNE[taille].sizes} className="object-cover" /> : null}
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate font-karla ${LIGNE[taille].text} font-bold transition-colors ${
                          on ? "text-white/85" : "text-white/35 line-through decoration-white/20"
                        }`}
                      >
                        {titre}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          /* La mosaïque remplit la carte ; le bas s'estompe au lieu de couper
             une rangée à mi-hauteur. */
          <div
            className="mt-2.5 min-h-0 flex-1 overflow-hidden px-3 pb-3"
            style={{
              maskImage: "linear-gradient(to bottom, #000 70%, transparent)",
              WebkitMaskImage: "linear-gradient(to bottom, #000 70%, transparent)",
            }}
          >
            <div className="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1">
              {shown.slice(0, 80).map((e) => (
                <span key={e.mediaId} className="relative aspect-[2/3] overflow-hidden rounded-md bg-white/[0.06]">
                  {e.cover ? <Image src={e.cover} alt="" fill sizes="56px" className="object-cover" /> : null}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 2. Ce qui entre sur le mur. Les cartes 2 et 3 se RANGENT pendant
          qu'on choisit les animés : le menu ouvert prend toute la colonne, au
          lieu de deux lignes de liste coincées entre les réglages. */}
      {choix ? null : card(
        <FunnelIcon className="h-4 w-4" />,
        t("profile.studioWallContent"),
        <>
          <div ref={menuRef} className="relative">
            {label(t("profile.studioWallLists"))}
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((o) => !o)}
              className={`flex h-9 w-full items-center gap-2 rounded-lg bg-white/[0.05] px-3 text-left font-karla text-[12.5px] font-bold text-white/85 ring-1 transition-colors hover:bg-white/[0.08] ${
                menu ? "ring-action/60" : "ring-white/10"
              }`}
            >
              <span className="flex min-w-0 flex-1 items-center">{resume}</span>
              <ChevronDownIcon className={`h-4 w-4 shrink-0 text-white/50 transition-transform duration-200 ${menu ? "rotate-180" : ""}`} />
            </button>
            {menu ? (
              <div
                role="menu"
                className="as-acc-in absolute left-0 right-0 top-full z-30 mt-1.5 max-h-[22rem] overflow-y-auto rounded-xl bg-[#1b1c25] p-1.5 shadow-[0_18px_44px_rgba(0,0,0,.6)] ring-1 ring-white/10 as-scroller"
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={wall.lists.length === 0}
                  onClick={() => set({ lists: [] })}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left font-karla text-[12.5px] font-bold text-white/80 transition-colors hover:bg-white/[0.06] hover:text-white"
                >
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ring-1 ${
                      wall.lists.length === 0 ? "bg-action ring-action" : "ring-white/25"
                    }`}
                  >
                    {wall.lists.length === 0 ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t("profile.studioWallAll")}</span>
                  <span className="tabular-nums text-white/35">{withCover.length}</span>
                </button>
                {statuts.length ? (
                  <>
                    <p className="px-2.5 pb-1 pt-2.5 font-karla text-[10.5px] font-bold uppercase tracking-[.12em] text-white/30">
                      {t("profile.studioWallStatuses")}
                    </p>
                    {statuts.map((l) => row(l.id, l.n))}
                  </>
                ) : null}
                {perso.length ? (
                  <>
                    <p className="px-2.5 pb-1 pt-2.5 font-karla text-[10.5px] font-bold uppercase tracking-[.12em] text-white/30">
                      {t("profile.studioWallCustom")}
                    </p>
                    {perso.map((l) => row(l.id, l.n))}
                  </>
                ) : null}
                <p className="border-t border-white/[0.06] px-2.5 pb-1 pt-2 font-karla text-[11px] text-white/35">
                  {t("profile.studioWallListsHint")}
                </p>
              </div>
            ) : null}
          </div>
          <div>
            {label(t("profile.studioWallScores"))}
            <ScoreRange
              min={0}
              max={10}
              step={0.5}
              from={wall.scores[0]}
              to={wall.scores[1]}
              onChange={(lo, hi) => set({ scores: [lo, hi] })}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="font-karla text-[12.5px] text-white/70">{t("profile.studioWallUnrated")}</span>
              {sw(wall.unrated, () => set({ unrated: !wall.unrated }), t("profile.studioWallUnrated"))}
            </div>
          </div>
        </>,
      )}

      {/* 3. Comment il bouge — l'interrupteur dans l'en-tête de la carte. */}
      {choix ? null : card(
        <ArrowsUpDownIcon className="h-4 w-4" />,
        t("profile.studioWallMotion"),
        /* Atténués à l'arrêt mais TOUJOURS RÉGLABLES (15/10/2026) : on prépare
           le sens et la vitesse avant de rallumer le défilement. Bloqués, ils
           passaient pour cassés. */
        <div className={`flex flex-col gap-4 transition-opacity ${wall.anim ? "" : "opacity-55 hover:opacity-90"}`}>
          <div>
            {label(t("profile.studioWallDirection"))}
            <div role="radiogroup" className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.04] p-1 ring-1 ring-white/[0.06]">
              {WALL_DIRS.map((d) => {
                const Icon = DIR_ICON[d];
                const on = wall.dir === d;
                return (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ dir: d })}
                    /* L'icône AU-DESSUS du libellé : trois libellés côte à côte
                       ne tiennent pas dans la colonne (« Sens contr… »). */
                    className={`group min-w-0 rounded-lg px-1 py-2 font-karla text-[11.5px] font-bold leading-tight transition-colors ${
                      on ? "bg-white/[0.1] text-white" : "text-white/45 hover:text-white/80"
                    }`}
                  >
                    <span className="flex flex-col items-center gap-1 transition-transform duration-150 group-active:scale-95">
                      <Icon
                        className={`h-4 w-4 shrink-0 ${on && wall.anim ? `as-wall-nudge-${d}` : ""}`}
                        strokeWidth={2.2}
                      />
                      <span className="text-center">{t(`profile.studioWallDir_${d}`)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            {label(t("profile.studioWallSpeed"))}
            <div className="flex items-center gap-2.5">
              <StudioRange
                value={wall.speed}
                min={WALL_SPEED_MIN}
                max={WALL_SPEED_MAX}
                step={1}
                onChange={(v) => set({ speed: clampWallSpeed(v) })}
                label={t("profile.studioWallSpeed")}
              />
              <span className="w-14 shrink-0 rounded-md bg-white/[0.07] py-0.5 text-center font-karla text-[11px] font-bold tabular-nums text-white/80">
                {wall.speed} px/s
              </span>
            </div>
          </div>
        </div>,
        sw(wall.anim, () => set({ anim: !wall.anim }), t("profile.studioWallAnim")),
      )}
    </div>
  );
}

/**
 * La grille des motifs. Avec `fill`, elle occupe la hauteur que la colonne lui
 * laisse et choisit le NOMBRE DE COLONNES qui donne les plus grandes vignettes
 * 3:2 tenant dans cette surface. Sans `fill` (dock réduit, hauteur libre), la
 * grille classique à vignettes de ~70 px.
 */
function PatternGrid({ count, fill, children }: { count: number; fill: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!fill || !el) return setCols(null);
    const GAP = 6;
    const PAD = 5; /* la marge intérieure de la boîte, des deux côtés */
    const fit = () => {
      const W = el.clientWidth - 2 * PAD, H = el.clientHeight - 2 * PAD;
      if (!W || !H) return;
      /* Le moins de colonnes possible (vignettes les plus larges) dont la
         hauteur totale tient encore dans H. */
      for (let n = 2; n <= count; n++) {
        const rows = Math.ceil(count / n);
        const tileH = ((W - GAP * (n - 1)) / n) * (2 / 3);
        if (rows * tileH + GAP * (rows - 1) <= H) return setCols(n);
      }
      setCols(count);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [fill, count]);
  return (
    /* `p-[5px]` : la boîte rogne ce qui dépasse, et l'anneau de la vignette
       choisie (2 px + 2 px de décalage) comme le grossissement au survol
       dépassent de la grille. Sans cette marge ils étaient coupés au bord. */
    <div ref={box} className={fill ? "min-h-[3rem] overflow-hidden p-[5px]" : undefined}>
      {/* Une fois les colonnes choisies, les rangées s'étirent sur toute la
          hauteur : le reste de la colonne ne reste pas vide sous la grille. */}
      <div
        className={`grid gap-1.5 ${
          cols ? "h-full [&>*]:aspect-auto" : "grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))]"
        }`}
        style={
          cols
            ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(0, 1fr)" }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}

/** Le curseur `as-range` du studio (rail, remplissage, poignée native). */
function StudioRange({
  value,
  min,
  max,
  step,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <span className="as-range relative block h-4 w-full min-w-0">
      <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.14]" />
      <span
        className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-action"
        style={{ width: `${((value - min) / (max - min)) * 100}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        /* En ligne : `.as-range input[type=range]` coupe les clics avec une
           spécificité qu'un utilitaire seul ne dépasse pas. */
        style={{ pointerEvents: "auto" }}
        aria-label={label}
      />
    </span>
  );
}

/** `fn` au prochain temps mort (au plus tard après `timeout` ms) ; rend
 *  l'annulation. Safari n'a pas `requestIdleCallback` : repli sur un délai. */
function whenIdle(fn: () => void, timeout: number): () => void {
  if ("requestIdleCallback" in window) {
    const id = window.requestIdleCallback(fn, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(fn, Math.min(timeout, 200));
  return () => clearTimeout(id);
}

/** Le dernier liseré allumé de la barre, d'où part le suivant. Une seule
 *  barre de studio existe à la fois. */
let lastSceneLine: HTMLSpanElement | null = null;

/**
 * Un compartiment de la barre du bas de la scène : un intitulé, puis la
 * commande. Tous à la même hauteur dans une seule barre — c'est ce qui rend la
 * rangée lisible d'un coup d'œil, là où l'ancien dock alignait douze icônes de
 * même poids.
 */
function SceneBox({
  label,
  active,
  grow,
  fit,
  extra,
  onOpen,
  children,
}: {
  label: string;
  /** Son menu est celui ouvert à gauche : le compartiment s'allume. */
  active?: boolean;
  /** Ouvre son menu : TOUT le compartiment est cliquable, pas seulement le
      texte. Les commandes à lui (croix, lecture, curseur) gardent leur clic. */
  onOpen?: () => void;
  grow?: boolean;
  /** À la largeur de son contenu (la rangée des huit fonds). */
  fit?: boolean;
  extra?: ReactNode;
  children: ReactNode;
}) {
  /* Le liseré du haut dit « ce menu est ouvert » d'un coup d'œil. Chaque
     compartiment porte le sien (toujours monté, donc toujours à sa largeur
     exacte) ; à l'allumage il part de la place du précédent (FLIP) : les deux
     rectangles sont lus dans le même repère, et l'animation ne touche que
     `transform`, que le compositeur joue même pendant le rendu du menu. */
  const line = useRef<HTMLSpanElement>(null);
  useBeforePaint(() => {
    const el = line.current;
    if (!active || !el) return;
    const prev = lastSceneLine;
    lastSceneLine = el;
    if (prev && prev !== el && prev.isConnected) {
      const a = prev.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      if (b.width > 0) {
        el.animate(
          [{ transform: `translateX(${a.left - b.left}px) scaleX(${a.width / b.width})` }, { transform: "none" }],
          { duration: 320, easing: "cubic-bezier(.3,.7,.2,1)" },
        );
        return;
      }
    }
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
  }, [active]);
  return (
    <div
      onClick={
        onOpen
          ? (e) => {
              if (!(e.target as HTMLElement).closest("button, input, a")) onOpen();
            }
          : undefined
      }
      /* Les intitulés sont TOUS en haut, à la même hauteur (16/10/2026) :
         centrée, chaque case posait le sien selon la taille de son contenu, et
         FOND, MUSIQUE et FLOU ne tombaient pas sur la même ligne. L'en-tête a
         une hauteur fixe (la pastille « 0 px » du flou le grandissait) et le
         contenu se centre dans ce qui reste. */
      className={`relative flex min-w-0 flex-col justify-start gap-1.5 px-4 py-2 transition-colors ${
        fit ? "flex-none" : grow ? "flex-[1.6]" : "flex-1"
      } ${onOpen ? "cursor-pointer" : ""} ${active ? "bg-action/[0.13]" : "hover:bg-white/[0.04]"}`}
    >
      <span
        ref={line}
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-[2px] origin-left bg-action ${active ? "" : "opacity-0"}`}
      />
      <span className="flex h-4 items-center justify-between gap-2">
        <span
          className={`font-karla text-[10.5px] font-bold uppercase tracking-[.12em] ${
            active ? "text-action" : "text-white/40"
          }`}
        >
          {label}
        </span>
        {extra}
      </span>
      <div className={`flex min-w-0 flex-1 items-center ${fit ? "gap-1" : "gap-2.5"}`}>{children}</div>
    </div>
  );
}

/**
 * LE RAIL À DEUX POIGNÉES — celui de la musique, et celui de la bande-annonce.
 *
 * Un seul exemplaire pour les deux : le geste est le même (cliquer-glisser dans
 * le rail déplace la lecture, saisir une poignée déplace une borne), et deux
 * copies auraient divergé au premier réglage — la première version de l'extrait
 * vidéo, écrite à part, avait déjà perdu la capture du pointeur en route.
 *
 * Il ne joue rien lui-même et ne connaît ni `<audio>` ni lecteur YouTube : il
 * reçoit des secondes, il rend des secondes. C'est ce qui lui permet de servir
 * un fichier local comme une iframe qu'on ne pilote que par messages.
 */
function TrimRail({
  len,
  from,
  to,
  at,
  buf = 0,
  onSeek,
  onTrim,
  onGrab,
  t,
}: {
  /** La durée totale. Rien ne se dessine tant qu'elle est inconnue. */
  len: number;
  from: number;
  to: number;
  /** Où en est la lecture. */
  at: number;
  /** La part déjà chargée, 0 à 1 — un lecteur YouTube ne la dit pas : 0. */
  buf?: number;
  /** Une fraction du rail, 0 à 1. */
  onSeek: (ratio: number) => void;
  onTrim: (edge: "from" | "to", seconds: number) => void;
  /** Une poignée est saisie (vrai) ou lâchée (faux). */
  onGrab?: (edge: "from" | "to", held: boolean) => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  /** Vrai tant qu'on tient le rail : le glissement déplace alors l'écoute. */
  const seeking = useRef(false);
  /** La poignée d'extrait en cours de déplacement, s'il y en a une. */
  const [grab, setGrab] = useState<"from" | "to" | null>(null);
  const pct = (s: number) => (len ? Math.min(100, Math.max(0, (s / len) * 100)) : 0);
  const railAt = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  return (
    /* Le rail s'écoute EN GLISSANT, pas seulement au clic : chercher un refrain,
       c'est balayer le morceau, et un rail qui ne répond qu'au relâchement
       oblige à cliquer dix fois pour trouver le bon endroit. Le pointeur est
       capturé, donc le geste survit à une sortie du rail — sans quoi il
       s'interrompait au premier écart vertical. `data-grab` laisse les poignées
       à leur propre geste.

       Le « on tient » vit dans une RÉFÉRENCE et non dans un état : les
       remplissages du rail se redessinent à chaque image pendant le glissement,
       et le gestionnaire de `pointermove` lisait un état d'avant le rendu — le
       geste mourait dès qu'il partait de la zone jouée, celle qui bouge le
       plus. */
    <div
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).dataset.grab) return;
        /* Sans ça, le navigateur voit un glissé de SÉLECTION (le pied du
           panneau est du texte) et affiche son curseur d'interdiction
           par-dessus le geste. */
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        seeking.current = true;
        onSeek(railAt(e));
      }}
      onPointerMove={(e) => {
        if (seeking.current && e.buttons & 1) onSeek(railAt(e));
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
      {/* Ce qui NE SERA PAS joué part en hachures : une zone simplement plus
          sombre se confond avec un rail vide, alors qu'une rayure dit « écarté »
          sans légende. Elles se posent sur le gris clair de la mémoire tampon,
          TOUJOURS, et non sur ce qui est réellement chargé : le bord du tampon y
          dessinait une marche, c'est-à-dire un chargement à moitié fait dans une
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
            onGrab?.(edge, true);
          }}
          onPointerMove={(e) => {
            if (grab !== edge || !len) return;
            const r = e.currentTarget.parentElement!.getBoundingClientRect();
            onTrim(edge, ((e.clientX - r.left) / r.width) * len);
          }}
          onPointerUp={() => {
            setGrab(null);
            onGrab?.(edge, false);
          }}
          onPointerCancel={() => {
            setGrab(null);
            onGrab?.(edge, false);
          }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 5 : 1;
            if (e.key === "ArrowLeft") onTrim(edge, value - step);
            else if (e.key === "ArrowRight") onTrim(edge, value + step);
            else return;
            e.preventDefault();
          }}
          className="absolute top-1/2 h-4 w-[7px] -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none rounded-full bg-[#facc15] shadow-[0_1px_4px_rgba(0,0,0,.6)] outline-none ring-offset-2 ring-offset-[#15161d] focus-visible:ring-2 focus-visible:ring-[#facc15]"
          style={{ left: `${pct(value)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * L'en-tête de la liste des génériques : l'affiche, le titre, le compte, et le
 * passage d'une saison à l'autre.
 *
 * Le menu déroulant est un `<select>` natif et non une liste construite à la
 * main. Une franchise dépasse rarement six saisons, la palette a déjà sa
 * navigation au clavier, et une liste maison aurait demandé son propre piège à
 * clics extérieurs, son propre focus et sa propre gestion des flèches — pour
 * arriver au comportement que le navigateur donne gratuitement.
 */
function AnimeHead({
  anime,
  count,
  countKey = "profile.studioMusicCount",
  seasons,
  current,
  onPick,
  onClose,
  anchor,
  t,
}: {
  anime: StudioAnime | null;
  count: number;
  /** Ce que le compte nomme : des génériques, ou des vidéos. */
  countKey?: string;
  seasons: Array<{ id: number; label: string }>;
  current: number | null;
  onPick: (id: number) => void;
  /** En accordéon : l'en-tête est la ligne ouverte, et un clic la replie. */
  onClose?: () => void;
  /** Le repère que le studio retrouve pour garder la ligne sous le pointeur. */
  anchor?: string;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  if (!anime) return null;
  const ident = (
    <>
      {anime.cover ? (
        <span className="relative h-16 w-11 shrink-0 overflow-hidden rounded-md bg-black/50">
          <Image src={anime.cover} alt="" fill sizes="44px" className="object-cover" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-outfit text-[15px] font-bold text-white">{anime.title}</span>
        <span className="mt-0.5 block font-karla text-[12px] text-white/40">
          {t(countKey, { count })}
        </span>
      </span>
    </>
  );
  return (
    <div data-anchor={anchor} className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2.5">
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-expanded
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          {ident}
        </button>
      ) : (
        ident
      )}
      {/* Une saison unique n'a pas de menu : un sélecteur à une entrée annonce
          un choix qui n'existe pas. */}
      {seasons.length > 1 ? (
        <select
          value={current ?? ""}
          onChange={(e) => onPick(Number(e.target.value))}
          aria-label={t("profile.studioSeason")}
          className="max-w-[10rem] shrink-0 cursor-pointer truncate rounded-full bg-white/[0.08] px-3 py-1.5 font-karla text-[12px] font-bold text-white/80 outline-none ring-1 ring-white/10 hover:bg-white/[0.12]"
        >
          {seasons.map((s) => (
            <option key={s.id} value={s.id} className="bg-[#15161d] text-white">
              {s.label}
            </option>
          ))}
        </select>
      ) : null}
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("profile.studioArtCollapse")}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ChevronRightIcon className="h-4 w-4 rotate-90" strokeWidth={2.2} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Le repère de fin de grille : invisible, il appelle `onVisible` quand il
 * arrive à moins de 600 px du bas de la colonne qui défile — assez tôt pour
 * que la page suivante soit là avant qu'on l'atteigne. Il se réarme à chaque
 * rendu (la page arrivée le repousse plus bas), donc rien ne part en boucle :
 * un repère resté visible attend que `onVisible` change.
 */
function Suite({
  onVisible,
  root,
}: {
  onVisible: () => void;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onVisible();
      },
      { root: root.current, rootMargin: "0px 0px 600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible, root]);
  return <div ref={ref} aria-hidden className="h-px w-full" />;
}
