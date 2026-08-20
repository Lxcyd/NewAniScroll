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
import { peekLocalEntry, LOCAL_LIST_EVENT } from "@/lib/list/localList";
import { fixApostrophes } from "@/lib/text/apostrophes";
import {
  getAnimeProgress,
  isCompleted,
  PROGRESS_EVENT,
  ProgressEntry,
  ProgressTick,
} from "@/lib/watch/progress";
import { peekRuntime, queueRuntime } from "@/lib/watch/episodeRuntime";

type EpisodeListsProps = {
  info: AniListInfoTypes;
  map: any;
  providerId: string;
  watchId: string;
  episode: Episode[];
  track: any;
  dub: string;
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
  txt3: "#5e6478",
  green: "#2dd47a",
};
const ACCENT = "var(--brand-primary, #ff3b5c)";
const ACCENT_BORDER = `color-mix(in srgb, ${ACCENT} 40%, transparent)`;
const ACCENT_SOFT = `color-mix(in srgb, ${ACCENT} 12%, transparent)`;
const ACCENT_ROW = `linear-gradient(90deg, color-mix(in srgb, ${ACCENT} 6%, transparent), ${T.bg2})`;

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
 * Duree de l'episode, par ordre de fiabilite :
 *
 *   1. l'episode EN COURS la tient du lecteur lui-meme, en direct ;
 *   2. un episode deja ouvert sur cet appareil l'a laissee dans le store de
 *      reprise ;
 *   3. les autres la demandent a AniSkip, directement depuis le navigateur —
 *      et seulement une fois la ligne A L'ECRAN (cf. lib/watch/episodeRuntime) ;
 *   4. a defaut, la moyenne annoncee par AniList, precedee d'un "~" pour ne
 *      pas faire passer une estimation pour la duree du fichier.
 */
