import Skeleton from "react-loading-skeleton";
import Image from "next/image";
import Link from "next/link";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/router";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { Episode } from "types/api/Episode";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHideSpoilers } from "@/lib/prefs/spoilerPrefs";
import { useSyncPrefs } from "@/lib/prefs/syncPrefs";
import { getPlayerPrefs } from "@/lib/prefs/playerPrefs";
import { peekLocalEntry, LOCAL_LIST_EVENT } from "@/lib/list/localList";
import { fixApostrophes } from "@/lib/text/apostrophes";
import {
  getAnimeProgress,
  isCompleted,
  PROGRESS_EVENT,
  ProgressEntry,
  ProgressTick,
} from "@/lib/watch/progress";
import {
  peekRuntime,
  queueRuntime,
  peekHostRuntime,
  loadHostRuntimes,
  reportHostRuntime,
} from "@/lib/watch/episodeRuntime";
/* Les tokens de la page d'info, en classe importable — c'est ce pour quoi
   `.tokens` a ete separe de `.root` (cf. son commentaire), et la page de
   lecture l'utilise deja pour sa rangee de recommandations. Le panneau les
   porte donc a son tour, ce qui lui donne `--line-2` / `--txt-3` et, avec eux,
   l'ascenseur `.customScroll` de cette meme feuille. */
import v2Styles from "@/components/anime/v2/styles.module.css";
import { seasonSubtitle } from "@/components/anime/v2/helpers";
import { animeHref } from "@/lib/prefs/clickTarget";

type EpisodeListsProps = {
  info: AniListInfoTypes;
  map: any;
  providerId: string;
  watchId: string;
  episode: Episode[];
  track: any;
  dub: string;
  /** Lecteur actif (id de lib/servers.js). Sert aux durees par encodage : le
   *  meme episode ne dure pas la meme chose chez deux hotes. Absent = on
   *  retombe sur les sources qui ignorent le lecteur (AniSkip, AniList). */
  server?: string | null;
};

type SeasonRow = {
  id: number;
  number: number;
  label: string;
  year: number | null;
  episodes: number | null;
  format: string | null;
  /** FINISHED / RELEASING / NOT_YET_RELEASED — voir /api/v2/seasons/[id]. */
  status: string | null;
};

/**
 * Le pied du panneau : quand sort le prochain episode.
 *
 * Il porte a lui seul ce que les tuiles noires des episodes non diffuses
 * disaient si mal — une fois, en toutes lettres, au lieu de quatre cases vides
 * qui se ressemblaient. La liste ne s'allonge donc plus de ce qui n'existe pas ;
 * elle raccourcit d'autant, ce pied etant `shrink-0` dans la meme colonne flex.
 *
 * Composant separe pour une raison de rendu : le compte a rebours se rafraichit
 * a la minute, et re-rendre <EpisodeLists> a ce rythme reconstruirait les 1174
 * lignes de One Piece. Ici, seule cette ligne repasse.
 */
