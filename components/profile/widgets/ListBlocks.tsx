import Image from "next/image";
import Link from "next/link";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { customListColor, listLabel, STATUS_TO_LIST } from "@/components/anime/v2/helpers";
import { genreLabel } from "@/lib/i18n/genreLabel";
import { blockOption, STATUS_KEYS } from "@/lib/profile/blocks";
import { previewAnchor } from "@/lib/preview/anchor";
import { useDragScroll } from "@/lib/ui/dragScroll";
import { useEdgeFade } from "@/lib/ui/edgeFade";
import { glideScrollBy } from "@/lib/ui/glideScroll";
import {
  CUSTOM_PREFIX,
  currentlyWatching,
  customListCounts,
  genreCounts,
  scoreBinValue,
  scoreSpread,
  showcaseFor,
  statusCounts,
  studioRanks,
  yearStats,
  type YearStat,
  STATUS_COLOR,
  type StatusKey,
} from "@/lib/profile/insights";
import type { ProfileEntry } from "@/lib/profile/types";
import { Bar, EmptyBlock } from "./common";

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

/* ── Favoris ─────────────────────────────────────────────────────────── */

/**
 * Une carte à peindre, et où elle en est de sa vie :
 *   `enter` — vient d'arriver, encore repliée (largeur nulle) ;
 *   `in`    — à sa place ;
 *   `out`   — s'en va, et referme la place derrière elle.
 */
type ShelfCard = { e: ProfileEntry; state: "enter" | "in" | "out" };

/** Le temps que dure la sortie — doit valoir la transition de `.as-fav-card`. */
const EXIT_MS = 320;

/**
 * COMBIEN D'AFFICHES LA VITRINE VA CHERCHER, **et seulement pour les favoris**.
 *
 * Elle en prenait vingt, puis soixante. Les deux chiffres avaient le même défaut,
 * et le second l'a caché au lieu de le corriger : sur une LISTE NOMMÉE —
 * « Terminés », des centaines de titres — la bande coupait au n-ième mieux noté
 * SANS LE DIRE. Curseur des notes ouvert de 0 à 10, on voyait la bande finir sur
 * un 8,5 et le réglage avait l'air de ne rien filtrer.
 *
 * Le plafond ne survit donc que là où il énonce la promesse du bloc : « les
 * favoris », dont le repli est « les mieux notés » et qui n'a de sens que borné.
 * Une liste nommée, elle, promet SON CONTENU : la montrer en partie, c'est
 * mentir sur le titre du widget. Elle passe entière (cf. l'appel à `showcaseFor`
 * plus bas) — le coût reste celui de ce qu'on regarde, puisque le défilement
 * horizontal laisse les affiches hors écran et que `next/image` ne va chercher
 * que celles-là.
 *
 * LA LEÇON, deux fois payée : un plafond qu'on remonte parce qu'il « se voyait »
 * ne cesse pas de couper, il cesse seulement de se voir sur l'exemple qu'on
 * avait sous les yeux.
 */
const SHELF_MAX = 60;

/**
 * Ce que la vitrine affiche PENDANT qu'elle change.
 *
 * React retire un nœud à l'instant où il quitte la liste, donc une carte qui
 * sort n'existe plus au moment où on voudrait l'animer. Ce hook garde la liste
 * précédente et la fusionne avec la nouvelle : les partantes restent montées,
 * marquées `out`, À LEUR PLACE — pas rejetées en fin de bande, sans quoi elles
 * traverseraient l'écran avant de disparaître — et ne sont retirées qu'une fois
 * l'animation finie.
 *
 * DEUX PIÈGES PAYÉS, et c'est pour eux que ce hook a la forme qu'il a.
 *
 * 1. UNE TRANSITION, PAS UNE KEYFRAME AU MONTAGE. Une `@keyframes` posée sur la
 *    classe se joue au montage du nœud, ce qui marche une fois — mais la carte
 *    apparaissait alors à sa taille finale et poussait ses voisines d'un coup
 *    sec avant de se fondre : à l'œil, c'est instantané. Les cartes naissent
 *    donc REPLIÉES (`enter`, largeur nulle) et sont dépliées à la frame
 *    suivante ; l'arrivée écarte ses voisines comme le départ les rapproche, et
 *    c'est ce déplacement, plus que le fondu, qui se voit.
 * 2. UNE SORTIE NE DOIT PAS ÊTRE ANNULÉE PAR LE CHANGEMENT SUIVANT. Tirer le
 *    curseur des notes envoie une nouvelle liste à chaque cran : la fusion
 *    précédente repartait des seules cartes présentes et JETAIT les partantes
 *    en vol, qui disparaissaient donc sans animation. Elles sont désormais
 *    reconduites d'une fusion à l'autre jusqu'à l'expiration de leur délai.
 *
 * Écrit ici plutôt que dans une bibliothèque d'animation : la vitrine est le
 * seul endroit du site qui en a besoin, et une dépendance de plus pour quarante
 * lignes de fusion de listes serait un mauvais échange.
 */