function Runtime({
  aniId,
  episode,
  malId,
  live,
  known,
  done,
  doneLabel,
  anchor,
  estimate,
  onMeasured,
}: {
  aniId: number | string;
  episode: number;
  malId?: number | string | null;
  live: boolean;
  known: number | null;
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
    known != null ? { s: known, player: true } : null,
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
    };
    window.addEventListener(PROGRESS_EVENT, onTick);
    return () => window.removeEventListener(PROGRESS_EVENT, onTick);
  }, [aniId, episode, live]);

  // 3. AniSkip, differé jusqu'a ce que la ligne soit reellement a l'ecran.
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
    const io = new IntersectionObserver((entries) => {
      if (fired || !entries.some((en) => en.isIntersecting)) return;
      fired = true;
      io.disconnect();
      queueRuntime({ malId, episode }, ac.signal).then(
        (s) => s != null && setExact({ s, player: false }),
      );
    });
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
  const onListScroll = useCallback(() => {
    headRef.current?.toggleAttribute(
      "data-scrolled",
      (listRef.current?.scrollTop ?? 0) > 4,
    );
  }, []);

  useEffect(() => {
    const box = listRef.current;
    const row = box?.querySelector<HTMLElement>("[data-playing]");
    if (!box || !row) return;
    // En HAUT du panneau, pas au centre : la ligne en cours devient la premiere
    // qu'on lit, et tout ce qui suit — l'episode suivant, surtout — se trouve
    // dessous, dans le sens de la lecture.
    box.scrollTop = Math.max(0, row.offsetTop - 8);
    onListScroll();
  }, [watchId, view, desc, query, episode?.length, track?.playing?.number]);

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

  const first = episode?.[0]?.number;
  const last = episode?.[episode.length - 1]?.number;
  /* Largeur du numero : autant de chiffres que le plus grand numero de la
     liste. 12 episodes donnent "01", 1120 donnent "0001" — les numeros
     restent alignes en colonne quelle que soit la longueur de la serie. */
  const padTo = String(last ?? episode?.length ?? 1).length;

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
    let rows = episode ?? [];
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
        const title = map?.find((i: any) => i.number === item.number)?.title;
        return !!title && flat(String(title)).includes(needle);
      });
    }
    return desc ? [...rows].reverse() : rows;
  }, [episode, map, query, desc, padTo]);

  /* Duree de reference de la saison, agregee au fil des mesures qui remontent
     des lignes. Elle sert deux fois : a combler les episodes que personne n'a
     mesures, et a recaler les valeurs participatives qui ne s'en ecartent que
     de quelques secondes (cf. <Runtime>).
     Les durees LUES DANS LE FICHIER priment : une seule d'entre elles suffit a
     fixer la reference, la ou il faut deux mesures participatives concordantes
     — le fichier, c'est ce que l'utilisateur va reellement regarder, alors
     qu'une soumission peut viser un autre encodage. */
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
    const mapData = map?.find((i: any) => i.number === item.number);
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
      pad: String(item.number).padStart(padTo, "0"),
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
       its content otherwise, which would push the scrollbar out of view. */
    <div className="w-full lg:h-full lg:max-w-sm xl:max-w-lg lg:w-[24rem] xl:w-[32rem] shrink-0 flex flex-col gap-2">
      <div
        className="rounded-xl border lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
        style={{ borderColor: T.line, background: "rgba(16,18,26,0.6)" }}
      >
        {/* ── Header: season · range · view mode ── */}
        <div
          ref={headRef}
          className="as-epbar flex shrink-0 items-center gap-2 px-2.5 py-2.5"
        >
          {seasons.length > 1 && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSeasonOpen((o) => !o);
                }}
                className="as-epbar-ctl flex h-[26px] items-center gap-1.5 rounded-lg pl-2.5 pr-2 text-[11px] font-semibold outline-none"
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
                  className="as-epscroll absolute left-0 top-[calc(100%+6px)] z-30 max-h-[320px] min-w-[220px] overflow-y-auto rounded-xl border p-1 shadow-2xl"
                  style={{ background: T.bg2, borderColor: T.line2 }}
                >
                  {seasons.map((s) => {
                    const rowActive = String(s.id) === String(info?.id);
                    const soon = s.status === "NOT_YET_RELEASED";
                    // Meme sous-titre que la page d'info : annee · nb d'episodes,
                    // repli sur le format quand ni l'un ni l'autre n'est connu.
                    // Et "Bientot" pour une saison qui n'a pas commence — la
                    // seule information qui compte pour elle.
                    const sub = soon
                      ? t("anime.notYetReleased")
                      : [s.year, s.episodes ? `${s.episodes} EP` : null]
                          .filter(Boolean)
                          .join(" · ") || (s.format ?? "");
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
                            router.push(`/en/anime/${s.id}`);
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
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${
                          rowActive ? "" : "as-epmenu-row"
                        }`}
                        style={{
                          background: rowActive ? ACCENT_SOFT : "transparent",
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
          <div className="as-epbar-badge flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg px-2.5">
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
              className="as-epbar-ctl h-[26px] w-full rounded-lg pl-[26px] pr-2 text-[11.5px] outline-none"
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
            className="as-epbar-ctl grid h-[26px] w-[28px] shrink-0 place-items-center rounded-lg"
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
            className="as-epbar-ctl grid h-[26px] w-[28px] shrink-0 place-items-center rounded-lg"
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
          className={`as-epscroll as-viewswap relative max-h-[60vh] overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1 ${
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
              {t("anime.noEpisodeMatch")}
            </p>
          ) : view === "grid" ? (
            shown.map((item) => {
              const f = factsFor(item);
              return (
                <Link
                  /* Clef prefixee par la vue : les trois branches rendent un
                     <Link> a la meme clef, donc React REUTILISE le meme noeud
                     d'une vue a l'autre et se contente d'echanger ses classes.
                     Avec `transition-all` dessus, le passage grille → cartes
                     animait tout, bordure comprise : la bordure de la grille
                     fondait vers le blanc en s'amincissant, et chaque carte
                     clignotait d'un liseré blanc — le meme que le survol.
                     Une clef differente par vue force un remontage : la
                     nouvelle vue s'affiche dans son etat final, sans tween. */
                  key={`grid-${item.id}`}
                  href={hrefFor(item)}
                  title={f.title}
                  data-playing={f.playing ? "" : undefined}
                  className={`grid aspect-square place-items-center rounded-lg border text-sm font-semibold transition-all duration-300 ease-out ${
                    f.playing
                      ? "pointer-events-none"
                      : "hover:scale-[1.06] hover:shadow-lg hover:ring-1 hover:ring-white"
                  }`}
                  style={{
                    borderColor: f.playing ? ACCENT_BORDER : T.line,
                    background: f.playing
                      ? ACCENT_SOFT
                      : f.watched
                        ? "rgba(45,212,122,0.06)"
                        : T.bg2,
                    color: f.playing
                      ? ACCENT
                      : f.watched
                        ? T.green
                        : T.txt0,
                  }}
                >
                  {item.number}
                </Link>
              );
            })
          ) : view === "compact" ? (
            shown.map((item) => {
              const f = factsFor(item);
              return (
                <Link
                  key={`compact-${item.id}`}
                  href={hrefFor(item)}
                  title={f.title}
                  data-playing={f.playing ? "" : undefined}
                  className={`flex min-h-[40px] items-center gap-3 rounded-lg border px-3 py-2.5 transition-all duration-300 ease-out ${
                    f.playing
                      ? "pointer-events-none"
                      : "hover:scale-[1.02] hover:shadow-lg hover:ring-1 hover:ring-white"
                  }`}
                  style={frame(f.playing)}
                >
                  <span
                    className="w-7 shrink-0 text-right text-[11px] tabular-nums tracking-[0.08em]"
                    style={{ color: T.txt3 }}
                  >
                    {f.pad}
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
            shown.map((item) => {
              const f = factsFor(item);
              return (
                /* Carte reprise TELLE QUELLE de la prod : vignette large a
                   gauche, titre en gras italique, resume en dessous. Et son
                   survol, qui manquait ici : la carte grossit d'un poil, prend
                   un liseré blanc et une ombre — c'est ce mouvement qui dit
                   qu'une ligne est cliquable. L'episode en cours grossit lui
                   aussi — une carte inerte au milieu de cartes vivantes se lit
                   comme un bug — mais garde son liseré accent, son curseur par
                   defaut, et son clic ne mene nulle part : on y est deja. */
                <Link
                  key={`detailed-${item.id}`}
                  href={hrefFor(item)}
                  data-playing={f.playing ? "" : undefined}
                  onClick={f.playing ? (e) => e.preventDefault() : undefined}
                  /* Pas de `scale-100` au repos : une transform, meme neutre,
                     compose l'element sur sa propre couche, et Chrome rogne
                     alors les coins arrondis sans anticrenelage — d'ou les
                     bords en escalier. La carte reste donc sans transform tant
                     qu'on ne la survole pas. */
                  className={`bg-secondary group relative flex h-[110px] w-full rounded-lg transition-transform duration-300 ease-out hover:scale-[1.02] ${
                    f.playing ? "cursor-default" : "cursor-pointer"
                  }`}
                >
                  <div className="relative h-[110px] w-[43%] shrink-0 overflow-hidden rounded-lg shadow-[4px_0px_5px_0px_rgba(0,0,0,0.3)] lg:w-[42%]">
                    {hasArt && f.parsedImage && (
                      <Image
                        src={f.parsedImage}
                        alt=""
                        draggable={false}
                        width={496}
                        height={280}
                        /* L'arrondi est porte par l'image ELLE-MEME, pas
                           seulement par le `overflow-hidden` du cadre : le
                           filtre `brightness` promeut l'image sur sa propre
                           couche, et le rognage du parent y perd son
                           anticrenelage. Arrondie a la source, elle sort
                           nette. */
                        className={`h-[110px] w-full rounded-lg object-cover transition-[filter] duration-300 ease-out ${
                          f.playing
                            ? "brightness-[30%]"
                            : "brightness-75 group-hover:brightness-100"
                        } ${hideSpoilers && !f.playing ? "blur-lg" : ""}`}
                      />
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
                    <span className="absolute bottom-2 left-2 font-karla text-[17px] font-bold leading-none text-white/90">
                      {f.pad}
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
                        live={f.playing}
                        known={f.known}
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
                  {f.playing ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-lg"
                      style={{ boxShadow: `inset 0 0 0 1.5px ${ACCENT}` }}
                    />
                  ) : (
                    /* Meme liseré, en blanc et au survol. Il est pose en calque
                       comme celui de l'episode en cours (et non en `ring`) pour
                       la meme raison : un ring peint hors de la boite escalade
                       le trait d'un pixel sur l'arrondi. On anime son opacite,
                       jamais sa presence — un trait qui apparait d'un coup se
                       lit comme un defaut de rendu. */
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-lg opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100"
                      style={{
                        boxShadow:
                          "inset 0 0 0 1.5px rgba(255,255,255,0.85), 0 6px 18px rgba(0,0,0,0.45)",
                      }}
                    />
                  )}
                </Link>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
