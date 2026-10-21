import Link from "next/link";
import { audioFirst } from "@/lib/animethemes/audioUrl";
import FramedAvatar from "@/components/profile/FramedAvatar";
import FeaturedBadges from "@/components/profile/FeaturedBadges";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useNavBackdrop } from "@/lib/color/navContrast";
import { watchTime } from "@/lib/profile/sources";
import { plateMode } from "@/lib/profile/types";
import PlateBackground, { type TrailerRemote } from "@/components/profile/PlateBackground";
import type { MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { useScene } from "@/components/profile/ProfileStage";
import YouTubeMusic, { type MusicMedia } from "@/components/profile/YouTubeMusic";
import MusicCard from "@/components/profile/MusicCard";

/* Pause, muet, volume et lecture auto : partagés avec le studio
   (lib/profile/playback). */
import {
  readAutoplay,
  readProfileVolume,
  rememberAutoplay,
  useBgMuted,
  useBgPaused,
  writeProfileVolume,
} from "@/lib/profile/playback";
export { PROFILE_AUTOPLAY_COOKIE } from "@/lib/profile/playback";
/* Plus haut que les aperçus (0,15) : ici on a cliqué pour écouter. */
const PROFILE_DEFAULT_VOLUME = 0.5;
import { fadeGain, isVideoKind, type Dressing } from "@/lib/profile/dressing";
import type { BannerOption, ProfileEntry, ProfileStats } from "@/lib/profile/types";
import { defaultWall, wallCovers } from "@/lib/profile/wall";

/**
 * The top of a profile: the plate, the identity, the numbers.
 *
 * The plate is decided upstream (lib/profile/banner.ts + the favourite-anime
 * rule) and arrives resolved; this component only knows the three shapes it can
 * take — an artwork, a blurred cover, or the site's own accent colour when
 * there is no list to draw from. Every profile route renders THIS, so a guest,
 * an AniScroll account and an AniList account look like the same page.
 */

export type HeroBanner = {
  url: string | null;
  animeId: number | null;
  title: string | null;
  /** What kind of art this is — decides page-background vs strip. */
  source?: BannerOption["source"] | null;
  /** The plate is a portrait cover — blur and over-scale it. */
  fallback?: boolean;
  /* Les quatre champs du studio (lib/profile/dressing.ts). Optionnels : un
     profil épinglé avant le studio n'en a aucun, et se lit comme une bannière
     sans musique ni flou — exactement ce qu'il était. */
  kind?: Dressing["kind"] | null;
  color?: string | null;
  pattern?: Dressing["pattern"];
  patternZoom?: Dressing["patternZoom"];
  patternAnim?: Dressing["patternAnim"];
  patternSpeed?: Dressing["patternSpeed"];
  music?: Dressing["music"];
  blur?: number | null;
  /** Bande-annonce YouTube portée en fond (kind « video »). */
  trailerId?: Dressing["trailerId"];
  /** Un épisode porté en fond (kind « video »), résolu à l'affichage. */
  episode?: Dressing["episode"];
  /** Le découpage du fond vidéo, et le fondu au noir de sa boucle. */
  videoFrom?: Dressing["videoFrom"];
  videoTo?: Dressing["videoTo"];
  videoFade?: Dressing["videoFade"];
  /** Le son du fond vidéo (0 = muet) ; une musique le fait taire. */
  videoVolume?: Dressing["videoVolume"];
  /** L'image de la case du fond vidéo, figée par le studio. */
  videoCover?: Dressing["videoCover"];
  /** Agencement du haut de profil. Absent : « band », l'agencement d'origine. */
  layout?: Dressing["layout"] | null;
  /** Cadre d'avatar (décoration Discord), ou rien. */
  frame?: Dressing["frame"] | null;
  /** Tailles de l'avatar et du pseudo, en % (100 = celles de l'agencement). */
  avatarScale?: number;
  nameScale?: number;
  /** Les badges mis en avant à côté du pseudo (trois au plus). */
  badges?: string[];
  /** Leur taille, en % (100 = 56 px). */
  badgeScale?: number;
  /** Le filtre du mur d'animés (kind « wall »). */
  wall?: Dressing["wall"];
};

/**
 * Le pont entre le dock du studio et le fond de la VRAIE page.
 *
 * Le studio n'a plus d'aperçu à lui : c'est le profil lui-même qui montre le
 * brouillon. Le rail de découpe vidéo du dock doit donc piloter le lecteur du
 * plateau de ProfileHero — d'où ces deux références, créées par la page et
 * tenues des deux côtés.
 */
export type StudioBridge = {
  remote: MutableRefObject<TrailerRemote | null>;
  progress: MutableRefObject<((at: number, duration: number, playing: boolean) => void) | null>;
};

/**
 * Ce que la page montre pendant l'édition : le brouillon dès qu'il porte un
 * fond, sinon le fond actuel habillé des réglages du brouillon (agencement,
 * cadre, flou). Sans la musique : le dock a son propre lecteur, et deux
 * boutons de son pour un même morceau se marcheraient dessus.
 */
export function previewBanner(draft: Dressing, base: HeroBanner): HeroBanner {
  const own = draft.url || draft.color || draft.trailerId || draft.episode || draft.kind === "wall";
  return {
    ...(own
      ? draft
      : {
          ...base,
          layout: draft.layout,
          frame: draft.frame,
          blur: draft.blur,
          avatarScale: draft.avatarScale,
          nameScale: draft.nameScale,
          badges: draft.badges,
          badgeScale: draft.badgeScale,
        }),
    music: null,
    /* Le studio joue la musique lui-même (d'où `music: null`) : la règle
       « la musique gagne » se pose donc ici, sur le brouillon. */
    videoVolume: draft.music ? 0 : draft.videoVolume,
  };
}

/**
 * The four numbers under the name, formatted. Lives here rather than in the
 * page so the public profile and /en/profile/me cannot label them differently.
 * A source that doesn't know a figure gets an em dash, never an invented one.
 */
export function heroStats(
  t: (key: string, opts?: any) => string,
  stats: ProfileStats,
): HeroStat[] {
  const time = stats.minutes != null ? watchTime(stats.minutes) : null;
  return [
    { key: "anime", label: t("profile.statAnime"), value: String(stats.count) },
    {
      key: "episodes",
      label: t("profile.statEpisodes"),
      value: String(stats.episodes),
    },
    {
      key: "time",
      label: t("profile.statWatched"),
      value: time?.days
        ? `${time.days}${t("profile.unitDays")}`
        : time?.hours
          ? `${time.hours}${t("profile.unitHours")}`
          : "—",
    },
    {
      key: "mean",
      label: t("profile.statMeanScore"),
      value: stats.meanScore != null ? String(stats.meanScore) : "—",
      accent: true,
    },
  ];
}

export type HeroStat = {
  key: string;
  label: string;
  value: string;
  /** Small line under the value (best streak, score format…). */
  hint?: string;
  /** Painted in the accent instead of white — one highlight, not five. */
  accent?: boolean;
};

type Props = {
  name: string;
  tag?: string | null;
  avatar?: string | null;
  /** Shown as a badge when the account is linked to AniList. */
  anilistName?: string | null;
  /** Epoch ms; renders "member since". */
  createdAt?: number | null;
  banner: HeroBanner;
  stats: HeroStat[];
  isOwner?: boolean;
  onEditBanner?: () => void;
  /** Free-form line under the name (e.g. "local profile, this device only"). */
  subtitle?: string | null;
  /** Pendant l'édition : le dock du studio pilote le fond vidéo d'ici. */
  studio?: StudioBridge | null;
  /** La liste du profil : un mur d'animés y prend ses affiches. */
  entries?: ProfileEntry[];
  /** Les badges obtenus (id → date) : filtre ceux mis en avant. */
  earned?: Record<string, number> | null;
  /** Lu du cookie au rendu serveur : la musique ne part pas seule. */
  musicPaused?: boolean;
};

export default function ProfileHero({
  name,
  tag,
  avatar,
  anilistName,
  createdAt,
  banner,
  stats,
  isOwner,
  onEditBanner,
  subtitle,
  studio,
  entries,
  earned,
  musicPaused,
}: Props) {
  const { t, i18n } = useTranslation();
  const clickTarget = useClickTarget();
  /* The navbar floats transparent over this plate, and a profile's artwork is
     picked by its owner — nothing stops it being a white one. Same measurement
     the info page's hero declares (lib/color/navContrast.ts). */
  /* Une IMAGE seulement : un fichier vidéo n'a pas de pixels à mesurer, et
     la route répondait 500 à chaque générique porté. */
  useNavBackdrop(isVideoKind(banner.kind) ? null : banner.url);

  /* An illustration is worn as the page's WALLPAPER — fixed to the window, the
     profile scrolling over it. A banner-shaped strip stays a strip: it was
     composed as one, and there is nothing above or below its crop to reveal.
     Stretching one across the window is the "zoom" this measurement exists to
     prevent — a 1000x185 fanart banner loses 62% of itself that way.

     The declared source is only the FIRST guess, used so the first paint is not
     a guess-free blank: it is a label, and labels go stale. A banner pinned
     before the kind was stored alongside the URL comes back as "background" and
     would be worn as a wallpaper. The picture's own proportions cannot go
     stale, so once it has loaded they decide. Nothing is downloaded twice —
     next/image has already fetched this exact URL, so the probe reads the cache. */
  const video = isVideoKind(banner.kind);
  /* Une bande-annonce est un fond d'écran comme une vidéo : elle n'a ni fichier
     ni proportions à mesurer, elle remplit la fenêtre. */
  const trailer = banner.kind === "video" && (!!banner.trailerId || !!banner.episode);
  const flat = banner.kind === "color" && !!banner.color;
  /* LE FOND VIDÉO SE MET EN PAUSE (21/10/2026, Luc) : il tournait sans fin
     sous les yeux de qui lit la page. Le choix est celui du VISITEUR, gardé
     dans son navigateur pour tous les profils. */
  /* Partagé avec le studio : une pause posée ici y vaut aussi. */
  const [bgPaused, setBgPaused] = useBgPaused();
  const toggleBg = () => setBgPaused((p) => !p);
  /* Le mur d'animés : un fond d'écran sans fichier, fait des affiches de la
     liste que la page tient déjà (lib/profile/wall.ts). */
  const wall = banner.kind === "wall";
  const covers = useMemo(
    () => (wall && entries ? wallCovers(entries, banner.wall ?? defaultWall()) : []),
    [wall, entries, banner.wall],
  );
  /* Une pochette portrait est floutée et sur-dimensionnée, qu'elle arrive comme
     dernier recours de la résolution automatique (`fallback`) ou comme un choix
     délibéré du studio (le type « Image ») : c'est la même image mal découpée
     dans les deux cas, et le remède est le même. */
  const cover = !!banner.fallback || banner.source === "cover";

  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    setRatio(null);
    /* Une vidéo et une couleur n'ont pas de proportions à mesurer : elles
       remplissent la fenêtre, un point c'est tout. */
    if (!banner.url || video || flat) return;
    const probe = new window.Image();
    probe.onload = () => {
      if (probe.naturalHeight) setRatio(probe.naturalWidth / probe.naturalHeight);
    };
    probe.src = banner.url;
  }, [banner.url, video, flat]);

  const mode = flat || wall
    ? "page"
    : trailer
      ? "page"
      : !banner.url
        ? "none"
        : video
          ? "page" /* une vidéo est un fond d'écran, jamais un bandeau */
          : cover
            ? "page" /* a portrait cover: blurred wallpaper, never a strip */
            : ratio == null
              ? plateMode(banner.source)
              : ratio > 3
                ? "band"
                : "page";
  const asPage = mode === "page";

  /* ── Le flou derrière les widgets ──────────────────────────────────────
     Les blocs de la grille ne sont pas dans cet arbre — ils sont plus bas dans
     la page — donc la valeur voyage par une variable posée sur la racine plutôt
     que par une prop traversant quatre composants. Retirée au démontage : la
     variable survivrait à la navigation vers un autre profil.

     La CLASSE voyage avec elle, et c'est elle qui fait exister le flou : sans
     `.as-plate-frosted`, les cartes n'ont plus aucun calque de flou, pas même
     un flou nul que le compositeur relirait à chaque image (cf. globals.css). */
  const blur = Math.max(0, Math.min(32, banner.blur || 0));
  useEffect(() => {
    const html = document.documentElement;
    const root = html.style;
    if (!blur) {
      root.removeProperty("--as-plate-blur");
      root.removeProperty("--as-plate-a1");
      root.removeProperty("--as-plate-a2");
      html.classList.remove("as-plate-frosted");
      return;
    }
    root.setProperty("--as-plate-blur", `${blur}px`);
    root.setProperty("--as-plate-a1", "0.34");
    root.setProperty("--as-plate-a2", "0.2");
    html.classList.add("as-plate-frosted");
    return () => {
      root.removeProperty("--as-plate-blur");
      root.removeProperty("--as-plate-a1");
      root.removeProperty("--as-plate-a2");
      html.classList.remove("as-plate-frosted");
    };
  }, [blur]);

  /* ── Le son ────────────────────────────────────────────────────────────
     Deux sources possibles et une seule règle : la musique choisie l'emporte
     sur la bande-son de la vidéo de fond, toujours. Aucune ne démarre seule —
     un navigateur refuse le son sans geste, et c'est tant mieux : un profil qui
     se met à jouer de la musique à l'ouverture serait une agression. Le bouton
     est donc la seule façon de l'entendre, et il dit ce qu'il joue. */
  const audio = useRef<HTMLAudioElement | null>(null);
  const [sound, setSound] = useState(false);
  /* Le niveau du son du profil — musique, version YouTube, fond vidéo —,
     réglé au rail de la case YouTube (HoverVolume, le même que les aperçus au
     survol) et retenu sur l'appareil, à part de celui des aperçus. */
  const [vol, setVol] = useState(PROFILE_DEFAULT_VOLUME);
  useEffect(() => {
    const v = readProfileVolume();
    if (v != null) setVol(v);
  }, []);
  const changeVol = (v: number) => {
    setVol(v);
    writeProfileVolume(v);
  };
  useEffect(() => setSound(false), [banner.url, banner.music?.url]);

  /* ── Le son du FOND VIDÉO (21/10/2026) ─────────────────────────────────
     Réglé au studio (`videoVolume`), muet par défaut, et TOUJOURS muet sous
     une musique. Le navigateur refuse le son sans geste : la vidéo part
     muette, et prend son son au premier geste sur la page — pas besoin de
     viser un bouton. Dans le studio, on est déjà en train de cliquer. */
  const videoVol = banner.music ? 0 : Math.min(1, Math.max(0, banner.videoVolume ?? 0));
  const [vidAwake, setVidAwake] = useState(false);
  /** L'instant du geste qui a donné le son : le clic qui le porte, s'il
      tombe sur le haut-parleur, ne doit pas le recouper aussitôt. */
  const vidWokeAt = useRef(0);
  useEffect(() => {
    if (studio || videoVol === 0 || vidAwake) return;
    const wake = () => {
      vidWokeAt.current = performance.now();
      setVidAwake(true);
    };
    const opts = { once: true, capture: true } as const;
    window.addEventListener("pointerdown", wake, opts);
    window.addEventListener("keydown", wake, opts);
    return () => {
      window.removeEventListener("pointerdown", wake, opts);
      window.removeEventListener("keydown", wake, opts);
    };
  }, [studio, videoVol, vidAwake]);
  /** Le visiteur a coupé le son de la vidéo (sa case) — partagé avec le studio. */
  const [vidMuted, setVidMuted] = useBgMuted();
  /** Le niveau choisi par le VISITEUR à la case ; sinon celui du propriétaire. */
  const [visitorVol, setVisitorVol] = useState<number | null>(null);
  const videoAudible = videoVol > 0 && !vidMuted && (!!studio || vidAwake);
  /** Le fichier d'AnimeThemes a déjà joué : sa case montre l'égaliseur. */
  const [audioStarted, setAudioStarted] = useState(false);
  useEffect(() => setAudioStarted(false), [banner.music?.url]);
  /* LECTURE AUTO PAR DÉFAUT (17/10/2026) — sauf si le visiteur a mis en pause
     une fois : ce choix est retenu sur l'appareil, et vaut jusqu'à ce qu'il
     relance. Un navigateur refuse souvent le son sans geste : la case joue
     alors muette (`browserMuted`), et son icône de volume le rétablit. */
  const [browserMuted, setBrowserMuted] = useState(false);
  /** L'instant du geste qui a rendu le son : le clic qui le porte ne doit
      pas, en plus, mettre en pause la case sur laquelle il tombe. */
  const wokeAt = useRef(0);
  /* Le son revient au PREMIER geste sur la page, où qu'il soit : c'est ce que
     le navigateur attendait (« Unmuting failed … the user didn't interact »).
     Sans ça il fallait viser l'icône de la case. */
  useEffect(() => {
    if (!browserMuted) return;
    const wake = () => {
      wokeAt.current = performance.now();
      setBrowserMuted(false);
      void yt.current?.play();
    };
    const opts = { once: true, capture: true } as const;
    window.addEventListener("pointerdown", wake, opts);
    window.addEventListener("keydown", wake, opts);
    return () => {
      window.removeEventListener("pointerdown", wake, opts);
      window.removeEventListener("keydown", wake, opts);
    };
  }, [browserMuted]);
  /* La pause lue dans le cookie au chargement. Le studio la réécrit en
     enregistrant (il relance la lecture) : au retour, le navigateur fait foi. */
  const [cookiePaused, setCookiePaused] = useState(!!musicPaused);
  const studioSeen = useRef(false);
  if (studio) studioSeen.current = true;
  useEffect(() => {
    if (studio) return;
    const was = cookiePaused && !studioSeen.current;
    if (!was && cookiePaused) setCookiePaused(!readAutoplay());
    if (!banner.music?.videoId) return;
    const auto = !was && readAutoplay();
    /* Une pause d'avant le cookie : on le pose, la visite suivante est juste. */
    if (!auto && !was) rememberAutoplay(false);
    if (auto) setSound(true);
  }, [banner.music?.videoId, studio]);

  /* Deux façons de jouer la musique, et la meilleure gagne quand elle existe.
     L'audio d'AnimeThemes est le rip du générique — 90 s, d'où le `loop`
     ci-dessous. Quand le morceau a été résolu sur YouTube on joue la version
     COMPLÈTE, par le lecteur officiel, via la même scène que les
     bandes-annonces au survol (scène « music », indépendante : voir
     stageStore, sinon survoler une affiche coupait le son). */
  const viaYouTube = !!banner.music?.videoId;
  const yt = useRef<MusicMedia | null>(null);

  /* Le lecteur YouTube est monté par le clic (il ne se charge qu'à ce
     moment-là) : `play` part dès qu'il est là, et la file du composant garde
     l'ordre s'il démarre encore. */
  useEffect(() => {
    const el = yt.current;
    if (!el || !viaYouTube) return;
    if (sound) void el.play();
    else el.pause();
  }, [sound, viaYouTube, banner.music?.videoId]);

  useEffect(() => {
    const el = audio.current;
    if (!el || viaYouTube) return;
    if (sound) void el.play().catch(() => setSound(false));
    else el.pause();
  }, [sound, viaYouTube, banner.music?.url]);

  /* Le fondu de l'extrait, quand le studio en a posé un. `timeupdate` ne parle
     que quatre fois par seconde : une rampe faite dessus s'entendrait par
     marches. Une boucle d'animation la rend continue, et elle ne tourne que
     pendant la lecture d'un extrait fondu. */
  const fade = banner.music?.fade ?? 0;
  useEffect(() => {
    const el = audio.current;
    if (!el || viaYouTube || !sound || !(fade > 0)) return;
    const f = banner.music?.from ?? 0;
    const to = banner.music?.to ?? 0;
    let raf = 0;
    const tick = () => {
      const g = vol * fadeGain(el.currentTime, f, to || el.duration || 0, fade);
      if (Math.abs(el.volume - g) > 0.005) el.volume = g;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.volume = vol;
    };
  }, [sound, viaYouTube, fade, vol, banner.music?.from, banner.music?.to, banner.music?.url]);
  /* Sans fondu, le niveau se pose tel quel. */
  useEffect(() => {
    const el = audio.current;
    if (el && !(fade > 0)) el.volume = vol;
  }, [vol, fade, sound, banner.music?.url]);

  /* A strip is shown WHOLE or it is not shown honestly. Guessing its shape is
     how the last crop happened: the band was cut to 4.75:1, the ratio AniList
     authors its own banners in, and a 1000x185 fanart banner (5.4:1) still lost
     its edges to `object-cover`. Since the picture has already been measured,
     the band simply takes the picture's own proportions and there is nothing
     left to crop. Capped, because a very long strip on a narrow window would
     otherwise be a hairline; `object-contain` then letterboxes rather than
     cuts, which is the whole point. */
  const bandStyle =
    !asPage && ratio
      ? { height: `min(calc(100vw / ${ratio.toFixed(3)}), 46vh)` }
      : undefined;

  /* A strip carries a composition — a logo, a character, a title — and the
     avatar and the name were landing right on top of it: exactly the picture we
     had just gone to the trouble of not cropping. So under a strip the identity
     steps OFF it and sits below, the avatar overlapping the edge just enough to
     tie the two together. Over a wallpaper it stays where it was: there, being
     read on the picture IS the design, and the artwork has room to spare. */
  const onArtwork = mode !== "band";

  /* Le papier peint vit dans l'écran de ProfileStage, PAS seulement en scène :
     dans la scène transformée, un élément fixe partirait avec le défilement,
     et ne l'y déplacer qu'à l'entrée en édition le démontait — l'image
     repassait par son aperçu flou le temps de se redécoder, en plein recul.
     L'écran est un simple conteneur hors scène : le papier peint s'y comporte
     comme avant. Le seul remontage a lieu à l'hydratation (le serveur le rend
     sur place), quand l'image est encore en chargement de toute façon. */
  const scene = useScene();
  const portal = (node: React.ReactNode) =>
    scene.screen ? createPortal(node, scene.screen) : node;

  /* ── L'agencement ──────────────────────────────────────────────────────
     Quatre dispositions du même matériel — avatar, nom, badges, chiffres. Ce
     n'est pas de l'habillage (le fond, la musique) mais ça se choisit au même
     endroit et ça se sauvegarde par le même appel, d'où le champ dans le même
     objet. « band » est l'agencement d'origine, et le repli de toute valeur
     inconnue : un profil épinglé avant ce réglage ne bouge pas d'un pixel. */
  const layout = banner.layout ?? "band";
  const centered = layout === "center";
  const medallion = layout === "medallion";
  /* En colonne, le haut de profil n'est plus qu'une plaque : l'identité et les
     chiffres sont rendus par la PAGE, dans une colonne à gauche du contenu. */
  const asColumn = layout === "column";
  /* La vitrine n'a de sens que sur un papier peint : un bandeau a ses propres
     proportions, l'étirer sur tout l'écran est le zoom qu'on refuse plus haut.
     Sur un bandeau, elle se rabat sur l'agencement d'origine. */
  const showcase = layout === "showcase" && asPage;

  /* Les chiffres en une ligne de texte : le médaillon dessous, la vitrine à
     droite du nom — deux places, une seule ligne. */
  /* Sous le médaillon, les chiffres sont posés à même le papier peint, et un
     mur d'affiches ou une illustration chargée les rendait illisibles (la note,
     en couleur d'accent, disparaissait sur une affiche rouge). Ils ont donc
     leur propre fond, une barre vitrée — dans la vitrine aussi : le bas du
     voile n'y suffisait pas sur un mur d'affiches (15/10/2026). */
  /* Dans la plaque du médaillon, la barre perd son propre fond : la plaque en
     est déjà un, et deux vitres l'une dans l'autre se liraient comme deux
     objets. */
  const statLine = (
    <dl
      className={`grid grid-cols-2 ${
        medallion
          ? /* Dans le médaillon, en 2 × 2 à droite de l'identité, en grand et
               aéré (16/10/2026). À partir de `md`, le bloc prend TOUTE la
               hauteur de la plaque (`self-stretch`) et ses deux lignes s'y
               répartissent (`content-around`) ; la taille des chiffres suit
               celle de l'avatar (`--as-av`), bornée. */
            "w-full gap-x-4 gap-y-6 py-1 md:ml-auto md:w-auto md:shrink-0 md:content-around md:gap-x-8 md:self-stretch"
          : "gap-y-3 as-stat-card rounded-2xl py-3 ring-1 ring-white/10 sm:grid-cols-4 sm:divide-x sm:divide-white/10"
      } ${showcase ? "w-full md:mb-1 md:w-auto" : ""}`}
    >
      {stats.map((s) => (
        <div key={s.key} className="flex items-baseline gap-2 px-5">
          <dd
            className={`font-outfit font-bold leading-none ${
              s.accent ? "text-action" : "text-white"
            } ${medallion ? "text-3xl md:text-[length:clamp(1.875rem,calc(2rem*var(--as-av,1)),3rem)]" : "text-xl"} ${showcase ? "md:text-2xl" : ""}`}
          >
            {s.value}
          </dd>
          <dt
            className={`font-bold uppercase tracking-wider text-white/60 ${
              medallion ? "text-xs md:text-[length:clamp(0.7rem,calc(0.75rem*var(--as-av,1)),0.95rem)]" : "text-[10px]"
            }`}
          >
            {s.label}
          </dt>
        </div>
      ))}
    </dl>
  );

  /* `max-w-screen-xl`, la largeur des onglets et des widgets (page) : en
     `screen-lg` l'avatar et les chiffres partaient 128 px plus à droite que
     « Aperçu » sur un grand écran, deux bords gauches l'un au-dessus de
     l'autre (15/10/2026). */
  /* Les tailles de l'avatar et du pseudo sont celles de l'agencement, par
     écran, MULTIPLIÉES par le réglage du studio (`--as-av`, `--as-nm`, posés
     sur la racine plus bas) : le profil reste responsive à toute taille. */
  const identityBody = (
    <>
      <div className="shrink-0">
        <FramedAvatar
          src={avatar}
          name={name}
          frame={banner.frame}
          priority
          /* Jusqu'à 9rem × 200 % = 288 px affichés : la version 160 px aurait
             été floue au maximum du réglage. */
          px={(banner.avatarScale ?? 100) > 110 ? 320 : 160}
          sizeClass={
            medallion
              ? "h-[calc(6rem*var(--as-av,1))] w-[calc(6rem*var(--as-av,1))] md:h-[calc(9rem*var(--as-av,1))] md:w-[calc(9rem*var(--as-av,1))]"
              : "h-[calc(5rem*var(--as-av,1))] w-[calc(5rem*var(--as-av,1))] md:h-[calc(7rem*var(--as-av,1))] md:w-[calc(7rem*var(--as-av,1))]"
          }
          textClass={medallion ? "text-4xl md:text-5xl" : "text-3xl md:text-4xl"}
        />
      </div>

      {/* Centré, le pseudo REMONTE sous l'avatar : l'interligne d'un titre
          laisse à lui seul un vide au-dessus des lettres. La remontée suit la
          TAILLE DU PSEUDO (15 % de sa police, `--as-nm` compris) : fixe, un
          petit pseudo passait sous l'avatar (16/10/2026). */}
      <div
        className={`min-w-0 pb-1 ${medallion || showcase ? "flex-1" : ""} ${
          centered
            ? `-mt-[calc(0.15*1.875rem*var(--as-nm,1))] flex flex-col items-center ${
                showcase
                  ? "md:-mt-[calc(0.15*3.75rem*var(--as-nm,1))]"
                  : "md:-mt-[calc(0.15*3rem*var(--as-nm,1))]"
              }`
            : ""
        }`}
      >
        {/* The name can overlap a plate that is anything at all: the shadow is
            what keeps it readable over a bright artwork.

            LA BOÎTE NOIRE DERRIÈRE LE PSEUDO ÉTAIT CETTE OMBRE, DÉCOUPÉE, et
            le remède n'est pas de la rendre plus discrète : c'est d'enlever ce
            qui la découpe. `truncate` pose `overflow: hidden`, et un overflow
            caché ROGNE l'ombre du texte — elle remplit la boîte du titre puis
            s'arrête net sur ses bords, d'où un rectangle à angles droits. Tant
            que le texte est aussi haut que sa boîte, aucun flou n'y échappe :
            baisser le flou n'a fait qu'éclaircir le rectangle.

            Le pseudo REVIENT donc À LA LIGNE au lieu d'être coupé. Rien n'est
            perdu — un nom d'AniList fait vingt caractères au plus, un pseudo
            AniScroll autant — et sans clip, l'ombre s'éteint où elle veut.

            CE QUI RESTE EST L'OMBRE ELLE-MÊME, et elle est maintenant SERRÉE.
            Mesuré au CDP sur dev.aniscroll.com (08/09/2026, modale de changelog
            écartée) : aucun élément n'est peint derrière le nom, et le voile de
            page assombrit uniformément toute la largeur (255 → 187), sans bord.
            Le halo sombre autour des lettres était donc le seul « noir
            derrière » qui restait. Un rayon de 2 px suffit à décoller le texte
            d'une image claire ; au-delà, on repeint le fond.

            SUR UN APLAT DE COULEUR, pas d'ombre du tout : le contraste y est
            choisi et connu, elle n'a rien à corriger (les aplats ont déjà leur
            voile allégé, `.as-page-scrim-tint`). */}
        {/* Les badges mis en avant : SOUS le pseudo dans les agencements
            centrés (16/10/2026), À CÔTÉ ailleurs — sur sa ligne, et sous lui
            quand le pseudo prend toute la largeur (téléphone). */}
        <div
          className={
            centered
              ? "flex flex-col items-center gap-2"
              : "flex flex-wrap items-center gap-x-4 gap-y-2"
          }
        >
        <h1
          className={`min-w-0 break-words font-outfit text-[length:calc(1.875rem*var(--as-nm,1))] font-bold leading-tight ${
            showcase
              ? "md:shrink-0 md:text-[length:calc(3.75rem*var(--as-nm,1))]"
              : "md:text-[length:calc(3rem*var(--as-nm,1))]"
          }`}
          style={flat ? undefined : { textShadow: "0 1px 2px rgba(0,0,0,0.7)" }}
        >
          {name}
        </h1>
        {/* À côté, centrés sur la hauteur du pseudo ; leur taille a son
            propre réglage dans le menu Badges du studio (`badgeScale`).
            En vitrine, ils quittent le pseudo pour la colonne de droite, AU-DESSUS des chiffres et calés sur leur bord
            droit (16/10/2026) : à côté d'un grand pseudo, ils
            passaient dessous ou débordaient sur la barre. */}
        {/* UN SEUL montage par page, jamais un second caché par CSS : chaque
            FeaturedBadges porte les dégradés des jetons (BadgeDefs) sous les
            mêmes ids, et le navigateur résout `url(#…)` vers le PREMIER — s'il
            est dans un bloc `display: none`, tous les badges de la page, studio
            compris, perdent leurs couleurs (16/10/2026). */}
        {showcase ? null : (
          <FeaturedBadges
            ids={banner.badges}
            earned={earned}
            size={Math.round(56 * ((banner.badgeScale ?? 100) / 100))}
            className={`gap-2 ${centered ? "justify-center" : "self-center"}`}
          />
        )}
        </div>
        {/* LA LIGNE D'IDENTITÉ : le logo AniList (lien vers le profil AniList),
            l'identifiant, la date d'arrivée — chacun dans sa petite boîte. Un
            fond flou englobant les trois a été essayé et retiré le 16/10/2026. */}
        {tag || anilistName || createdAt ? (
        /* `mb-8` : posée à ras du bas de l'en-tête, la ligne paraissait
           tomber trop bas, et `mb-2` la laissait encore collée aux widgets
           (16/10/2026). En centré seulement : à côté de l'avatar (bandeau,
           médaillon), le bloc est centré sur lui, et une marge sous la ligne
           le faisait remonter au-dessus. */
        <div className={`mt-2.5 flex ${centered ? "mb-8 justify-center md:mb-10" : ""}`}>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {anilistName ? (
            <a
              href={`https://anilist.co/user/${anilistName}`}
              target="_blank"
              rel="noreferrer"
              title={`AniList · ${anilistName}`}
              aria-label={`AniList · ${anilistName}`}
              /* `mr-1` : à écart égal, un rond PARAÎT plus près de la boîte
                 voisine qu'un rectangle — ses bords fuient en haut et en bas
                 mais son milieu touche presque. Écarté un peu plus (correction
                 optique, 16/10/2026). */
              className={`mr-1 grid h-[1.6rem] w-[1.6rem] shrink-0 place-items-center rounded-full bg-[#152232] ring-1 ring-[#02a9ff]/30 transition-transform hover:scale-110`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="https://anilist.co/img/icons/icon.svg" alt="" className="h-4 w-4" />
            </a>
          ) : null}
          {tag ? (
            /* `as-stat-card` : le fond et le flou des widgets (le curseur
               « Flou » du studio), pas un flou à part. */
            <span className="as-stat-card rounded-md px-2 py-1 font-mono text-white/60 ring-1 ring-white/10">
              #{tag}
            </span>
          ) : null}
          {createdAt ? (
            <span className="as-stat-card rounded-md px-2 py-1 text-white/65 ring-1 ring-white/10">
              {/* Formatée contre la langue ACTIVE de l'interface, jamais contre
                  celle de l'environnement — même note que Hero.tsx, et le même
                  prix quand on l'oublie. `toLocaleDateString(undefined)`
                  demande à l'environnement, et les deux environnements ne
                  répondent pas la même chose : Node sur Vercel résout `en-US`
                  et écrit « September 2024 », un navigateur français écrit
                  « septembre 2024 ». React voit alors un texte différent de
                  celui que le serveur a envoyé — erreur #425 — et son remède
                  est de JETER tout le HTML du serveur pour re-rendre la page
                  entière côté client (#418, #423). Mesuré le 02/09/2026 sur
                  dev.aniscroll.com : DOM prêt à 14 982 ms sur ce profil, contre
                  647 ms sur une fiche anime, pour un TTFB de 19 ms.

                  `i18n.language` vaut « en » sur le serveur ET au premier rendu
                  du client (cf. lib/i18n/I18nProvider), donc l'hydratation
                  correspond ; le français arrive avec la bascule de langue,
                  après.

                  `timeZone: "UTC"` pour la même raison, un cran plus fin : le
                  serveur est en UTC et le lecteur ne l'est pas, donc une date
                  d'inscription tombée le 1er ou le dernier jour d'un mois se
                  lirait sur deux mois différents. */}
              {t("profile.memberSince", {
                date: new Date(createdAt).toLocaleDateString(i18n.language, {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                }),
              })}
            </span>
          ) : null}
        </div>
        </div>
        ) : null}
        {subtitle ? <p className="mt-1 text-xs text-white/50">{subtitle}</p> : null}
      </div>
      {medallion ? statLine : null}
      {showcase ? (
        <div className="flex w-full flex-col items-end gap-3 md:ml-auto md:w-auto md:shrink-0">
          <FeaturedBadges
            ids={banner.badges}
            earned={earned}
            size={Math.round(56 * ((banner.badgeScale ?? 100) / 100))}
            className="gap-2"
          />
          {statLine}
        </div>
      ) : null}
    </>
  );

  /* Le médaillon (refait le 15/10/2026, il ne se distinguait plus du
     bandeau) : TOUTE l'identité tient dans une seule plaque vitrée — avatar,
     pseudo, pastilles, chiffres. Un objet, là où le bandeau pose ses pièces
     à même le fond. */
  /* La plaque est une carte de widget (`as-stat-card`) : même teinte, même
     liseré et SURTOUT même flou — celui du curseur « Flou » du studio — que
     les blocs qu'elle surplombe. L'avatar y est tout entier (il en sortait par
     le haut dans la première version, 15/10/2026). */
  const identity = medallion ? (
    <div className="mx-auto w-full max-w-screen-xl px-4 pb-5 md:pb-7">
      {/* `md:flex-nowrap` : les chiffres restent À DROITE de l'identité, ils
          ne passent plus à la ligne quand la plaque est étroite (16/10/2026) —
          c'est le pseudo qui revient à la ligne. */}
      <div className="as-stat-card flex flex-wrap items-center gap-x-6 gap-y-4 rounded-3xl p-5 ring-1 ring-white/10 md:flex-nowrap md:px-7 md:py-6">
        {identityBody}
      </div>
    </div>
  ) : (
    <div
      /* Centré, l'écart est VERTICAL, entre l'avatar et le pseudo : le
         `gap-6` d'à côté les décollait trop (16/10/2026). À côté (bandeau),
         pseudo, badges et ligne d'identité sont centrés sur la hauteur de
         l'avatar : calés en bas avec la marge de la ligne, ils flottaient
         au-dessus de lui (16/10/2026). En vitrine, calés en bas, et les
         chiffres À DROITE sur la même ligne (`md:flex-nowrap`) : ils passaient
         dessous dès que le pseudo et les badges prenaient de la place. Plus
         de chevron sous elle (retiré le 16/10/2026), d'où une marge du bas
         ramenée de 64 à 32 px : le tout descend vers le bas de l'écran. */
      className={`mx-auto flex w-full max-w-screen-xl px-4 ${
        centered
          ? "flex-col items-center gap-0 text-center"
          : showcase
            ? "items-end gap-4 md:gap-6"
            : "items-center gap-4 md:gap-6"
      } ${showcase ? "flex-wrap pb-6 md:flex-nowrap md:pb-8" : "pb-5 md:pb-7"}`}
    >
      {identityBody}
    </div>
  );

  return (
    <div
      className="relative w-full"
      style={
        {
          "--as-av": (banner.avatarScale ?? 100) / 100,
          "--as-nm": (banner.nameScale ?? 100) / 100,
        } as React.CSSProperties
      }
    >
      {/* La musique du profil. `loop` parce que le rip d'AnimeThemes dure 90
          secondes et qu'un profil se lit plus longtemps que ça. Jamais
          `autoPlay` : voir la note sur le son plus haut. Court-circuité dès
          qu'on a la version complète sur YouTube. */}
      {banner.music && !viaYouTube ? (
        /* `loop` natif tant que le morceau est entier ; dès qu'un extrait a été
           découpé dans le studio, c'est nous qui rebouclons, sur sa borne de
           fin — le navigateur, lui, ne sait reboucler que sur le fichier. */
        <audio
          ref={audio}
          src={audioFirst(banner.music.url)}
          /* L'OGG tenté par audioFirst n'existe pas : la vidéo d'origine. */
          onError={(e) => {
            const url = banner.music?.url;
            if (url && e.currentTarget.src !== url) e.currentTarget.src = url;
          }}
          loop={!(banner.music.to && banner.music.to > (banner.music.from ?? 0))}
          preload="none"
          onPlay={(e) => {
            setAudioStarted(true);
            const el = e.currentTarget;
            const f = banner.music?.from ?? 0;
            const to = banner.music?.to ?? 0;
            if (to > f && (el.currentTime < f || el.currentTime > to)) el.currentTime = f;
          }}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            const f = banner.music?.from ?? 0;
            const to = banner.music?.to ?? 0;
            if (to > f && el.currentTime > to) el.currentTime = f;
          }}
        />
      ) : null}
      {/* SA CASE (17/10/2026) : le fichier d'AnimeThemes n'avait rien à
          l'écran pour se lancer ni se couper. La même que la version YouTube,
          sa pochette à la place du lecteur. Jamais de lecture auto : le
          visiteur la lance d'ici. */}
      {banner.music && !viaYouTube && !studio ? (
        <div className="fixed bottom-6 right-6 z-40">
          <MusicCard
            className="h-[240px] w-[240px]"
            art={banner.music.cover || banner.url || ""}
            showArt
            started={audioStarted}
            eqKey={banner.music.url}
            clock={() => audio.current?.currentTime ?? 0}
            live={() => !!audio.current && !audio.current.paused}
            gain={() => {
              const el = audio.current;
              if (!el || !(fade > 0)) return 1;
              return fadeGain(el.currentTime, banner.music?.from ?? 0, banner.music?.to || el.duration || 0, fade);
            }}
            playing={sound}
            muted={vol === 0}
            volume={vol > 0 ? vol : PROFILE_DEFAULT_VOLUME}
            onToggle={() => setSound((x) => !x)}
            onMuted={(m) => changeVol(m ? 0 : PROFILE_DEFAULT_VOLUME)}
            onVolume={changeVol}
            fallback={PROFILE_DEFAULT_VOLUME}
            minimizable
          />
        </div>
      ) : null}

      {/* LA CASE DU FOND VIDÉO (21/10/2026, Luc) : la même que celle de la
          musique, au même coin — lecture au centre, volume en haut à droite,
          petit carré hors survol. Seulement sans musique : celle-ci a déjà sa
          case, et la vidéo se tait sous elle. Hors studio : il a la sienne. */}
      {(trailer || (video && !!banner.url)) && !studio && !banner.music ? (
        <div className="fixed bottom-6 right-6 z-40">
          <MusicCard
            className="h-[240px] w-[240px]"
            art={
              banner.videoCover ||
              (banner.trailerId ? `https://i.ytimg.com/vi/${banner.trailerId}/hqdefault.jpg` : "") ||
              /* Rien à montrer : un pixel transparent plutôt qu'une image cassée. */
              "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
            }
            showArt
            started={!bgPaused}
            eqKey={banner.trailerId || banner.url || `${banner.animeId}:${banner.episode?.n}`}
            clock={() => performance.now() / 1000}
            live={() => !bgPaused && videoAudible}
            playing={!bgPaused}
            muted={!videoAudible}
            volume={visitorVol || (videoVol > 0 ? videoVol : PROFILE_DEFAULT_VOLUME)}
            onToggle={toggleBg}
            onMuted={(m) => {
              /* Le clic qui vient de donner le son ne le recoupe pas. */
              if (performance.now() - vidWokeAt.current < 600) return;
              /* Une vidéo que son propriétaire a voulue muette le reste. */
              if (videoVol === 0) return;
              setVidAwake(true);
              setVidMuted(m);
            }}
            onVolume={(v) => {
              if (videoVol === 0) return;
              setVidAwake(true);
              setVidMuted(v === 0);
              setVisitorVol(v);
            }}
            fallback={PROFILE_DEFAULT_VOLUME}
            minimizable
          />
        </div>
      ) : null}

      {/* Le lecteur YouTube de la musique.
          Il RESTE VISIBLE, et c'est la condition de sa légitimité : c'est le
          lecteur officiel qui sert le morceau et sa publicité, laquelle paie la
          licence. Le masquer pour n'en garder que le son reviendrait à
          contourner ce que l'écoute gratuite finance. 200 px est le minimum que
          demandent les conditions de l'API. Depuis le 17/10/2026, la case se
          réduit hors survol sous les 200 px : choix de Luc, en connaissance
          de cause. Et la case montre l'image du morceau par-dessus le lecteur,
          jamais la vidéo (17/10/2026, même choix). */}
      {/* Pas dans le studio : il a sa propre case, la musique jouerait deux fois. */}
      {viaYouTube && banner.music?.videoId && !studio ? (
        /* TOUJOURS LÀ (17/10/2026), en pause tant qu'on ne l'a pas lancée :
           c'est elle qui démarre la musique, l'icône du haut est partie.
           La petite case, habillée comme l'aperçu au survol :
           lumière d'ambiance, lecture au centre, volume en haut à droite. La
           bande-annonce y est aussi, comme les autres. Les bornes et le fondu
           du studio valent pour elle (YouTubeMusic pilote le lecteur). */
        <div className="fixed bottom-6 right-6 z-40">
          <YouTubeMusic
            autoStart={!cookiePaused}
            ref={yt}
            videoId={banner.music.videoId}
            className="h-[240px] w-[240px]"
            /* L'image du morceau, jamais la vidéo. */
            cover={banner.music.cover}
            clip={{ from: banner.music.from, to: banner.music.to, fade: banner.music.fade ?? 0, volume: vol }}
            card={{
              playing: sound,
              muted: vol === 0 || browserMuted,
              volume: vol > 0 ? vol : PROFILE_DEFAULT_VOLUME,
              /* Le choix est retenu : en pause, le profil ne repart plus seul. */
              /* Muette par le navigateur, la case ne se met PAS en pause au
                 clic : ce clic sert à rendre le son. Et seule une vraie pause,
                 son audible, est retenue — cliquer pour avoir le son
                 enregistrait « pas de lecture auto » (17/10/2026). */
              onToggle: () => {
                if (browserMuted || performance.now() - wokeAt.current < 600) return;
                setSound((x) => {
                  rememberAutoplay(!x);
                  return !x;
                });
              },
              onMuted: (m) => {
                if (!m && browserMuted) {
                  /* Un clic ici EST le geste qui manquait : le son passe. */
                  setBrowserMuted(false);
                  void yt.current?.play();
                  if (vol === 0) changeVol(PROFILE_DEFAULT_VOLUME);
                  return;
                }
                changeVol(m ? 0 : PROFILE_DEFAULT_VOLUME);
              },
              onVolume: changeVol,
              fallback: PROFILE_DEFAULT_VOLUME,
              minimizable: true,
            }}
            onError={() => setSound(false)}
            onBrowserMute={() => setBrowserMuted(true)}
          />
        </div>
      ) : null}
      {asPage ? portal(
        <div className="as-page-plate">
          {/* Full-bleed, and a wallpaper that fills the window is worth the ~10%
              a 16:9 artwork loses to a wider one. `contain` plus a blurred copy
              of the same picture as a frame was tried, and it shows the artwork
              entire — but the blurred bars cost more than the crop saves. A
              strip is a different matter: see the band below, where cropping
              destroys a composition and nothing is shown whole otherwise. */}
          <PlateBackground
            dressing={{
              kind: banner.kind ?? "banner",
              url: banner.url,
              color: banner.color ?? null,
              pattern: banner.pattern ?? null,
              patternZoom: banner.patternZoom,
              patternAnim: banner.patternAnim ?? false,
              patternSpeed: banner.patternSpeed,
              wall: banner.wall ?? null,
              source: banner.source ?? null,
              trailerId: banner.trailerId ?? null,
              episode: banner.episode ?? null,
              animeId: banner.animeId ?? null,
              /* Le découpage et le fondu voyagent avec le fond : c'est le
                 plateau qui tient la boucle, ici comme dans le studio. */
              videoFrom: banner.videoFrom ?? null,
              videoTo: banner.videoTo ?? null,
              videoFade: banner.videoFade ?? 0,
            }}
            fallback={cover}
            wallCovers={covers}
            unmuted={videoAudible}
            volume={visitorVol ?? videoVol}
            priority
            videoRemote={studio?.remote}
            /* La même pause sur le profil et dans le studio (lib/profile/playback). */
            paused={bgPaused}
            onVideoProgress={
              studio ? (at, d, playing) => studio.progress.current?.(at, d, playing) : undefined
            }
          />
          {/* Une couleur choisie reçoit un voile léger : le voile lourd existe
              pour détacher du texte d'une PHOTO, et l'appliquer à un aplat
              rendait une autre couleur que celle qu'on avait cliquée. */}
          {/* Le mur aussi : il porte son propre voile, un second voile lourd
              le noircissait sous la barre de navigation. */}
          <div className={flat || wall ? "as-page-scrim-tint" : "as-page-scrim"} />
        </div>,
      ) : null}

      <header className="relative z-10 w-full">
      <div
        className={`relative w-full overflow-hidden ${
          asPage ? "as-hero-band" : "as-hero-band-slim"
        }`}
        /* `svh` : la hauteur de l'écran barre d'adresse comprise, sinon sur un
           téléphone le bas de l'identité passe sous la barre au chargement.
           MOINS 6,5 rem : les onglets dépassent en bas du premier écran et
           disent qu'il y a une suite — ils remplacent le chevron, retiré le
           16/10/2026. */
        style={showcase ? { height: "calc(100svh - 6.5rem)" } : bandStyle}
      >
        {!asPage && banner.url ? (
          <PlateBackground
            dressing={{
              kind: banner.kind ?? "banner",
              url: banner.url,
              color: null,
              source: banner.source ?? null,
              videoFrom: banner.videoFrom ?? null,
              videoTo: banner.videoTo ?? null,
              videoFade: banner.videoFade ?? 0,
            }}
            contain={!!ratio}
            priority
            paused={bgPaused}
          />
        ) : null}
        {!banner.url && !flat && !trailer && !wall ? (
          /* No list, no artwork: the site's own colour. */
          <div className="absolute inset-0 as-hero-default as-hero-weave" />
        ) : null}

        {/* The heavy scrim exists to make a name readable over a plate, so it
            belongs only where a name is: on the flat-colour plate. A wallpaper
            carries its own (as-page-scrim), and a strip no longer has anything
            written on it — darkening its lower third into black would just be
            damaging the artwork for nothing. It gets a foot fade instead, to
            meet the page. */}
        {mode === "none" ? <div className="as-hero-scrim absolute inset-0" /> : null}
        {mode === "band" ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 as-strip-foot" />
        ) : null}
        {/* PLUS DE HALO SOUS LA PLAQUE. C'était un rectangle de 192 px de haut
            (`-bottom-24 h-48`), un dégradé radial rouge à 0,35 d'opacité et
            40 px de flou : sur une illustration sombre il ne se lisait pas
            comme une lueur mais comme un voile presque transparent posé sous le
            nom et derrière les chiffres, avec ses bords droits visibles là où
            la bande le coupe. Relevé au CDP sur dev.aniscroll.com le
            07/09/2026 : c'était le seul calque large peint dans l'en-tête. */}

        {/* Where the plate comes from — and, for the owner, the way to change
            it. Pinned under the navbar so it never crowds the name below.
            `z-20`, AU-DESSUS de l'identité (`z-10`, posée après) : en vitrine,
            sa boîte pleine largeur remonte jusqu'ici une fois les badges sous
            le pseudo, et avalait le clic du bouton bannière (16/10/2026). */}
        <div className="absolute right-3 top-[4.75rem] z-20 flex flex-wrap items-center justify-end gap-2 md:right-6">
          {banner.title && banner.animeId ? (
            <Link
              href={animeHref(banner.animeId, clickTarget)}
              className="rounded-full bg-black/45 px-3 py-1.5 text-[11px] font-medium text-white/75 ring-1 ring-white/10 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white"
            >
              {banner.kind === "video" && banner.episode
                ? t("profile.episodeFrom", { title: banner.title, n: banner.episode.n })
                : t("profile.bannerFrom", { title: banner.title })}
            </Link>
          ) : null}
          {/* Plus d'icône de son ici (17/10/2026) : la musique YouTube se
              lance depuis sa case, en bas à droite, toujours affichée. */}
          {/* Caché pendant l'édition (21/10/2026) : le studio est déjà ouvert. */}
          {isOwner && onEditBanner && !studio ? (
            <button
              type="button"
              onClick={onEditBanner}
              /* Icône seule : le libellé encombrait une bande déjà occupée par
                 la pilule « bannière tirée de … ». Il survit en infobulle et en
                 nom accessible, donc rien n'est perdu pour qui en a besoin. */
              aria-label={t("profile.changeBanner")}
              title={t("profile.changeBanner")}
              className="inline-flex items-center justify-center rounded-full bg-black/45 p-2 text-white/85 ring-1 ring-white/15 backdrop-blur-md transition-colors hover:bg-action hover:text-white hover:ring-action"
            >
              <PaletteIcon className="h-[1.05rem] w-[1.05rem]" />
            </button>
          ) : null}
        </div>

        {/* On a wallpaper, the identity is read on the picture. Le médaillon
            fait exception : son avatar doit MORDRE sur le bord de la plaque, ce
            qui n'est possible qu'en le rendant sous elle. */}
        {onArtwork && !asColumn && !medallion ? (
          <div className="absolute inset-x-0 bottom-0 z-10">{identity}</div>
        ) : null}
      </div>

      {/* Under a strip: below it, the avatar overlapping the edge. */}
      {(!onArtwork || medallion) && !asColumn ? (
        <div className={`relative z-10 ${medallion ? "" : "-mt-12 md:-mt-14"}`}>{identity}</div>
      ) : null}

      {/* Le médaillon et la vitrine portent leurs chiffres dans l'identité
          (statLine) ; les cartes ne servent qu'au bandeau et au centré. */}
      {!medallion && !asColumn && !showcase && stats.length > 0 ? (
        <dl className="mx-auto mt-5 grid w-full max-w-screen-xl grid-cols-2 gap-2.5 px-4 sm:grid-cols-4 md:gap-3">
          {stats.map((s) => (
            <div
              key={s.key}
              className="as-stat-card rounded-xl px-3.5 py-3 ring-1 ring-white/10"
            >
              <dt className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                {s.label}
              </dt>
              <dd
                className={`mt-0.5 font-outfit text-2xl font-bold leading-none ${
                  s.accent ? "text-action" : "text-white"
                }`}
              >
                {s.value}
              </dd>
              {s.hint ? (
                <p className="mt-1 text-[10px] text-white/35">{s.hint}</p>
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}

      {/* No seam here any more. It faded 140px into rgba(12,13,16,0.9) to meet
          .as-page-under, and .as-page-under is gone (see globals.css): fading
          into a colour nothing is painted in just drew a dark band across the
          wallpaper, at the one spot the wallpaper is meant to keep going. */}
      </header>
    </div>
  );
}

/**
 * L'ICÔNE DU STUDIO : une palette, et non plus une image (21/10/2026, choix de
 * Luc) — le bouton ouvre la personnalisation de tout le profil (fond,
 * agencement, cadre, badges, musique), pas seulement son image. Tracé Material
 * Symbols « palette », dans la couleur du texte du bouton.
 */
function PaletteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden className={className}>
      <path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Zm0-400Zm-177 23q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120-160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm200 0q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120 160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17ZM480-160q9 0 14.5-5t5.5-13q0-14-15-33t-15-57q0-42 29-67t71-25h70q66 0 113-38.5T800-518q0-121-92.5-201.5T488-800q-136 0-232 93t-96 227q0 133 93.5 226.5T480-160Z" />
    </svg>
  );
}