function useShelfTransition(shown: ProfileEntry[], resetKey = 0) {
  const [cards, setCards] = useState<ShelfCard[]>(() =>
    shown.map((e) => ({ e, state: "enter" as const })),
  );
  /* UNE AUTRE LISTE : la bande est remplacée d'un bloc, sans fusion. Le fondu
     est celui de la bande entière (cf. FavoritesBlock) — replier et déplier
     des centaines de cartes à la fois saccadait (25/10/2026, Luc).
     PENDANT LE RENDU, PAS DANS UN EFFET : fait dans un effet, le remplacement
     arrivait un rendu APRÈS la nouvelle `resetKey`, et `useShelfReflow`, qui
     avait déjà consommé la sienne, faisait glisser les cartes communes aux
     deux listes depuis leur ancienne place — « les cartes restent et se
     déplacent ». */
  const [seenReset, setSeenReset] = useState(resetKey);
  if (seenReset !== resetKey) {
    setSeenReset(resetKey);
    setCards(shown.map((e) => ({ e, state: "in" as const })));
  }

  useEffect(() => {
    setCards((prev) => {
      const nextIds = new Set(shown.map((e) => e.mediaId));
      const held = new Map(
        prev.filter((c) => c.state !== "out").map((c) => [c.e.mediaId, c]),
      );
      const merged: ShelfCard[] = shown.map((e) => {
        const old = held.get(e.mediaId);
        return old ? { ...old, e } : { e, state: "enter" };
      });
      // Les partantes — celles qui viennent de sortir de la liste comme celles
      // dont l'animation court encore — reprennent leur ancienne place.
      prev.forEach((c, i) => {
        if (nextIds.has(c.e.mediaId)) return;
        merged.splice(Math.min(i, merged.length), 0, { ...c, state: "out" });
      });
      const same =
        merged.length === prev.length &&
        merged.every(
          (c, i) => c.e.mediaId === prev[i].e.mediaId && c.state === prev[i].state,
        );
      // Rien n'a bougé : ne pas remplacer l'état, sinon cet effet se rappelle.
      return same ? prev : merged;
    });
  }, [shown]);

  // Le dépliage : une frame après leur montage, les arrivantes passent à `in`
  // et la transition CSS a enfin deux états entre lesquels aller. Deux rAF, pas
  // un — le premier rend la frame où la carte est repliée, le second la change.
  useEffect(() => {
    if (!cards.some((c) => c.state === "enter")) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        setCards((prev) =>
          prev.map((c) => (c.state === "enter" ? { ...c, state: "in" } : c)),
        ),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [cards]);

  // Le balayage des parties, une fois leur animation finie.
  useEffect(() => {
    if (!cards.some((c) => c.state === "out")) return;
    const timer = setTimeout(
      () => setCards((prev) => prev.filter((c) => c.state !== "out")),
      EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [cards]);

  return cards;
}

/* Même échange que dans RelationsGraph.tsx : React avertit pour un effet de mise
   en page pendant le rendu serveur, et le profil est en `getServerSideProps`. Il
   n'y a de toute façon rien à mesurer tant qu'aucun navigateur ne rend la bande. */
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * LE DÉPLACEMENT DES CARTES QUI RESTENT (technique dite « FLIP »).
 *
 * `useShelfTransition` n'anime que ce qui arrive et ce qui part. Tant que le
 * réglage ne faisait que RETIRER des cartes, ça suffisait : les survivantes
 * glissaient toutes seules, poussées par la place qui se referme devant elles.
 *
 * Mais dès que l'ORDRE change — la borne haute des notes qu'on descend, une
 * autre liste choisie, une note modifiée ailleurs dans le site — React déplace
 * le nœud d'un rang à l'autre, et la carte se TÉLÉPORTE : aucune propriété CSS
 * ne transitionne, puisque rien sur la carte n'a changé, c'est son voisinage qui
 * a bougé. C'est ce saut sec qu'on lit comme « il n'y a pas d'animation », même
 * quand l'entrée et la sortie, elles, fonctionnent.
 *
 * Le remède tient en trois temps : on retient la position d'avant (First), on
 * laisse le navigateur poser la nouvelle (Last), on remet la carte à son ancienne
 * place par une `transform` SANS transition, puis on la relâche à la frame
 * suivante — elle rejoint sa vraie place en glissant (Invert / Play).
 *
 * DEUX PRÉCAUTIONS QUI NE SONT PAS DU LUXE :
 *
 * 1. LIRE D'ABORD, ÉCRIRE ENSUITE. Lire `offsetLeft` force le calcul de mise en
 *    page ; l'entrelacer avec des écritures de style en forcerait un PAR CARTE.
 *    Maintenant qu'une liste nommée passe entière (des centaines d'affiches),
 *    ce détail est la différence entre un seul calcul et huit cents.
 * 2. ON NE TOUCHE QU'AUX CARTES `is-in`. Les arrivantes et les partantes portent
 *    déjà leur propre `transform` (repli, mise à l'échelle) : y superposer celle
 *    du FLIP effacerait leur animation au lieu de s'y ajouter.
 */
function useShelfReflow(
  /* La forme que rend `useDragScroll`, pas un `RefObject` strict : sa case est
     nullable, et c'est le même objet que la mesure de largeur reçoit. */
  rowRef: { current: HTMLDivElement | null },
  cards: ShelfCard[],
  /** Change à chaque autre liste : on note les positions sans rien faire
   *  glisser, la bande entière est déjà en train d'apparaître. */
  resetKey = 0,
  /** Pendant le fondu d'une liste à l'autre : aucune carte ne glisse. */
  frozen = false,
) {
  const previous = useRef(new Map<number, number>());
  const lastReset = useRef(resetKey);

  useIsoLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const reset = frozen || resetKey !== lastReset.current;
    lastReset.current = resetKey;
    const nodes = Array.from(
      row.querySelectorAll<HTMLElement>(".as-fav-card"),
    );

    // 1) Lecture seule : une seule mise en page pour toute la bande.
    const now = new Map<number, number>();
    const movers: Array<{ node: HTMLElement; dx: number }> = [];
    for (const node of nodes) {
      const id = Number(node.dataset.mediaId);
      if (!id) continue;
      const x = node.offsetLeft;
      now.set(id, x);
      const was = previous.current.get(id);
      if (!reset && was != null && was !== x && node.classList.contains("is-in")) {
        movers.push({ node, dx: was - x });
      }
    }
    previous.current = now;
    if (!movers.length) return;

    // 2) Écriture : chaque partante retourne d'où elle vient, sans transition.
    for (const { node, dx } of movers) {
      node.style.transition = "none";
      node.style.transform = `translateX(${dx}px)`;
    }

    // 3) Une frame plus tard, on lâche : la transition de `.as-fav-card` fait
    //    le reste. Le style inline est retiré, donc la carte retrouve ensuite
    //    exactement le comportement qu'elle avait sans ce hook.
    const frame = requestAnimationFrame(() => {
      for (const { node } of movers) {
        node.style.transition = "";
        node.style.transform = "";
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const { node } of movers) {
        node.style.transition = "";
        node.style.transform = "";
      }
    };
  }, [rowRef, cards, resetKey, frozen]);
}

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
    /* Les favoris sont bornés (cf. SHELF_MAX) ; une liste nommée passe entière,
       sans quoi le curseur des notes descendu à 0 ne rendrait toujours pas la
       liste complète — le défaut qu'on croyait réglé en montant le plafond. */
    () =>
      showcaseFor(
        entries,
        source,
        source === "favourites" ? SHELF_MAX : Infinity,
        [lo, hi],
        unrated,
      ),
    [entries, source, lo, hi, unrated],
  );
  const { ref, onClickCapture } = useDragScroll<HTMLDivElement>();

  /* UNE AUTRE LISTE = UN FONDU DE LA BANDE ENTIÈRE (25/10/2026, Luc : « laggy
     et buggé »). L'animation carte par carte replie et déplie des LARGEURS :
     pour quelques cartes (le curseur des notes) c'est fluide, pour une liste
     qui en remplace une autre — des centaines d'affiches — chaque image
     recalculait la mise en page de toute la bande. Ici seule l'opacité de la
     bande bouge, ce que le compositeur fait seul :
       out  — l'ancienne s'efface (FADE_MS) ;
       from — la nouvelle est posée, invisible, SANS transition, cartes
              recréées (cf. la clé plus bas) ;
       idle — elle apparaît. */
  const FADE_MS = 180;
  const [live, setLive] = useState(shown);
  const [resetKey, setResetKey] = useState(0);
  const [fade, setFade] = useState<"idle" | "out" | "from">("idle");
  const lastSource = useRef(source);
  const swapping = useRef(false);
  const latest = useRef(shown);
  latest.current = shown;
  // Le reste (curseur des notes, non notés) : la bande suit, carte par carte —
  // sauf pendant un fondu, qui prendra la dernière liste à son changement.
  useEffect(() => {
    // `source` pas encore pris en compte : c'est un changement de liste, que
    // l'effet suivant traite en fondu.
    if (!swapping.current && source === lastSource.current) setLive(shown);
  }, [shown, source]);
  useEffect(() => {
    if (source === lastSource.current) return;
    lastSource.current = source;
    swapping.current = true;
    setFade("out");
    let r1 = 0;
    let r2 = 0;
    const timer = setTimeout(() => {
      swapping.current = false;
      setLive(latest.current);
      setResetKey((k) => k + 1);
      setFade("from");
      if (ref.current) ref.current.scrollLeft = 0;
      r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setFade("idle"));
      });
    }, FADE_MS);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
      // Un nouveau choix pendant le fondu : il repart de là, rien ne reste figé.
      swapping.current = false;
    };
  }, [source, ref]);

  const cards = useShelfTransition(live, resetKey);
  useShelfReflow(ref, cards, resetKey, fade !== "idle");

  /* Les bords estompés, communs à tous les carrousels du site (cf.
     lib/ui/edgeFade.ts). Le nombre de cartes est passé en témoin : la bande
     s'allonge sans que sa boîte change de taille, ce qu'un ResizeObserver seul
     ne verrait pas. */
  const syncFades = useEdgeFade(ref, cards.length);

  /**
   * LA LARGEUR D'UNE CARTE, posée en `--as-fav-w` sur la bande.
   *
   * Elle vient du rapport 2:3 applique a la hauteur disponible : rien en CSS ne
   * la connait. La bande en a besoin DEUX FOIS — pour donner à chaque carte une
   * largeur définie (voir plus bas), et comme point d'arrivée de l'animation
   * (une carte qui grandit depuis zéro, une autre qui referme sa place).
   *
   * ON MESURE L'AFFICHE, PAS LA CARTE, et c'est tout le correctif.
   *
   * La carte n'a pas de largeur propre : elle la tient de son contenu, donc du
   * PLUS LARGE de ses deux éléments. L'affiche fait 2:3, mais un titre de six
   * mots est plus large qu'elle — et c'était alors LUI qui fixait la largeur de
   * la carte. D'où des cartes toutes différentes, écartées chacune à proportion
   * de la longueur de son titre : « I Became a Legend After My 10 Year-Long
   * Last… » poussait ses voisines bien plus loin que « Tomb Raider King ». Le
   * `w-0 min-w-full` du titre devait l'empêcher, mais il ne peut pas : un
   * pourcentage de largeur minimale se résout contre la largeur du parent, et
   * cette largeur-là n'existe pas encore quand le navigateur la calcule
   * justement à partir du contenu. Il n'y avait aucun moyen d'en sortir sans
   * donner à la carte une largeur qui ne vienne pas de son texte.
   *
   * L'affiche, elle, tient sa largeur de sa HAUTEUR par son rapport 2:3 — donc
   * du widget, et de rien d'autre. La mesurer donne la seule largeur honnête,
   * la même pour toutes les cartes, quel que soit le titre.
   *
   * Et cette mesure NE TOUCHE PLUS À LA CARTE. L'ancienne levait le plafond de
   * la carte, lisait sa largeur, puis le remettait — un aller-retour qui avait
   * déjà coûté un bug (une mesure forcée sur un élément qui transitionne lui
   * donne un style de départ qu'il n'avait pas, cf. devlog du 02/09). Lire
   * l'affiche ne demande rien de tout ça : sa largeur ne dépend ni du plafond
   * de la carte, ni de l'état de son animation.
   *
   * Mesurée ici et pas au défilement : elle coûte un calcul de mise en page
   * force, ce qui n'a rien à faire dans un gestionnaire de `scroll`.
   */
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const measure = () => {
      const poster = row.querySelector<HTMLElement>(".as-fav-poster");
      const w = poster?.offsetWidth ?? 0;
      if (w) row.style.setProperty("--as-fav-w", `${w}px`);
      syncFades();
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [ref, syncFades, cards]);

  if (!cards.length)
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
    /* Animé à la main (lib/ui/glideScroll.ts) : le `smooth` natif saute d'un
       coup quand le système réduit les animations. */
    if (el) glideScrollBy(el, dir * el.clientWidth * 0.8);
  };

  return (
    <div className="relative h-full">
      {/* LES FLÈCHES DU CARROUSEL DE RECOMMANDATIONS, dans l'en-tête du bloc.
          Elles sont posées en NÉGATIF au-dessus du contenu parce que l'en-tête
          appartient à la grille et non au bloc : le bloc ne reçoit que sa boîte
          de contenu, et remonter de 38 px l'amène au milieu du titre, à droite,
          là où le carrousel les met. */}
      {/* EN ÉDITION AUSSI, SOUS LA ROUE ET LE MOINS (25/10/2026, Luc), comme la
          flamme de « Vu récemment » : 6 px plus bas, pour ne pas toucher la
          roue, posée dans le coin de la carte. Le contenu est inerte en édition
          (WidgetGrid) : les flèches reprennent la main (`!pointer-events-auto`)
          et arrêtent le pointeur, sinon cliquer dessus attraperait la carte. */}
        <div
          className={`absolute ${editing ? "-top-[32px]" : "-top-[38px]"} right-0 z-10 flex gap-1.5`}
        >
          {[-1, 1].map((dir) => (
            <button
              key={dir}
              type="button"
              onClick={() => nudge(dir)}
              onPointerDown={editing ? (e) => e.stopPropagation() : undefined}
              aria-label={t(dir < 0 ? "anime.prev" : "anime.next")}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.06] text-white/60 ring-1 ring-white/10 transition-colors hover:bg-white/[0.12] hover:text-white !pointer-events-auto"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3">
                <polyline points={dir < 0 ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
              </svg>
            </button>
          ))}
        </div>

      <div
        ref={ref}
        onClickCapture={onClickCapture}
        onScroll={syncFades}
        /* La hauteur, le rembourrage et les marges de la bande sont dans
           `.as-fav-row` (globals.css) et pas ici : les trois se compensent au
           pixel pour déborder dans le rembourrage de la carte, et écrits en
           classes séparées ils invitaient à en changer une sans les autres —
           ce qui est précisément l'erreur qui a laissé une bande vide en bas. */
        className="as-fav-row as-fade-x as-noscroll flex cursor-grab select-none overflow-x-auto overflow-y-hidden"
        /* Le fondu d'une liste à l'autre (cf. `fade` plus haut). */
        /* Un fondu, rien d'autre : pas de glissement (Luc, 25/10/2026). */
        style={{
          opacity: fade === "idle" ? 1 : 0,
          transition: fade === "from" ? "none" : `opacity ${FADE_MS}ms ease`,
        }}
      >
        {cards.map(({ e, state }, i) => (
          <Link
            /* LA CLE EST L'ANIME, ET RIEN D'AUTRE. Une cle qui portait aussi le
               filtre remontait TOUTES les cartes a chaque reglage : les
               survivantes rejouaient leur entree pour rien, ce qui se voyait
               comme un clignotement general au lieu du depart de deux titres.
               Avec l'anime seul, React garde les noeuds communs — donc seules
               les cartes qui arrivent s'animent, et celles qui partent restent
               montees le temps de leur sortie (cf. useShelfTransition).
               SAUF D'UNE LISTE À L'AUTRE : `resetKey` change, TOUTES les cartes
               sont recréées — une carte commune aux deux listes restait en
               place puis glissait à son nouveau rang (25/10/2026, Luc : « fais
               juste un fade out et in »). */
            key={`${resetKey}:${e.mediaId}`}
            /* Lu par `useShelfReflow` pour reconnaître une carte d'un rendu à
               l'autre : la clé React n'est pas lisible depuis le DOM. */
            data-media-id={e.mediaId}
            /* Le décalage par rang ne sert qu'à L'ARRIVÉE, et il est plafonné :
               au-delà d'une douzaine de cartes on attendrait le dépliage de la
               dernière bien après avoir cessé de regarder. Ce qui part n'attend
               pas son tour (cf. `.as-fav-card.is-out`). */
            style={{ ["--as-fav-delay" as string]: `${Math.min(i, 12) * 22}ms` }}
            href={animeHref(e.mediaId, clickTarget)}
            draggable={false}
            aria-hidden={state === "out" || undefined}
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
            className={`as-fav-card group grid h-full shrink-0 gap-1.5 is-${state}`}
          >
            {/* PAS DE `shadow-poster` ICI. Cette ombre — 32 px de flou noir à
                55 % — est faite pour une affiche posée sur une page claire ou
                sur une illustration. Sur le fond presque noir d'un widget elle
                ne se lit pas comme une ombre mais comme une BOÎTE NOIRE autour
                de chaque affiche, d'autant plus visible que les affiches sont
                petites et serrées. */}
            <div
              /* `as-fav-poster` : c'est CE nœud que la mesure lit pour donner sa
                 largeur à toute la bande — sa taille ne vient que du rapport
                 2:3 et de la hauteur du widget, jamais du titre. */
              className="as-fav-poster relative h-full overflow-hidden rounded-xl as-clip-bg [--clip-bg:var(--surface-card,#1a1a24)] transition-transform duration-200 group-hover:scale-[1.03]"
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
            <p className="as-fav-title line-clamp-2 w-0 min-w-full font-semibold leading-[1.15] text-white">
              {pickTitle(e.title, titlePref)}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Répartition par statut ──────────────────────────────────────────── */

/**
 * Six statuts, ou les listes qu'on s'est inventées — un interrupteur, pas deux
 * blocs. La mise en page est la même et les deux répartitions ne se mélangent
 * jamais : leurs totaux ne se comparent pas (cf. `customListCounts`).
 *
 * TOUTES LES DIMENSIONS SONT DANS LA FEUILLE DE STYLE (`.as-status-list`,
 * globals.css), par requête de conteneur : le corps du texte, l'épaisseur des
 * barres, la pastille et l'écart entre deux lignes grandissent avec la carte.
 * Écrites ici en classes fixes, six lignes debordaient d'une carte de 1×1 et
 * flottaient en haut d'une carte de 2×2.
 *
 * LA BARRE N'A PLUS DE LARGEUR A ELLE. Elle en avait une — 96 px — donc elle
 * restait identique d'une carte de 300 px à une carte de 616, et tout
 * l'agrandissement partait dans le nom. Elle prend maintenant sa part de la
 * place libre, comme le nom : c'est elle qu'on lit, elle doit s'étirer.
 */
/**
 * LES LIGNES QUI ARRIVENT ET QUI PARTENT, pour une liste qui change (la
 * répartition, quand on coche ou décoche une liste — 25/10/2026, Luc).
 * Même principe que `useShelfTransition` : une ligne qui part reste montée,
 * marquée `out`, le temps de s'effacer ; une ligne qui arrive naît `enter`
 * (invisible, barre à zéro) et passe `in` deux images plus tard, pour que la
 * transition ait un point de départ.
 */
type Presence<T> = { item: T; key: string; state: "enter" | "in" | "out" };
/** Le fondu et le glissement d'une ligne de la répartition. */
const ROW_TRANSITION = "opacity 0.22s ease, transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)";
function usePresence<T>(items: T[], keyOf: (t: T) => string, outMs = 220): Presence<T>[] {
  const [list, setList] = useState<Presence<T>[]>(() =>
    items.map((item) => ({ item, key: keyOf(item), state: "in" as const })),
  );
  useEffect(() => {
    setList((prev) => {
      const next = items.map((item) => {
        const key = keyOf(item);
        const old = prev.find((p) => p.key === key && p.state !== "out");
        return { item, key, state: old ? old.state : ("enter" as const) };
      });
      const keys = new Set(next.map((p) => p.key));
      prev.forEach((p, i) => {
        if (!keys.has(p.key)) next.splice(Math.min(i, next.length), 0, { ...p, state: "out" });
      });
      // Rien n'a bougé (même lignes, mêmes états, mêmes valeurs) : garder l'état.
      const same =
        next.length === prev.length &&
        next.every(
          (p, i) => p.key === prev[i].key && p.state === prev[i].state && p.item === prev[i].item,
        );
      return same ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  useEffect(() => {
    if (!list.some((p) => p.state === "enter")) return;
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() =>
        setList((prev) => prev.map((p) => (p.state === "enter" ? { ...p, state: "in" } : p))),
      );
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [list]);
  useEffect(() => {
    if (!list.some((p) => p.state === "out")) return;
    const timer = setTimeout(
      () => setList((prev) => prev.filter((p) => p.state !== "out")),
      outMs,
    );
    return () => clearTimeout(timer);
  }, [list, outMs]);
  return list;
}

export function StatusesBlock({
  entries,
  lists = [...STATUS_KEYS],
}: {
  entries: ProfileEntry[];
  /**
   * Les listes cochées dans les réglages (25/10/2026) : clés de statut
   * (`CURRENT`…) et listes perso préfixées `custom:`. Les statuts d'abord, dans
   * l'ordre du site, puis les listes perso, la mieux fournie d'abord.
   */
  lists?: string[];
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const want = new Set(lists);
    const status = statusCounts(entries)
      .filter((r) => want.has(r.key))
      .map((r) => ({ ...r, custom: false }));
    const mine = customListCounts(entries)
      .filter((r) => want.has(`${CUSTOM_PREFIX}${r.key}`))
      .map((r) => ({ ...r, custom: true }));
    return [...status, ...mine];
  }, [entries, lists]);
  const custom = lists.length > 0 && lists.every((l) => l.startsWith(CUSTOM_PREFIX));

  /* COCHER / DÉCOCHER S'ANIME (25/10/2026, Luc) : la ligne cochée apparaît en
     fondu, sa barre pousse depuis zéro ; la décochée s'efface, puis disparaît,
     et ses voisines glissent refermer la place (FLIP sur `offsetTop`). */
  const shown = usePresence(rows, (r) => (r.custom ? `${CUSTOM_PREFIX}${r.key}` : r.key));
  const listRef = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<string, number>());
  useIsoLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const moved: Array<[HTMLElement, number]> = [];
    const now = new Map<string, number>();
    for (const row of Array.from(list.querySelectorAll<HTMLElement>("[data-row]"))) {
      const k = row.dataset.row!;
      now.set(k, row.offsetTop);
      const was = tops.current.get(k);
      if (was != null && was !== row.offsetTop) moved.push([row, was - row.offsetTop]);
    }
    tops.current = now;
    if (!moved.length) return;
    for (const [row, dy] of moved) {
      row.style.transition = "none";
      row.style.transform = `translateY(${dy}px)`;
    }
    // Forcer le calcul de la position de départ avant de relâcher (cf. le même
    // correctif dans « En cours de visionnage »).
    void list.offsetWidth;
    for (const [row] of moved) {
      // La transition de la ligne (fondu ET glissement), pas une chaîne vide :
      // vidée, elle effacerait aussi celle que React a posée.
      row.style.transition = ROW_TRANSITION;
      row.style.transform = "";
    }
  }, [shown]);

  if (!shown.length) {
    /* Deux vides pour deux raisons différentes : une liste vide n'a rien à
       répartir, une liste bien remplie peut n'avoir aucune liste personnalisée —
       et dans ce second cas le bloc doit dire ce qui lui manque, pas laisser
       croire que le compte est à zéro. */
    return (
      <EmptyBlock
        note={t(
          custom ? "profile.blocks.statuses.emptyCustom" : "profile.blocks.statuses.empty",
        )}
      />
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    /* DEUX BOÎTES, ET L'INTÉRIEURE A BESOIN DE SAVOIR COMBIEN DE LIGNES.
       L'extérieure défile et centre ; l'intérieure porte les lignes et se
       PLAFONNE. Le plafond vaut tant de pixels PAR LIGNE, donc il ne peut pas
       s'écrire sans leur nombre — le CSS ne sait pas compter ses enfants, d'où
       la seule chose que ce composant lui dise (cf. `--as-st-slot`, globals.css).

       PAS DE `content-start` : il calerait les lignes en haut et annulerait le
       partage de hauteur — c'est ce qui laissait un grand vide sous la
       dernière. */
    <div className="as-status-wrap as-widget-scroll grid h-full overflow-y-auto pr-1.5">
      <div
        ref={listRef}
        className="as-status-list grid"
        style={{ ["--as-st-n" as string]: shown.length }}
      >
        {shown.map(({ item: r, key, state }) => {
          const color = r.custom
            ? customListColor(r.key)
            : STATUS_COLOR[r.key as StatusKey] || "#6b7280";
          return (
            <div
              key={key}
              data-row={key}
              className="as-status-row"
              style={{
                opacity: state === "in" ? 1 : 0,
                transition: ROW_TRANSITION,
              }}
            >
              <span
                className="as-status-dot rounded-full"
                style={{ background: color, boxShadow: `0 0 10px ${color}55` }}
              />
              {/* LE NOM NE PREND QUE CE QU'IL LUI FAUT, et la barre prend tout
                  le reste. Il avait une part fixe de la ligne — 1,4 contre 1 —
                  donc « En cours » reservait la largeur de rien, et la barre
                  commencait au milieu de la carte pour aucune raison lisible.

                  Sa colonne se cale maintenant sur le PLUS LONG des noms
                  affiches, tous les autres compris (`subgrid`, globals.css) :
                  les barres restent alignees entre elles sans qu'aucune part ne
                  soit reservee d'avance. Le plafond en `ch` est pour les listes
                  personnalisees, dont le nom n'a pas de longueur connue. */}
              <span className="max-w-[16ch] truncate text-white/70">
                {r.custom ? r.key : listLabel(t, STATUS_TO_LIST[r.key] || r.key)}
              </span>
              <span className="as-status-bar min-w-0">
                <Bar pct={state === "in" ? (r.count / max) * 100 : 0} color={color} />
              </span>
              {/* `min-w` en `ch` et pas en pixels : la colonne des nombres reste
                  alignée à chaque palier sans qu'on ait à la re-mesurer, puisque
                  sa largeur suit le corps du texte. */}
              <span className="as-status-count min-w-[2.5ch] text-right font-karla font-bold text-white">
                {r.count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Notes attribuées ────────────────────────────────────────────────── */

/**
 * LA VIRGULE DÉCIMALE DE LA LANGUE COURANTE.
 *
 * Le bloc écrit des demi-points partout — sur son axe, dans ses infobulles, et
 * dans sa moyenne — et « 7.5 » au milieu d'une interface française se lit comme
 * une coquille. La séparation vient donc de la langue chargée, pas d'un
 * remplacement inconditionnel du point par une virgule : c'est ce que fait
 * `StudiosBlock` plus bas, et sa note s'écrit « 8,5 » jusque sur l'interface
 * anglaise.
 *
 * `Intl` n'est pas convoqué pour si peu : il faudrait lui interdire son
 * groupement des milliers, et un `Intl.NumberFormat` par rendu coûterait plus
 * cher que la ligne qu'il remplace.
 */
function useDecimal(): (n: number) => string {
  const { i18n } = useTranslation();
  const comma = (i18n.language || "").toLowerCase().startsWith("fr");
  return (n: number) => (comma ? String(n).replace(".", ",") : String(n));
}

/**
 * LA MOYENNE, DANS LE COIN DE L'EN-TÊTE.
 *
 * Même pilule que la série de jours de « Vu récemment » — même plateau opaque,
 * même bord gris, même centrage sur la ligne d'œil du titre (cf. `StreakBadge`,
 * DeviceBlocks.tsx, pour le pourquoi de chacun) : deux blocs qui posent un
 * chiffre au même endroit doivent le poser de la même façon.
 *
 * ELLE PORTE SON « / 10 ». Seule, « 8,4 » se lit aussi bien comme une moyenne
 * sur 5 que sur 100 — et l'histogramme sous elle est gradué de 1 à 10, donc
 * l'unité est écrite là où le doute naît. Le nombre est en or, la couleur des
 * notes partout ailleurs sur le site (`text-as-score`).
 *
 * L'UNITÉ EST AU MÊME CORPS QUE LE NOMBRE, et seule sa couleur la met en
 * retrait. Écrite plus petite, elle se lisait comme un exposant — « 6.9 » avec
 * une note de bas de page — au lieu d'une fraction. C'est le gris qui hiérarchise
 * ici, pas la taille.
 */
function AverageBadge({
  mean,
  rated,
  t,
  num,
}: {
  mean: number;
  rated: number;
  t: (k: string, o?: any) => string;
  num: (n: number) => string;
}) {
  return (
    <div
      /* Même noir translucide que la flamme de « Vu récemment » (24/10/2026). */
      className="as-score-avg absolute right-0 z-10 flex items-baseline gap-[0.22em] rounded-full bg-black/25 px-2.5 py-1.5 ring-1 ring-black/20"
      title={t("profile.blocks.scores.meanTitle", { count: rated })}
    >
      <span className="font-outfit font-bold leading-none text-as-score">
        {/* La virgule de la langue courante, comme l'axe juste dessous : deux
            décimales écrites de deux façons dans la même carte se liraient comme
            deux statistiques (cf. `useDecimal`). */}
        {num(mean)}
      </span>
      {/* TROIS ÉLÉMENTS ET PAS DEUX, pour que les deux espaces de la fraction
          soient ÉGALES PAR CONSTRUCTION. La barre oblique était collée au 10 par
          une espace fine, alors que sa gauche recevait l'écart de la pilule :
          « 6.9 / 10 » penchait à droite. Rendue comme un élément à part, elle
          reçoit le même écart des deux côtés — et cet écart est en `em`, donc il
          suit le corps du texte à chaque palier au lieu de valoir 4 px partout. */}
      <span className="font-outfit font-bold leading-none text-white/40">/</span>
      <span className="font-outfit font-bold leading-none text-white/40">10</span>
    </div>
  );
}

/**
 * L'ÉCHELLE DE L'HISTOGRAMME : un pas rond, et un sommet qui tombe dessus.
 *
 * Les barres montaient jusqu'au plus haut compte, ce qui ne dit RIEN — une barre
 * pleine hauteur vaut 3 titres sur un profil et 300 sur un autre, et rien à
 * l'écran ne distinguait les deux. Il fallait donc des graduations, donc des
 * valeurs rondes : personne ne lit une ligne posée à 37.
 *
 * Le pas vise le quart du plus haut compte — quatre lignes, ce qui reste lisible
 * sur une carte de 1×1 haute de ~120 px — arrondi au NOMBRE ROND immédiatement
 * supérieur. Les multiplicateurs sont ceux de toutes les échelles de graphe
 * (1, 2, 5, 10), plus 2,5 pour éviter qu'un maximum de 100 ne saute de 20 à 50 ;
 * il est écarté quand il donnerait un pas fractionnaire, des titres ne se
 * comptant pas par moitiés.
 *
 * Le sommet est le premier multiple du pas au-dessus du maximum : c'est ce qui
 * donne à la plus haute barre son peu de dégagement, et la place où poser son
 * compte au survol.
 */
export function scoreScale(max: number): { step: number; top: number; ticks: number[] } {
  const target = Math.max(1, max / 4);
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const steps = [1, 2, 2.5, 5, 10].map((m) => m * pow).filter(Number.isInteger);
  const step = steps.find((s) => s >= target) ?? steps[steps.length - 1];
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = step; v <= top; v += step) ticks.push(v);
  return { step, top, ticks };
}

/**
 * La distribution des notes du profil : une colonne par demi-point, leurs
 * graduations, et la moyenne dans le coin.
 *
 * TOUT CE QUI SE MESURE EST DANS LA FEUILLE DE STYLE (`.as-score-plot`,
 * `.as-score-avg`, globals.css), par requête de conteneur — l'écart entre deux
 * colonnes, le corps des chiffres, celui de la moyenne. Écrit ici en classes
 * fixes, l'histogramme gardait ses six pixels d'écart et ses graduations de
 * 10 px aussi bien sur une carte de 1×1 que sur une carte quatre fois plus
 * large, où elles devenaient illisibles de petitesse.
 *
 * En 1×1 c'est l'ÉCART qui rend la tenue possible : vingt colonnes dans 196 px
 * de contenu ne peuvent pas garder les 6 px d'origine — il ne resterait presque
 * rien pour les barres elles-mêmes.
 *
 * UNE GRILLE, PAS VINGT BOÎTES CÔTE À CÔTE. Les lignes de graduation doivent
 * traverser TOUTES les colonnes, écarts compris : posées dans chaque colonne
 * elles s'interrompraient entre deux barres. La grille donne une bande unique
 * qui les porte (`gridColumn: 2 / -1`), derrière les barres puisqu'elle est
 * déclarée avant elles.
 */
export function ScoresBlock({
  entries,
  /**
   * Ne compter que les titres terminés (cf. `scoreSpread`).
   *
   * SON DÉFAUT EST CELUI DU CATALOGUE, LU LÀ-BAS ET PAS RECOPIÉ ICI. Il était
   * écrit `false` — l'habitude du booléen qui commence éteint — alors que le
   * réglage du bloc, lui, est allumé par défaut (`OPTIONS.scores`,
   * lib/profile/blocks.ts). Deux défauts contradictoires, et l'onglet
   * « Statistiques », qui rend ce bloc sans lui passer de réglage, prenait le
   * mauvais : le même profil montrait deux distributions différentes selon
   * l'onglet.
   */
  completedOnly = blockOption("scores", "completedOnly", undefined),
  /* En réorganisation, le coin de l'en-tête appartient à la roue et au moins. */
  editing = false,
  /** Une colonne cliquée. Absent : les colonnes ne sont pas cliquables — c'est
   *  le cas du profil d'un autre, où il n'y a pas d'onglet où l'ouvrir. */
  onPick,
}: {
  entries: ProfileEntry[];
  completedOnly?: boolean;
  editing?: boolean;
  onPick?: (score: number) => void;
}) {
  const { t } = useTranslation();
  const num = useDecimal();
  const { bins, mean, rated } = useMemo(
    () => scoreSpread(entries, completedOnly),
    [entries, completedOnly],
  );
  if (!bins.length) {
    /* Deux vides pour deux raisons différentes : un profil sans aucune note n'a
       rien à répartir, un profil qui n'a noté que des titres en cours a bien des
       notes — et le bloc doit alors dire que c'est SON filtre qui les écarte,
       sinon le réglage reste introuvable. */
    return (
      <EmptyBlock
        note={t(
          completedOnly ? "profile.blocks.scores.emptyCompleted" : "profile.blocks.scores.empty",
        )}
      />
    );
  }
  const { top, ticks } = scoreScale(Math.max(...bins));

  return (
    /* DEUX BOÎTES, comme « Vu récemment » : la moyenne est posée au-dessus du
       contenu, dans l'en-tête, donc elle ne peut pas vivre dans la boîte qui
       porte les colonnes en `h-full`. */
    <div className="relative h-full">
      {!editing && mean != null ? (
        <AverageBadge mean={mean} rated={rated} t={t} num={num} />
      ) : null}
      <div
        className="as-score-plot grid h-full"
        style={{
          gridTemplateColumns: `auto repeat(${bins.length}, minmax(0, 1fr))`,
          gridTemplateRows: "minmax(0, 1fr) auto",
        }}
      >
        {/* LA COLONNE DES GRADUATIONS. Ses chiffres sont posés en absolu, à leur
            hauteur — ils ne comptent donc pas dans la largeur `auto` de la
            colonne, qui retomberait à zéro. D'où le gabarit invisible : la
            colonne prend la largeur du plus grand des nombres, sans qu'aucune
            valeur en pixels n'ait à être devinée ni re-réglée à chaque palier. */}
        <div className="relative" style={{ gridArea: "1 / 1 / 2 / 2" }}>
          <span className="invisible font-karla">{top}</span>
          {/* LE ZÉRO EST ÉCRIT, LUI AUSSI, et il n'a pourtant pas de ligne : la
              base du graphe EST sa ligne. Sans ce chiffre, l'axe commençait à sa
              première graduation — 20, 40, 60 — et rien ne disait où était
              l'origine ; une colonne minuscule pouvait alors se lire comme une
              colonne coupée en bas. */}
          {[0, ...ticks].map((v) => (
            <span
              key={v}
              /* L'échelle change avec le filtre : les graduations glissent avec
                 les barres plutôt que de sauter. */
              className="absolute right-0 translate-y-1/2 font-karla tabular-nums text-white/30 transition-[bottom] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ bottom: `${(v / top) * 100}%` }}
            >
              {v}
            </span>
          ))}
        </div>

        {/* LES LIGNES, sous les barres — déclarées avant elles, donc peintes
            avant elles : une ligne qui passerait par-dessus une barre la ferait
            paraître coupée en tranches. */}
        <div className="relative" style={{ gridArea: "1 / 2 / 2 / -1" }}>
          {ticks.map((v) => (
            <span
              key={v}
              aria-hidden
              className="absolute inset-x-0 border-t border-white/[0.07] transition-[bottom] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ bottom: `${(v / top) * 100}%` }}
            />
          ))}
        </div>

        {bins.map((n, i) => {
          /* UNE COLONNE PLEINE MÈNE À CE QU'ELLE COMPTE.
             « 38 titres à 7 » est une réponse qui appelle la question suivante —
             lesquels — et l'onglet « Ma liste » du profil sait déjà répondre :
             il est à deux pas, il a les mêmes entrées sous les yeux, et il n'y a
             donc rien à recharger.

             UN BOUTON, PAS UN LIEN : la destination est un ONGLET de cette même
             page, pas une URL (cf. `onPick`). Un lien promettrait une adresse à
             ouvrir dans un nouvel onglet du navigateur, et elle n'existe pas.

             UNE COLONNE VIDE N'EST PAS UN BOUTON : elle mènerait à une liste qui
             dit « aucun titre à cette note », ce qu'elle disait déjà elle-même
             en ne dessinant rien. */
          const clickable = n > 0 && !!onPick;
          const Tag = (clickable ? "button" : "div") as any;
          return (
            <Tag
              key={i}
              {...(clickable
                ? { type: "button", onClick: () => onPick(scoreBinValue(i)) }
                : {})}
              /* LE SURVOL PORTE SUR TOUTE LA COLONNE, pas sur la barre : viser
                 une barre de 15 px de large et de 4 % de haut — une note que
                 personne ne met — serait un jeu d'adresse. La zone sensible
                 monte donc du bas jusqu'au sommet du graphe. */
              /* `hover:z-20` : la colonne survolée passe DEVANT ses voisines,
                 son chiffre avec elle — sinon les colonnes peintes après
                 recouvraient la pastille qui dépasse sur elles. */
              className={`group relative flex items-end hover:z-20 ${clickable ? "cursor-pointer" : ""}`}
              style={{ gridRow: 1, gridColumn: i + 2 }}
              /* La colonne DIT SA NOTE, parce que l'axe n'en écrit qu'une sur
                 deux : sans ça, une barre entre le 6 et le 7 laisse le doute sur
                 ce qu'elle compte. Le survol donne le nombre, l'infobulle donne
                 la phrase entière. */
              title={t("profile.blocks.scores.barTitle", {
                score: num(scoreBinValue(i)),
                count: n,
              })}
            >
            {/* LE COMPTE, AU-DESSUS DE SA BARRE, et en absolu : ajouté dans le
                flux, il aurait raccourci la barre à l'instant du survol — la
                colonne se serait mise à bouger sous le curseur. */}
            {/* CENTRÉ SUR SA BARRE, SUR UNE PASTILLE (25/10/2026, Luc). Calé sur
                les bords de la colonne (`inset-x-0`), un « 28 » plus large
                qu'elle débordait d'un seul côté et chevauchait la barre
                voisine. `left-1/2` + translation le centre quelle que soit sa
                largeur, et `z-10` le pose sur les voisines. Sans fond : la
                pastille noire a été retirée (Luc, même jour). */}
            <span
              className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 -translate-y-1 whitespace-nowrap text-center font-karla font-bold tabular-nums text-white opacity-0 transition-[opacity,bottom] [transition-duration:150ms,500ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              /* Au doigt, pas de survol : les comptes restent affichés. */
              style={{ bottom: `${(n / top) * 100}%` }}
            >
              {n}
            </span>
            <div
              /* PAS DE DÉGRADÉ : L'ACCENT, PLEIN, SUR TOUTE LA HAUTEUR.
                 (Choisi sur planche, parmi vingt remplissages.)

                 Deux dégradés l'ont précédé, et chacun avait son défaut. Le
                 premier partait de l'orange du logo et s'éteignait à 15 %
                 d'opacité en bas : les petites barres — celles qui sont presque
                 entièrement faites de ce bas — disparaissaient dans le fond de
                 la carte, et une bannière claire derrière les effaçait tout à
                 fait. Le second, rose clair vers rose, ne s'effaçait plus mais
                 mettait une nuance là où il n'y a rien à nuancer : ce qui compte
                 dans une barre est sa HAUTEUR, et un dégradé vertical est
                 exactement la seule décoration qui entre en concurrence avec
                 elle.

                 LA COULEUR EST L'ACCENT LUI-MÊME, jamais un hexadécimal figé :
                 il est réglable (lib/prefs/accentColor.ts), et un rose écrit en
                 dur laisserait cet histogramme rose sur un profil passé au
                 bleu. */
              /* LA HAUTEUR S'ANIME (25/10/2026, Luc) : basculer « Terminés
                 uniquement » fait monter ou descendre chaque barre au lieu de
                 sauter. Pas sous `prefers-reduced-motion` : le Chrome de Luc
                 répond `reduce`. */
              className="as-score-bar w-full transition-[height,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:brightness-110"
              style={{
                background: "var(--brand-primary, #E94560)",
                /* UN PLANCHER EN PIXELS POUR CE QUI EXISTE, ET RIEN POUR CE QUI
                   N'EXISTE PAS. L'ancien plancher valait 4 % pour tout le monde,
                   y compris pour les notes que personne n'a mises : dix moignons
                   identiques alignés au bas du graphe, dont on ne pouvait pas
                   dire s'ils valaient zéro ou un. Une note jamais donnée n'a donc
                   plus de barre du tout, et une note donnée une fois garde 3 px,
                   sans quoi elle serait invisible sur une échelle qui monte
                   à 40. */
                height: n ? `max(3px, ${(n / top) * 100}%)` : "0px",
              }}
            />
            </Tag>
          );
        })}

        {/* LES NOTES DU BAS. Les demi-points sont écrits AUSSI, et DE LA MÊME
            COULEUR que les entiers : un 7,5 est une note comme les autres, pas
            une graduation secondaire. Écrits plus pâles, ils faisaient une
            seconde rangée sous la première — un axe à deux étages là où il n'y
            a qu'une échelle.

            MAIS PAS PARTOUT : « 0,5 » demande trois caractères, et vingt fois
            trois caractères ne tiennent pas sous une carte étroite ; ils s'y
            chevaucheraient au lieu de renseigner. La feuille de style les cache
            donc tant que la carte n'a pas la largeur de les porter
            (`.as-score-half`, globals.css), et les entiers suffisent alors à
            lire l'axe. Chaque chiffre reste posé sur SA colonne : le 7 désigne
            le 7, pas l'entre-deux du 6,5 et du 7. */}
        {bins.map((_, i) => {
          const v = scoreBinValue(i);
          const whole = Number.isInteger(v);
          return (
            <span
              key={i}
              /* CENTRÉ PAR FLEX, PAS PAR `text-center` (25/10/2026, Luc). La
                 colonne est souvent plus étroite que le chiffre (9 px en 1×1,
                 « 10 » en fait plus) : `text-center` laisse alors déborder le
                 texte d'un seul côté, à droite, et le chiffre glisse hors de
                 sous sa barre. Un flex centré déborde des DEUX côtés à parts
                 égales, donc reste dans l'axe de la barre. */
              /* Les demi-notes n'ont PAS la classe `flex` : elle passerait
                 devant le `display: none` de `.as-score-half`, qui les montre
                 lui-même en flex quand la carte est assez large. */
              className={`justify-center whitespace-nowrap pt-2 font-karla tabular-nums text-white/35 ${
                whole ? "flex" : "as-score-half"
              }`}
              style={{ gridRow: 2, gridColumn: i + 2 }}
            >
              {num(v)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ── Genres (radar) ──────────────────────────────────────────────────── */

/**
 * Un radar plutôt qu'un classement : la forme se compare d'un coup d'œil, ce
 * qu'une liste de barres ne permet pas. En SVG pur — aucune librairie de
 * graphes n'entre dans le bundle pour seize points.
 *
 * TOUT LE PROFIL, PAS SON PODIUM. Le radar montrait les huit premiers genres et
 * une liste chiffrée les répétait à côté. Deux défauts, et le second est le
 * vrai : la liste disait déjà tout ce que la figure disait, donc la moitié de la
 * carte servait à écrire ce que l'autre moitié dessinait ; et un radar tronqué à
 * huit branches n'est plus une SILHOUETTE mais un top 8 — les creux, qui sont ce
 * qu'une forme raconte de mieux, avaient été coupés avec les genres rares.
 *
 * Les chiffres reviennent donc AU BOUT DE LEUR BRANCHE, où ils nomment ce qu'ils
 * mesurent sans qu'on ait à faire l'aller-retour vers une légende.
 *
 * LE GRAPHIQUE SE MET À L'ÉCHELLE TOUT SEUL, et c'est pour ça que rien ici n'est
 * réglé par palier de carte (contrairement à « Notes ») : un `viewBox` est un
 * système de coordonnées, donc les corps de texte, les épaisseurs et les rayons
 * grandissent avec la carte dans le même rapport, sans une seule requête de
 * conteneur.
 */
/**
 * DES NOMBRES QUI GLISSENT vers leur cible en 500 ms (même courbe que les
 * barres de « Notes »). Une clé absente de l'état précédent part de 0. Le
 * premier rendu montre la cible directement : l'animation ne sert qu'aux
 * changements, pas à l'arrivée sur la page.
 */
function useTween(
  target: Record<string, number>,
  ms = 500,
  /** Le point de départ d'une clé qui n'existait pas (0 par défaut). */
  init: (key: string) => number = () => 0,
): Record<string, number> {
  const [live, setLive] = useState(target);
  const liveRef = useRef(target);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const from = { ...liveRef.current };
    const t0 = performance.now();
    const ease = (x: number) => 1 - Math.pow(1 - x, 3);
    let raf = 0;
    const step = (now: number) => {
      const k = ease(Math.min(1, (now - t0) / ms));
      const next: Record<string, number> = {};
      for (const key of Object.keys(target)) {
        const a = from[key] ?? init(key);
        next[key] = a + (target[key] - a) * k;
      }
      liveRef.current = next;
      setLive(next);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return live;
}

export function GenresBlock({
  entries,
  /* Le défaut vient du catalogue, pas d'un littéral : ProfileStats rend ce bloc
     sans réglages, et il doit montrer la même chose que la grille par défaut. */
  completedOnly = blockOption("genres", "completedOnly", undefined),
}: {
  entries: ProfileEntry[];
  completedOnly?: boolean;
}) {
  const { t } = useTranslation();
  /* Seize : ce qu'AniList compte de genres, moins les rarissimes. Ce n'est pas
     un classement tronqué mais une limite de lisibilité — au-delà, deux branches
     voisines sont à moins de 20° l'une de l'autre et leurs étiquettes se
     touchent. */
  /* LES BRANCHES SONT DANS L'ORDRE ALPHABÉTIQUE, PAS PAR TAILLE.
     C'était l'erreur de forme : classées par nombre, les grosses valeurs
     arrivaient toutes côte à côte et la figure devenait un LOBE unique poussé
     d'un seul côté, l'autre moitié du cercle restant plate. Un radar ne se lit
     pas comme ça — ce sont les pointes ET les creux, alternés, qui font une
     silhouette. L'ordre alphabétique les mélange, et il fait mieux : il est le
     MÊME sur tous les profils, donc deux radars se comparent. Un ordre par
     taille place « Action » à midi chez l'un et à sept heures chez l'autre, et
     deux formes identiques n'y voudraient plus rien dire de commun.

     Il suit le nom AFFICHÉ, donc la langue : le cercle se lit de A à Z tel qu'on
     le lit à l'écran. */
  const genres = useMemo(
    () =>
      genreCounts(entries, 16, completedOnly)
        .map((g) => ({ ...g, label: genreLabel(t, g.key) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [entries, completedOnly, t],
  );
  /* LA FORME GLISSE D'UN RÉGLAGE À L'AUTRE (25/10/2026, Luc). Un polygone SVG
     ne s'anime pas en CSS (`points` n'est pas une propriété), d'où une
     interpolation en JS, PAR GENRE : la part de chaque branche et son compte. */
  const target = useMemo(() => {
    const max = Math.max(1, ...genres.map((g) => g.count));
    const out: Record<string, number> = {};
    for (const g of genres) {
      out[`r:${g.key}`] = g.count / max;
      out[`n:${g.key}`] = g.count;
    }
    return out;
  }, [genres]);
  const live = useTween(target);

  if (genres.length < 3)
    return (
      <EmptyBlock
        note={t(
          /* Deux vides différents : la liste locale n'a jamais de genres, et le
             filtre peut n'avoir rien laissé. Le second se répare d'un clic sur
             la roue dentée, encore faut-il le dire. */
          completedOnly
            ? "profile.blocks.genres.emptyCompleted"
            : "profile.blocks.genres.empty",
        )}
      />
    );

  const n = genres.length;
  const cx = 100;
  const cy = 100;
  /* LE RAYON EST DONNÉ EN COORDONNÉES DU `viewBox`, donc ce qui compte n'est pas
     sa valeur mais son RAPPORT au corps du texte : c'est lui qui décide si la
     figure est une grande roue étiquetée ou un petit gribouillis cerné de mots.
     Il valait 62 pour un texte de 8,5 — la toile faisait quatorze fois la
     hauteur d'une étiquette, et la carte se lisait comme une liste de mots
     disposée en rond. À 100, elle en fait vingt-trois, le rapport de la
     maquette. */
  const R = 100;
  /** Le rayon des étiquettes : hors de la toile, sans s'en éloigner. */
  const RL = R + 14;
  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const point = (i: number, r: number) => {
    const a = angle(i);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };
  const shape = genres
    .map((g, i) => point(i, (live[`r:${g.key}`] ?? 0) * R).join(","))
    .join(" ");

  return (
    /* LE `viewBox` EST PLUS LARGE QUE LA TOILE, et c'est ce qui donne leur place
       aux étiquettes : la toile va de 0 à 200, la boîte de -92 à 292. La marge
       se mesure sur le PIRE des noms, celui de neuf heures, qui pousse vers la
       gauche depuis x=-14 — « Science-fiction », quinze signes, en fait environ
       64. En hauteur, de -36 (le nom de midi, posé AU-DESSUS de son compte) à
       238 (le compte de six heures, sous son nom).
       `meet` (le défaut) fait ensuite tenir le tout dans la carte quelle que
       soit sa forme, sans déformer. */
    <svg viewBox="-92 -36 384 274" className="h-full w-full">
      {/* LA TOILE EST FAITE DE CERCLES, plus de polygones. Un polygone à seize
          côtés dessine seize sommets de plus dans une figure qui en a déjà
          seize : les repères devenaient impossibles à distinguer de la mesure.
          Un cercle ne peut pas être confondu avec une forme. */}
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <circle
          key={f}
          cx={cx}
          cy={cy}
          r={R * f}
          fill="none"
          stroke="rgba(255,255,255,0.13)"
          strokeWidth="0.9"
        />
      ))}
      {genres.map((_, i) => {
        const [x, y] = point(i, R);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="rgba(255,255,255,0.09)"
            strokeWidth="0.9"
          />
        );
      })}

      {/* PAS DE PASTILLE AUX SOMMETS. Seize disques sur une ligne brisée de seize
          segments épaississent la figure sans rien ajouter : le sommet est déjà
          là où deux segments se rejoignent, et son étiquette le nomme. */}
      <polygon
        points={shape}
        fill="var(--brand-primary, #E94560)"
        fillOpacity="0.22"
        stroke="var(--brand-primary, #E94560)"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />

      {genres.map((g, i) => {
        const [x, y] = point(i, RL);
        const c = Math.cos(angle(i));
        /* L'ANCRAGE SUIT LE CÔTÉ : une étiquette de droite pousse vers la
           droite, celle de gauche vers la gauche, et celles du haut et du bas se
           centrent. Toutes centrées, les longues mordaient sur le cercle. */
        const anchor = c > 0.15 ? "start" : c < -0.15 ? "end" : "middle";
        /* LE BLOC « NOM + COMPTE » SE POSE DU CÔTÉ EXTÉRIEUR DE SA BRANCHE.
           Le nom était posé SUR le point et le compte dix unités dessous : en
           haut, le compte retombait dans la toile (« Action 112 » à cheval sur
           le cercle). La ligne de base suit maintenant le sinus : en haut le bloc
           entier monte au-dessus du point, en bas il descend dessous, sur les
           côtés il se centre sur lui. */
        const s = Math.sin(angle(i));
        return (
          <text
            key={g.key}
            x={x}
            y={y - 2 + s * 10.5}
            textAnchor={anchor}
            fontFamily="Karla, sans-serif"
            fontSize="8.5"
          >
            {/* Le nom traduit, comme partout ailleurs sur le site : AniList ne
                publie ses genres qu'en anglais, et `genreLabel` est la table qui
                les dit dans la langue de l'interface. La branche affichait la
                clé brute — « Slice of Life » au milieu d'une page en
                français. */}
            <tspan fill="rgba(255,255,255,0.75)">{genreLabel(t, g.key)}</tspan>
            {/* Le compte sous son nom, en couleur : c'est LUI qu'on cherche
                quand on lit une branche, et la ligne du dessus le nomme déjà. */}
            <tspan
              x={x}
              dy="11"
              fill="var(--brand-primary, #E94560)"
              fontWeight="700"
              fontSize="9"
            >
              {Math.round(live[`n:${g.key}`] ?? g.count)}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}

/* ── Années de sortie ────────────────────────────────────────────────── */

/** La couleur de la courbe : le bleu des formats, que le bloc remplace. */
const YEAR_LINE = "#3B82F6";
/** La largeur d'une année, en pixels. C'est elle qui décide de la longueur. */
const YEAR_STEP = 56;
/** La hauteur du dessin avant mesure, et son plancher : au-delà, c'est la carte
 *  qui la donne (cf. le `ResizeObserver` du bloc). */
const YEAR_H = 200;

/**
 * UNE COURBE, PAS DES BARRES, ET PAR ANNÉE, PAS PAR DÉCENNIE.
 *
 * Le bloc montrait deux choses — la répartition des formats en ruban, puis un
 * histogramme par décennie. Les décennies étaient le vrai défaut : dix ans dans
 * une colonne, c'est six barres pour toute une vie de visionnage, et la vague
 * que raconte une liste (le lycée, la pause, le retour) tombait entièrement dans
 * l'épaisseur d'une barre. Les formats, eux, tenaient de l'inventaire : trois
 * couleurs qui disent « surtout de la TV », ce que tout le monde sait déjà de sa
 * propre liste.
 *
 * L'année est la maille juste, et une ligne est la forme juste pour elle : c'est
 * une SÉRIE TEMPORELLE, donc des points reliés dans l'ordre, pas des catégories
 * côte à côte.
 *
 * ELLE SE DÉROULE, ELLE NE SE COMPRIME PAS. Chaque année vaut `YEAR_STEP`
 * pixels et le dessin déborde en défilement horizontal : trente ans écrasés dans
 * la largeur d'une carte donnent des étiquettes qui se chevauchent, et un
 * graphique qu'on ne peut plus lire ne vaut pas la place qu'il prend. Le SVG
 * n'a donc PAS de `viewBox` : ses coordonnées sont des pixels, les corps de
 * texte et les rayons restent ceux qu'on a choisis quelle que soit la carte.
 */
export function YearsBlock({
  entries,
  /* Les défauts viennent du catalogue, pas de littéraux : l'onglet
     « Statistiques » rend ce bloc sans réglages, et il doit montrer la même
     chose que la grille par défaut. */
  completedOnly = blockOption("years", "completedOnly", undefined),
  skipEmpty = blockOption("years", "skipEmpty", undefined),
}: {
  entries: ProfileEntry[];
  completedOnly?: boolean;
  skipEmpty?: boolean;
}) {
  const { t } = useTranslation();
  const years = useMemo(
    () => yearStats(entries, completedOnly, skipEmpty),
    [entries, completedOnly, skipEmpty],
  );
  /** L'année survolée, celle dont la bulle est ouverte, et la position de son
   *  point À L'ÉCRAN — la bulle est portée par `document.body` (cf. `YearTip`),
   *  donc elle se place en coordonnées de fenêtre et pas dans le dessin. */
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  /* Le même « attraper et tirer » que les carrousels du site — une frise se
     pousse à la souris, pas seulement à la molette. */
  const { ref } = useDragScroll<HTMLDivElement>();
  /* LA HAUTEUR DU DESSIN EST CELLE DE LA CARTE, MESURÉE.
     Elle était figée à 200 px : dans une carte plus basse, le SVG débordait et
     le navigateur ajoutait une barre VERTICALE — le graphique était coupé et il
     fallait le faire défiler en hauteur pour voir le sommet de sa propre
     courbe. Un graphique se déroule en longueur, jamais en hauteur : la seule
     réponse juste est de le dessiner à la taille qu'on lui donne. */
  const [box, setBox] = useState(YEAR_H);
  /* LA FRISE S'OUVRE SUR LA DERNIÈRE ANNÉE, pas sur la première. Ce qu'on vient
     voir est où on en est, et la fin d'une frise chronologique est le présent :
     ouverte à gauche, la carte montrait 1998 et il fallait tirer trente ans pour
     arriver à ce mois-ci. `useLayoutEffect` place le cadrage AVANT la peinture,
     sans quoi la frise s'afficherait au début puis sauterait. */
  /* Le cadrage sur la fin ne se fait qu'À L'OUVERTURE (`years.length` n'est
     plus une dépendance) : refait à chaque réglage, il ramenait la frise tout à
     droite au milieu de son animation — un des sauts signalés le 25/10/2026. */
  const n0 = years.length;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    /* La carte se redimensionne à la main, dans la grille : un observateur, pas
       une mesure au montage. */
    const ro = new ResizeObserver(() => setBox(el.clientHeight));
    ro.observe(el);
    setBox(el.clientHeight);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, n0 >= 3]);

  /* LA FRISE GLISSE D'UN RÉGLAGE À L'AUTRE (25/10/2026, Luc), pour les deux
     interrupteurs.

     PENDANT L'ANIMATION, ON MONTRE LES DEUX FRISES RÉUNIES : les années d'avant
     ET celles d'après, dans l'ordre chronologique. Une année qui part se replie
     entre ses voisines (son abscisse va à son point d'insertion dans la
     nouvelle frise) en tombant à zéro et en s'effaçant ; une année qui arrive
     se déplie depuis son point d'insertion dans l'ancienne. Les abscisses
     restent ainsi croissantes du début à la fin — plus de croisement de la
     courbe — et rien n'apparaît ni ne disparaît d'un coup.

     `snap` est mis à jour PENDANT le rendu, pas dans un effet : sinon le
     premier rendu avec les nouvelles années n'aurait pas encore l'ancienne
     frise, et celles qui arrivent clignoteraient à leur place finale. */
  const [snap, setSnap] = useState<{ years: YearStat[]; prev: YearStat[] | null }>({
    years,
    prev: null,
  });
  if (snap.years !== years) setSnap({ years, prev: snap.years });
  useEffect(() => {
    if (!snap.prev) return;
    const t = setTimeout(() => setSnap((s) => ({ ...s, prev: null })), 540);
    return () => clearTimeout(t);
  }, [snap]);

  const yearOf = (v: YearStat) => Number(v.key) || Number(v.label) || 0;
  /** L'abscisse d'une année dans une frise : la sienne si elle y est, sinon le
   *  milieu entre les deux voisines qui l'encadrent. */
  const posIn = (list: YearStat[], yr: number) => {
    let k = 0;
    while (k < list.length && yearOf(list[k]) < yr) k++;
    if (k < list.length && yearOf(list[k]) === yr) return YEAR_STEP / 2 + k * YEAR_STEP;
    return k * YEAR_STEP;
  };
  const display = useMemo(() => {
    const now = snap.years;
    const before = snap.prev ?? [];
    const seen = new Map<string, { stat: YearStat; alive: boolean }>();
    for (const v of before) seen.set(v.key, { stat: v, alive: false });
    for (const v of now) seen.set(v.key, { stat: v, alive: true });
    return [...seen.values()].sort((a, b) => yearOf(a.stat) - yearOf(b.stat));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap]);
  const target = useMemo(() => {
    const out: Record<string, number> = {
      max: Math.max(1, ...snap.years.map((v) => v.count)),
    };
    for (const d of display) {
      const yr = yearOf(d.stat);
      out[`x:${d.stat.key}`] = posIn(snap.years, yr);
      out[`c:${d.stat.key}`] = d.alive ? d.stat.count : 0;
      out[`a:${d.stat.key}`] = d.alive ? 1 : 0;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, snap]);
  const live = useTween(target, 500, (k) =>
    /* Une clé neuve : une année qui arrive part de son point d'insertion dans
       l'ANCIENNE frise, à zéro et invisible. */
    k.startsWith("x:") ? posIn(snap.prev ?? snap.years, Number(k.slice(2)) || 0) : 0,
  );
  /* Le fondu d'ouverture (`as-year-veil`) ne vaut qu'au premier affichage : une
     année ajoutée par un réglage le rejouait — invisible une demi-seconde, puis
     un saut. */
  const opened = useRef(false);
  useEffect(() => {
    opened.current = true;
  }, []);

  /* FILET : tant que la bulle est ouverte, tout mouvement du pointeur HORS de
     la frise la ferme. Le glisser de la frise capture le pointeur, et le
     navigateur ne signale alors pas toujours qu'on en est sorti. */
  const hovering = hover != null;
  useEffect(() => {
    if (!hovering) return;
    const away = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (
        !r ||
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        setHover(null);
    };
    window.addEventListener("pointermove", away);
    return () => window.removeEventListener("pointermove", away);
  }, [hovering, ref]);

  /* Deux points font un segment, pas une courbe : sous trois années la figure
     ne raconte rien qu'une phrase ne dirait mieux. */
  if (years.length < 3)
    return (
      <EmptyBlock
        note={t(
          completedOnly ? "profile.blocks.years.emptyCompleted" : "profile.blocks.years.empty",
        )}
      />
    );

  const max = live.max ?? target.max;
  const H = Math.max(120, box);
  const x = (i: number) => live[`x:${display[i].stat.key}`] ?? target[`x:${display[i].stat.key}`];
  const alpha = (i: number) => live[`a:${display[i].stat.key}`] ?? target[`a:${display[i].stat.key}`];
  /* La largeur suit les points EN VOL : figée à la nouvelle valeur, elle
     couperait ceux qui glissent encore depuis plus loin. */
  const W = Math.max(years.length * YEAR_STEP, x(display.length - 1) + YEAR_STEP / 2);
  /* Ce que la hauteur doit loger, du bas vers le haut : la barre de défilement
     (11 px, cf. `.as-scroller`), l'année, puis la courbe, puis le chiffre du
     sommet. `BASE` est la ligne de zéro, posée assez haut pour que l'étiquette
     de l'année ne passe jamais sous la barre. */
  const BASE = H - 46;
  const TOP = 22;
  const y = (c: number) => BASE - (c / max) * (BASE - TOP);
  const pts = display.map(
    (d, i) => [x(i), y(live[`c:${d.stat.key}`] ?? target[`c:${d.stat.key}`])] as const,
  );
  /* L'aire : la courbe refermée sur sa ligne de base. Elle ne dit rien que la
     ligne ne dise déjà — elle donne du POIDS au dessous, pour qu'on voie une
     masse qui monte et redescend plutôt qu'un fil posé dans le vide. */
  const area = `${smoothPath(pts)} L ${pts[pts.length - 1][0]},${BASE} L ${pts[0][0]},${BASE} Z`;

  /** Où tombe le point d'une année dans la FENÊTRE, défilement compris. */
  const locate = (i: number) => {
    const el = ref.current;
    if (!el || !pts[i]) return null;
    const r = el.getBoundingClientRect();
    return { i, x: r.left + pts[i][0] - el.scrollLeft, y: r.top + pts[i][1] };
  };

  return (
    /* `select-none` : sans lui, tirer la frise SURLIGNAIT les chiffres au lieu
       de la faire défiler — un glissement de souris sur du texte est une
       sélection pour le navigateur, et le SVG est plein de texte.
       `overflow-y-hidden` : il ne reste qu'une barre, l'horizontale. */
    <div
      ref={ref}
      className="as-scroller flex h-full select-none items-center overflow-x-auto overflow-y-hidden"
      onMouseLeave={() => setHover(null)}
      onPointerLeave={() => setHover(null)}
      /* LA FRISE DÉFILE : LA BULLE SE FERME (25/10/2026, Luc). Elle suivait son
         année, y compris hors de la carte — tirée vers la gauche, la frise
         laissait la bulle de 2020 flotter à côté du widget. Le survol suivant
         la rouvrira sur l'année qui est sous le pointeur. */
      onScroll={() => setHover(null)}
    >
      <div className="relative shrink-0" style={{ width: W, height: H }}>
      <svg width={W} height={H} className="font-karla">
        <defs>
          <linearGradient
            id="as-years-fill"
            x1="0"
            y1={TOP}
            x2="0"
            y2={BASE}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={YEAR_LINE} stopOpacity="0.42" />
            <stop offset="1" stopColor={YEAR_LINE} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* L'AIRE ET LES CHIFFRES ARRIVENT DERRIÈRE LE TRAIT, pas avec lui : la
            courbe se trace d'abord, de la plus vieille année à aujourd'hui, et
            le reste se pose dessus une fois la forme lue. `pathLength={1}`
            évite de mesurer le chemin en JS — le trait fait une unité de long,
            quelle que soit la frise, donc un seul jeu de keyframes suffit. */}
        <path d={area} fill="url(#as-years-fill)" className="as-year-veil" />
        <path
          d={smoothPath(pts)}
          fill="none"
          stroke={YEAR_LINE}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          className="as-year-draw"
        />
        {display.map(({ stat: v }, i) => (
          <g
            key={v.key}
            className={opened.current ? undefined : "as-year-veil"}
            opacity={alpha(i)}
          >
            {/* LA CIBLE DU SURVOL EST LA COLONNE ENTIÈRE, pas la pastille :
                viser un disque de quatre pixels à la souris est un exercice
                d'adresse, et la colonne est sans ambiguïté — une abscisse
                appartient à une seule année. */}
            <rect
              x={pts[i][0] - YEAR_STEP / 2}
              y="0"
              width={YEAR_STEP}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(locate(i))}
            />
            <circle
              cx={pts[i][0]}
              cy={pts[i][1]}
              r={hover?.i === i ? 6 : 4}
              fill={YEAR_LINE}
              stroke="rgba(255,255,255,0.9)"
              strokeWidth={hover?.i === i ? 2 : 0}
              className="pointer-events-none"
            />
            {/* Le compte AU-DESSUS de son point : la valeur se lit sans légende,
                et une courbe sans chiffres oblige à viser une graduation. */}
            <text
              x={pts[i][0]}
              y={pts[i][1] - 14}
              textAnchor="middle"
              fontSize="12"
              fontWeight="700"
              fill={hover?.i === i ? "#fff" : "rgba(255,255,255,0.72)"}
              className="pointer-events-none"
            >
              {Math.round(live[`c:${v.key}`] ?? target[`c:${v.key}`])}
            </text>
            <text
              x={pts[i][0]}
              y={BASE + 22}
              textAnchor="middle"
              fontSize="12"
              fontWeight="700"
              fill={hover?.i === i ? YEAR_LINE : "rgba(255,255,255,0.38)"}
              className="pointer-events-none"
            >
              {v.label}
            </text>
          </g>
        ))}
      </svg>
      {/* `years[hover]` peut avoir disparu entre-temps : basculer un réglage
          refait la frise pendant que la souris est encore dessus. */}
      {hover && display[hover.i]?.alive ? (
        <YearTip stat={display[hover.i].stat} x={hover.x} y={hover.y} />
      ) : null}
      </div>
    </div>
  );
}

/**
 * La bulle de survol d'une année : ce que la courbe ne peut pas écrire.
 *
 * Le graphique porte déjà le compte au-dessus de chaque point — la bulle
 * n'existe donc pas pour le répéter mais pour ce qui n'a pas de place sur un
 * axe : le temps passé et la note moyenne de cette année-là. Les lignes que le
 * profil ne peut pas honnêtement remplir sont ABSENTES, pas remplies d'un tiret
 * ni d'un zéro : une liste locale ne connaît pas la durée d'un épisode, et une
 * année sans note n'a pas de moyenne.
 */
function YearTip({
  stat,
  x,
  y,
}: {
  stat: YearStat;
  /** L'abscisse du point survolé, DANS LA FENÊTRE. */
  x: number;
  /** Son ordonnée, dans la fenêtre : la bulle se pose toujours au-dessus. */
  y: number;
}) {
  const { t } = useTranslation();
  const TIP = 176;
  /* Bornée aux deux bords de la FENÊTRE : la bulle d'une année de bord sortait
     de l'écran, pas seulement de la carte. */
  const left = Math.min(Math.max(x, TIP / 2 + 8), window.innerWidth - TIP / 2 - 8);
  const rows: [string, string][] = [
    [t("profile.blocks.years.tipCount"), String(stat.count)],
    ...(stat.minutes != null
      ? ([[t("profile.blocks.years.tipHours"), String(Math.round(stat.minutes / 60))]] as [
          string,
          string,
        ][])
      : []),
    ...(stat.mean != null
      ? ([[t("profile.blocks.years.tipMean"), String(stat.mean).replace(".", ",")]] as [
          string,
          string,
        ][])
      : []),
  ];

  /* PORTÉE PAR LE `body`, ET C'EST TOUT L'INTÉRÊT. Dans la carte, elle était
     rognée par le bloc qui défile (`overflow`) : la bulle d'un point haut était
     coupée net au bord du widget, et c'est ce qui l'avait fait basculer en
     dessous — une rustine pour un problème de découpe. Ancrée à la fenêtre,
     elle sort du widget, se pose toujours AU-DESSUS du point, et passe par-dessus
     les cartes voisines. */
  return createPortal(
    /* DEUX BOÎTES, ET C'EST LA CONDITION DE L'ANIMATION : le placement (un
       `translate(-50%,-100%)` qui accroche la bulle par son bas-centre) vit sur
       la boîte du dehors, l'apparition sur celle du dedans. Sur un seul
       élément, les deux se disputeraient la même propriété `transform` et
       l'animation renverrait la bulle à l'angle du point.
       `as-preview-root` est l'apparition des aperçus au survol du site — même
       geste pour le même rôle, plutôt qu'un troisième fondu maison. */
    <div
      className="pointer-events-none fixed z-[60]"
      /* 34 px au-dessus du point, et plus 18 : à 18 la bulle couvrait le
         chiffre de l'année survolée, posé 14 px au-dessus du point
         (25/10/2026, Luc). */
      style={{ width: TIP, left, top: y - 34, transform: "translate(-50%, -100%)" }}
    >
      {/* PAS DE CLÉ ICI, ET C'EST DÉLIBÉRÉ. Elle y était pour rejouer
          l'apparition à chaque changement d'année ; à l'usage, longer la frise
          faisait clignoter la bulle une fois par colonne — l'animation devenait
          du bruit. Sans clé, React garde le même nœud : le geste ne joue qu'à
          l'ARRIVÉE sur le graphique, et glisser d'une année à l'autre ne fait
          que changer ce qui est écrit dedans. */}
      {/* FOND SOMBRE ET OPAQUE, celui du panneau de réglages (25/10/2026, Luc :
          « plus lisible ») : la carte translucide d'avant laissait passer la
          courbe et le papier peint sous le texte. */}
      <div className="as-preview-root rounded-xl border border-[#2c2d36] bg-[#15161d] px-3.5 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.55)]">
        <p className="mb-2 font-outfit text-[13px] font-bold text-white">
          {t("profile.blocks.years.tipTitle", { year: stat.label })}
        </p>
        <div className="grid gap-1">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <span className="font-karla text-[11px] text-white/60">{label}</span>
              <span className="font-karla text-[12px] font-bold text-white">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Le chemin lissé qui passe par les points SANS LES DÉPASSER (cubique monotone,
 * méthode de Fritsch-Carlson).
 *
 * Une polyligne montrerait les mêmes valeurs ; l'arrondi dit que la variable est
 * continue — le nombre de titres d'une année n'est pas une catégorie voisine
 * d'une autre, c'est le même compte qui monte et qui redescend.
 *
 * LE LISSAGE PRÉCÉDENT (Catmull-Rom) MENTAIT AUX SOMMETS. Ses tangentes suivent
 * la droite qui joint les deux VOISINS d'un point, donc à un pic — où les
 * voisins sont tous les deux plus bas — la courbe arrivait encore en montant et
 * ne s'arrêtait qu'après : le haut du dessin passait au-dessus de sa pastille,
 * et le maximum apparent tombait entre deux années. Sur une frise de comptes,
 * c'est faux : il n'y a rien entre 2022 et 2023.
 *
 * La tangente est ici plafonnée par les deux pentes voisines, et forcée à ZÉRO
 * quand elles changent de signe — c'est-à-dire exactement aux pics et aux
 * creux. La courbe y arrive donc à plat : le sommet du trait est la pastille,
 * pas un point du vide à côté.
 */
function smoothPath(p: readonly (readonly [number, number])[]): string {
  const n = p.length;
  if (n < 2) return `M ${p[0][0]},${p[0][1]}`;
  /** La pente de chaque segment, et l'écart en x qui la porte. */
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    /* Jamais nul : pendant l'animation de la frise, deux années peuvent passer
       un instant à la même abscisse, et une pente infinie ferait un chemin NaN. */
    dx[i] = p[i + 1][0] - p[i][0] || 0.001;
    slope[i] = (p[i + 1][1] - p[i][1]) / dx[i];
  }
  /** La tangente en chaque point. Aux deux bouts, celle du seul segment voisin. */
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    /* Signes opposés (ou un palier) : c'est un pic ou un creux, la courbe y
       passe à plat. */
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0;
    } else {
      /* Ailleurs, la MOYENNE des deux pentes, seulement BRIDÉE au triple de la
         plus douce (la limite de Fritsch-Carlson, qui suffit à interdire le
         dépassement). La moyenne harmonique, elle, tire la tangente vers la
         pente la plus douce même quand les deux vont dans le même sens : une
         année qui passe de 26 à 22 puis à 8 se retrouvait presque plate à 22,
         et la frise prenait un air d'escalier — des paliers aux points, des
         chutes entre eux. */
      const avg = (slope[i - 1] + slope[i]) / 2;
      const cap = 3 * Math.min(Math.abs(slope[i - 1]), Math.abs(slope[i]));
      m[i] = Math.sign(avg) * Math.min(Math.abs(avg), cap);
    }
  }
  m[n - 1] = slope[n - 2];

  let d = `M ${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    /* LA POIGNÉE EST UN PEU RACCOURCIE AUX SOMMETS ET AUX CREUX. La tangente y
       est horizontale — il le faut, c'est ce qui met le maximum du tracé
       exactement sur la pastille — mais avec la poignée pleine (un tiers du
       pas) la courbe RESTAIT à sa hauteur sur une quinzaine de pixels après le
       point : un plateau, dont l'œil place le milieu à droite de la pastille.
       Le pixel le plus haut était bien sur le point ; ce qu'on lisait comme le
       sommet ne l'était pas.

       DEUX FACTEURS, PARCE QUE LES DEUX BOUTS NE DEMANDENT PAS LA MÊME CHOSE.
       Aux extrema la poignée est à peine raccourcie (0,95) : assez pour que la
       crête se pose sur sa pastille, pas assez pour pincer le dôme — à 0,35,
       essayé, les crêtes étaient parfaites et la frise ne l'était plus, car
       sur une liste en dents de scie presque chaque année est un extremum et
       la courbe redevenait une ligne brisée à coins arrondis. Ailleurs, en
       pente, la poignée est ALLONGÉE (1,25) : c'est ce qui donne son moelleux
       au trait entre les points.

       Allonger n'est plus rigoureusement sans dépassement — mesuré sur trois
       séries (celle-ci, une liste courte, une liste trouée) : 0,37 px au pire,
       soit un tiers de pixel, sous l'antialiasing du trait de 2,5. Les crêtes,
       elles, restent à 0,00 px de leur pastille. Au-delà (1,4) ça se voit :
       1 px de dépassement et la crête glisse de 4,7 px. */
    const flat = (t: number) => (t === 0 ? 0.95 : 1.25) * (dx[i] / 3);
    const t0 = flat(m[i]);
    const t1 = flat(m[i + 1]);
    d +=
      ` C ${p[i][0] + t0},${p[i][1] + m[i] * t0}` +
      ` ${p[i + 1][0] - t1},${p[i + 1][1] - m[i + 1] * t1}` +
      ` ${p[i + 1][0]},${p[i + 1][1]}`;
  }
  return d;
}

/* ── Studios ─────────────────────────────────────────────────────────── */

export function StudiosBlock({
  entries,
  /* Le défaut vient du catalogue : l'onglet « Statistiques » rend ce bloc sans
     réglages et doit montrer la même chose que la grille. */
  completedOnly = blockOption("studios", "completedOnly", undefined),
}: {
  entries: ProfileEntry[];
  completedOnly?: boolean;
}) {
  const { t } = useTranslation();
  /* TOUS LES STUDIOS, plus les six premiers (25/10/2026, Luc) : la liste
     défile, avec la barre visible du site (`as-scroller`). Le plancher de
     quatre titres par studio reste — sans lui, un studio d'un seul titre noté
     10 passerait premier. */
  const ranks = useMemo(
    () => studioRanks(entries, 4, completedOnly),
    [entries, completedOnly],
  );

  /* LE RÉGLAGE S'ANIME PAR UN FONDU DE LA LISTE (25/10/2026, Luc). Faire
     glisser chaque ligne vers son nouveau rang croisait les lignes les unes
     sur les autres (« bizarre ») : le classement change presque entièrement
     d'un réglage à l'autre. La liste s'efface donc (FADE), est remplacée, puis
     réapparaît barres à zéro et les barres poussent jusqu'à leur note. */
  const FADE = 160;
  const [shownRanks, setShownRanks] = useState(ranks);
  const [phase, setPhase] = useState<"idle" | "out" | "grow">("idle");
  const lastRanks = useRef(ranks);
  useEffect(() => {
    if (lastRanks.current === ranks) return;
    lastRanks.current = ranks;
    setPhase("out");
    let r1 = 0;
    let r2 = 0;
    const timer = setTimeout(() => {
      setShownRanks(ranks);
      setPhase("grow");
      r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setPhase("idle"));
      });
    }, FADE);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [ranks]);

  if (!shownRanks.length)
    return (
      <EmptyBlock
        note={t(
          completedOnly
            ? "profile.blocks.studios.emptyCompleted"
            : "profile.blocks.studios.empty",
        )}
      />
    );

  return (
    /* LA MISE EN PAGE DE « RÉPARTITION PAR STATUT » (25/10/2026, Luc) : une
       grille dont chaque ligne reprend les colonnes (`subgrid`). Le nom ne prend
       que la largeur du PLUS LONG des noms (plafonnée à 16 caractères), et la
       barre TOUT le reste — elle s'étire avec la carte au lieu de rester à
       64 px. `overflow-x-hidden` : plus de barre de défilement en bas. */
    <div
      className="as-studio-list as-scroller grid h-full content-start gap-x-3 gap-y-3 overflow-y-auto overflow-x-hidden pr-1.5"
      style={{
        opacity: phase === "out" ? 0 : 1,
        transition: `opacity ${FADE}ms ease`,
      }}
    >
      {shownRanks.map((s, i) => (
        <div
          key={s.name}
          data-studio={s.name}
          className="col-span-full grid items-center"
          style={{ gridTemplateColumns: "subgrid" }}
        >
          <span className="font-karla text-[11px] font-bold text-white/30">{i + 1}</span>
          <span className="max-w-[16ch] truncate text-[13px] font-semibold text-white">
            {s.name}
          </span>
          <span className="whitespace-nowrap font-karla text-[11px] text-white/35">
            {/* « 5 titres » quand la carte a la place, « 5 » seul sinon
                (globals.css, `.as-studio-count-*`). */}
            <span className="as-studio-count-full">
              {t("profile.blocks.studios.titles", { count: s.count })}
            </span>
            <span className="as-studio-count-short" title={t("profile.blocks.studios.titles", { count: s.count })}>
              {s.count}
            </span>
          </span>
          <span className="min-w-0">
            <Bar
              /* À zéro pendant la réapparition, puis à leur note : les barres
                 poussent (cf. `phase`). */
              pct={phase === "grow" ? 0 : s.score ? ((s.score - 5) / 5) * 100 : 2}
              color="linear-gradient(90deg,#FFD700,#b8860b)"
            />
          </span>
          <span className="min-w-[3ch] text-right font-karla text-[13px] font-bold text-as-score">
            {s.score != null ? String(s.score).replace(".", ",") : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Saison en cours ─────────────────────────────────────────────────── */

/**
 * LA COULEUR DES ÉPISODES : le bleu de la barre d'épisodes (25/10/2026, Luc :
 * « la couleur des ép. est le bleu »). UNIQUEMENT pour l'avancement EN NOMBRE
 * D'ÉPISODES (ép. 22 / 24). L'avancement DANS un épisode (« Vu récemment »,
 * « Reprendre », minutes restantes) garde l'accent — précisé par Luc le même
 * jour.
 */
export const EP_BLUE = "#0ea5e9";

/** Le vert « en diffusion » : pastille de l'intertitre et bandeau du compte à
 *  rebours sur l'affiche (25/10/2026, Luc). Un cran plus clair que le vert
 *  du bloc au catalogue (#22c55e), à sa demande. */
export const AIRING_GREEN = "#4ade80";

/**
 * « EN COURS DE VISIONNAGE », REFAIT SUR LE MODÈLE DES AUTRES WIDGETS
 * (25/10/2026, Luc). Ce qui a changé, et pourquoi :
 *  - TOUS les titres en cours, plus les six premiers : la liste défile, barre
 *    visible du site (`as-scroller`), jamais de défilement horizontal ;
 *  - les colonnes suivent la LARGEUR DE LA CARTE (`auto-fill`, une colonne
 *    par tranche de 15 rem) et non celle de l'écran — un bloc de 2 colonnes
 *    sur un grand écran en avait deux, écrasées ;
 *  - l'AFFICHE au format 2:3, à la hauteur de la ligne (`.as-season-poster`,
 *    globals.css, grandit avec la carte), plus la vignette carrée de 38 px qui
 *    rognait l'image ;
 *  - un total inconnu (One Piece) n'efface plus la ligne de progression : elle
 *    dit l'épisode atteint, et la barre reste une piste vide ;
 *  - ce qui RESTE à voir, plutôt que de faire faire la soustraction ;
 *  - la barre en BLEU ÉPISODES (`EP_BLUE`) ;
 *  - un réglage : les re-visionnages, avec leur pastille, ou pas.
 */
export function SeasonBlock({
  entries,
  rewatching = blockOption("season", "rewatching", undefined),
  /** Titres par ligne : 0 = auto (une colonne par tranche de 15 rem), ou 1 à 5. */
  perRow = 0,
  /** Taille des cartes (`cardSize`) : « small » resserre tout, titre sur une
      ligne ; « large » agrandit tout (`.as-season-small/-large`, globals.css). */
  size = "normal",
  /** Les titres en diffusion d'abord, avec le compte à rebours (`airingFirst`). */
  airingFirst = true,
}: {
  entries: ProfileEntry[];
  rewatching?: boolean;
  perRow?: number;
  size?: "small" | "normal" | "large";
  airingFirst?: boolean;
}) {
  const small = size === "small";
  const large = size === "large";
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  /* L'HEURE, POSÉE APRÈS L'HYDRATATION et rafraîchie chaque minute : le serveur
     n'a pas la même, et un compte à rebours rendu des deux côtés différerait. */
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const countdown = (at: number) => {
    const s = Math.max(0, Math.round((at - now) / 1000));
    if (s < 60) return t("profile.blocks.season.now");
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return t("profile.blocks.season.inD", { d, h });
    if (h) return t("profile.blocks.season.inH", { h, m, mm: String(m).padStart(2, "0") });
    return t("profile.blocks.season.inM", { m });
  };
  const watching = useMemo(
    () =>
      currentlyWatching(entries, Infinity)
        .filter((e) => rewatching || (e.status || "").toUpperCase() !== "REPEATING")
        /* STRICT (25/10/2026, Luc) : « En cours » à zéro épisode vu n'est pas
           un visionnage — un titre ouvert par erreur ou à peine lancé (même
           règle que les missclics écartés de « Vu récemment »). Il faut au
           moins un épisode compté. */
        .filter((e) => (e.progress || 0) >= 1)
        /* DU PLUS RÉCEMMENT REGARDÉ AU PLUS ANCIEN (25/10/2026, Luc), et plus
           du plus avancé : la dernière activité sur l'entrée. Sans date (cache
           AniList d'avant ce champ), l'ordre précédent sert de départage. */
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [entries, rewatching],
  );
  /* LES DIFFUSIONS EN TÊTE (25/10/2026, Luc) : ce qui a un prochain épisode
     annoncé passe devant, du plus proche au plus lointain — l'ordre de la
     page « Airing » d'AniList. Le reste garde l'ordre du dernier regardé. */
  const isAiring = (e: ProfileEntry) => !!(airingFirst && e.airingAt && e.nextEpisode);
  const airing = useMemo(
    () => watching.filter(isAiring).sort((a, b) => (a.airingAt || 0) - (b.airingAt || 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [watching, airingFirst],
  );
  const items = useMemo(
    () => (airing.length ? [...airing, ...watching.filter((e) => !isAiring(e))] : watching),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [watching, airing],
  );
  /* Les deux intertitres ne servent qu'à séparer DEUX groupes. */
  const grouped = airing.length > 0 && airing.length < items.length;
  /* LES CARTES GLISSENT D'UNE MISE EN PAGE À L'AUTRE (25/10/2026, Luc) :
     changer le nombre par ligne (ou le réglage des re-visionnages) déplace et
     redimensionne chaque carte. FLIP en position ET en taille : la boîte
     d'avant, la nouvelle, une `transform` de l'une vers l'autre relâchée à
     l'image suivante. Les cartes qui arrivent apparaissent en fondu. */
  const gridRef = useRef<HTMLDivElement>(null);
  type Box = { left: number; top: number; width: number; height: number };
  const boxes = useRef(new Map<string, Box>());
  useIsoLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = Array.from(grid.querySelectorAll<HTMLElement>("[data-season]"));
    const first = boxes.current.size === 0;
    const now = new Map<string, Box>();
    const moves: Array<[HTMLElement, string]> = [];
    /* Mesurées dans le CONTENU de la liste (défilement compris), pas dans la
       fenêtre : faire défiler entre deux réglages ne doit rien faire voler. */
    const g = grid.getBoundingClientRect();
    for (const card of cards) {
      const c = card.getBoundingClientRect();
      const r: Box = {
        left: c.left - g.left + grid.scrollLeft,
        top: c.top - g.top + grid.scrollTop,
        width: c.width,
        height: c.height,
      };
      const k = card.dataset.season!;
      now.set(k, r);
      const was = boxes.current.get(k);
      if (was) {
        const dx = was.left - r.left;
        const dy = was.top - r.top;
        const sx = was.width / r.width;
        const sy = was.height / r.height;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) {
          moves.push([card, `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`]);
        }
      } else if (!first) {
        card.classList.add("as-fade-in");
      }
    }
    boxes.current = now;
    if (!moves.length) return;
    for (const [card, tf] of moves) {
      card.style.transition = "none";
      card.style.transformOrigin = "0 0";
      card.style.transform = tf;
    }
    /* LA POSITION DE DÉPART DOIT ÊTRE CALCULÉE AVANT LE LÂCHER. Relâchées dans
       un `requestAnimationFrame` posé depuis cet effet, les cartes l'étaient
       AVANT la première peinture de leur position d'avant : pour le
       navigateur, départ et arrivée tombaient dans le même calcul de style, et
       il n'y avait rien à animer (« pas d'animation », 25/10/2026). Lire une
       mesure force ce calcul ; on peut relâcher tout de suite après. */
    void grid.offsetWidth;
    for (const [card] of moves) {
      card.style.transition = "transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)";
      card.style.transform = "";
    }
  }, [items, perRow, size]);

  if (!items.length) return <EmptyBlock note={t("profile.blocks.season.empty")} />;

  const n = Number(perRow);
  return (
    <div
      ref={gridRef}
      className={`as-scroller grid h-full content-start overflow-y-auto overflow-x-hidden pr-1.5 ${
        small ? "as-season-small gap-1.5" : large ? "as-season-large gap-3" : "gap-2.5"
      }`}
      style={{
        gridTemplateColumns:
          n >= 1 && n <= 5
            ? `repeat(${n}, minmax(0, 1fr))`
            : `repeat(auto-fill, minmax(${small ? "11rem" : large ? "26rem" : "15rem"}, 1fr))`,
      }}
    >
      {items.map((e, idx) => {
        const live = isAiring(e);
        /* L'intertitre d'un groupe, posé devant sa première carte, sur toute
           la largeur de la grille. */
        const heading =
          grouped && (idx === 0 || idx === airing.length) ? (
            <p
              className={`col-span-full flex items-center gap-2 font-karla text-[11px] font-bold uppercase tracking-[0.08em] text-white/45 ${
                idx ? "mt-2" : ""
              }`}
            >
              {idx === 0 ? (
                /* Pastille VERTE « en diffusion » (25/10/2026, Luc) : un point
                   dont la LUEUR respire (`.as-airing-dot`, globals.css), repris
                   du prototype AniScroll. Décalée de 6 px : le bord gauche de la
                   liste (`overflow-x: hidden`) coupait la lueur. */
                <span className="as-airing-dot ml-1.5" />
              ) : null}
              {t(idx === 0 ? "profile.blocks.season.groupAiring" : "profile.blocks.season.groupWatching")}
              {/* Le nombre de titres du groupe, juste après (26/10/2026, Luc). */}
              <span className="text-white/30">{idx === 0 ? airing.length : items.length - airing.length}</span>
            </p>
          ) : null;
        /* Sans total (série en cours, One Piece) : la borne est le dernier
           épisode SORTI, suivi d'un « + » — la barre et le reste à voir se
           lisent sur ce qu'on peut regarder aujourd'hui (25/10/2026, Luc). */
        const aired = !e.total && e.aired && e.aired >= e.progress ? e.aired : null;
        const end = e.total || aired;
        const pct = end ? Math.min(100, (e.progress / end) * 100) : 0;
        const left = end ? Math.max(0, end - e.progress) : null;
        const again = (e.status || "").toUpperCase() === "REPEATING";
        /* « À JOUR » (25/10/2026, Luc) : en diffusion, et tout ce qui est sorti
           est vu — le prochain épisode est le seul à attendre. */
        const upToDate = !again && live && e.progress >= (e.nextEpisode || 0) - 1;
        const cornerTag = again
          ? { text: t("profile.blocks.season.rewatch"), color: STATUS_COLOR.REPEATING }
          : upToDate
            ? { text: t("profile.blocks.season.upToDate"), color: AIRING_GREEN }
            : null;
        return (
          <Fragment key={e.mediaId}>
          {heading}
          <Link
            data-season={e.mediaId}
            href={animeHref(e.mediaId, clickTarget)}
            className={`group relative flex min-w-0 items-center bg-white/[0.03] ring-1 ${
              small
                ? "gap-2 rounded-xl p-1.5"
                : large
                  ? "gap-5 rounded-[1.25rem] p-3"
                  : "gap-3 rounded-2xl p-2"
            } ring-white/[0.06] transition-colors hover:bg-white/[0.06] hover:ring-white/15`}
          >
            <span
              className={`as-season-poster relative shrink-0 overflow-hidden as-clip-bg [--clip-bg:rgba(255,255,255,0.1)] ${
                small ? "rounded-lg" : "rounded-xl"
              }`}
            >
              {e.cover ? (
                <Image src={e.cover} alt="" fill sizes={large ? "160px" : "80px"} className="object-cover" />
              ) : null}
              {/* LE PROCHAIN ÉPISODE SUR L'AFFICHE, comme la page « Airing »
                  d'AniList : son numéro et le temps qui reste, sur un fondu
                  sombre en bas. Les petites cartes n'ont pas la place (affiche
                  de 32 px) : le compte à rebours y passe dans la ligne de
                  progression. */}
              {live && !small && now ? (
                <span
                  className={`absolute inset-x-0 bottom-0 flex flex-col items-center bg-gradient-to-t from-black/90 via-black/60 to-transparent text-center font-karla leading-tight text-white ${
                    large ? "pt-6 text-[13px]" : "pt-4 text-[10px]"
                  }`}
                >
                  <span className={`font-bold ${large ? "pb-1" : "pb-0.5"}`}>
                    {t("profile.blocks.season.nextEp", { n: e.nextEpisode })}
                  </span>
                  {/* LE TEMPS SUR UN BANDEAU VERT (25/10/2026, Luc — préféré à
                      une pastille de verre, essayée le même jour). */}
                  <span
                    className={`w-full whitespace-nowrap font-bold text-black ${large ? "py-1" : "py-0.5"}`}
                    style={{ background: AIRING_GREEN }}
                  >
                    {countdown(e.airingAt!)}
                  </span>
                </span>
              ) : null}
            </span>
            {cornerTag ? (
              /* « REVISIONNAGE », ÉTIQUETTE DE CARTE (25/10/2026, Luc — piste
                 13 de la planche de vingt) : en petites capitales, coin haut
                 droit, dans le cyan des re-visionnages (STATUS_COLOR). Ni sur
                 l'affiche, ni dans la ligne de progression, qu'il coupait. */
              <span
                className={`pointer-events-none absolute font-karla font-bold uppercase tracking-[0.06em] ${
                  small
                    ? "right-2 top-1.5 text-[9px]"
                    : large
                      ? "right-3.5 top-3 text-[12px]"
                      : "right-2.5 top-2 text-[10px]"
                }`}
                style={{ color: cornerTag.color }}
              >
                {cornerTag.text}
              </span>
            ) : null}
            <span className="flex min-w-0 flex-1 flex-col">
              {/* LE TITRE OCCUPE TOUJOURS DEUX LIGNES, et se cale en BAS : une
                  ligne ou deux, la progression et la barre tombent à la même
                  hauteur d'une carte à sa voisine (2 × leading-tight = 2,5em).
                  Il laisse le coin à l'étiquette « Revisionnage » (`pr-20`).
                  En petites cartes : une seule ligne. */}
              <span
                className={`as-season-title flex items-end ${
                  again ? (small ? "pr-[4.5rem]" : "pr-20") : upToDate ? (small ? "pr-11" : "pr-14") : ""
                }`}
                style={{ minHeight: small ? undefined : "2.5em" }}
              >
                <span
                  className={`font-semibold leading-tight text-white ${
                    small ? "line-clamp-1" : "line-clamp-2"
                  }`}
                >
                  {pickTitle(e.title, titlePref)}
                </span>
              </span>
              <span className="as-season-sub mt-1 flex min-w-0 items-center gap-1.5 font-karla text-white/50">
                <span className="truncate">
                  <span className="font-bold text-white/80">
                    {e.total
                      ? t("profile.blocks.season.progress", { progress: e.progress, total: e.total })
                      : aired
                        ? t("profile.blocks.season.progressAiring", { progress: e.progress, aired })
                        : t("profile.blocks.season.progressOpen", { progress: e.progress })}
                  </span>
                  {live && small && now ? (
                    <>
                      {" · "}
                      <span className="font-bold" style={{ color: AIRING_GREEN }}>
                        {t("profile.blocks.season.nextEp", { n: e.nextEpisode })} {countdown(e.airingAt!)}
                      </span>
                    </>
                  ) : left != null && left > 0
                      ? ` · ${t("profile.blocks.season.left", { count: left })}`
                      : null}
                </span>
              </span>
              <span className={`block ${small ? "mt-1.5" : large ? "mt-4" : "mt-2"}`}>
                <Bar pct={pct} color={EP_BLUE} />
              </span>
            </span>
          </Link>
          </Fragment>
        );
      })}
    </div>
  );
}
