import { useCallback, useEffect, useRef, useState } from "react";
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
  title: string;
  /** Petite ligne grise à côté du titre (« 5 », « cette semaine »…). */
  meta?: string | null;
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
      /** `color` peint la pastille du choix — celle de sa liste, à l'identique
       *  de l'éditeur de liste. `heart` la remplace par un cœur, pour les
       *  favoris, qui ne sont pas une liste comme les autres. */
      choices: { value: string; label: string; color?: string; heart?: boolean }[];
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
  const panelRef = useRef<HTMLDivElement | null>(null);

  /* La largeur du conteneur EST l'unité de la grille : sans elle rien ne peut
     être placé, et elle change avec la fenêtre comme avec un panneau latéral. */
  useEffect(() => {
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
      if (delta) window.scrollBy({ top: delta, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [settings]);

  /* La disposition en cours est lue dans un ref pendant un glissement : les
     handlers sont posés une fois sur window et ne doivent pas dépendre d'un
     état recréé à chaque mouvement. */
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    setOffset({ dx: 0, dy: 0 });
    if (d) onLayout(compact(layoutRef.current));
  }, [onLayout]);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const cw = columnWidth(width || 1);
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (d.mode === "move") {
        const nx = Math.min(COLS - d.w, Math.max(0, d.x + Math.round(dx / (cw + GAP))));
        const ny = Math.max(0, d.y + Math.round(dy / (ROW + GAP)));
        const moved = layoutRef.current.map((o) =>
          o.i === d.id ? { ...o, x: nx, y: ny } : o,
        );
        setOffset({ dx, dy });
        onLayout(compact(moved, d.id));
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
        onLayout(resizeItem(layoutRef.current, d.id, nw, nh, b));
      }
    },
    [boundsOf, onLayout, width],
  );

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

  function startDrag(id: string, mode: Drag["mode"], e: React.PointerEvent) {
    if (!editing || e.button !== 0) return;
    const it = layout.find((o) => o.i === id);
    if (!it) return;
    e.preventDefault();
    /* Attraper une carte referme le panneau. L'écouteur `window` ci-dessus ne
       peut pas s'en charger : ce `stopPropagation`-ci coupe aussi l'événement
       natif, donc il ne remonte jamais jusqu'à lui. */
    e.stopPropagation();
    setSettings(null);
    const started: Drag = {
      id,
      mode,
      sx: e.clientX,
      sy: e.clientY,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
    };
    dragRef.current = started;
    setOffset({ dx: 0, dy: 0 });
    setDrag(started);
  }

  const rows = rowCount(layout);
  const height = Math.max(
    0,
    rows * (ROW + GAP) - GAP + (editing ? ROW * 0.5 : 0),
  );
  const dragged = drag ? layout.find((o) => o.i === drag.id) : null;

  /* Ce que le bloc tenu sous le curseur mesure À L'INSTANT, avant arrondi.
     Déplacer : sa case ne bouge pas tant qu'on n'a pas franchi la moitié d'une
     colonne, mais le bloc, lui, suit la main. Redimensionner : pareil pour le
     coin. Les deux se calculent depuis le rectangle de DÉPART — celui de la
     disposition a déjà sauté à la case suivante, s'en servir ferait rebondir le
     bloc à chaque franchissement. */
  function livePixels(it: GridItem) {
    const rect = pixelRect(it, width || 1);
    if (!drag || drag.id !== it.i) return rect;
    const start = pixelRect(
      { i: it.i, x: drag.x, y: drag.y, w: drag.w, h: drag.h },
      width || 1,
    );
    if (drag.mode === "move") {
      return { ...start, left: start.left + offset.dx, top: start.top + offset.dy };
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
    <div ref={hostRef} className="relative w-full" style={{ height }}>
      {/* Où le bloc tombera s'il est lâché maintenant — pour un déplacement
          comme pour un redimensionnement. C'est le seul repère qui dit la
          vérité pendant que le bloc lui-même flotte sous le curseur, et il
          glisse d'une case à l'autre au lieu d'y apparaître. */}
      {dragged ? (
        <div
          className="pointer-events-none absolute z-0 rounded-[20px] border-2 border-dashed border-action/50 bg-action/10 transition-[left,top,width,height] duration-100 ease-out"
          style={pixelRect(dragged, width || 1)}
        />
      ) : null}

      {layout.map((it) => {
        const chrome = renderBlock(it.i);
        if (!chrome) return null;
        const rect = livePixels(it);
        const active = drag?.id === it.i;
        return (
          <section
            key={it.i}
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
            className={`as-widget absolute flex flex-col overflow-hidden rounded-[20px] px-5 py-4 ring-1 ${
              editing
                ? `bg-[#13141b]/95 ring-action/40 ring-dashed ${
                    active && drag?.mode === "move" ? "cursor-grabbing" : "cursor-grab"
                  }`
                : "as-stat-card ring-white/10"
            } ${
              /* AUCUNE transition sur le bloc tenu : il est déjà à la position
                 du curseur, l'animer ferait traîner la main. Les autres, qui se
                 réorganisent autour de lui, ont les 200 ms — c'est exactement le
                 partage que fait react-grid-layout entre `.react-grid-item` et
                 `.react-grid-item.react-draggable-dragging`. */
              active
                ? "z-30 shadow-[0_26px_60px_rgba(0,0,0,0.65)]"
                : "z-10 transition-[left,top,width,height] duration-200 ease-in-out"
            }`}
            style={{
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              // Sans quoi un glissement au doigt fait défiler la page.
              touchAction: editing ? "none" : undefined,
            }}
          >
            <header
              /* `pr-14` en édition : la roue et le moins occupent ce coin sur
                 deux fois 28 px, et un titre assez long pour les atteindre
                 passerait dessous. */
              className={`mb-3 flex shrink-0 items-center justify-between gap-2 ${
                editing ? "pr-14" : ""
              }`}
            >
              {/* PAS DE PASTILLE DE COULEUR. Chaque bloc en portait une, et
                  réunies sur une grille elles faisaient une constellation de
                  points qui ne distinguait rien : le nom du bloc est écrit juste
                  à côté. La couleur reste où elle sert, sur les icônes de la
                  bibliothèque, où l'on choisit un bloc avant de savoir son nom. */}
              <h2 className="as-widget-head flex min-w-0 items-center gap-2 font-outfit text-lg font-bold text-white">
                <span className="truncate">{chrome.title}</span>
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
            <div
              className={`min-h-0 flex-1 ${editing ? "select-none [&_*]:pointer-events-none" : ""}`}
            >
              {chrome.body}
            </div>

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
                onClick={() => onLayout(compact(layout.filter((o) => o.i !== it.i)))}
                aria-label={t("profile.widgets.remove")}
                title={t("profile.widgets.remove")}
                /* Le miroir exact du coin de redimensionnement : même boîte de
                   28 px, même retrait de 7 px, même gris. Les deux commandes de
                   la carte se répondent en diagonale au lieu de flotter chacune
                   à sa propre distance du bord. */
                className="absolute right-0 top-0 flex h-7 w-7 items-start justify-end p-[7px] text-white/60 transition-colors hover:text-white"
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
                className={`absolute right-7 top-0 flex h-7 w-7 items-start justify-end p-[7px] transition-colors ${
                  settings === it.i ? "text-white" : "text-white/60 hover:text-white"
                }`}
              >
                <svg viewBox="0 -960 960 960" fill="currentColor" className="h-3.5 w-3.5">
                  <path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z" />
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

          Sa largeur suit la carte, plafonnée à 260 px — un bloc de quatre
          colonnes n'a pas besoin d'un panneau de 1 000 px de large. */}
      {(() => {
        const it = editing && settings ? layout.find((o) => o.i === settings) : null;
        if (!it) return null;
        const rect = livePixels(it);
        const w = Math.max(180, Math.min(260, rect.width - 16));
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