function ProchainEpisode({ airingAt, number }: { airingAt: number; number: number }) {
  const { t, i18n } = useTranslation();
  /* Le rebours descend d'heure en heure au-dessus d'un jour et de minute en
     minute en dessous : inutile de reveiller quoi que ce soit toutes les
     secondes pour un texte qui ne change pas. */
  const [maintenant, setMaintenant] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setMaintenant(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const reste = airingAt * 1000 - maintenant;
  if (reste <= 0) return null; // l'heure est passee : AniList n'a pas encore rattrape

  const minutes = Math.floor(reste / 60_000);
  const jours = Math.floor(minutes / 1440);
  const heures = Math.floor((minutes % 1440) / 60);
  const delai = jours
    ? `${jours}${t("anime.unitDay")} ${heures}${t("anime.unitHour")}`
    : heures
      ? `${heures}${t("anime.unitHour")} ${minutes % 60}${t("anime.unitMinute")}`
      : `${minutes}${t("anime.unitMinute")}`;

  /* La date absolue accompagne le rebours plutot que de le remplacer : "dans
     4j 18h" dit s'il faut attendre, "mercredi 2 sept., 14:30" dit quand
     revenir. Le jour en TOUTES LETTRES : cette barre est la seule ligne de date
     du panneau, elle n'a pas la place a economiser d'une colonne de tableau, et
     "mercredi" se lit sans etre decode. */
  const date = new Date(airingAt * 1000).toLocaleString(i18n.language, {
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  /* Meme boite que la barre des serveurs, de l'autre cote du lecteur
     (components/watch/primary/serverSelector.js) : memes `px-3 py-2`, meme
     `py-1` sur la ligne, meme corps de 13 px. Les deux barres se font face en
     bas de page — une difference de quelques pixels s'y verrait comme un
     defaut d'alignement. Reproduites par CONSTRUCTION plutot que par une
     hauteur figee, qui mentirait des que l'une des deux bougerait. */
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-[13px]"
      style={{ borderColor: T.line, color: T.txt3 }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        style={{ color: ACCENT }}
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      <span className="truncate py-1">
        {/* Le numero et le delai sont ce qu'on vient lire ; la date exacte est
            le detail qu'on consulte ensuite, et elle seule reste en gris. */}
        <span style={{ color: T.txt0, fontWeight: 600 }}>
          {t("common.episode")} {number}
        </span>{" "}
        <span style={{ color: T.txt0 }}>{t("anime.airsIn", { delay: delai })}</span>
        {" · "}
        {date}
      </span>
    </div>
  );
}

/* Design tokens copied from components/anime/v2/styles.module.css.
 *
 * They live there scoped to the info page's `.root`, which also sets a page
 * background and a 100vh floor — not something to drag into a sidebar. So the
 * VALUES are mirrored here rather than the stylesheet imported. Keep the two in
 * step: this panel is meant to be the info page's episode list, narrower. */
const T = {
  bg2: "#161924",
  line: "#252938",
  line2: "#2f3447",
  txt0: "#f4f5f8",
  /* Le blanc grisé des numeros d'episode. Un cran plus bas que le --txt-1 de la
     page d'info (#c4c8d4), qui se lisait encore blanc a cote du titre : l'ecart
     avec `txt0` doit se VOIR. Mais on reste loin au-dessus de `txt3`, la teinte
     du secondaire — le numero est une information qu'on lit, pas un detail
     efface, et il garde son opacite pleine. */
  txt1: "#a2a8b8",
  txt3: "#5e6478",
  green: "#2dd47a",
};
const ACCENT = "var(--brand-primary, #ff3b5c)";
const ACCENT_BORDER = `color-mix(in srgb, ${ACCENT} 40%, transparent)`;
const ACCENT_SOFT = `color-mix(in srgb, ${ACCENT} 12%, transparent)`;
/* La teinte d'accent est POSEE SUR l'aplat, elle ne le remplace pas : ce
   panneau flotte sur un fond translucide (rgba(16,18,26,0.6)), donc une couche
   a 6% d'accent laissait voir l'image de l'anime a travers la ligne en cours —
   la seule ligne trouee de la liste. Le degrade s'eteint maintenant vers
   `transparent` et `T.bg2` ferme la pile en couleur de fond opaque. */
const ACCENT_ROW = `linear-gradient(90deg, color-mix(in srgb, ${ACCENT} 6%, transparent), transparent), ${T.bg2}`;
const ACCENT_CELL = `linear-gradient(${ACCENT_SOFT}, ${ACCENT_SOFT}), ${T.bg2}`;
const WATCHED_CELL = `linear-gradient(rgba(45,212,122,0.06), rgba(45,212,122,0.06)), ${T.bg2}`;

/** Bande, en px, le long de chaque bord de la fenetre : y trainer la poignee de
 *  l'ascenseur y fait glisser la page (cf. `onListPointerDown`). */
const THUMB_MARGIN = 96;
/** Vitesse plancher de ce glissement, en px par frame, poignee au ras du bord —
 *  soit environ un ecran par seconde. Elle grandit avec l'ecart au-dela (cf.
 *  `rate`), pour rattraper une poignee jetee loin sous le pli. */
const THUMB_SPEED = 16;

/** Premiere tranche de lignes rendue apres un changement de liste — de quoi
 *  remplir le premier ecran dans les trois vues, la grille comprise. Le reste
 *  suit en doublant a chaque frame (cf. `budget`). */
const CHUNK = 40;

/* The three shapes the list can take, same three as the info page's Episodes
   tab: thumbnails, one-line rows, grid of numbers. Remembered per device — a
   choice about how you read a list shouldn't reset on the next episode. */
const VIEWS = ["detailed", "compact", "grid"] as const;
type View = (typeof VIEWS)[number];
const VIEW_KEY = "aniscroll.episodeView";
/* L'ordre de lecture est une preference d'usage, pas un etat de page : quelqu'un
   qui rattrape une serie en cours veut les derniers episodes en haut a chaque
   visite, pas a chaque fois qu'il y repense. */
const ORDER_KEY = "aniscroll.episodeOrder";

/** Signes diacritiques, pour que "resurrection" trouve "Résurrection". */
const RE_DIACRITICS = /[\u0300-\u036f]/g;
// Same labels as the info page's own switch — one vocabulary for one control.
const VIEW_LABELS: Record<View, string> = {
  detailed: "anime.detailedView",
  compact: "anime.compactList",
  grid: "anime.gridOfNumbers",
};

/** Next view in the cycle, wrapping round. */
export function nextView(current: View): View {
  return VIEWS[(VIEWS.indexOf(current) + 1) % VIEWS.length];
}

function ViewIcon({ view }: { view: View }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
  } as const;
  if (view === "detailed") {
    // Picture glyph — this is the mode that shows the thumbnails.
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
        <path d="m4 18 5-5 4 4 3-3 4 4" />
      </svg>
    );
  }
  if (view === "compact") {
    return (
      <svg {...common}>
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/**
 * "23:40" — la lecture minutes:secondes du lecteur. Elle se passe d'unite
 * comme d'icone : posee dans son cadre, au coin de la vignette, elle occupe la
 * place ou une duree se lit sur n'importe quelle carte video.
 */
function humanRuntime(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* Ces deux composants s'abonnent EUX-MEMES aux remontees du lecteur et
   ecrivent dans le DOM par une ref, sans passer par un state. C'est
   deliberé : le lecteur emet toutes les 3 s, et faire re-rendre la liste
   entiere a ce rythme se paie cher des qu'un anime compte plusieurs
   centaines d'episodes. Ici seul l'episode en cours ecoute, et il ne touche
   que ses deux noeuds. */

/** Barre de progression posee sur la vignette : elle avance PENDANT la
 *  lecture, et se remplit quand l'episode est fini. */
function ProgressBar({
  aniId,
  episode,
  live,
  width,
}: {
  aniId: number | string;
  episode: number;
  live: boolean;
  width: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!live) return;
    const onTick = (e: Event) => {
      const d = (e as CustomEvent<ProgressTick>).detail;
      if (!d || String(d.aniId) !== String(aniId)) return;
      if (Number(d.episode) !== Number(episode)) return;
      if (!ref.current || !(d.duration > 0)) return;
      // `time: -1` = remontee de duree seule (le fichier vient d'etre charge),
      // sans position a montrer : la barre n'a rien a en faire.
      if (d.time < 0) return;
      ref.current.style.width = `${Math.min(100, (d.time / d.duration) * 100)}%`;
    };
    window.addEventListener(PROGRESS_EVENT, onTick);
    return () => window.removeEventListener(PROGRESS_EVENT, onTick);
  }, [aniId, episode, live]);
  return (
    <span
      ref={ref}
      className="absolute bottom-0 left-0 h-[3px]"
      style={{
        width,
        background: ACCENT,
        // Les remontees arrivent par paliers de 3 s ; la transition rattrape
        // l'intervalle, sinon la barre sauterait au lieu d'avancer.
        transition: "width 1s linear",
      }}
    />
  );
}

/**
 * La vignette d'un episode, et la plaque qui respire a sa place tant qu'elle
 * n'est pas arrivee. Un composant a elle seule pour ce seul etat : c'est la
 * seule chose de la carte qui ait besoin d'un state, et le tenir ici evite de
 * refaire rendre la liste entiere a chaque image qui se pose.
 */
function Thumb({ src, blurred }: { src: string; blurred: boolean }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {/* Sous l'image, pas a la place : elle s'efface par-dessus la plaque, sans
          le vide d'une frame entre les deux. */}
      {!loaded && <div className="as-epskel absolute inset-0 rounded-lg" />}
      <Image
        src={src}
        alt=""
        draggable={false}
        /* La taille REELLE de la vignette, pas celle de la source. Le panneau
           fait 33rem au plus large, la vignette 42% : ~224px. Avec 496 annonces,
           `next/image` servait un fichier de 496px de large — et son 2x, un de
           992 — pour une case de 224 : cinq a vingt fois les octets
           necessaires, sur une liste qui en charge des centaines. C'est ce qui
           les faisait arriver en retard quand on descend vite. */
        width={224}
        height={126}
        /* 60 plutot que les 75 par defaut : un quart d'octets en moins, et a
           cette taille la difference ne se voit pas. */
        quality={60}
        onLoad={() => setLoaded(true)}
        /* AUCUN filtre ici, et c'est la regle : un `filter` promeut l'image sur
           sa propre couche, que le navigateur rasterise une fois puis ETIRE
           pendant le `scale` du survol — l'image partait floue et ne redevenait
           nette qu'a la fin du mouvement. L'assombrissement de l'episode en
           cours passe donc par un voile pose au-dessus, pas par `brightness`.
           L'arrondi reste porte par l'image elle-meme : le rognage du parent
           perd son anticrenelage des que la couche est composee.
           (`blur-lg` est l'exception assumee : masquer un spoiler EST un
           filtre, et cette carte-la ne grandit pas plus mal qu'une autre.) */
        className={`h-[110px] w-full rounded-lg object-cover transition-opacity duration-200 ${
          loaded ? "opacity-100" : "opacity-0"
        } ${blurred ? "blur-lg" : ""}`}
      />
    </>
  );
}

/**
 * Duree de l'episode, par ordre de fiabilite :
 *
 *   1. l'episode EN COURS la tient du lecteur lui-meme, en direct ;
 *   2. notre base, pour L'ENCODAGE DE CE LECTEUR (`hostKnown`) — une mesure
 *      faite sur le fichier, sur l'hote exact, partagee entre tous les
 *      visiteurs ;
 *   3. un episode deja ouvert sur cet appareil l'a laissee dans le store de
 *      reprise ;
 *   4. les autres la demandent a AniSkip, directement depuis le navigateur —
 *      et seulement une fois la ligne A L'ECRAN (cf. lib/watch/episodeRuntime) ;
 *   5. a defaut, la moyenne annoncee par AniList, precedee d'un "~" pour ne
 *      pas faire passer une estimation pour la duree du fichier.
 *
 * Pourquoi la base passe DEVANT le store de reprise, alors que les deux sont des
 * mesures de fichier : le store est indexe par (anime, episode) et ignore le
 * LECTEUR. Un episode regarde hier sur sibnet y a laisse la duree de l'encodage
 * sibnet ; si on est aujourd'hui sur ansembed, c'est la duree d'un autre fichier.
 * La base, elle, est indexee par hote — c'est le bon encodage par construction.
 */
function Runtime({
  aniId,
  episode,
  malId,
  server,
  live,
  known,
  hostKnown,
  done,
  doneLabel,
  anchor,
  estimate,
  onMeasured,
}: {
  aniId: number | string;
  episode: number;
  malId?: number | string | null;
  /** Lecteur actif — la duree remontee lui est attribuee. */
  server?: string | null;
  live: boolean;
  known: number | null;
  /** Duree stockee pour cet episode SUR CE LECTEUR, ou null. */
  hostKnown: number | null;
  /** Episode fini : la duree restante n'interesse plus personne. */
  done: boolean;
  /** Libelle traduit du "Terminé" — le composant n'a pas de `t` a lui. */
  doneLabel: string;
  /** Duree de reference de la saison — cf. `anchorOf` plus bas. */
  anchor: number | null;
  estimate: string | null;
  onMeasured: (episode: number, seconds: number, fromPlayer: boolean) => void;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  // La provenance compte autant que la valeur : une duree lue dans le fichier
  // ne se discute pas, une duree participative se recale (voir plus bas).
  const [exact, setExact] = useState<{ s: number; player: boolean } | null>(
    hostKnown != null
      ? { s: hostKnown, player: true }
      : known != null
        ? { s: known, player: true }
        : null,
  );

  // 1. Le lecteur, pour l'episode en cours.
  useEffect(() => {
    if (!live) return;
    const onTick = (e: Event) => {
      const d = (e as CustomEvent<ProgressTick>).detail;
      if (!d || String(d.aniId) !== String(aniId)) return;
      if (Number(d.episode) !== Number(episode)) return;
      if (!(d.duration > 0)) return;
      setExact((prev) =>
        prev?.player && prev.s === d.duration ? prev : { s: d.duration, player: true },
      );
      /* Le fichier vient de dire sa duree, sur l'hote exact : c'est la mesure de
         reference, et elle est gratuite. On la remonte a la base quand elle
         diverge de ce qu'on avait — c'est tout le mecanisme de correction, celui
         qui rattrape un hote qui a re-encode sans jamais rien re-sonder a
         l'aveugle. Un episode stable n'ecrit rien (cf. reportHostRuntime). */
      reportHostRuntime(malId, episode, server, d.duration);
    };
    window.addEventListener(PROGRESS_EVENT, onTick);
    return () => window.removeEventListener(PROGRESS_EVENT, onTick);
  }, [aniId, episode, live, malId, server]);

  // 2. La base, quand elle arrive apres le premier rendu. Jamais sur la ligne en
  //    cours : celle-la a mieux, le lecteur en direct.
  useEffect(() => {
    if (live || hostKnown == null) return;
    setExact((prev) =>
      prev?.player && prev.s === hostKnown ? prev : { s: hostKnown, player: true },
    );
  }, [hostKnown, live]);

  // 4. AniSkip, differé jusqu'a ce que la ligne soit reellement a l'ecran.
  useEffect(() => {
    if (live || exact != null || malId == null || !ref.current) return;
    const cached = peekRuntime({ malId, episode });
    if (cached != null) {
      setExact({ s: cached, player: false });
      return;
    }
    // Un episode deja fini n'a plus rien a demander au reseau : son libelle ne
    // depend plus de sa duree. Sa valeur en cache, elle, reste bonne a prendre
    // — elle nourrit la reference de la saison.
    if (done) return;
    const el = ref.current;
    const ac = new AbortController();
    let fired = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (fired || !entries.some((en) => en.isIntersecting)) return;
        fired = true;
        io.disconnect();
        queueRuntime({ malId, episode }, ac.signal).then(
          (s) => s != null && setExact({ s, player: false }),
        );
      },
      /* La marge d'avance se prend sur le CADRE DEFILANT, pas sur la fenetre.
         Avec `root: null`, `rootMargin` elargit bien le rectangle de la fenetre
         mais pas le rognage des ancetres : une ligne encore sous le bas du
         panneau reste "hors champ" quoi qu'on annonce, et la duree ne partait
         chercher qu'une fois la ligne arrivee — trop tard quand on descend
         vite. Vise depuis le cadre, l'avance porte enfin.
         600px : deux ecrans de liste compacte, cinq cartes detaillees. */
      {
        root: el.closest("[data-eplist]"),
        rootMargin: "600px 0px",
      },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      ac.abort();
    };
  }, [episode, malId, live, exact, done]);

  // Toute mesure obtenue nourrit la duree de reference de la saison.
  useEffect(() => {
    if (exact) onMeasured(episode, exact.s, exact.player);
  }, [exact, episode, onMeasured]);

  /* Choix de la valeur affichee.
     - Le fichier lu par le lecteur ne se discute jamais.
     - Une valeur participative n'est retenue que si elle est PLAUSIBLE face a
       la reference de la saison. Deux mesures d'AniSkip nous ont menti de deux
       façons : 23:42 la ou le fichier fait 23:40 (bruit entre encodages), et
       23:40 sur l'episode 4 de Steins;Gate 0 la ou tous ses voisins — et le
       lecteur lui-meme — disent 23:56 (soumission mesuree contre une autre
       version). Les deux sont des ecarts de quelques secondes sur un metrage
       de saison : dans ce regime, la reference est plus sure que la valeur
       isolee, donc elle gagne.
     - L'exception est l'ecart FRANC : un episode double, un recap ou un
       special s'ecartent de dizaines de minutes, pas de secondes. Au-dela d'un
       quart du metrage de la saison, la valeur participative decrit un episode
       vraiment different et on la garde telle quelle.
     - Sans mesure du tout, la reference vaut mieux que la moyenne d'AniList,
       arrondie a la minute. */
  const genuinelyDifferent =
    exact != null && anchor != null && Math.abs(exact.s - anchor) > anchor * 0.25;
  const shown = exact?.player
    ? exact.s
    : anchor != null && !genuinelyDifferent
      ? anchor
      : (exact?.s ?? anchor);
  const text = shown != null ? humanRuntime(shown) : estimate;
  // Le <p> reste monte meme sans rien a dire : c'est lui que l'observateur de
  // visibilite surveille pour declencher la mesure.
  return (
    <p
      ref={ref}
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-[2px] font-outfit text-[11px] font-light tabular-nums"
      // L'episode qu'on est en train de regarder garde sa duree, meme s'il a
      // deja ete termine un jour : c'est celle-la qu'on veut sous les yeux
      // pendant une rediffusion.
      style={
        done && !live
          ? { color: T.green, borderColor: "rgba(45,212,122,0.35)" }
          : { color: T.txt3, borderColor: T.line2 }
      }
    >
      {done && !live ? (
        <>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            className="shrink-0"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {doneLabel}
        </>
      ) : (
        text
      )}
    </p>
  );
}

export default function EpisodeLists({
  info,
  map,
  providerId,
  watchId,
  episode,
  track,
  dub,
  server,
}: EpisodeListsProps) {
  // Watched-episode count for the "seen" bar. Source of truth must match the
  // rest of the app: the LOCAL list when sync is off / guest (the editor and
  // Hero read it there), and only fall back to AniList's mediaListEntry when
  // sync is ON. Reading AniList directly regardless of sync (the old behaviour)
  // painted every episode "watched" for a user whose AniList said COMPLETED
  // even though they never enabled sync and the site shows nothing.
  const syncEnabled = useSyncPrefs().enabled;
  const [localProgress, setLocalProgress] = useState<number | undefined>(
    undefined,
  );
  useEffect(() => {
    const aniId = Number(info?.id);
    if (!Number.isFinite(aniId)) return;
    const read = () => setLocalProgress(peekLocalEntry(aniId)?.progress);
    read();
    window.addEventListener(LOCAL_LIST_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(LOCAL_LIST_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [info?.id]);
  const progress = syncEnabled ? info.mediaListEntry?.progress : localProgress;

  /* Positions sauvegardees de CET anime (lib/watch/progress.ts), une lecture
     pour toute la liste. Elles portent aussi la duree reelle mesuree par le
     lecteur, episode par episode. On relit au changement d'episode : celui
     qu'on vient de quitter a sa position fraiche, et l'episode en cours, lui,
     avance en direct via <ProgressBar live>. */
  const [saved, setSaved] = useState<Record<string, ProgressEntry>>({});
  useEffect(() => {
    if (info?.id == null) return;
    setSaved(getAnimeProgress(info.id));
  }, [info?.id, watchId]);

  /* Un episode qui se termine sous nos yeux doit passer au vert sans attendre
     une navigation. `markComplete` (fin naturelle, bouton suivant, enchainement
     automatique) ecrit `time = duration` puis l'annonce : c'est ce palier-la
     qu'on guette, et lui seul — se relire a chaque remontee de position
     redeclencherait un rendu toutes les 3 s pour rien. */
  useEffect(() => {
    if (info?.id == null) return;
    const onTick = (e: Event) => {
      const d = (e as CustomEvent<ProgressTick>).detail;
      if (!d || String(d.aniId) !== String(info.id)) return;
      if (!(d.duration > 0) || d.time < d.duration) return;
      setSaved(getAnimeProgress(info.id));
    };
    window.addEventListener(PROGRESS_EVENT, onTick);
    return () => window.removeEventListener(PROGRESS_EVENT, onTick);
  }, [info?.id]);
  const hideSpoilers = useHideSpoilers();
  const { t } = useTranslation();
  const router = useRouter();

  const [view, setView] = useState<View>("detailed");
  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_KEY) as View | null;
    if (saved && VIEWS.includes(saved)) setView(saved);
  }, []);
  function pickView(next: View) {
    setView(next);
    window.localStorage.setItem(VIEW_KEY, next);
  }

  const [desc, setDesc] = useState(false);
  useEffect(() => {
    setDesc(window.localStorage.getItem(ORDER_KEY) === "desc");
  }, []);
  function toggleOrder() {
    setDesc((d) => {
      window.localStorage.setItem(ORDER_KEY, d ? "asc" : "desc");
      return !d;
    });
  }

  const [query, setQuery] = useState("");

  /* Ancrage sur l'episode en cours.
     La liste s'ouvrait en haut, ce qui ne sert que pour l'episode 1 : partout
     ailleurs il fallait aller chercher a la main la ligne qu'on est en train de
     regarder — et sur une longue serie, elle est hors de vue des l'ouverture.
     On repositionne donc le conteneur (jamais la fenetre : `scrollIntoView`
     aurait emporte la page avec lui) a chaque fois que la ligne visee peut
     avoir bouge — episode, vue, ordre, filtre. */
  const listRef = useRef<HTMLDivElement>(null);

  /* Separation en-tete / liste. Le trait plein etait la ligne de trop : il
     barrait le panneau meme quand la liste commencait a son sommet, avec rien
     a separer. A la place, l'en-tete porte une ombre douce, et seulement
     quand des cartes passent DESSOUS — la separation apparait au moment ou
     elle sert, et s'efface des qu'on revient en haut.
     L'attribut est pose a la main sur le noeud plutot que par un state : ce
     handler part a chaque cran de molette, et re-rendre une liste de plusieurs
     centaines de lignes a ce rythme se paierait cher. */
  const headRef = useRef<HTMLDivElement>(null);
  /* Le lecteur a-t-il place la liste lui-meme ? Des lors, plus rien ne la
     replace dans son dos — voir l'ancrage plus bas. `ancrageEnCours` distingue
     le defilement que l'ancrage vient de provoquer de celui d'un humain. */
  const dejaTouche = useRef(false);
  const ancrageEnCours = useRef(false);
  const onListScroll = useCallback(() => {
    if (!ancrageEnCours.current) dejaTouche.current = true;
    headRef.current?.toggleAttribute(
      "data-scrolled",
      (listRef.current?.scrollTop ?? 0) > 4,
    );
  }, []);
 
  /* Qui defile, la liste ou la page ? Personne ne l'arbitre ici : c'est le
     navigateur, comme pour la tuile de tags de la fiche anime, qui n'est elle
     aussi qu'un `overflow-y: auto`. Chrome verrouille un geste de molette sur
     le conteneur qu'il a commence a faire defiler — la liste sous le curseur
     garde son geste jusqu'au bout, un geste parti sur la page ne lui est pas
     vole en passant dessus — et il chaine au geste suivant. C'est exactement le
     comportement voulu, et trois tentatives de le reecrire (bascule d'overflow,
     relais de molette a la main) n'ont fait que lui nuire : ascenseur qui
     disparait, lissage natif perdu, butee qui arrete tout. Ne rien mettre ici
     est la bonne reponse. */

  /* La page suit la poignee de l'ascenseur de la liste.
     Le panneau est plus haut que la fenetre : son cadre commence en haut de
     l'ecran et se termine sous le pli. La poignee descend le long de CE cadre,
     donc en la trainant on finit par la pousser sous le bord de la fenetre et
     on defile a l'aveugle. Tant qu'on la tient pres d'un bord, la page glisse
     donc dans ce sens, ce qui ramene le reste du panneau dans l'ecran.
     Seulement en la TENANT, jamais a la molette : a la molette on regarde la
     liste, pas l'ascenseur, et deplacer la page sous les yeux de quelqu'un qui
     n'a rien demande est une surprise.

     Deux choses a savoir sur la poignee NATIVE, qui expliquent la forme de ce
     qui suit. Elle ne dit rien : pendant qu'on la traine, le navigateur ne
     transmet plus aucun `pointermove` a la page — la piloter au pointeur ne
     declenchait donc plus rien du tout. Et elle est tenue : le navigateur la
     replace sous le curseur, si bien qu'un rattrapage calcule pour la sortir
     d'un bord est defait aussitot — c'est cet aller-retour qu'on voyait vibrer.

     D'ou : une boucle de frames qui lit la position de la poignee et fait
     GLISSER la page a vitesse constante tant que celle-ci est dans la bande, au
     lieu de rendre l'ecart d'un coup. Le glissement eloigne la poignee du bord
     et s'arrete de lui-meme au bout d'une bande ; le mouvement de souris suivant
     la ramene et le relance. Chaque geste rend donc un glissement continu la ou
     il rendait un saut. */
  const thumbHeld = useRef<(() => void) | null>(null);
  const onListPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      /* Tient-on la poignee ? Le clic tombe-t-il au-dela de `clientWidth`, qui
         exclut la gouttiere de l'ascenseur alors que le rectangle de l'element
         la comprend. On mesure depuis ce rectangle et non avec `offsetX` : sous
         le pointeur il y a le plus souvent une ligne, et `offsetX` se compterait
         alors depuis elle. */
      const box = e.currentTarget;
      if (e.clientX - box.getBoundingClientRect().left < box.clientWidth) return;
      thumbHeld.current?.();

      let frame = 0;
      const tick = () => {
        frame = requestAnimationFrame(tick);
        const { scrollTop, scrollHeight, clientHeight } = box;
        if (scrollHeight <= clientHeight) return;
        /* Geometrie de la poignee native : sa taille est la part visible de la
           liste, sa position la meme part du chemin parcouru. Le plancher de
           24px est celui qu'appliquent les navigateurs sur les listes tres
           longues. */
        const thumbH = Math.max(24, (clientHeight / scrollHeight) * clientHeight);
        const thumbTop =
          box.getBoundingClientRect().top +
          (scrollTop / scrollHeight) * clientHeight;
        const below = thumbTop + thumbH - (window.innerHeight - THUMB_MARGIN);
        const above = THUMB_MARGIN - thumbTop;
        /* La vitesse croit avec l'ecart, sans plafond : jetee d'un coup tout en
           bas, la poignee se retrouve a plusieurs ecrans sous le pli, et la
           rattraper a vitesse constante donnait une page qui semblait coincee.
           Elle ne depasse jamais `d`, pour ne pas passer devant la poignee. */
        const rate = (d: number) => Math.min(d, THUMB_SPEED + d * 0.25);
        // `else if` : sur une liste a peine defilable la poignee est plus haute
        // que la fenetre moins ses deux bandes, et les deux bords depassent a la
        // fois. Suivre le bas est alors le bon choix, c'est le sens de lecture.
        if (below > 0) window.scrollBy(0, rate(below));
        else if (above > 0) window.scrollBy(0, -rate(above));
      };
      const release = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("pointerup", release);
        window.removeEventListener("pointercancel", release);
        thumbHeld.current = null;
      };
      thumbHeld.current = release;
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
      frame = requestAnimationFrame(tick);
    },
    [],
  );

  // Poignee relachee par la sortie du panneau : la boucle et ses trois
  // ecouteurs vivent sur `window`, ils ne partiraient pas d'eux-memes.
  useEffect(() => () => thumbHeld.current?.(), []);

  /* Season siblings, fetched after mount from the edge-cached route rather
     than resolved in the page's SSR — see /api/v2/seasons/[id]. A franchise
     with a single season returns one row (or none), and the picker hides. */
  const [seasons, setSeasons] = useState<SeasonRow[]>([]);
  useEffect(() => {
    const aniId = Number(info?.id);
    if (!Number.isFinite(aniId)) return;
    let alive = true;
    fetch(`/api/v2/seasons/${aniId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => alive && setSeasons(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [info?.id]);

  /* Menu de saisons maison plutot qu'un <select> natif : la liste porte un
     libelle ("Season 2 Part 2") et un sous-titre, et deux cours d'une meme
     saison partagent le meme `number` — "Saison 2" deux fois dans le natif.
     Meme rendu que le SeasonPicker de la page d'info. */
  const [seasonOpen, setSeasonOpen] = useState(false);
  const activeSeason = seasons.find((s) => String(s.id) === String(info?.id));
  useEffect(() => {
    if (!seasonOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSeasonOpen(false);
    const onClick = () => setSeasonOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [seasonOpen]);

  // Titles/images live in `map` (the provider's episode metadata); a run
  // without usable art falls back to number-only rows, as before.
  const hasArt = useMemo(
    () =>
      !!map?.some(
        (item: any) =>
          (item?.img || item?.image) &&
          !item?.img?.includes("https://s4.anilist.co/"),
      ),
    [map],
  );

  /* Les episodes pas encore diffuses ne sont pas montres.
     Le fournisseur liste les douze episodes annonces d'une saison en cours ; les
     quatre derniers n'existent pas encore et donnaient quatre tuiles noires,
     sans titre, avec une duree empruntee a la serie — un lien qui ne menait a
     rien. AniList dit lequel est le prochain a sortir (`nextAiringEpisode`),
     donc lui et tous ceux d'apres sortent de la liste, et la date d'attente se
     dit une seule fois, en pied de panneau, ou elle se lit vraiment.
     Le selecteur de saison NAVIGUE (il ne change pas la liste sur place), donc
     `info` decrit toujours la saison affichee : pas de risque d'appliquer ici la
     date d'une autre saison. */
  const prochainNumero = Number(info?.nextAiringEpisode?.episode);
  const sortis = useMemo(() => {
    const rows = episode ?? [];
    if (!Number.isFinite(prochainNumero)) return rows;
    return rows.filter((item) => Number(item.number) < prochainNumero);
  }, [episode, prochainNumero]);

  const first = sortis[0]?.number;
  const last = sortis[sortis.length - 1]?.number;
  /* Nombre de chiffres du plus grand numero de la liste. Il ne sert plus a
     AFFICHER les numeros — ils s'ecrivent nus, 1 puis 10 puis 100 — mais la
     recherche continue d'en avoir besoin : quelqu'un qui tape "007" cherche
     l'episode 7, et l'a peut-etre lu ecrit ainsi ailleurs. */
  const padTo = String(last ?? sortis.length ?? 1).length;

  /* Les donnees du fournisseur indexees par numero d'episode.
     Elles etaient retrouvees par un `find` dans le tableau, une fois par ligne
     rendue et une fois par ligne filtree — donc un balayage complet par
     episode. Sur douze episodes ça ne se voit pas ; sur les 1174 de One Piece
     ça fait plus d'un million de comparaisons a chaque inversion de l'ordre ou
     frappe dans la recherche, et c'est la que l'interface se figeait. Un index
     construit une fois rend la meme reponse en temps constant. */
  const byNumber = useMemo(() => {
    const index = new Map<any, any>();
    // Le premier gagne, comme `find` : deux entrees pour un meme numero
    // arrivent des fournisseurs qui listent un episode en double.
    for (const row of (map as any[]) ?? [])
      if (!index.has(row?.number)) index.set(row?.number, row);
    return index;
  }, [map]);

  /* Recherche et ordre d'affichage.
     Un chiffre se cherche comme un MOTIF, pas comme une valeur : taper "1"
     doit ramener 1, 01, 11, 21… — c'est ainsi qu'on cherche dans une liste
     numerotee, en tapant ce qu'on voit ecrit sur la vignette. Le motif est
     donc compare a la fois au numero nu et au numero pade, sinon "01" ne
     trouverait rien sur une serie a deux chiffres. Le texte, lui, se compare
     au titre affiche — celui du fournisseur — accents ignores : chercher un
     mot qu'on ne voit nulle part dans la liste ne rendrait service a
     personne. */
  const shown = useMemo(() => {
    let rows = sortis;
    const q = query.trim().toLowerCase();
    if (q) {
      const flat = (s: string) =>
        s.toLowerCase().normalize("NFD").replace(RE_DIACRITICS, "");
      const needle = flat(q);
      const digits = /^\d+$/.test(q);
      rows = rows.filter((item) => {
        if (digits) {
          const n = String(item.number);
          if (n.includes(q) || n.padStart(padTo, "0").includes(q)) return true;
        }
        const title = byNumber.get(item.number)?.title;
        return !!title && flat(String(title)).includes(needle);
      });
    }
    return desc ? [...rows].reverse() : rows;
  }, [sortis, byNumber, query, desc, padTo]);

  /* Rendu par tranches.
     Changer de vue ou inverser l'ordre reconstruisait les 1174 lignes de One
     Piece dans la meme frame que le clic : le bouton restait enfonce une
     seconde avant que quoi que ce soit ne bouge. Or personne n'a besoin de la
     ligne 900 a cet instant — on ne voit que le premier ecran.
     La liste repart donc a une tranche, ce qui est immediat, puis double a
     chaque frame jusqu'a tout contenir : six frames pour une serie de mille
     episodes, dont seule la premiere est devant les yeux de quelqu'un qui
     attend. Le doublement, plutot qu'un pas fixe, garde le total du travail du
     meme ordre de grandeur qu'un rendu unique.

     La remise a zero se fait PENDANT le rendu et non dans un effet : un effet
     s'execute apres, et la frame du clic aurait justement rendu la liste
     entiere — le mal qu'on cherche a eviter. */
  const [rendered, setRendered] = useState(shown);
  const [budget, setBudget] = useState(CHUNK);
  if (rendered !== shown) {
    setRendered(shown);
    setBudget(CHUNK);
  }
  useEffect(() => {
    if (budget >= shown.length) return;
    const frame = requestAnimationFrame(() =>
      setBudget((b) => Math.min(shown.length, b * 2)),
    );
    return () => cancelAnimationFrame(frame);
  }, [budget, shown]);
  const visible = budget >= shown.length ? shown : shown.slice(0, budget);

  /* Ancrage sur l'episode en cours — la suite du commentaire de `listRef`.
     Pose ici, apres le rendu par tranches, parce qu'il en depend : la ligne
     visee peut n'arriver qu'a une tranche plus tard. */
  /* L'ancrage est un geste D'ARRIVEE : il place la liste une fois, quand ce
     qu'elle montre change (episode, vue, ordre, filtre). Passe ça, la position
     appartient au lecteur.
     Il repartait pourtant a chaque reprise du budget de rendu — or ce budget
     redemarre des que la liste change d'identite, ce que font les durees quand
     elles remontent, c'est-a-dire au moment ou la liste revient a l'ecran. On
     se retrouvait donc ramene aux premiers episodes apres avoir scrolle
     jusqu'aux derniers. Cette cle dit ce qui merite un ancrage ; une fois pose,
     on n'y revient plus. */
  const clefAncrage = `${watchId}|${view}|${desc}|${query}|${track?.playing?.number ?? ""}`;
  const ancre = useRef<string | null>(null);
  const clefPrecedente = useRef<string | null>(null);

  useEffect(() => {
    /* Nouvelle cle = la liste montre autre chose : l'ancrage redevient
       legitime, et le fait que le lecteur ait defile AVANT ne compte plus. */
    if (clefPrecedente.current !== clefAncrage) {
      clefPrecedente.current = clefAncrage;
      dejaTouche.current = false;
    }
    /* La regle qui prime sur tout le reste : si le lecteur a place la liste
       lui-meme, on ne la lui reprend pas. Peu importe ce qui a relance cet
       effet — durees qui remontent, tranche de rendu, props rafraichies : rien
       ne justifie de ramener quelqu'un aux premiers episodes alors qu'il
       lisait les derniers. */
    if (dejaTouche.current) return;
    /* Le reglage est lu ICI, a chaud, et non par `usePlayerPrefs` : ce hook
       rend d'abord les valeurs par defaut puis les vraies apres son propre
       effet — l'ancrage serait donc deja parti avant de savoir qu'il est
       desactive. Et il n'a rien a suivre en direct : seul compte son etat a
       l'instant ou la liste se replace. */
    if (!getPlayerPrefs().snapToCurrentEpisode) return;
    if (ancre.current === clefAncrage) return;
    /* Une frame d'attente : l'effet part avant que la liste ait sa mise en page
       definitive (la vue vient d'etre remontee, `key={view}`), et une mesure
       prise trop tot vise a cote. */
    const frame = requestAnimationFrame(() => {
      const box = listRef.current;
      const row = box?.querySelector<HTMLElement>("[data-playing]");
      if (!box || !row) return;
      /* Ecart mesure entre les deux rectangles, et non `row.offsetTop` : ce
         dernier se compte depuis l'`offsetParent`, qui n'est pas forcement le
         cadre defilant et n'inclut ni ses bordures ni la meme origine — d'ou
         une ligne qui tombait quelques pixels sous le haut. La difference des
         rectangles, elle, est exactement ce qu'il faut defiler.
         En HAUT du panneau, pas au centre : la ligne en cours devient la
         premiere qu'on lit, et tout ce qui suit — l'episode suivant, surtout —
         se trouve dessous, dans le sens de la lecture. */
      const delta =
        row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      /* Le defilement qui suit vient de nous, pas du lecteur : sans ce drapeau
         l'ancrage se declarerait lui-meme « touche par un humain » et ne se
         poserait jamais deux fois de suite. Il retombe a la frame suivante,
         une fois l'evenement `scroll` du navigateur passe. */
      ancrageEnCours.current = true;
      box.scrollTop = Math.max(0, box.scrollTop + delta);
      onListScroll();
      requestAnimationFrame(() => {
        ancrageEnCours.current = false;
      });
      ancre.current = clefAncrage; // pose : la position appartient au lecteur
    });
    return () => cancelAnimationFrame(frame);
    /* `budget` en dependance : la ligne en cours peut n'etre rendue qu'a une
       tranche plus tard, et l'ancrage n'aurait alors rien trouve. Il repasse
       donc a chaque tranche, mais seulement TANT QU'IL N'A PAS TROUVE — c'est
       la cle ci-dessus qui ferme la porte derriere lui. Meme raison pour
       `episode?.length` : la liste peut arriver apres. */
  }, [clefAncrage, episode?.length, budget]);

  /* Duree de reference de la saison, agregee au fil des mesures qui remontent
     des lignes. Elle sert deux fois : a combler les episodes que personne n'a
     mesures, et a recaler les valeurs participatives qui ne s'en ecartent que
     de quelques secondes (cf. <Runtime>).
     Les durees LUES DANS LE FICHIER priment : une seule d'entre elles suffit a
     fixer la reference, la ou il faut deux mesures participatives concordantes
     — le fichier, c'est ce que l'utilisateur va reellement regarder, alors
     qu'une soumission peut viser un autre encodage. */
  /* Durees mesurees sur l'encodage de CE lecteur, servies par notre base. Une
     seule requete pour la saison, cachee au CDN (cf. /api/v2/runtimes). Le
     compteur ne sert qu'a redessiner : les valeurs, elles, sont lues en direct
     par `peekHostRuntime` au rendu. */
  const [hostRuntimesTick, setHostRuntimesTick] = useState(0);
  useEffect(() => {
    if (info?.idMal == null || !server) return;
    let alive = true;
    loadHostRuntimes(info.idMal, server).then(() => {
      if (alive) setHostRuntimesTick((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [info?.idMal, server]);

  /* Lecteur de la table chargee ci-dessus. Le `tick` dans les dependances est ce
     qui fait relire les lignes une fois la reponse arrivee — les valeurs vivent
     dans un cache de module, pas dans un etat React. */
  const hostRuntimeOf = useMemo(
    () => (ep: number) => peekHostRuntime(info?.idMal, ep, server),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info?.idMal, server, hostRuntimesTick],
  );

  const measured = useRef<{
    id: unknown;
    rows: Map<number, { s: number; player: boolean }>;
  }>({ id: null, rows: new Map() });
  const [anchor, setAnchor] = useState<number | null>(null);
  const reportRuntime = useCallback(
    (ep: number, seconds: number, fromPlayer: boolean) => {
      // Les mesures appartiennent a UNE saison : changer d'anime sans vider la
      // table ferait recaler les episodes de la suivante sur le metrage de la
      // precedente.
      if (measured.current.id !== info?.id) {
        measured.current = { id: info?.id, rows: new Map() };
        setAnchor(null);
      }
      const prev = measured.current.rows.get(ep);
      // Ne jamais laisser une valeur participative effacer une mesure du fichier.
      if (prev?.player && !fromPlayer) return;
      measured.current.rows.set(ep, { s: seconds, player: fromPlayer });
      const all = [...measured.current.rows.values()];
      const fromFiles = all.filter((v) => v.player).map((v) => v.s);
      const pool = fromFiles.length ? fromFiles : all.map((v) => v.s);
      if (!fromFiles.length && pool.length < 2) return;
      pool.sort((a, b) => a - b);
      const median = pool[Math.floor(pool.length / 2)];
      setAnchor((old) => (old != null && Math.abs(old - median) < 1 ? old : median));
    },
    [info?.id],
  );

  /* L'episode en cours se reconnait a son NUMERO. `watchId` ne peut plus servir
     a ça : c'est devenu la cle de la liste de visionnage (`{aniId}-{num}`),
     alors que les lignes portent l'id du fournisseur ("animesama-ansembed-1").
     La comparaison echouait donc a tous les coups — plus de liseré, plus de
     vignette assombrie, et surtout plus rien pour designer la ligne qui doit
     suivre la lecture en direct. Le repli sur `watchId` reste pour le cas ou la
     navigation n'est pas encore resolue. */
  const playingNumber = Number(track?.playing?.number);

  function hrefFor(item: Episode) {
    return `/en/anime/watch/${info.id}/${providerId}?id=${encodeURIComponent(
      item.id,
    )}&num=${item.number}${dub ? `&dub=${dub}` : ""}`;
  }

  /* Per-episode facts shared by all three views. `barWidth` is the resume bar:
     the local watch position when we have one, else "fully watched" for
     everything at or below the list progress. */
  function factsFor(item: Episode) {
    /* La position vient de `aniscroll:progress`, la meme que celle qui fait
       reprendre la lecture. L'ancienne source (`artStorage[item.id]`) ne
       pouvait rien rendre : ce store est indexe par ID D'ANIME, jamais par id
       d'episode, donc la recherche echouait a tous les coups et la barre ne
       bougeait que pour les episodes deja comptes comme vus. */
    const store = saved[String(item.number)];
    const watched = progress !== undefined && progress >= item?.number;
    const prog =
      store && store.duration > 0
        ? Math.min(100, (store.time / store.duration) * 100)
        : 0;
    const mapData = byNumber.get(item.number);
    const parsedImage = mapData
      ? mapData?.img?.includes("null") || mapData?.image?.includes("null")
        ? info.coverImage?.extraLarge
        : mapData?.img || mapData?.image
      : info.coverImage?.extraLarge || null;
    return {
      mapData,
      parsedImage,
      watched,
      playing: Number.isFinite(playingNumber)
        ? item.number === playingNumber
        : item.id == watchId,
      // Fini = pleine. Un episode compte pour vu soit parce que la liste le
      // dit, soit parce que la position sauvegardee est arrivee au bout (le
      // lecteur ecrit time = duration a la fin de l'episode).
      barWidth: watched || prog >= 99.5 ? "100%" : `${prog}%`,
      title: hideSpoilers
        ? `${t("common.episode")} ${item?.number}`
        : fixApostrophes(mapData?.title) ||
          `${t("common.episode")} ${item?.number}`,
      /* Duree deja mesuree par le lecteur sur cet appareil, s'il y en a une ;
         <Runtime> se charge d'aller chercher les autres. Le "~" de l'estimation
         AniList evite de faire passer une moyenne de serie pour la duree du
         fichier. */
      /* Le seuil n'est pas cosmetique : `markComplete` retombe sur `duration =
         1` quand il termine un episode dont il ne connait pas la duree (passage
         a l'episode suivant avant que le fichier ait ete charge). Ces entrees
         existent dans les historiques deja constitues, et sans garde elles
         s'affichaient telles quelles — les "0:01" sur les episodes 02 et 03. */
      known: store && store.duration > 60 ? store.duration : null,
      /* Duree stockee pour CET encodage. Prime sur `known` ci-dessus, qui est
         une mesure de fichier elle aussi mais sans memoire du lecteur sur
         lequel elle a ete faite (cf. l'en-tete de <Runtime>). */
      hostKnown: hostRuntimeOf(item.number),
      /* "Fini" au sens du site : soit la liste de visionnage l'a compte, soit
         la position sauvegardee est arrivee au bout — ce que `markComplete`
         ecrit aussi bien a la fin naturelle de la video qu'au passage a
         l'episode suivant (bouton ou enchainement automatique). */
      done: watched || isCompleted(store),
      estimate: info?.duration
        ? `~${t("home.minutesShort", { count: info.duration })}`
        : null,
    };
  }

  /* One row's frame — the accent-tinted gradient + border the info page gives
     the episode you're on, plain surface otherwise. */
  function frame(playing: boolean) {
    return {
      borderColor: playing ? ACCENT_BORDER : T.line,
      background: playing ? ACCENT_ROW : T.bg2,
    };
  }

  return (
    /* `lg:h-full` + the flex chain below: the card stretches to whatever the
       page gives this column, and the scroll area — not the card — absorbs the
       overflow. `min-h-0` at each level because a flex item won't shrink below
       its content otherwise, which would push the scrollbar out of view.
       La LARGEUR marche pareil : elle etait figee ici (24rem/32rem), heritee de
       l'epoque ou la colonne de la page etait fixe elle aussi. Depuis que cette
       colonne est le reste (`1fr`), une largeur figee laissait le surplus en
       marge a droite — la page avait donc l'air decentree. */
    <div className={`${v2Styles.tokens} flex w-full shrink-0 flex-col gap-2 lg:h-full`}>
      <div
        className="rounded-xl border lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
        style={{ borderColor: T.line, background: "rgba(16,18,26,0.6)" }}
      >
        {/* ── Header: season · range · view mode ── */}
        <div
          ref={headRef}
          className="relative z-[1] flex shrink-0 items-center gap-2 px-2.5 py-2.5 transition-shadow duration-200 data-[scrolled]:shadow-[0_10px_14px_-10px_rgba(0,0,0,0.85)]"
        >
          {seasons.length > 1 && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSeasonOpen((o) => !o);
                }}
                className="bg-white/[0.04] text-[#f4f5f8] transition-colors hover:bg-white/[0.08] flex h-[26px] items-center gap-1.5 rounded-lg pl-2.5 pr-2 text-[11px] font-semibold outline-none"
              >
                <span className="max-w-[150px] truncate">
                  {activeSeason?.label || `${t("anime.season")} ${activeSeason?.number ?? 1}`}
                </span>
                <ChevronDownIcon
                  className="h-3 w-3 shrink-0 transition-transform"
                  style={{ transform: seasonOpen ? "rotate(180deg)" : "none" }}
                />
              </button>
              {seasonOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className={`${v2Styles.customScroll} absolute left-0 top-[calc(100%+6px)] z-30 max-h-[320px] min-w-[220px] overflow-y-auto rounded-xl border p-1 shadow-2xl`}
                  style={{ background: T.bg2, borderColor: T.line2 }}
                >
                  {seasons.map((s) => {
                    const rowActive = String(s.id) === String(info?.id);
                    const soon = s.status === "NOT_YET_RELEASED";
                    // Meme ligne que le selecteur de la page d'info, et
                    // desormais le meme code : cf. seasonSubtitle.
                    const sub = seasonSubtitle(t, s);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setSeasonOpen(false);
                          if (rowActive) return;
                          /* Une saison pas encore diffusee n'a pas d'episode 1 :
                             l'ouvrir dans le lecteur donnait une page qui
                             retombait sur les episodes de la saison en cours —
                             on croyait regarder la S3, on regardait la S2. Elle
                             mene donc a sa fiche, qui sait dire "Bientot" et
                             porte la date de sortie. */
                          if (soon) {
                            router.push(animeHref(s.id, "info"));
                            return;
                          }
                          /* Et l'id d'episode se derive de la saison CIBLE, pas
                             du fournisseur de celle qu'on quitte :
                             `${providerId}-1` fabriquait "animesama-ansembed-1",
                             l'id d'un episode d'un AUTRE anime. Meme forme que
                             partout ailleurs sur le site (Hero, accueil,
                             decouverte). */
                          router.push(
                            `/en/anime/watch/${s.id}/megaplay?id=megaplay-${s.id}-1&num=1${
                              dub ? `&dub=${dub}` : ""
                            }`,
                          );
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05]"
                        style={{
                          /* Rien d'inline sur une ligne inactive : le fond
                             accent de la ligne active passe devant la classe
                             de survol sans avoir a crier `!important`. */
                          background: rowActive ? ACCENT_SOFT : undefined,
                          color: rowActive ? ACCENT : soon ? T.txt3 : T.txt0,
                        }}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-[12.5px] font-semibold">
                            {s.label || `${t("anime.season")} ${s.number}`}
                          </span>
                          {sub && (
                            <span
                              className="text-[10.5px]"
                              style={{ color: T.txt3 }}
                            >
                              {sub}
                            </span>
                          )}
                        </span>
                        {rowActive && (
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            className="ml-auto shrink-0"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Meme cadre que le selecteur de saison et les deux boutons : les
              quatre elements de cet en-tete sont maintenant sur une seule
              ligne, et un libelle nu au milieu de trois pastilles bordees
              donnait une rangee bancale. */}
          <div className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 text-[#f4f5f8]">
            <span className="text-[11px] font-semibold">
              {t("anime.episodes")}
            </span>
            {first != null && last != null && (
              <span className="text-[11px] tabular-nums opacity-80">
                {first}–{last}
              </span>
            )}
          </div>

          {/* Recherche : elle occupe la place qui reste dans l'en-tete, entre le
              compte d'episodes et les deux boutons — pas de ligne dediee, pas
              de largeur figee. Numero ou titre, et elle FILTRE plutot que de
              sauter : sur une serie longue, voir les trois lignes qui
              correspondent vaut mieux que d'etre depose au milieu de mille
              autres. */}
          <div className="relative min-w-0 flex-1">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
              style={{ color: T.txt0 }}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("anime.searchEpisode")}
              aria-label={t("anime.searchEpisode")}
              className="bg-white/[0.04] text-[#f4f5f8] transition-colors hover:bg-white/[0.08] h-[26px] w-full rounded-lg pl-[26px] pr-2 text-[11.5px] outline-none placeholder:text-[#f4f5f8]/50"
            />
          </div>

          {/* Ordre de lecture. La fleche montre le sens ACTUEL, et l'infobulle
              annonce ce qu'un clic ferait. Volontairement SANS accent quand il
              est inverse : l'accent, sur cette page, ne designe que l'episode
              en cours — l'etaler sur un bouton d'affichage lui ferait perdre
              ce sens. */}
          <button
            type="button"
            onClick={toggleOrder}
            title={desc ? t("anime.sortDesc") : t("anime.sortAsc")}
            aria-label={desc ? t("anime.sortAsc") : t("anime.sortDesc")}
            className="bg-white/[0.04] text-[#f4f5f8] transition-colors hover:bg-white/[0.08] grid h-[26px] w-[28px] shrink-0 place-items-center rounded-lg"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: desc ? "scaleY(-1)" : "none" }}
            >
              <path d="M7 4v16M3 8l4-4 4 4" />
              <path d="M14 7h7M14 12h5M14 17h3" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => pickView(nextView(view))}
            title={`${t(VIEW_LABELS[view])} · ${t("anime.changeView")}`}
            aria-label={`${t(VIEW_LABELS[view])} · ${t("anime.changeView")}`}
            className="bg-white/[0.04] text-[#f4f5f8] transition-colors hover:bg-white/[0.08] grid h-[26px] w-[28px] shrink-0 place-items-center rounded-lg"
          >
            <ViewIcon view={view} />
          </button>
        </div>

        {/* ── List ──
            `relative` : l'ancrage sur l'episode en cours mesure `offsetTop`, et
            il lui faut ce conteneur comme reference — sinon la mesure part du
            haut de la page et on defile n'importe ou. */}
        <div
          key={view}
          ref={listRef}
          onScroll={onListScroll}
          onPointerDown={onListPointerDown}
          /* Repere pour les lignes : c'est ce cadre, et non la fenetre, qui
             sert de reference aux observateurs qui prennent de l'avance. */
          data-eplist=""
          className={`${v2Styles.customScroll} as-viewswap relative max-h-[60vh] overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1 ${
            view === "grid"
              ? /* content-start : le conteneur est `flex-1` donc plus haut que
                   ses lignes ; sans ca `align-content: stretch` etire les rangees
                   et laisse un trou beant entre l'ep 8 et l'ep 9. */
                "grid content-start grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-1.5 p-2.5"
              : view === "compact"
                ? "flex flex-col gap-1 p-2"
                : "flex flex-col gap-2 p-2"
          }`}
        >
          {!episode || episode.length === 0 ? (
            <Skeleton className="h-[86px] w-full rounded-[10px]" />
          ) : shown.length === 0 ? (
            <p
              className="px-2 py-6 text-center text-[12.5px]"
              style={{ color: T.txt3 }}
            >
              {/* Une saison dont AUCUN episode n'est encore sorti n'est pas une
                  recherche infructueuse — le pied de panneau dit deja quand le
                  premier arrive. */}
              {query.trim() ? t("anime.noEpisodeMatch") : t("anime.notReleased")}
            </p>
          ) : view === "grid" ? (
            visible.map((item) => {
              const f = factsFor(item);
              return (
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  title={f.title}
                  data-playing={f.playing ? "" : undefined}
                  onClick={f.playing ? (e) => e.preventDefault() : undefined}
                  /* Meme regle que les deux autres vues : la case en cours se
                     survole comme les autres, seul son curseur la distingue. */
                  /* Numero ecrit comme sur la vignette de la vue detaillee (voir
                     la vue liste) — la couleur, elle, reste celle de l'etat :
                     c'est le seul signal dont dispose une case qui n'affiche
                     que son chiffre. */
                  className={`grid aspect-square place-items-center rounded-lg border font-karla text-[17px] font-bold tabular-nums transition-all duration-300 ease-out hover:scale-[1.06] ${
                    f.playing
                      ? "as-eplive cursor-default"
                      : "hover:shadow-lg hover:ring-1 hover:ring-white"
                  }`}
                  style={{
                    borderColor: f.playing ? ACCENT_BORDER : T.line,
                    background: f.playing
                      ? ACCENT_CELL
                      : f.watched
                        ? WATCHED_CELL
                        : T.bg2,
                    color: f.playing
                      ? ACCENT
                      : f.watched
                        ? T.green
                        : T.txt1,
                  }}
                >
                  {item.number}
                </Link>
              );
            })
          ) : view === "compact" ? (
            visible.map((item) => {
              const f = factsFor(item);
              return (
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  title={f.title}
                  data-playing={f.playing ? "" : undefined}
                  onClick={f.playing ? (e) => e.preventDefault() : undefined}
                  /* L'episode en cours bouge comme les autres : une ligne inerte
                     au milieu de lignes vivantes se lit comme un bug. Son liseré
                     de survol reste rose, en plus intense (`as-eplive`) — le
                     blanc dit "cliquable", or on y est deja ; d'ou aussi le
                     curseur par defaut et le `preventDefault`, qui neutralise le clic sans
                     tuer le survol comme le ferait `pointer-events-none`. */
                  className={`flex min-h-[48px] items-center gap-3 rounded-lg border px-3 py-3 transition-all duration-300 ease-out hover:scale-[1.02] ${
                    f.playing
                      ? "as-eplive cursor-default"
                      : "hover:shadow-lg hover:ring-1 hover:ring-white"
                  }`}
                  style={frame(f.playing)}
                >
                  {/* Le numero est ecrit comme celui pose sur la vignette de la
                      vue detaillee — meme fonte, meme corps, meme graisse, meme
                      blanc. C'est le meme objet vu de trois facons ; le lire en
                      petit gris ici et en gros blanc la-bas ne se justifiait
                      pas. `tabular-nums` en plus, que la vignette n'a pas :
                      alignes en colonne, des chiffres de largeurs inegales se
                      voient.
                      Le numero s'ecrit nu — 1, 10, 100 — sans zeros de tete :
                      c'est ainsi qu'on nomme un episode a voix haute. La colonne
                      garde un plancher de 28px pour que les series courtes
                      restent alignees entre elles, et s'ouvre au-dela : une
                      largeur fixe laissait le numero d'une serie a quatre
                      chiffres deborder et coller le titre. */}
                  <span
                    className="min-w-[28px] shrink-0 text-center font-karla text-[17px] font-bold leading-none tabular-nums"
                    style={{ color: T.txt1 }}
                  >
                    {item.number}
                  </span>
                  <span
                    className="flex-1 truncate text-[13px] font-medium"
                    style={{ color: T.txt0 }}
                  >
                    {f.title}
                  </span>
                  {f.playing ? (
                    <span
                      className="shrink-0 text-xs font-semibold"
                      style={{ color: ACCENT }}
                    >
                      ●
                    </span>
                  ) : f.watched ? (
                    <span
                      className="shrink-0 text-xs font-semibold"
                      style={{ color: T.green }}
                    >
                      ✓
                    </span>
                  ) : null}
                </Link>
              );
            })
          ) : (
            visible.map((item) => {
              const f = factsFor(item);
              return (
                /* Carte reprise TELLE QUELLE de la prod : vignette large a
                   gauche, titre en gras italique, resume en dessous. Et son
                   survol, qui manquait ici : la carte grossit d'un poil, prend
                   un liseré blanc et une ombre — c'est ce mouvement qui dit
                   qu'une ligne est cliquable. L'episode en cours bouge pareil —
                   une carte inerte au milieu de cartes vivantes se lit comme un
                   bug — mais son liseré ne passe pas au blanc : `as-eplive`
                   garde l'accent, a la meme epaisseur. Restent son curseur par
                   defaut et son clic mort. */
                <Link
                  key={item.id}
                  href={hrefFor(item)}
                  data-playing={f.playing ? "" : undefined}
                  onClick={f.playing ? (e) => e.preventDefault() : undefined}
                  /* Pas de `scale-100` au repos : une transform, meme neutre,
                     compose l'element sur sa propre couche, et Chrome rogne
                     alors les coins arrondis sans anticrenelage — d'ou les
                     bords en escalier. La carte reste donc sans transform tant
                     qu'on ne la survole pas. */
                  className={`as-epcard bg-secondary group relative flex h-[110px] w-full rounded-lg transition-transform duration-300 ease-out hover:scale-[1.02] ${
                    f.playing ? "as-eplive cursor-default" : "cursor-pointer"
                  }`}
                >
                  <div className="relative h-[110px] w-[43%] shrink-0 overflow-hidden rounded-lg shadow-[4px_0px_5px_0px_rgba(0,0,0,0.3)] lg:w-[42%]">
                    {hasArt && f.parsedImage && (
                      <Thumb
                        src={f.parsedImage}
                        blurred={hideSpoilers && !f.playing}
                      />
                    )}
                    {/* L'episode en cours s'assombrit sous un voile plein, la
                        ou un `brightness` sur l'image aurait suffi : le voile
                        est un aplat, il ne cree pas de couche filtrée qui
                        flouterait la vignette pendant le `scale` du survol.
                        Meme rendu, meme opacite (70% de noir ~ brightness 30%). */}
                    {f.playing && (
                      <div className="pointer-events-none absolute inset-0 rounded-lg bg-black/70" />
                    )}
                    {/* Voile bas, pour que le numero tienne aussi sur une
                        image claire. */}
                    <div
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%]"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 100%)",
                      }}
                    />
                    <ProgressBar
                      aniId={info.id}
                      episode={item.number}
                      live={f.playing}
                      width={f.barWidth}
                    />
                    {/* Blanc franc, et non le gris des deux autres vues : ce
                        numero-la n'est pas pose sur l'aplat du panneau mais sur
                        une photo, sous un voile. Un gris qui recule proprement
                        d'un aplat sombre devient juste sale sur une image. */}
                    <span
                      className="absolute bottom-2 left-2 font-karla text-[17px] font-bold leading-none text-white"
                    >
                      {item.number}
                    </span>
                    {f.playing && (
                      <div className="absolute inset-0 grid place-items-center">
                        <svg
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="h-5 w-5 scale-[1.5]"
                        >
                          <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                        </svg>
                      </div>
                    )}
                  </div>

                  <div
                    /* Pas de gris pour l'episode en cours : son titre se lit
                       comme les autres. Il est deja designe par le liseré
                       accent, la vignette assombrie et l'icone de lecture —
                       l'eteindre en plus le faisait passer pour indisponible,
                       alors que c'est celui qu'on regarde. */
                    className="flex h-full w-full select-none flex-col gap-1.5 overflow-hidden p-3.5"
                  >
                    {/* Un titre long passe a la ligne au lieu d'etre coupe :
                        deux lignes tiennent dans la hauteur de la vignette, et
                        c'est la moitie des titres d'episodes. */}
                    <h1 className="line-clamp-2 font-karla text-[14px] font-bold italic leading-[1.3]">
                      {f.title}
                    </h1>
                    {/* La duree remplace le resume ("Episode 1" sous un titre
                        qui dit deja l'episode ne servait a rien) et se pose en
                        bas a droite, la ou une duree se lit sur n'importe
                        quelle carte video. */}
                    <div className="mt-auto self-end">
                      <Runtime
                        aniId={info.id}
                        episode={item.number}
                        malId={info?.idMal ?? null}
                        server={server}
                        live={f.playing}
                        known={f.known}
                        hostKnown={f.hostKnown}
                        done={f.done}
                        doneLabel={t("anime.episodeDone")}
                        anchor={anchor}
                        estimate={f.estimate}
                        onMeasured={reportRuntime}
                      />
                    </div>
                  </div>

                  {/* Liseré de l'episode en cours, pose en calque PAR-DESSUS la
                      carte : la vignette est collee au bord gauche, donc un
                      trait peint dans le fond passerait derriere elle. Et il
                      est trace en ombre INTERNE de ce calque plutot qu'en
                      `ring` — un ring est peint hors de la boite, sur le bord
                      exterieur du rayon, la ou Chrome escalade le trait d'un
                      pixel ; a l'interieur il suit exactement le meme arrondi
                      et sort net. */}
                  {f.playing && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-lg"
                      style={{ boxShadow: `inset 0 0 0 1.5px ${ACCENT}` }}
                    />
                  )}
                </Link>
              );
            })
          )}
        </div>

        {info?.nextAiringEpisode?.airingAt != null &&
          info?.nextAiringEpisode?.episode != null && (
            <ProchainEpisode
              airingAt={Number(info.nextAiringEpisode.airingAt)}
              number={Number(info.nextAiringEpisode.episode)}
            />
          )}
      </div>
    </div>
  );
}
