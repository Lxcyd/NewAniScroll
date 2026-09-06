import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PhotoIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
} from "@heroicons/react/24/outline";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useNavBackdrop } from "@/lib/color/navContrast";
import { watchTime } from "@/lib/profile/sources";
import { plateMode } from "@/lib/profile/types";
import PlateBackground from "@/components/profile/PlateBackground";
import TrailerStage from "@/components/shared/HoverPreview/TrailerStage";
import { attachStage, detachStage } from "@/components/shared/HoverPreview/stageStore";
import { fadeGain, isVideoKind, type Dressing } from "@/lib/profile/dressing";
import type { BannerOption, ProfileStats } from "@/lib/profile/types";

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
  music?: Dressing["music"];
  blur?: number | null;
  /** Bande-annonce YouTube portée en fond (kind « video »). */
  trailerId?: Dressing["trailerId"];
  /** Agencement du haut de profil. Absent : « band », l'agencement d'origine. */
  layout?: Dressing["layout"] | null;
};

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
}: Props) {
  const { t, i18n } = useTranslation();
  const clickTarget = useClickTarget();
  /* The navbar floats transparent over this plate, and a profile's artwork is
     picked by its owner — nothing stops it being a white one. Same measurement
     the info page's hero declares (lib/color/navContrast.ts). */
  useNavBackdrop(banner.url);

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
  const trailer = banner.kind === "video" && !!banner.trailerId;
  const flat = banner.kind === "color" && !!banner.color;
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

  const mode = flat
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
     variable survivrait à la navigation vers un autre profil. */
  const blur = Math.max(0, Math.min(32, banner.blur || 0));
  useEffect(() => {
    const root = document.documentElement.style;
    if (!blur) {
      root.removeProperty("--as-plate-blur");
      root.removeProperty("--as-plate-a1");
      root.removeProperty("--as-plate-a2");
      return;
    }
    root.setProperty("--as-plate-blur", `${blur}px`);
    root.setProperty("--as-plate-a1", "0.34");
    root.setProperty("--as-plate-a2", "0.2");
    return () => {
      root.removeProperty("--as-plate-blur");
      root.removeProperty("--as-plate-a1");
      root.removeProperty("--as-plate-a2");
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
  /* Une bande-annonce ne compte PAS comme une source de son : elle est jouée
     muette et le reste (voir PlateBackground). Un bouton de son qui ne
     débloquerait rien vaut moins que pas de bouton du tout. */
  const hasSound = !!banner.music || (video && !!banner.url);
  useEffect(() => setSound(false), [banner.url, banner.music?.url]);

  /* Deux façons de jouer la musique, et la meilleure gagne quand elle existe.
     L'audio d'AnimeThemes est le rip du générique — 90 s, d'où le `loop`
     ci-dessous. Quand le morceau a été résolu sur YouTube on joue la version
     COMPLÈTE, par le lecteur officiel, via la même scène que les
     bandes-annonces au survol (scène « music », indépendante : voir
     stageStore, sinon survoler une affiche coupait le son). */
  const viaYouTube = !!banner.music?.videoId;
  const musicSlot = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = musicSlot.current;
    const id = banner.music?.videoId;
    if (!el || !id || !sound) return;
    attachStage("music", {
      el,
      id,
      handlers: { onPlaying: () => {}, onHide: () => setSound(false), onProgress: () => {} },
    });
    return () => detachStage("music", el);
  }, [sound, banner.music?.videoId]);

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
      const g = fadeGain(el.currentTime, f, to || el.duration || 0, fade);
      if (Math.abs(el.volume - g) > 0.005) el.volume = g;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.volume = 1;
    };
  }, [sound, viaYouTube, fade, banner.music?.from, banner.music?.to, banner.music?.url]);

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

  const identity = (
    <div
      className={`mx-auto flex w-full max-w-screen-lg gap-4 px-4 pb-5 md:gap-6 md:pb-7 ${
        centered ? "flex-col items-center text-center" : "items-end"
      }`}
    >
      <div
        className={`shrink-0 bg-gradient-to-br from-as-accent to-as-accent2 p-[3px] shadow-glow ${
          /* Le médaillon monte sur la plaque au lieu de s'y adosser : c'est ce
             chevauchement franc qui le fait lire comme un portrait épinglé et
             non comme une vignette posée au bord. */
          medallion ? "-mt-8 rounded-full md:-mt-14" : "rounded-[1.35rem]"
        }`}
      >
        {avatar ? (
          <Image
            src={avatar}
            alt={name}
            width={160}
            height={160}
            priority
            className={`object-cover ${
              medallion
                ? "h-24 w-24 rounded-full md:h-36 md:w-36"
                : "h-20 w-20 rounded-[1.2rem] md:h-28 md:w-28"
            }`}
          />
        ) : (
          <div
            className={`flex items-center justify-center bg-primary font-bold text-white/80 ${
              medallion
                ? "h-24 w-24 rounded-full text-4xl md:h-36 md:w-36 md:text-5xl"
                : "h-20 w-20 rounded-[1.2rem] text-3xl md:h-28 md:w-28 md:text-4xl"
            }`}
          >
            {name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      <div className={`min-w-0 pb-1 ${centered ? "flex flex-col items-center" : ""}`}>
        {/* The name can overlap a plate that is anything at all: the shadow is
            what keeps it readable over a bright artwork. */}
        <h1
          className="truncate font-outfit text-3xl font-bold leading-tight md:text-5xl"
          style={{ textShadow: "0 2px 18px rgba(0,0,0,0.75)" }}
        >
          {name}
        </h1>
        <div
          className={`mt-2 flex flex-wrap items-center gap-1.5 text-[11px] ${
            centered ? "justify-center" : ""
          }`}
        >
          {tag ? (
            <span className="rounded-md bg-black/40 px-2 py-1 font-mono text-white/60 ring-1 ring-white/10 backdrop-blur-sm">
              #{tag}
            </span>
          ) : null}
          {anilistName ? (
            <a
              href={`https://anilist.co/user/${anilistName}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-[#02a9ff]/20 px-2 py-1 font-bold text-[#5ac8ff] ring-1 ring-[#02a9ff]/30 backdrop-blur-sm transition-colors hover:bg-[#02a9ff]/30"
            >
              AniList · {anilistName}
            </a>
          ) : null}
          {createdAt ? (
            <span className="px-1 py-1 text-white/50">
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
        {subtitle ? <p className="mt-1 text-xs text-white/50">{subtitle}</p> : null}
      </div>
    </div>
  );

  return (
    <div className="relative w-full">
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
          src={banner.music.url}
          loop={!(banner.music.to && banner.music.to > (banner.music.from ?? 0))}
          preload="none"
          onPlay={(e) => {
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

      {/* Le lecteur YouTube de la musique.
          Il RESTE VISIBLE, et c'est la condition de sa légitimité : c'est le
          lecteur officiel qui sert le morceau et sa publicité, laquelle paie la
          licence. Le masquer pour n'en garder que le son reviendrait à
          contourner ce que l'écoute gratuite finance. 200 px est le minimum que
          demandent les conditions de l'API ; le SCALE de TrailerStage efface
          par ailleurs l'habillage YouTube, donc ça se lit comme une pochette
          qui bouge, pas comme une vidéo. */}
      {viaYouTube && sound ? (
        <div className="fixed bottom-4 right-4 z-40 overflow-hidden rounded-xl bg-black/80 shadow-2xl ring-1 ring-white/15">
          <div ref={musicSlot} className="h-[200px] w-[200px]" />
          {banner.music ? (
            <p className="max-w-[200px] truncate px-2.5 py-1.5 text-[11px] text-white/80">
              {banner.music.title}
              {banner.music.artist ? ` — ${banner.music.artist}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
      {viaYouTube ? <TrailerStage scene="music" /> : null}
      {asPage ? (
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
              source: banner.source ?? null,
              trailerId: banner.trailerId ?? null,
            }}
            fallback={cover}
            unmuted={sound && !banner.music}
            priority
          />
          {/* Une couleur choisie reçoit un voile léger : le voile lourd existe
              pour détacher du texte d'une PHOTO, et l'appliquer à un aplat
              rendait une autre couleur que celle qu'on avait cliquée. */}
          <div className={flat ? "as-page-scrim-tint" : "as-page-scrim"} />
        </div>
      ) : null}

      <header className="relative z-10 w-full">
      <div
        className={`relative w-full overflow-hidden ${
          asPage ? "as-hero-band" : "as-hero-band-slim"
        }`}
        style={bandStyle}
      >
        {!asPage && banner.url ? (
          <PlateBackground
            dressing={{
              kind: banner.kind ?? "banner",
              url: banner.url,
              color: null,
              source: banner.source ?? null,
            }}
            contain={!!ratio}
            priority
          />
        ) : null}
        {!banner.url && !flat && !trailer ? (
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
        <div className="pointer-events-none absolute inset-x-0 -bottom-24 h-48 as-hero-glow" />

        {/* Where the plate comes from — and, for the owner, the way to change
            it. Pinned under the navbar so it never crowds the name below. */}
        <div className="absolute right-3 top-[4.75rem] z-10 flex flex-wrap items-center justify-end gap-2 md:right-6">
          {banner.title && banner.animeId ? (
            <Link
              href={animeHref(banner.animeId, clickTarget)}
              className="rounded-full bg-black/45 px-3 py-1.5 text-[11px] font-medium text-white/75 ring-1 ring-white/10 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white"
            >
              {t("profile.bannerFrom", { title: banner.title })}
            </Link>
          ) : null}
          {hasSound ? (
            <button
              type="button"
              onClick={() => setSound((s) => !s)}
              aria-label={
                banner.music
                  ? t("profile.playMusic", { title: banner.music.title })
                  : t("profile.playSound")
              }
              title={
                banner.music
                  ? `${banner.music.title}${banner.music.artist ? ` — ${banner.music.artist}` : ""}`
                  : t("profile.playSound")
              }
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium ring-1 backdrop-blur-md transition-colors ${
                sound
                  ? "bg-action text-white ring-action"
                  : "bg-black/45 text-white/75 ring-white/10 hover:bg-black/70 hover:text-white"
              }`}
            >
              {sound ? (
                <SpeakerWaveIcon className="h-4 w-4" />
              ) : (
                <SpeakerXMarkIcon className="h-4 w-4" />
              )}
              {banner.music ? (
                <span className="max-w-[9rem] truncate">{banner.music.title}</span>
              ) : null}
            </button>
          ) : null}
          {isOwner && onEditBanner ? (
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
              <PhotoIcon className="h-[1.05rem] w-[1.05rem]" />
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

      {/* Le médaillon remplace les quatre cartes par une ligne de chiffres :
          un grand portrait rond au-dessus d'une grille de cadres faisait deux
          objets lourds l'un sur l'autre, et c'est le portrait qu'on regarde. */}
      {medallion && stats.length > 0 ? (
        <dl className="mx-auto mt-3 flex w-full max-w-screen-lg flex-wrap items-baseline gap-x-6 gap-y-2 px-4">
          {stats.map((s) => (
            <div key={s.key} className="flex items-baseline gap-2">
              <dd
                className={`font-outfit text-xl font-bold leading-none ${
                  s.accent ? "text-action" : "text-white"
                }`}
              >
                {s.value}
              </dd>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                {s.label}
              </dt>
            </div>
          ))}
        </dl>
      ) : null}

      {!medallion && !asColumn && stats.length > 0 ? (
        <dl className="mx-auto mt-5 grid w-full max-w-screen-lg grid-cols-2 gap-2.5 px-4 sm:grid-cols-4 md:gap-3">
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
