import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  COLS,
  DEFAULT_BOUNDS,
  GAP,
  ROW,
  clampSize,
  columnWidth,
  compact,
  pixelRect,
  resizeItem,
  rowCount,
  type Bounds,
  type GridItem,
} from "@/lib/profile/grid";
import WidgetSettings from "./WidgetSettings";

/* `useLayoutEffect` n'existe pas au rendu serveur — React y avertit. Ce module
   est rendu des deux cotes : on prend l'effet de mise en page dans le
   navigateur, et l'effet ordinaire (jamais execute) sur le serveur. */
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * La grille de widgets : pose, déplacement, redimensionnement.
 *
 * Le composant ne connaît AUCUN bloc — il reçoit une disposition et une
 * fonction qui peint un identifiant. Toute la géométrie vit dans
 * lib/profile/grid.ts ; ici il n'y a que le pointeur et les pixels.
 *
 * Hors mode réorganisation, rien n'est déplaçable : ni la carte ni le coin de
 * redimensionnement ne répondent, et un visiteur qui n'est pas le propriétaire
 * n'entre jamais dans ce mode.
 *
 * TROIS GESTES, PAS DIX BOUTONS. Chaque bloc portait, en édition, deux flèches
 * monter/descendre, quatre tailles types (S M L XL) et une croix : sept
 * commandes serrées dans l'en-tête, sur une carte qui fait parfois une colonne
 * de large, et toutes en double d'un geste qui existait déjà — les flèches de
 * ce que fait le glisser, les tailles de ce que fait le coin. Il ne reste que
 * les gestes : glisser l'en-tête, tirer le coin, un moins pour retirer, et une
 * roue dentée pour ce qu'aucun geste ne peut dire — les réglages du bloc.
 *
 * La roue n'apparaît pas SEULEMENT sur les blocs qui ont des réglages. Une
 * commande qui existe sur certaines cartes et pas sur d'autres se cherche ; le
 * panneau, lui, sait dire qu'il n'a rien à proposer. Et le composant ne connaît
 * toujours aucun bloc : il reçoit des interrupteurs déjà traduits et déjà
 * résolus (`options`) et rend des bascules (`onOption`).
 *
 * OÙ S'OUVRE LE PANNEAU, ET POURQUOI PAS AILLEURS. Sur la carte du bloc, en
 * frère des cartes et non en enfant : la carte coupe ce qui dépasse
 * (`overflow-hidden`) et un panneau posé dedans y était tronqué, tandis que
 * posé dans le conteneur de la grille il est libre et sait quand même où est sa
 * carte — `livePixels` le suit jusque pendant un déplacement.
 *
 * L'étape d'après avait été une fenêtre centrée, calquée sur l'éditeur de
 * liste. Elle réglait le découpage mais coûtait un aller-retour au centre de
 * l'écran pour un bloc qu'on est en train de regarder, et il fallait alors lui
 * réexpliquer de quel bloc il s'agissait — d'où sa couleur et son icône. Ouvert
 * sur la carte, le panneau n'a plus rien à réexpliquer : il est dessus.
 */

export type BlockChrome = {
  /** Un nœud et pas une chaîne : un titre peut avoir une forme courte pour les
   *  cartes étroites (cf. `blockTitle` dans ProfileOverview.tsx). */
  title: React.ReactNode;
  /** Le nom donné au bloc par le propriétaire, vide s'il n'en a pas donné. */
  name?: string;
  /** Le nom du catalogue, en texte : ce que le champ de renommage suggère. */
  defaultName?: string;
  /** Petite ligne grise à côté du titre (« 5 », « cette semaine »…). */
  meta?: string | null;
  /** Le bloc pose SES PROPRES commandes dans le coin haut-droit de l'en-tête
   *  (les flèches du carrousel de la vitrine). Elles sont en position absolue,
   *  donc hors du flux : sans cette réservation, un titre assez long passerait
   *  dessous au lieu de s'y arrêter. */
  endRoom?: boolean;
  /** Un CRAYON à gauche de la roue, en réorganisation : il remplace le contenu
   *  du bloc par `node`, sa version éditable, sur place (les personnages
   *  favoris, 25/10/2026, Luc). */
  editor?: { label: string; node: React.ReactNode };
  body: React.ReactNode;
};

type Props = {
  layout: GridItem[];
  onLayout: (next: GridItem[]) => void;
  renderBlock: (id: string) => BlockChrome | null;
  /**
   * Les tailles admises par un bloc. Le composant ne sait toujours rien des
   * blocs : il demande, il n'interroge aucun catalogue.
   */
  limits?: (id: string) => Bounds;
  /** Les réglages d'un bloc, déjà traduits et déjà résolus à leur état. */
  options?: (id: string) => WidgetOption[];
  onOption?: (id: string, key: string, value: boolean | string) => void;
  /** Renommer un bloc. Absent : les titres ne se modifient pas. */
  onRename?: (id: string, name: string) => void;
  editing: boolean;
};

/**
 * Un réglage prêt à peindre : un interrupteur, ou un menu déroulant dont les
 * choix portent déjà leur libellé. La grille et son panneau ne savent rien de
 * plus — ce que la clé signifie ne regarde que l'appelant.
 */
export type WidgetOption =
  | { key: string; label: string; desc?: string; on: boolean }
  | {
      key: string;
      label: string;
      desc?: string;
      value: string;
      /** Une rangée de boutons côte à côte plutôt qu'un menu : pour quelques
       *  choix courts qu'on veut voir tous d'un coup (« Taille des cartes »). */
      segmented?: boolean;
      /** `color` peint la pastille du choix — celle de sa liste, à l'identique
       *  de l'éditeur de liste. `heart` la remplace par un cœur, pour les
       *  favoris, qui ne sont pas une liste comme les autres. */
      choices: {
        value: string;
        label: string;
        color?: string;
        heart?: boolean;
        group?: string;
        groupLabel?: string;
      }[];
    }
  /** Un curseur à une poignée ; `zeroLabel` nomme la position 0 (« Auto »). */
  | {
      key: string;
      label: string;
      desc?: string;
      single: { min: number; max: number; value: number; zeroLabel?: string };
    }
  /** Des cases à cocher dans un menu ; `values` sont les cochées. */
  | {
      key: string;
      label: string;
      desc?: string;
      values: string[];
      multi: { value: string; label: string; color?: string; group?: string; groupLabel?: string }[];
    }
  /** Une plage à deux poignées. `from`/`to` sont déjà bornés. */
  | {
      key: string;
      label: string;
      desc?: string;
      min: number;
      max: number;
      step: number;
      from: number;
      to: number;
    };

type Drag = {
  id: string;
  mode: "move" | "resize";
  sx: number;
  sy: number;
  /** Échelle d'affichage de la grille : < 1 dans la scène d'édition
      (ProfileStage), où le curseur parcourt moins de pixels écran que la
      grille n'a de pixels de mise en page. */
  k: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export default function WidgetGrid({
  layout,
  onLayout,
  renderBlock,
  limits,
  options,
  onOption,
  onRename,
  editing,
}: Props) {
  const { t } = useTranslation();
  const boundsOf = useCallback(
    (id: string) => limits?.(id) ?? DEFAULT_BOUNDS,
    [limits],
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<Drag | null>(null);
  /* Le rectangle de DÉPART, en unités de grille, plus le mode. Le rendu en a
     besoin — la taille qui suit le curseur se calcule à partir de lui — et un
     ref lu pendant le rendu ne déclencherait rien. */
  const [drag, setDrag] = useState<Drag | null>(null);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  /* Le bloc dont le panneau de réglages est ouvert. Un seul à la fois. */
  const [settings, setSettings] = useState<string | null>(null);
  /* Le bloc dont le CONTENU est en édition (le crayon) : il se modifie sur
     place, dans sa carte, au lieu d'ouvrir un panneau (25/10/2026, Luc). */
  const [contentEdit, setContentEdit] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setContentEdit(null);
  }, [editing]);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /* La largeur du conteneur EST l'unité de la grille : sans elle rien ne peut
     être placé, et elle change avec la fenêtre comme avec un panneau latéral.

     LA MESURE SE PREND AVANT LA PEINTURE (`useLayoutEffect`), et c'est ce qui
     enlève le saut du chargement. En `useEffect`, le navigateur peignait
     d'abord la disposition calculée sur `width || 1` — tous les blocs empilés à
     un pixel de large — puis la vraie mesure arrivait et les 200 ms de
     transition les faisaient GLISSER en place. Avec le flou par-dessus, ce sont
     des rectangles troubles qui traversent l'écran. */
  useIsoLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Le panneau se referme sur Échap, en sortant du mode réorganisation, et sur
     un appui AILLEURS. Ce dernier n'a personne à reconnaître : la roue et le
     panneau arrêtent tous deux la propagation du pointerdown — c'est leur
     `draggableCancel` — donc l'écouteur ne les voit jamais. */
  useEffect(() => {
    if (!settings) return;
    const away = () => setSettings(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettings(null);
    };
    window.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [settings]);
  useEffect(() => {
    if (!editing) setSettings(null);
  }, [editing]);

  /**
   * SI LE PANNEAU SORT DE L'ÉCRAN, C'EST L'ÉCRAN QUI BOUGE.
   *
   * Il s'ouvre AU-DESSUS de sa carte et sa hauteur dépend du nombre de réglages :
   * sur un bloc de la première ligne, ou avec quatre réglages, il commence
   * au-dessus du bord haut de la fenêtre. Plutôt que de le faire basculer sous
   * la carte — essayé, refusé : il y cache le bloc qu'on règle — la page défile
   * juste assez pour le découvrir en entier.
   *
   * LA MARGE HAUTE N'EST PAS UNE MARGE DE CONFORT. Elle valait 16 px et le
   * panneau arrivait décapité : au-dessus de la fenêtre il y a la barre de
   * navigation du site, collante et opaque, qui recouvre les premières dizaines
   * de pixels. S'arrêter à 16 px du bord de la FENÊTRE, c'est s'arrêter sous la
   * barre. Le dégagement vaut sa hauteur, plus le repos.
   *
   * DEUX PIÈGES QUI FONT SOUS-DÉFILER, et qui viennent tous deux de la HAUTEUR
   * DU PANNEAU — laquelle change avec le nombre de réglages du bloc :
   *
   * 1. Un panneau qui tient à l'écran peut dépasser par le BAS, pas seulement
   *    par le haut : il est ancré sur le bord supérieur d'une carte, donc plus
   *    il est haut plus il monte, mais une carte du bas de page laisse le
   *    panneau descendre sous la fenêtre. Les deux sens sont donc traités, en
   *    préférant toujours le haut : mieux vaut perdre le dernier réglage que le
   *    titre du panneau.
   * 2. La mesure ne peut pas passer par `getBoundingClientRect` : le panneau
   *    entre en animation (`as-widget-pop`), et une rAF plus tard il est encore
   *    réduit de 6 % et décalé de 6 px. Un rectangle mesuré là est plus petit et
   *    plus bas que le vrai, donc le défilement calculé est trop court — c'est
   *    exactement le « pas assez » observé. La géométrie est donc lue en
   *    coordonnées de MISE EN PAGE (`offsetTop`/`offsetHeight`), que les
   *    transformations n'affectent pas, replacée dans la fenêtre par le
   *    conteneur de la grille, lui, jamais animé.
   */
  const NAV_CLEARANCE = 96;
  const BOTTOM_MARGIN = 16;
  useEffect(() => {
    if (!settings) return;
    const id = requestAnimationFrame(() => {
      const el = panelRef.current;
      const host = hostRef.current;
      if (!el || !host) return;
      const top = host.getBoundingClientRect().top + el.offsetTop;
      const bottom = top + el.offsetHeight;
      const vh = window.innerHeight;

      let delta = 0;
      if (top < NAV_CLEARANCE) {
        delta = top - NAV_CLEARANCE;
      } else if (bottom > vh - BOTTOM_MARGIN) {
        // Descendre juste ce qu'il faut, sans jamais faire passer le haut du
        // panneau sous la barre de navigation : un panneau plus haut que la
        // place disponible est montré par le haut, pas par le milieu.
        delta = Math.min(bottom - (vh - BOTTOM_MARGIN), top - NAV_CLEARANCE);
      }
      /* En scène d'édition, c'est la scène qui défile, pas la fenêtre. */
      const scroller = host.closest<HTMLElement>(".as-stage.is-fixed");
      if (delta) (scroller ?? window).scrollBy({ top: delta, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [settings]);

  /* La disposition en cours est lue dans un ref pendant un glissement : les
     handlers sont posés une fois sur window et ne doivent pas dépendre d'un
     état recréé à chaque mouvement. */
  /* LA DISPOSITION DU GESTE RESTE ICI (25/10/2026, Luc : « grosses optis »).
     Chaque case franchie remontait au profil (`onLayout`) : il se redessinait
     en entier, relançait la minuterie d'envoi — et chez l'invité écrivait le
     stockage. Pendant le geste, la grille garde sa propre disposition (`live`)
     et ne la rend au profil qu'au lâcher, une fois. */
  const [live, setLive] = useState<GridItem[] | null>(null);
  const shown = live ?? layout;
  const layoutRef = useRef(shown);
  layoutRef.current = shown;
  /* Le décalage de la carte tenue en DÉPLACEMENT, hors état React (cf. onMove). */
  const moveRef = useRef({ dx: 0, dy: 0 });
  /* Le dernier contenu rendu de chaque bloc, resservi pendant un geste. */
  const chromeCache = useRef(new Map<string, BlockChrome>());
  /* LA CARTE ENTIÈRE, resservie telle quelle tant que rien de ce qu'elle
     affiche n'a changé (25/10/2026, « grosses optis ») : React saute un
     élément IDENTIQUE à celui du rendu d'avant, sous-arbre compris. À chaque
     case franchie, seules les cartes qui changent de place sont refaites — plus
     les en-têtes, boutons et traductions des autres. */
  const cardCache = useRef(new Map<string, { chrome: BlockChrome; sig: string; el: React.ReactElement }>());
  useEffect(() => () => document.documentElement.classList.remove("as-dragging"), []);

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    /* Où la carte lâchée SE TROUVE à l'écran : c'est de là qu'elle glissera
       vers sa case (cf. l'effet FLIP plus bas). */
    if (d?.mode === "move") {
      const s = pixelRect({ i: d.id, x: d.x, y: d.y, w: d.w, h: d.h }, width || 1);
      released.current = {
        id: d.id,
        l: Math.round(s.left) + moveRef.current.dx,
        t: Math.round(s.top) + moveRef.current.dy,
      };
    }
    moveRef.current = { dx: 0, dy: 0 };
    document.documentElement.classList.remove("as-dragging");
    setDrag(null);
    setOffset({ dx: 0, dy: 0 });
    if (d) onLayout(compact(layoutRef.current));
    setLive(null);
  }, [onLayout, width]);

  /* LES CARTES GLISSENT PAR `transform`, PLUS PAR `left`/`top` (25/10/2026,
     Luc : déplacer « laggy »). Animer `left`/`top` refaisait la mise en page
     de la grille et repeignait chaque carte et son flou à chaque image, pour
     toutes les cartes poussées à la fois. Ici la carte saute à sa nouvelle
     place, puis un `transform` la ramène visuellement d'où elle était et se
     relâche en 200 ms — le compositeur fait le reste (FLIP). D'où elle était :
     sa case d'avant PLUS le décalage de l'animation en cours, pour qu'une
     carte poussée deux fois de suite reparte d'où on la voit. */
  const targets = useRef(new Map<string, { l: number; t: number }>());
  const released = useRef<{ id: string; l: number; t: number } | null>(null);
  const flipWidth = useRef(0);
  useIsoLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sameWidth = flipWidth.current === width;
    flipWidth.current = width;
    const heldId = dragRef.current?.mode === "move" ? dragRef.current.id : null;
    const rel = released.current;
    released.current = null;
    /* Toutes les lectures d'abord, puis toutes les écritures, puis UNE seule
       remise en page forcée : lire et écrire carte par carte en forçait une
       par carte. */
    const moves: Array<[HTMLElement, number, number]> = [];
    for (const el of Array.from(host.querySelectorAll<HTMLElement>(":scope > section[data-widget]"))) {
      const id = el.dataset.widget!;
      const tgt = { l: parseFloat(el.style.left) || 0, t: parseFloat(el.style.top) || 0 };
      const prev = targets.current.get(id);
      targets.current.set(id, tgt);
      if (id === heldId || !sameWidth || !width) continue;
      let from: { l: number; t: number } | null = null;
      if (rel && rel.id === id) from = rel;
      else if (prev && (prev.l !== tgt.l || prev.t !== tgt.t)) {
        const tf = getComputedStyle(el).transform;
        const m = tf && tf !== "none" ? new DOMMatrixReadOnly(tf) : null;
        from = { l: prev.l + (m?.m41 ?? 0), t: prev.t + (m?.m42 ?? 0) };
      }
      if (!from || (from.l === tgt.l && from.t === tgt.t)) continue;
      moves.push([el, from.l - tgt.l, from.t - tgt.t]);
    }
    if (!moves.length) return;
    for (const [el, dx, dy] of moves) {
      el.style.transition = "none";
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    }
    void host.offsetWidth;
    for (const [el] of moves) {
      el.style.transition =
        "transform 200ms ease-in-out, width 200ms ease-in-out, height 200ms ease-in-out";
      el.style.transform = "";
    }
  });

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const cw = columnWidth(width || 1);
      const dx = (e.clientX - d.sx) / d.k;
      const dy = (e.clientY - d.sy) / d.k;
      if (d.mode === "move") {
        const nx = Math.min(COLS - d.w, Math.max(0, d.x + Math.round(dx / (cw + GAP))));
        const ny = Math.max(0, d.y + Math.round(dy / (ROW + GAP)));
        /* LA CARTE SUIT LA MAIN SANS PASSER PAR REACT : son `transform` est
           écrit directement, et la grille n'est redessinée qu'au changement de
           case. Un `setOffset` par mouvement la redessinait en entier à chaque
           mouvement de souris (25/10/2026, Luc : « toujours laggy »). */
        moveRef.current = { dx, dy };
        const held = hostRef.current?.querySelector<HTMLElement>(`[data-widget="${CSS.escape(d.id)}"]`);
        if (held) held.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        /* LA DISPOSITION NE CHANGE QU'AU CHANGEMENT DE CASE (25/10/2026, Luc :
           « laggy »). Elle était recalculée et renvoyée au profil à CHAQUE
           mouvement de souris, qui redessinait alors tout l'aperçu. Entre deux
           cases, seul `offset` bouge : la carte suit la main, rien d'autre. */
        const cur = layoutRef.current.find((o) => o.i === d.id);
        if (cur && cur.x === nx && cur.y === ny) return;
        const moved = layoutRef.current.map((o) =>
          o.i === d.id ? { ...o, x: nx, y: ny } : o,
        );
        const next = compact(moved, d.id);
        layoutRef.current = next;
        setLive(next);
      } else {
        /* Le coin suit le curseur au pixel — c'est `offset` qui le fait, dans le
           rendu. Ici on ne s'occupe que de la case OÙ ÇA TOMBERA : elle est
           arrondie, elle repousse les voisins, et le fantôme la dessine. Sans
           ce partage des rôles le bloc avançait par bonds d'une colonne, avec
           200 ms de retard à chaque bond. */
        setOffset({ dx, dy });
        const b = boundsOf(d.id);
        const [nw, nh] = clampSize(
          Math.min(COLS - d.x, d.w + Math.round(dx / (cw + GAP))),
          d.h + Math.round(dy / (ROW + GAP)),
          b,
        );
        const cur = layoutRef.current.find((o) => o.i === d.id);
        if (!cur || (cur.w === nw && cur.h === nh)) return;
        const next = resizeItem(layoutRef.current, d.id, nw, nh, b);
        layoutRef.current = next;
        setLive(next);
      }
    },
    [boundsOf, width],
  );

  /* LE CONTENU D'UN BLOC QU'ON REDIMENSIONNE NE CLIGNOTE PLUS (25/10/2026,
     Luc). Enregistré à l'écran image par image : ce n'était pas le flou, c'était
     la LISTE DÉFILANTE du bloc (« En cours de visionnage ») qui manquait une
     image entière — Chrome peint une zone qui défile sur son propre calque, et
     ce calque, redimensionné à chaque mouvement, n'était pas toujours redessiné
     à temps. Le temps du geste, ces zones ne défilent donc plus (`hidden`, la
     position est gardée) : elles se peignent avec la carte. `scrollbar-gutter`
     garde la place de la barre, rien ne se décale. Seules celles qui défilent
     vraiment : les autres n'ont pas de calque à elles. */
  const resizingId = drag?.mode === "resize" ? drag.id : null;
  useIsoLayoutEffect(() => {
    if (!resizingId) return;
    const card = hostRef.current?.querySelector<HTMLElement>(
      `[data-widget="${CSS.escape(resizingId)}"]`,
    );
    if (!card) return;
    const frozen: HTMLElement[] = [];
    const freeze = (el: HTMLElement) => {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
        el.style.scrollbarGutter = "stable";
        el.style.overflowY = "hidden";
        frozen.push(el);
      }
    };
    for (const el of Array.from(card.querySelectorAll<HTMLElement>("*"))) freeze(el);
    /* ET LE CADRE QUI FAIT DÉFILER TOUT LE PROFIL (le studio, `.as-stage`) :
       second enregistrement, le contenu de TOUS les blocs manquait par carrés
       pendant une image, chaque fois que la grille se réorganisait — les tuiles
       pas encore redessinées d'une zone qui défile. La page elle-même
       (`scrollingElement`) n'est pas touchée. */
    for (let el = hostRef.current?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el !== document.scrollingElement) freeze(el);
    }
    return () => {
      for (const el of frozen) {
        el.style.overflowY = "";
        el.style.scrollbarGutter = "";
      }
    };
  }, [resizingId]);

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [drag, onMove, endDrag]);

  /* AU DOIGT, ATTRAPER UN BLOC DEMANDE UN APPUI LONG.
     Toute la carte est la poignée ; à la souris c'est sans ambiguïté, mais au
     doigt les blocs couvrent tout l'aperçu, et un doigt posé dessus ne pouvait
     plus faire défiler le profil jusqu'aux blocs du bas. Un glisser direct
     défile donc (`touch-action: pan-y`), et un appui immobile de ~0,3 s attrape
     le bloc ; ensuite le défilement est bloqué tant qu'on le tient (écouteur
     `touchmove` non passif, posé dès l'édition pour être là au premier
     contact). La souris garde le glisser immédiat. */
  const touchArm = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const disarm = () => {
    if (touchArm.current) clearTimeout(touchArm.current.timer);
    touchArm.current = null;
  };
  useEffect(() => {
    if (!editing) return;
    const host = hostRef.current;
    if (!host) return;
    const block = (e: TouchEvent) => {
      if (dragRef.current) e.preventDefault();
    };
    const onMoveArm = (e: PointerEvent) => {
      const a = touchArm.current;
      if (a && Math.hypot(e.clientX - a.x, e.clientY - a.y) > 8) disarm();
    };
    host.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("pointermove", onMoveArm);
    window.addEventListener("pointerup", disarm);
    window.addEventListener("pointercancel", disarm);
    return () => {
      disarm();
      host.removeEventListener("touchmove", block);
      window.removeEventListener("pointermove", onMoveArm);
      window.removeEventListener("pointerup", disarm);
      window.removeEventListener("pointercancel", disarm);
    };
  }, [editing]);

  function startDrag(id: string, mode: Drag["mode"], e: React.PointerEvent) {
    if (!editing || e.button !== 0) return;
    const it = layoutRef.current.find((o) => o.i === id);
    if (!it) return;
    if (mode === "move" && e.pointerType === "touch") {
      // Pas de preventDefault ni de stopPropagation : si le doigt bouge avant
      // l'échéance, c'est un défilement, et il doit rester possible.
      disarm();
      const x = e.clientX;
      const y = e.clientY;
      touchArm.current = {
        id,
        x,
        y,
        timer: setTimeout(() => {
          touchArm.current = null;
          navigator.vibrate?.(10);
          beginDrag(id, mode, x, y);
        }, 300),
      };
      return;
    }
    e.preventDefault();
    /* Attraper une carte referme le panneau. L'écouteur `window` ci-dessus ne
       peut pas s'en charger : ce `stopPropagation`-ci coupe aussi l'événement
       natif, donc il ne remonte jamais jusqu'à lui. */
    e.stopPropagation();
    beginDrag(id, mode, e.clientX, e.clientY);
  }

  function beginDrag(id: string, mode: Drag["mode"], sx: number, sy: number) {
    const it = layoutRef.current.find((o) => o.i === id);
    if (!it) return;
    setSettings(null);
    const started: Drag = {
      id,
      mode,
      sx,
      sy,
      k: (() => {
        const host = hostRef.current;
        const k = host && host.offsetWidth ? host.getBoundingClientRect().width / host.offsetWidth : 1;
        return k > 0 ? k : 1;
      })(),
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
    };
    dragRef.current = started;
    moveRef.current = { dx: 0, dy: 0 };
    /* Le temps du geste, les animations en boucle du profil se figent
       (`html.as-dragging`, globals.css ; le mur d'animés, AnimeWall) : chacune
       repeint sous les cartes floutées, donc refait leur flou à chaque image. */
    document.documentElement.classList.add("as-dragging");
    /* La transition qu'un glissement FLIP a pu laisser sur la carte : tenue,
       elle doit suivre la main et le coin sans retard. */
    const el = hostRef.current?.querySelector<HTMLElement>(`[data-widget="${CSS.escape(id)}"]`);
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
    }
    setOffset({ dx: 0, dy: 0 });
    setDrag(started);
  }

  const rows = rowCount(shown);
  /* TELEPHONE, EN LECTURE : UNE COLONNE. Quatre colonnes dans ~360 px, ce sont
     des blocs de 77 px — titres tronqués, contenus écrasés. Hors édition et
     sous 600 px, les blocs s'empilent dans l'ordre de lecture de la grille
     (ligne, puis colonne), chacun sur toute la largeur et à sa hauteur. La
     disposition enregistrée n'est pas touchée : en édition (le studio) on range
     la vraie grille, celle que voient les visiteurs sur PC. */
  const stacked = !editing && width > 0 && width < 600;
  const stackRects = new Map<string, { left: number; top: number; width: number; height: number }>();
  let stackH = 0;
  if (stacked) {
    for (const it of shown.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
      const h = it.h * ROW + (it.h - 1) * GAP;
      stackRects.set(it.i, { left: 0, top: stackH, width, height: h });
      stackH += h + GAP;
    }
    stackH = Math.max(0, stackH - GAP);
  }
  const height = stacked
    ? stackH
    : Math.max(
        0,
        rows * (ROW + GAP) - GAP + (editing ? ROW * 0.5 : 0),
      );
  const dragged = drag ? shown.find((o) => o.i === drag.id) : null;

  /* Ce que le bloc tenu sous le curseur mesure À L'INSTANT, avant arrondi.
     Déplacer : sa case ne bouge pas tant qu'on n'a pas franchi la moitié d'une
     colonne, mais le bloc, lui, suit la main. Redimensionner : pareil pour le
     coin. Les deux se calculent depuis le rectangle de DÉPART — celui de la
     disposition a déjà sauté à la case suivante, s'en servir ferait rebondir le
     bloc à chaque franchissement. */
  function livePixels(it: GridItem) {
    const s = stackRects.get(it.i);
    if (s) return s;
    const rect = pixelRect(it, width || 1);
    if (!drag || drag.id !== it.i) return rect;
    const start = pixelRect(
      { i: it.i, x: drag.x, y: drag.y, w: drag.w, h: drag.h },
      width || 1,
    );
    if (drag.mode === "move") {
      return { ...start, left: start.left + moveRef.current.dx, top: start.top + moveRef.current.dy };
    }
    /* Le coin ne tire pas plus loin que ce que le bloc accepte : la carte
       s'arrête net à sa borne au lieu de suivre la main puis de revenir en
       arrière au relâchement. */
    const cw = columnWidth(width || 1);
    const b = boundsOf(it.i);
    const px = (n: number) => n * cw + (n - 1) * GAP;
    const py = (n: number) => n * ROW + (n - 1) * GAP;
    return {
      ...start,
      width: Math.min(
        (width || 1) - start.left,
        px(Math.min(b.maxW, COLS - drag.x)),
        Math.max(px(b.minW), start.width + offset.dx),
      ),
      height: Math.min(py(b.maxH), Math.max(py(b.minH), start.height + offset.dy)),
    };
  }

  return (
    <div ref={hostRef} className={`relative w-full ${drag ? "as-grid-dragging" : ""}`} style={{ height }}>
      {/* Où le bloc tombera s'il est lâché maintenant — pour un déplacement
          comme pour un redimensionnement. C'est le seul repère qui dit la
          vérité pendant que le bloc lui-même flotte sous le curseur, et il
          glisse d'une case à l'autre au lieu d'y apparaître. */}
      {/* POUSSÉ DE 2 PX VERS LE HAUT ET LA GAUCHE (25/10/2026, Luc) : le
          repère et la carte tenue partagent le même coin haut-gauche, donc ses
          pointillés de ces deux côtés passaient sous le bord de la carte et
          ne se voyaient presque plus, quand ceux du bas et de droite, qui
          suivent la souris, dépassaient. */}
      {dragged
        ? (() => {
            const r = pixelRect(dragged, width || 1);
            return (
              <div
                /* AU COMPOSITEUR (25/10/2026) : il glissait en animant
                   `left/top`, donc mise en page et repeint à chaque image, juste
                   SOUS la carte floutée. Posé en (0, 0), il se déplace par
                   `transform` ; seule sa taille (redimensionnement) anime encore
                   la mise en page. */
                className="pointer-events-none absolute left-0 top-0 z-0 rounded-[22px] border-2 border-dashed border-action/50 bg-action/10 transition-[transform,width,height] duration-100 ease-out"
                /* …et de 2 px vers le bas et la droite, même demande. */
                style={{
                  transform: `translate3d(${r.left - 2}px, ${r.top - 2}px, 0)`,
                  width: r.width + 4,
                  height: r.height + 4,
                }}
              />
            );
          })()
        : null}

      {shown.map((it) => {
        /* PENDANT UN GESTE, LE CONTENU DES BLOCS EST CELUI DE L'IMAGE D'AVANT
           (25/10/2026, Luc : déplacer « pas smooth »). Chaque mouvement
           redessine la grille, et `renderBlock` recréait le contenu de TOUS les
           blocs — radar, frise, vignettes —, que React refaisait en entier.
           Rendre le MÊME objet le lui fait sauter. Seul le bloc qu'on
           redimensionne est refait : sa taille change, son contenu s'y adapte. */
        const reuse = drag && !(drag.mode === "resize" && drag.id === it.i);
        const chrome = (reuse && chromeCache.current.get(it.i)) || renderBlock(it.i);
        if (chrome) chromeCache.current.set(it.i, chrome);
        if (!chrome) return null;
        const rect = livePixels(it);
        const active = drag?.id === it.i;
        const sig = [
          Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height),
          active ? drag?.mode : "", editing, contentEdit === it.i, settings === it.i, !!width,
        ].join("|");
        const hit = cardCache.current.get(it.i);
        /* La carte tenue est toujours refaite : sa position vient de `moveRef`. */
        if (!active && hit && hit.chrome === chrome && hit.sig === sig) return hit.el;
        const el = (
          <section
            key={it.i}
            data-widget={it.i}
            /* LA CARTE ENTIÈRE EST LA POIGNÉE, comme react-grid-layout sans
               `draggableHandle` : on attrape un bloc là où on le voit, pas là
               où une barre invisible le permet. Ce qui doit y échapper le fait
               en arrêtant la propagation du pointerdown — le coin de
               redimensionnement (dans startDrag) et le moins — ce qui est
               exactement le rôle du `draggableCancel` de la bibliothèque. */
            onPointerDown={(e) => startDrag(it.i, "move", e)}
            /* `as-widget` fait de la carte un CONTENEUR DE REQUETE (styles/
               globals.css) : le contenu d'un bloc peut alors grandir avec la
               taille qu'on lui a donnee, sans que ni la grille ni le bloc n'aient
               à se dire quoi que ce soit. */
            /* LE LISERÉ EST UN `outline` RENTRÉ D'UN PIXEL, pas un `ring`
               (24/10/2026, Luc : bords bleus nets en bas et à droite, pas à
               gauche ni en haut). Un ring est une ombre peinte HORS de la
               boîte : contre le bord de la grille il se faisait rogner à
               gauche et en haut. Un ring rentré (`inset`) n'aurait pas suffi :
               peint avec le fond de la carte, il passe SOUS le calque de flou
               (`::before`) qui le floute. L'outline se peint par-dessus tout,
               et il suit l'arrondi. */
            className={`as-widget absolute flex flex-col overflow-hidden rounded-[20px] px-5 py-4 outline outline-1 outline-offset-[-1px] ${
              /* En édition, la carte garde SA transparence (`as-stat-card`, la
                 même qu'en lecture) : on range le profil tel qu'il sera vu. Elle
                 ne fonce qu'au survol ou tenue, pour dire « c'est celle-ci
                 qu'on attrape ». Le liseré bleu dit le mode. */
              editing
                ? /* Le bleu du mode édition : celui que le ring donnait par
                     défaut (Tailwind, blue-500 à 50 %), gardé à la demande de
                     Luc (24/10/2026) — `ring-action/40` ne produisait rien. */
                  `as-stat-card as-widget-edit outline-blue-500/50 ${
                    active ? "is-held" : ""
                  } ${active && drag?.mode !== "move" ? "is-resizing" : ""} ${active && drag?.mode === "move" ? "cursor-grabbing" : "cursor-grab"}`
                : "as-stat-card outline-white/10"
            } ${
              /* AUCUNE transition sur le bloc tenu : il est déjà à la position
                 du curseur, l'animer ferait traîner la main. Les autres, qui se
                 réorganisent autour de lui, ont les 200 ms — c'est exactement le
                 partage que fait react-grid-layout entre `.react-grid-item` et
                 `.react-grid-item.react-draggable-dragging`. */
              active
                ? "z-30 shadow-[0_26px_60px_rgba(0,0,0,0.65)]"
                : /* Et AUCUNE transition tant que la largeur n'est pas connue :
                     sinon le premier vrai placement s'anime depuis la
                     disposition d'un pixel, ce qui est le glissement qu'on
                     cherche justement a supprimer. */
                  /* PENDANT UN GESTE, LES AUTRES BLOCS NE SE SURVOLENT PAS
                     (25/10/2026, Luc : « le widget de personnages s'assombrit
                     plusieurs fois ») : c'est la classe `as-grid-dragging` du
                     conteneur qui le dit (globals.css), une seule pour toutes
                     les cartes — une classe par carte les refaisait toutes. */
                  `z-10 ${width ? "transition-[width,height] duration-200 ease-in-out" : ""}`
            }`}
            style={{
              /* LA CARTE TENUE SE DÉPLACE PAR `transform` (25/10/2026, Luc :
                 « laggy »). En `left`/`top`, chaque mouvement refaisait la mise
                 en page de la grille et repeignait la carte et son flou ; en
                 `transform` elle garde sa place de départ et c'est le
                 compositeur qui la promène. */
              ...(active && drag?.mode === "move"
                ? (() => {
                    const start = pixelRect({ i: it.i, x: drag.x, y: drag.y, w: drag.w, h: drag.h }, width || 1);
                    return {
                      left: Math.round(start.left),
                      top: Math.round(start.top),
                      transform: `translate3d(${moveRef.current.dx}px, ${moveRef.current.dy}px, 0)`,
                      willChange: "transform",
                    };
                  })()
                : { left: Math.round(rect.left), top: Math.round(rect.top) }),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              /* Le HTML du serveur porte forcement la disposition d'un pixel —
                 il n'a pas de fenetre a mesurer. On le laisse occuper sa place
                 (la hauteur du conteneur, elle, ne depend pas de la largeur)
                 mais on ne le montre pas : la premiere image visible est deja
                 la bonne. */
              visibility: width ? undefined : "hidden",
              /* Au doigt : un glisser vertical défile l'aperçu, un appui long
                 attrape le bloc (cf. `touchArm`). Sans effet à la souris. */
              touchAction: editing ? "pan-y" : undefined,
              /* La taille FIXE du calque de flou pendant un redimensionnement
                 (cf. `.is-resizing` dans globals.css) : jusqu'au bord droit de
                 la grille, et un écran de plus que la hauteur. */
              ...(active && drag?.mode === "resize"
                ? ({
                    "--as-frost-w": `${Math.max(1, (width || 1) - Math.round(rect.left) - 2)}px`,
                    "--as-frost-h": `${
                      Math.round(
                        pixelRect({ i: it.i, x: drag.x, y: drag.y, w: drag.w, h: drag.h }, width || 1)
                          .height,
                      ) + window.innerHeight
                    }px`,
                    /* La taille de la carte, pour découper ce calque à SON arrondi. */
                    "--as-card-w": `${Math.round(rect.width)}px`,
                    "--as-card-h": `${Math.round(rect.height)}px`,
                  } as React.CSSProperties)
                : null),
            }}
          >
            <header
              /* `pr-14` dès que ce coin est occupé : en édition par la roue et
                 le moins (deux fois 28 px), hors édition par les commandes que
                 le bloc y pose lui-même (`endRoom`). Dans les deux cas elles
                 sont en position absolue, donc invisibles au calcul de largeur
                 du titre — sans la réservation, il passe dessous au lieu de
                 s'arrêter avant. */
              /* `relative z-[1]` : le titre passe AU-DESSUS de la lumière
                 d'ambiance du contenu (« Reprendre la lecture », 24/10/2026,
                 Luc), qui est positionnée et peinte après lui. Sous les
                 pastilles du coin (flamme, moyenne : z-10). */
              className={`relative z-[1] mb-3 flex shrink-0 items-center justify-between gap-2 ${
                editing && chrome.editor ? "pr-[5.25rem]" : editing || chrome.endRoom ? "pr-14" : ""
              }`}
            >
              {/* PAS DE PASTILLE DE COULEUR. Chaque bloc en portait une, et
                  réunies sur une grille elles faisaient une constellation de
                  points qui ne distinguait rien : le nom du bloc est écrit juste
                  à côté. La couleur reste où elle sert, sur les icônes de la
                  bibliothèque, où l'on choisit un bloc avant de savoir son nom. */}
              <h2 className="as-widget-head flex min-w-0 items-center gap-2 font-outfit text-lg font-bold text-white">
                {/* En réorganisation, le titre devient un champ — et le tireté
                    est ce qui le dit : c'est la convention du site pour « ceci
                    s'écrit », et elle évite un crayon de plus dans un en-tête
                    qui porte déjà la roue et le moins. Le champ garde la police
                    et la taille du titre, donc le nom ne saute pas en entrant
                    ni en sortant du mode.

                    `stopPropagation` sur le pointeur : sans lui, cliquer dans
                    le champ démarre le glissement de la carte qui le porte, et
                    on ne peut jamais poser le curseur. Même raison que pour le
                    moins et le coin. */}
                {editing && onRename ? (
                  <input
                    value={chrome.name ?? ""}
                    onChange={(e) => onRename(it.i, e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      /* Entrée et Échap rendent la main au clavier : la carte
                         écoute les flèches pour se déplacer, et taper un nom ne
                         doit pas la faire bouger. */
                      if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                      e.stopPropagation();
                    }}
                    placeholder={chrome.defaultName ?? ""}
                    maxLength={48}
                    aria-label={t("profile.widgets.rename")}
                    title={t("profile.widgets.rename")}
                    /* Le cadre épouse le TEXTE et ne traverse plus la carte :
                       une boîte vide de 300 px sous un mot de six lettres se
                       lisait comme une zone de saisie de formulaire, pas comme
                       un titre qu'on peut reprendre. `field-sizing` fait ça
                       exactement, `size` le fait approximativement partout
                       ailleurs — d'où les deux, l'un couvrant l'autre. */
                    size={Math.max(6, (chrome.name || chrome.defaultName || "").length)}
                    className="[field-sizing:content] w-auto min-w-0 max-w-full rounded-md border border-dashed border-white/25 bg-transparent px-2 py-0.5 font-outfit text-lg font-bold text-white outline-none transition-colors placeholder:text-white/35 hover:border-white/45 focus:border-action focus:bg-white/[0.06]"
                  />
                ) : (
                  <span className="truncate">{chrome.title}</span>
                )}
                {chrome.meta ? (
                  <span className="shrink-0 font-karla text-[11px] font-medium text-white/35">
                    {chrome.meta}
                  </span>
                ) : null}
              </h2>

            </header>

            {/* Le contenu devient inerte en édition. Les blocs sont pleins de
                liens et de boutons — une jaquette, un titre, « relancer » — et
                maintenant que la carte entière se glisse, chaque glissement
                partirait de l'un d'eux et finirait en navigation. Réorganiser,
                c'est ranger, pas parcourir : le contenu reste visible, il ne
                répond plus. Le moins et le coin sont ailleurs dans la carte, ils
                gardent le leur. */}
            {/* SAUF le bloc dont le contenu est en édition (le crayon) : il
                reprend la main, et un appui dedans n'attrape plus la carte. */}
            {contentEdit === it.i && chrome.editor ? (
              <div className="min-h-0 flex-1" onPointerDown={(e) => e.stopPropagation()}>
                {chrome.editor.node}
              </div>
            ) : (
              <div
                className={`min-h-0 flex-1 ${editing ? "select-none [&_*]:pointer-events-none" : ""}`}
              >
                {chrome.body}
              </div>
            )}

            {/* Retirer le bloc. Repris des cartes du graphe des relations
                (gStyles.nodeClose) : un MOINS, sans cadre ni fond, glissé dans
                le coin — « enlève celui-ci ». Une croix cerclée poserait une
                seconde pastille sur une carte qui en a déjà une, celle de la
                couleur du bloc, et se lirait comme un élément du bloc plutôt
                que comme une commande. */}
            {editing ? (
              <button
                type="button"
                /* Le `draggableCancel` du moins : sans lui, appuyer dessus
                   démarre un glissement de la carte qui le porte. */
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onLayout(compact(layoutRef.current.filter((o) => o.i !== it.i)))}
                aria-label={t("profile.widgets.remove")}
                title={t("profile.widgets.remove")}
                /* Le miroir exact du coin de redimensionnement : même boîte de
                   28 px, même retrait de 7 px, même gris. Les deux commandes de
                   la carte se répondent en diagonale au lieu de flotter chacune
                   à sa propre distance du bord. */
                className="absolute right-0 top-0 z-[2] flex h-7 w-7 items-start justify-end p-[7px] text-white/60 transition-colors hover:text-white"
              >
                <svg viewBox="0 -960 960 960" fill="currentColor" className="h-3 w-3">
                  <path d="M200-440v-80h560v80H200Z" />
                </svg>
              </button>
            ) : null}

            {/* Les réglages du bloc. Même boîte de 28 px que le moins, posée
                juste à sa gauche (`right-7`) : les deux commandes du coin se
                lisent comme une paire, pas comme deux trouvailles. */}
            {editing ? (
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setSettings((v) => (v === it.i ? null : it.i))}
                aria-label={t("profile.widgets.settings")}
                aria-expanded={settings === it.i}
                title={t("profile.widgets.settings")}
                className={`absolute right-7 top-0 z-[2] flex h-7 w-7 items-start justify-end p-[7px] transition-colors ${
                  settings === it.i ? "text-white" : "text-white/60 hover:text-white"
                }`}
              >
                <svg viewBox="0 -960 960 960" fill="currentColor" className="h-3.5 w-3.5">
                  <path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z" />
                </svg>
              </button>
            ) : null}

            {/* Le crayon, à gauche de la roue (`right-14`), même boîte de 28 px :
                il édite le CONTENU du bloc, la roue en règle l'affichage. */}
            {editing && chrome.editor ? (
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setSettings(null);
                  setContentEdit((v) => (v === it.i ? null : it.i));
                }}
                aria-label={chrome.editor.label}
                aria-pressed={contentEdit === it.i}
                title={chrome.editor.label}
                className={`absolute right-14 top-0 z-[2] flex h-7 w-7 items-start justify-end p-[7px] transition-colors ${
                  contentEdit === it.i ? "text-action" : "text-white/60 hover:text-white"
                }`}
              >
                {/* Le crayon plein de Material (« edit »), même famille que la
                    roue posée juste à droite. */}
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                </svg>
              </button>
            ) : null}

            {editing ? (
              <div
                onPointerDown={(e) => startDrag(it.i, "resize", e)}
                title={t("profile.widgets.resize")}
                className="absolute bottom-0 right-0 flex h-7 w-7 cursor-nwse-resize items-end justify-end p-[7px]"
                style={{ touchAction: "none" }}
              >
                <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" className="h-3 w-3 text-white/60">
                  <path d="M9.2 1v8.2H1" />
                  <path d="M9.2 5.4H5.4v3.8" />
                </svg>
              </div>
            ) : null}
          </section>
        );
        cardCache.current.set(it.i, { chrome, sig, el });
        return el;
      })}

      {/* LE PANNEAU DE RÉGLAGES, AU-DESSUS DE SA CARTE.
          Frère des cartes et non enfant de l'une d'elles : une carte coupe ce
          qui dépasse, celle-ci le tronquerait. Il retrouve sa carte par
          `livePixels`, la même mesure que les cartes utilisent — donc il la
          suit jusque pendant un déplacement, au lieu de rester en arrière.

          POSÉ AU-DESSUS, PAS DESSUS, ET SANS EXCEPTION. Il s'ouvrait sur la
          carte, sous la roue : il cachait précisément le bloc qu'on est en train
          de régler, ce qui est absurde quand le réglage change son apparence —
          on bascule la lumière d'ambiance sans voir la vignette qu'elle éclaire.
          Il est donc calé sur le BORD SUPÉRIEUR de la carte, par `bottom` : sa
          hauteur dépend du nombre d'interrupteurs et n'est pas mesurable au
          rendu, alors qu'ancré par le bas elle n'a pas besoin de l'être.

          Un repli sous la carte pour la première ligne a été essayé et retiré :
          la première ligne est justement celle qu'on règle le plus souvent, et
          le repli y ramenait exactement le défaut qu'on venait de corriger. La
          place existe — la grille a la barre d'outils et le bandeau du mode
          réorganisation au-dessus d'elle, que le panneau recouvre le temps qu'il
          est ouvert. Rien ici ne coupe : le conteneur ne masque pas ce qui
          déborde.

          Sa largeur suit la carte, entre 240 et 320 px — un bloc de quatre
          colonnes n'a pas besoin d'un panneau de 1 000 px de large. (180-260
          jusqu'au 25/10/2026, élargi avec ses textes : illisible, dit Luc.) */}
      {(() => {
        const it = editing && settings ? shown.find((o) => o.i === settings) : null;
        if (!it) return null;
        const rect = livePixels(it);
        const w = Math.max(240, Math.min(320, rect.width - 16));
        return (
          <div
            ref={panelRef}
            onPointerDown={(e) => e.stopPropagation()}
            className="as-widget-pop absolute z-40 origin-bottom-right"
            style={{
              left: Math.round(rect.left + rect.width - 8 - w),
              // Depuis le bas du conteneur, seul repère qui ne demande pas de
              // connaître la hauteur du panneau.
              bottom: Math.round(height - rect.top + 8),
              width: w,
            }}
          >
            <WidgetSettings
              options={options?.(it.i) ?? []}
              onOption={(key, value) => onOption?.(it.i, key, value)}
              onClose={() => setSettings(null)}
            />
          </div>
        );
      })()}
    </div>
  );
}
