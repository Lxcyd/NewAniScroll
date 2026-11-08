import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { notify } from "@/lib/notifications/noticeStore";

import WidgetGrid, { type BlockChrome, type WidgetOption } from "./WidgetGrid";
import BlockLibrary from "./BlockLibrary";
import { EmptyBlock } from "./widgets/common";
import { CharactersBlock } from "./widgets/CharactersBlock";
import {
  FavoritesBlock,
  YearsBlock,
  GenresBlock,
  ScoresBlock,
  SeasonBlock,
  StatusesBlock,
  StudiosBlock,
} from "./widgets/ListBlocks";
import { RecentsBlock, ResumeBlock } from "./widgets/DeviceBlocks";
import {
  customListColor,
  listLabel,
  LIST_COLORS,
  STATUS_TO_LIST,
} from "@/components/anime/v2/helpers";
import { CUSTOM_PREFIX, customListNames } from "@/lib/profile/insights";
import type { ActivityRow, WatchDays } from "@/lib/profile/activity";
import type { ProgressEntry } from "@/lib/watch/progress";
import { CalendarBlock } from "./widgets/CalendarBlock";
import { HeatmapBlock } from "./widgets/HeatmapBlock";
import {
  AffinityBlock,
  AffinityEditor,
  parseTags,
  BingeBlock,
  BingoBlock,
  GoalBlock,
  PinnedBlock,
  ThemesBlock,
  parsePins,
  parseThemes,
} from "./widgets/ExtraBlocks";
import { useLocalDays } from "./widgets/CalendarBlock";
import { favsOf, rememberMe, tasteOf } from "@/lib/profile/affinity";
import { sendMyTaste } from "@/lib/friends/client";
import type { Binge } from "@/lib/profile/activity";
import {
  BLOCKS,
  DEFAULT_LAYOUT,
  blockBounds,
  blockDef,
  blockOption,
  blockOptionList,
  blockOptionNumber,
  blockOptionRange,
  blockOptionValue,
  blockOptions,
  blockSize,
  blockType,
  isKnownBlock,
  nextInstance,
  visibleTo,
} from "@/lib/profile/blocks";
import {
  MAX_VALUE as MAX_NAME,
  GAP,
  ROW,
  addItem,
  compact,
  pixelRect,
  rowCount,
  sanitizeLayout,
  type GridItem,
} from "@/lib/profile/grid";
import { setProfileLayout, useProfileLayout } from "@/lib/prefs/profileLayout";
import {
  NO_WIDGETS,
  publishWidgets,
  useWidgetsMenuOpen,
  WIDGETS_MENU_EVENT,
  WIDGETS_RESET_EVENT,
  type WidgetPreview,
} from "@/lib/profile/widgetBridge";
import WidgetAddIcon from "./WidgetAddIcon";
import type { ProfileCharacter, ProfileEntry, ProfileTitle } from "@/lib/profile/types";

/** Les exemples du menu Widgets : les FAVORIS AniList d'abord (08/11/2026,
    Luc), puis les titres les mieux notés, les titres finis ou en cours à
    défaut de note. */
function sampleEntries(entries: ProfileEntry[], n: number): ProfileEntry[] {
  const rank = (e: ProfileEntry) =>
    (e.favourite ? 1000 : 0) +
    (e.score ?? 0) * 10 +
    (e.status === "COMPLETED" ? 2 : e.status === "CURRENT" ? 1 : 0);
  return entries
    .filter((e) => e.status !== "PLANNING")
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, n);
}

/**
 * L'onglet « Aperçu » : la grille de widgets du profil, sa barre d'outils et
 * sa bibliothèque de blocs.
 *
 * Trois choses seulement vivent ici — quel bloc peint quoi, qui a le droit de
 * réorganiser, et d'où vient la disposition. La géométrie est dans
 * lib/profile/grid.ts et chaque widget dans son propre fichier.
 *
 * LA DISPOSITION APPARTIENT AU PROFIL, PAS AU LECTEUR.
 *
 * Elle vivait dans `aniscroll:profileLayout`, une clé locale sauvegardée avec
 * la catégorie `prefs` — c'est-à-dire chez celui qui REGARDE. Un visiteur
 * voyait donc, au mieux, sa propre disposition, et le code s'en protégeait en
 * lui servant la grille par défaut : ce que le propriétaire rangeait, personne
 * d'autre ne le voyait jamais, et deux propriétaires partageant un navigateur
 * se marchaient dessus. Elle est maintenant une colonne de `users`
 * (`profile_layout`), lue au rendu serveur et servie à tout le monde, à côté de
 * `profile_banner` qui est publique pour exactement la même raison.
 *
 * Les deux vues montrent maintenant les MÊMES blocs, activité de lecture
 * comprise : celle-ci arrive par la prop `activity`, reconstruite au rendu
 * serveur depuis la sauvegarde du propriétaire. Ce qui change d'un côté à
 * l'autre n'est donc plus la liste des blocs mais la source de deux d'entre
 * eux, et la formulation des textes qui tutoyaient le lecteur.
 *
 * `lib/prefs/profileLayout.ts` reste, pour le seul cas qui n'a pas de compte :
 * le profil local d'un invité (components/profile/LocalProfile.tsx).
 */

type Props = {
  entries: ProfileEntry[];
  characters: ProfileCharacter[];
  isOwner: boolean;
  /** La disposition rangée par le propriétaire DU PROFIL, lue sur sa ligne
   *  `users` au rendu serveur. `null` : rien de rangé, la disposition par
   *  défaut. `undefined` : il n'y a pas de compte derrière — le profil local
   *  d'un invité — et la disposition reste alors celle de l'appareil. */
  accountLayout?: GridItem[] | null;
  /** L'activité de lecture DU PROPRIÉTAIRE, reconstruite au rendu serveur
   *  depuis sa sauvegarde de compte. Sert aux blocs `resume` et `recents` quand
   *  le lecteur n'est pas chez lui : sans elle ils liraient le localStorage de
   *  CE navigateur et afficheraient sa lecture à lui sous le nom d'un autre.
   *  Le propriétaire, lui, garde sa source locale — elle est plus fraîche que
   *  la dernière synchronisation, et elle se met à jour pendant qu'il regarde. */
  activity?: ActivityRow[] | null;
  /** Chez soi : la progression du compte et du fil AniList, que « Vu
   *  récemment » mêle à celle du navigateur (pages/en/profile/[user].tsx). */
  ownerProgress?: Record<string, ProgressEntry> | null;
  /** Les jours consécutifs de lecture DU PROPRIÉTAIRE, comptés au rendu serveur
   *  en même temps que `activity`. Chez lui, le bloc les recompte dans son
   *  navigateur : un jour de série est un jour de calendrier, donc il dépend du
   *  fuseau, et celui du serveur n'est pas le sien. */
  streak?: number | null;
  /** Les jours de lecture DU PROPRIÉTAIRE pour le calendrier (visiteur). */
  watchDays?: WatchDays | null;
  /** Son plus long binge, compté au rendu serveur (visiteur). */
  binge?: Binge | null;
  /** Ses badges obtenus (id → date), pour « Badges & succès ». */
  earned?: Record<string, number> | null;
  /** Qui est ce profil : l'affinité range sa liste sous ce nom (visiteur). */
  who?: { name: string; avatar: string | null; tag?: string | null } | null;
  /** Une note cliquée dans l'histogramme. La page bascule alors sur son onglet
   *  « Ma liste », filtrée sur cette note — et sur les titres terminés quand le
   *  bloc est réglé ainsi, sans quoi la liste montrerait des titres que la
   *  colonne cliquée ne comptait pas. Absent sur le profil d'un autre. */
  onPickScore?: (score: number, completedOnly: boolean) => void;
  /**
   * Le mode édition, quand la PAGE le tient : il est alors le même que celui
   * du studio (fond, musique, cadre), dont le dock porte « Enregistrer ». Le
   * bouton d'ici ne sert plus qu'à y entrer.
   */
  editing?: boolean;
  onEditingChange?: (on: boolean) => void;
  /** L'onglet « Statistiques » (07/11/2026, Luc) : la même grille, avec un
   *  jeu de blocs FIXE (STATS_LAYOUT) — on les déplace, on les redimensionne,
   *  on les règle, mais on n'en ajoute ni n'en retire. Disposition gardée dans
   *  le localStorage de cet appareil (STATS_KEY), chez soi seulement. */
  variant?: "stats";
};

const STATS_KEY = "aniscroll:statsTabLayoutTmp";
/* La disposition de Luc (07/11/2026, « garde cette organisation par défaut »). */
const STATS_LAYOUT: readonly GridItem[] = [
  { i: "statuses", x: 0, y: 0, w: 2, h: 1 },
  { i: "heatmap", x: 2, y: 0, w: 2, h: 1 },
  { i: "genres", x: 0, y: 1, w: 2, h: 2 },
  { i: "scores", x: 2, y: 1, w: 2, h: 1 },
  { i: "studios", x: 2, y: 2, w: 2, h: 1 },
  { i: "years", x: 0, y: 3, w: 4, h: 1 },
];
const STATS_IDS = new Set(STATS_LAYOUT.map((o) => o.i));

/** Une disposition rangée, ramenée au jeu fixe : les blocs en trop partent,
 *  ceux qui manquent reviennent à leur taille par défaut. */
function statsLayout(saved: GridItem[]): GridItem[] {
  let out = sanitizeLayout(saved, (id) => STATS_IDS.has(id), blockBounds);
  for (const d of STATS_LAYOUT) if (!out.some((o) => o.i === d.i)) out = addItem(out, d.i, d.w, d.h);
  return out;
}

/**
 * CE QUE LE PROPRIÉTAIRE VIENT DE RANGER, GARDÉ POUR LA DURÉE DE LA PAGE.
 *
 * Le bug qu'il corrige : « Aperçu » et « Ma liste » sont deux ONGLETS de la même
 * page, rendus par un ternaire (`pages/en/profile/[user].tsx`). Changer d'onglet
 * DÉMONTE cette grille, et y revenir la remonte — avec, comme point de départ,
 * la prop `accountLayout` du rendu serveur, qui date du chargement de la page et
 * ne bouge plus. La carte qu'on venait d'agrandir retrouvait donc sa taille
 * d'avant, alors même que le serveur, lui, avait bien reçu la nouvelle.
 *
 * Ce n'est donc pas une écriture qui manquait mais une LECTURE qui mentait, et
 * aucune correction du côté de l'envoi ne pouvait y changer quoi que ce soit.
 *
 * Hors du composant, parce que le composant est justement ce qui disparaît. Et
 * seulement pour le propriétaire : lui seul écrit, et une session n'a qu'un
 * compte — un profil visité n'y touche ni ne le lit.
 *
 * `{ items: null }` n'est pas l'absence de cache : c'est « remis par défaut »,
 * et la nuance est ce qui fait tenir le bouton de réinitialisation.
 */
let ownLayout: { items: GridItem[] | null } | null = null;

/* La disposition par défaut, places et réglages compris (DEFAULT_LAYOUT),
   copiée pour que personne ne modifie la constante. */
function defaultLayout(isOwner: boolean, variant?: "stats"): GridItem[] {
  return sanitizeLayout(
    (variant === "stats" ? STATS_LAYOUT : DEFAULT_LAYOUT).filter((o) => visibleTo(isOwner, o.i)).map((o) => ({ ...o, ...(o.s ? { s: { ...o.s } } : {}) })),
    isKnownBlock,
    blockBounds,
  );
}

/* Les widgets retirés, gardés pour leur retour (cf. `commit`). */
const REMOVED_KEY = "aniscroll:removedWidgets";
/** Les proportions d'une case du menu Widgets du studio (WidgetMenuTile). */
const TILE_RATIO = 2;
/** La largeur de la grille de l'Aperçu à sa dernière mesure (aperçus du menu). */
let lastGridW = 0;
/** Montrés dans le menu à leur taille par défaut, pas à la plus grande qui
    remplit la case (08/11/2026, Luc) : l'affinité n'a qu'une ligne par ami,
    en 4×2 réduit elle devenait illisible ; en 2×1 elle remplit la case
    presque aussi bien et se lit. « Reprendre la lecture » en 4×2 : ses
    pilules grandissent avec la hauteur et « Plus d'infos » sortait de la
    carte, coupé (même jour). */
const AT_DEFAULT_SIZE = new Set(["affinity", "resume"]);
type Removed = { w: number; h: number; s?: GridItem["s"] };
function readRemoved(): Record<string, Removed> {
  try {
    const v = JSON.parse(localStorage.getItem(REMOVED_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function stashRemoved(o: GridItem) {
  try {
    const all = readRemoved();
    all[o.i] = { w: o.w, h: o.h, ...(o.s ? { s: o.s } : {}) };
    localStorage.setItem(REMOVED_KEY, JSON.stringify(all));
  } catch {
    /* best-effort */
  }
}
/** La taille gardée, ramenée dans les bornes actuelles du bloc. */
function clampSize(id: string, w: number, h: number): [number, number] {
  const b = blockBounds(id);
  return [Math.min(b.maxW, Math.max(b.minW, w)), Math.min(b.maxH, Math.max(b.minH, h))];
}
function takeRemoved(id: string): Removed | null {
  try {
    const all = readRemoved();
    const r = all[id];
    if (!r) return null;
    delete all[id];
    localStorage.setItem(REMOVED_KEY, JSON.stringify(all));
    return Number.isFinite(r.w) && Number.isFinite(r.h) ? r : null;
  } catch {
    return null;
  }
}

export default function ProfileOverview({
  entries,
  characters,
  isOwner,
  accountLayout,
  activity,
  ownerProgress,
  streak,
  watchDays,
  binge,
  earned,
  who,
  onPickScore,
  editing: editingProp,
  onEditingChange,
  variant,
}: Props) {
  const { t } = useTranslation();

  /* L'AFFINITÉ (03/11/2026) : chez soi, ses goûts sont rangés sur l'appareil
     (pour se comparer aux profils visités) ET, pour un compte, sur le serveur,
     où ses amis les lisent (lib/auth/friends.ts). */
  useEffect(() => {
    if (!entries.length || !isOwner) return;
    rememberMe(entries);
    if (who?.tag) sendMyTaste(tasteOf(entries), favsOf(entries));
  }, [entries, isOwner, who?.tag]);

  /* Le journal des jours de CET appareil, chez soi, pour l'objectif et le
     bingo ; chez un autre, celui que sert la page. */
  const localDays = useLocalDays(isOwner);
  /* Chez soi, l'appareil et la sauvegarde du compte, jour par jour le plus
     rempli des deux : la mémoire de dev.aniscroll.com, par exemple, ne contient
     presque rien (03/11/2026). */
  const ownDays = useMemo(() => {
    if (!localDays) return null;
    if (!watchDays) return localDays;
    const out = { ...watchDays };
    for (const [d, v] of Object.entries(localDays)) if (!out[d] || v.n >= out[d].n) out[d] = v;
    return out;
  }, [localDays, watchDays]);
  const days = isOwner ? ownDays : (watchDays ?? {});
  /* Le compte l'emporte dès qu'il y en a un ; le hook n'est là que pour le
     profil local d'un invité. Il est appelé dans tous les cas — un hook ne se
     saute pas — mais son résultat est ignoré côté compte. */
  const onAccount = accountLayout !== undefined;
  const device = useProfileLayout();
  const source = onAccount ? accountLayout : device.layout;
  const loaded = onAccount || device.loaded;

  const [ownEditing, setOwnEditing] = useState(false);
  const controlled = onEditingChange !== undefined;
  const editing = controlled ? !!editingProp : ownEditing;
  const setEditing = (on: boolean) => (controlled ? onEditingChange(on) : setOwnEditing(on));
  const [library, setLibrary] = useState(false);
  /* La disposition vit ici pendant la session : le stockage n'est écrit qu'aux
     changements, et le relire à chaque déplacement ferait un aller-retour par
     pixel. */
  const [layout, setLayout] = useState<GridItem[] | null>(null);

  /* La reprise des dispositions rangées AVANT que la grille ne devienne
     publique : elles sont dans le localStorage de leur auteur et nulle part sur
     son compte. Sans ça, tout le monde retrouverait la grille par défaut le
     jour du déploiement. Une seule fois, et seulement pour le propriétaire. */
  const migrated = useRef(false);

  useEffect(() => {
    if (!loaded) return;
    if (variant === "stats") {
      let mine: GridItem[] | null = null;
      try {
        if (isOwner) mine = JSON.parse(localStorage.getItem(STATS_KEY) || "null");
      } catch {}
      setLayout(
        compact(Array.isArray(mine) ? statsLayout(mine) : defaultLayout(isOwner, variant)),
      );
      return;
    }
    /* La disposition rangée pendant CETTE session l'emporte sur celle du rendu
       serveur : elle est postérieure, et la prop ne sera rafraîchie qu'au
       prochain chargement de la page (cf. `ownLayout`). */
    let base = isOwner && ownLayout ? ownLayout.items : source;
    if (onAccount && isOwner && !base && device.loaded && device.layout && !migrated.current) {
      migrated.current = true;
      base = device.layout;
      save(base);
    }
    const items = base
      ? sanitizeLayout(base, isKnownBlock, blockBounds)
      : defaultLayout(isOwner);
    /* `visibleTo` ne retire plus rien à un visiteur : les blocs d'activité sont
       désormais nourris par la sauvegarde du propriétaire (prop `activity`) et
       non par le localStorage du lecteur. Le filtre reste comme point de
       branchement d'un futur réglage de visibilité — il n'y en a aucun
       aujourd'hui, on retire le bloc pour ne rien publier. */
    setLayout(compact(items.filter((o) => visibleTo(isOwner, o.i))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, source, isOwner, onAccount, device.loaded, device.layout]);

  /* L'écriture est différée : `commit` est appelé à CHAQUE mouvement du
     pointeur, et une requête par pixel n'a pas de sens. Le dernier état gagne,
     ce qui est exactement la sémantique voulue.

     LE DIFFÉRÉ DOIT ÊTRE ENVOYÉ, PAS ANNULÉ, QUAND LA PAGE S'EN VA.
     Le nettoyage de l'effet faisait un `clearTimeout` : redimensionner un bloc
     puis partir avant la fin du délai — cliquer « Ma liste » juste après avoir
     lâché le coin — jetait l'écriture purement et simplement. Au retour, le
     rendu serveur relisait la colonne inchangée et la carte retrouvait sa
     taille d'avant, sans que rien n'ait signalé la perte.

     `keepalive` est ce qui rend l'envoi tardif possible : la requête part au
     moment où le composant est démonté, et le navigateur s'engage à la mener à
     terme même si la navigation l'emporte. */
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; next: GridItem[] | null } | null>(
    null,
  );

  const send = useCallback(
    (next: GridItem[] | null, keepalive: boolean) => {
      fetch("/api/v2/account/profile-layout", {
        method: next ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: next ? JSON.stringify({ layout: next }) : undefined,
        keepalive,
      })
        .then((r) => {
          /* UNE RÉPONSE D'ERREUR N'EST PAS UNE ABSENCE DE RÉPONSE. Le `.catch`
             seul ne voyait que les pannes de réseau : une session expirée (401)
             ou une disposition refusée (400) repartait en silence, et le
             propriétaire ne l'apprenait qu'en revenant sur son profil. */
          if (!r.ok) notify.error(t("profile.widgets.saveError"));
        })
        .catch(() => {
          /* Hors ligne : la grille est rangée à l'écran, le geste suivant
             réessaiera. Rien à dire ici que le navigateur ne dise déjà. */
        });
    },
    [t],
  );

  /** Envoie tout de suite ce qui attendait — au démontage, ou en sortant du
   *  mode réorganisation, où plus rien ne va suivre. */
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    send(p.next, true);
  }, [send]);

  useEffect(() => flush, [flush]);
  useEffect(() => {
    if (!editing) flush();
  }, [editing, flush]);

  function save(next: GridItem[] | null) {
    if (!isOwner) return;
    if (variant === "stats") {
      try {
        if (next) localStorage.setItem(STATS_KEY, JSON.stringify(next));
        else localStorage.removeItem(STATS_KEY);
      } catch {}
      return;
    }
    /* Retenue AVANT l'envoi, et quel que soit son sort : ce qui est à l'écran
       est ce que le propriétaire a voulu, et un changement d'onglet ne doit pas
       le défaire même si le réseau, lui, a échoué. */
    ownLayout = { items: next };
    if (!onAccount) {
      setProfileLayout(next);
      return;
    }
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = {
      next,
      timer: setTimeout(() => {
        pending.current = null;
        send(next, false);
      }, 500),
    };
  }

  function commit(next: GridItem[]) {
    /* UN WIDGET RETIRÉ GARDE SES RÉGLAGES (03/11/2026, Luc) : remis plus tard,
       il revient avec son nom, ses options, son contenu (épinglés, musiques…)
       et sa taille. Gardés sur cet appareil. */
    const kept = new Set(next.map((o) => o.i));
    for (const o of layout || []) if (!kept.has(o.i)) stashRemoved(o);
    setLayout(next);
    save(next);
  }

  /* Les blocs qu'on ne peut plus ajouter : posés autant de fois que le
     catalogue le permet (une seule pour la plupart, cf. `multi`). */
  const posed = useMemo(() => {
    const ids = (layout || []).map((o) => o.i);
    return new Set(BLOCKS.filter((b) => !nextInstance(ids, b.id)).map((b) => b.id));
  }, [layout]);
  const count = layout?.length ?? 0;

  /** Poser un bloc absent, retirer un bloc posé : la bibliothèque passe par
      ici. Un bloc qui peut être posé plusieurs fois s'ajoute jusqu'à son
      plafond, puis le dernier posé se retire. */
  function toggleBlock(type: string) {
    const cur = layout || [];
    const id = nextInstance(cur.map((o) => o.i), type);
    if (!id) {
      const last = cur.filter((o) => blockType(o.i) === type).pop();
      commit(compact(cur.filter((o) => o !== last)));
    } else {
      const back = takeRemoved(id);
      const [w, h] = back ? clampSize(id, back.w, back.h) : blockSize(id);
      const added = addItem(cur, id, w, h);
      commit(back?.s ? added.map((o) => (o.i === id ? { ...o, s: back.s } : o)) : added);
    }
  }
  /* Le menu Widgets du studio (lib/profile/widgetBridge) : la grille de
     l'Aperçu seulement — celle des Statistiques n'ajoute ni ne retire rien. */
  const gridBox = useRef<HTMLDivElement>(null);
  /** Le bloc qu'on vient d'ajouter depuis le menu, à faire apparaître. */
  const [fresh, setFresh] = useState<{ id: string; n: number } | null>(null);
  /** UN CLIC DANS LE MENU AJOUTE LE WIDGET À LA FIN (07/11/2026, Luc, à la
      place du glisser) : rien s'il est au plafond (posé, pour la plupart).
      Dans les deux cas la vue descend jusqu'à lui et le fait apparaître. */
  function addBlock(type: string) {
    const cur = layout || [];
    let id = nextInstance(cur.map((o) => o.i), type);
    if (id) {
      const back = takeRemoved(id);
      const [w, h] = back ? clampSize(id, back.w, back.h) : blockSize(id);
      /* Sous la dernière ligne, pas dans le premier trou venu. */
      const item: GridItem = { i: id, x: 0, y: rowCount(cur), w, h, ...(back?.s ? { s: back.s } : null) };
      commit(cur.concat([item]));
    } else id = cur.filter((o) => blockType(o.i) === type).pop()?.i ?? type;
    const target = id;
    setFresh((f) => ({ id: target, n: (f?.n ?? 0) + 1 }));
  }
  /* Après le rendu qui a posé le bloc : descendre jusqu'à lui, puis le faire
     surgir. Défilement et animation en JS (Web Animations) et pas en CSS :
     le Chrome de Luc est en `prefers-reduced-motion`, un défilement `smooth`
     ou une animation sous la media query y seraient instantanés. */
  useEffect(() => {
    if (!fresh) return;
    const el = gridBox.current?.querySelector<HTMLElement>(`[data-widget="${CSS.escape(fresh.id)}"]`);
    if (!el) return;
    let raf = 0;
    let cancelled = false;
    const pop = () => {
      if (cancelled) return;
      /* NI `opacity` NI `filter` SUR LA CARTE (08/11/2026, Luc : fond « de
         survol » pendant l'animation). L'un comme l'autre en fait une racine
         de fond : le flou de son `::before` ne voit plus le décor derrière et
         la carte change de teinte le temps de l'animation. `scale` (une
         transformation) et l'ombre ne touchent pas au flou. */
      /* Plus de liseré rose (08/11/2026, Luc) : la carte surgit, son ombre
         s'efface en fondu — la dernière image ne la nomme pas, elle revient
         donc à celle de la carte. */
      el.animate(
        [
          { offset: 0, scale: "0.6", boxShadow: "0 0 0 rgba(0,0,0,0)", easing: "cubic-bezier(.2,.8,.2,1)" },
          { offset: 0.3, scale: "1.04", boxShadow: "0 20px 50px rgba(0,0,0,0.55)" },
          { offset: 0.5, scale: "1", easing: "ease-out" },
          { offset: 1, scale: "1" },
        ],
        { duration: 1100 },
      );
    };
    /* Le premier ancêtre qui défile : `.as-stage` dans le studio, la page
       sinon. */
    let box: HTMLElement | null = el.parentElement;
    while (box) {
      const oy = getComputedStyle(box).overflowY;
      if ((oy === "auto" || oy === "scroll") && box.scrollHeight > box.clientHeight) break;
      box = box.parentElement;
    }
    const root = box ?? (document.scrollingElement as HTMLElement);
    /* `.as-stage` est réduit par un `scale` dans le studio : les mesures à
       l'écran se divisent par l'échelle pour devenir du défilement. */
    const br = box?.getBoundingClientRect();
    const k = box && br && box.offsetHeight ? br.height / box.offsetHeight || 1 : 1;
    const viewTop = br ? br.top : 0;
    const viewH = box ? box.clientHeight : window.innerHeight;
    const r = el.getBoundingClientRect();
    const from = root.scrollTop;
    const max = root.scrollHeight - root.clientHeight;
    const to = Math.max(0, Math.min(max, from + (r.top - viewTop) / k - (viewH - r.height / k) / 2));
    if (Math.abs(to - from) < 4) {
      pop();
    } else {
      el.style.visibility = "hidden";
      const t0 = performance.now();
      const dur = Math.min(550, 220 + Math.abs(to - from) * 0.25);
      const step = (now: number) => {
        if (cancelled) return;
        const p = Math.min(1, (now - t0) / dur);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        root.scrollTop = from + (to - from) * e;
        if (p < 1) raf = requestAnimationFrame(step);
        else {
          el.style.visibility = "";
          pop();
        }
      };
      raf = requestAnimationFrame(step);
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      el.style.visibility = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh?.n]);
  const addRef = useRef(addBlock);
  addRef.current = addBlock;
  const posedRef = useRef(posed);
  posedRef.current = posed;
  /** La disposition par défaut, enregistrée comme telle (pas de copie). */
  function resetLayout() {
    save(null);
    setLayout(defaultLayout(isOwner, variant));
  }
  /* Le bouton « Réinitialiser » de l'en-tête du profil (08/11/2026, Luc) :
     la grille de l'onglet affiché, Aperçu ou Statistiques — une seule est
     montée à la fois. */
  const resetRef = useRef(resetLayout);
  resetRef.current = resetLayout;
  useEffect(() => {
    if (!isOwner) return;
    const go = () => resetRef.current();
    window.addEventListener(WIDGETS_RESET_EVENT, go);
    return () => window.removeEventListener(WIDGETS_RESET_EVENT, go);
  }, [isOwner, variant]);
  const previewRef = useRef<(id: string) => WidgetPreview | null>(() => null);
  const menuPreview = useRef(false);
  const widgetsMenuOpen = useWidgetsMenuOpen();
  const bridged = isOwner && variant !== "stats" && !!layout;
  useEffect(() => {
    if (!bridged) return;
    publishWidgets({
      posed,
      count,
      add: (id) => addRef.current(id),
      preview: (id) => previewRef.current(id),
    });
  }, [bridged, posed, count]);
  const countRef = useRef(count);
  countRef.current = count;
  useEffect(() => {
    if (!bridged) return;
    /* Sur un autre onglet, le menu Widgets garde ses aperçus (08/11/2026,
       Luc) : on ne peut plus ajouter (`add` nul), mais les vignettes restent,
       sous le message. */
    const keep = previewRef;
    return () =>
      publishWidgets({ ...NO_WIDGETS, posed: posedRef.current, count: countRef.current, preview: (id) => keep.current(id) });
  }, [bridged]);

  function renderBlock(id: string): BlockChrome | null {
    const def = blockDef(id);
    if (!def) return null;
    /* `id` est l'instance (`favorites~2`), `type` le bloc du catalogue. */
    const type = def.id;
    /* « Reprendre la lecture » est écrit pour celui qui lit. Sur le profil d'un
       autre, c'est lui qui regarde, pas nous. */
    const other = !isOwner && type === "resume";
    const name = customName(id);
    return {
      /* Le nom donné l'emporte sur celui du catalogue — c'est tout l'objet du
         renommage. Il n'a pas de forme courte : celle du catalogue existait
         pour des libellés qu'on n'avait pas écrits soi-même. */
      title: name || blockTitle(id, other),
      name,
      defaultName: blockName(id, other),
      /* AUCUN BLOC N'A DE MÉTA. « 18 uniques » a été essayé sur les genres, pour
         dire que le radar n'en dessine que seize : c'était vrai et sans intérêt
         — un nombre de plus dans un en-tête, là où la carte entière parle déjà
         de genres, et personne ne compte les branches pour vérifier. */
      meta: null,
      /* La vitrine pose ses flèches dans le coin de l'en-tête, « Vu récemment »
         sa flamme, « Notes attribuées » sa moyenne : il faut leur garder la
         place (cf. `endRoom` dans WidgetGrid.tsx). Pour la flamme, seulement
         quand elle est allumée — sinon le titre perdrait 56 px pour rien. La
         moyenne, elle, n'est pas réglable : elle est là dès qu'une note existe,
         et la réservation ne coûte que sur un profil qui n'a rien noté. */
      endRoom:
        type === "favorites" ||
        type === "scores" ||
        /* La légende « Moins ▪▪▪▪▪ Plus » de la heatmap (02/11/2026). */
        type === "heatmap" ||
        /* Le volume du Top OP / ED (03/11/2026). */
        type === "themes" ||
        (type === "recents" && optionOn(id, "streak")),
      /* Le crayon des personnages favoris, à côté de la roue, chez le
         propriétaire (25/10/2026, Luc) : ajouter, retirer, réordonner. */
      editor:
        type === "characters" && isOwner
          ? {
              label: t("profile.blocks.characters.manage"),
              node: (
                <CharactersBlock
                  characters={characters}
                  showFrom={optionOn(id, "showFrom")}
                  size={optionValue(id, "cardSize") as "small" | "normal" | "large"}
                  isOwner
                  editing
                />
              ),
            }
          : /* Les épinglés et les génériques s'écrivent au crayon, comme les
               personnages (03/11/2026) ; ils sont rangés dans la disposition. */
            type === "pinned" && isOwner
            ? {
                label: t("profile.blocks.pinned.manage"),
                node: (
                  <PinnedBlock
                    pins={parsePins(savedString(id, "pins"))}
                    entries={entries}
                    isOwner
                    onChange={(p) => setOption(id, "pins", JSON.stringify(p))}
                    /* Le crayon part de l'exemple affiché (08/11/2026, Luc). */
                    sample={sampleEntries(entries, 3).map((e) => e.mediaId)}
                  />
                ),
              }
            : type === "themes" && isOwner
              ? {
                  label: t("profile.blocks.themes.manage"),
                  node: (
                    <ThemesBlock
                      favs={parseThemes(savedString(id, "themes"))}
                      entries={entries}
                      isOwner
                      onChange={(f) => setOption(id, "themes", JSON.stringify(f))}
                      sample={sampleEntries(entries, 5).map((e) => e.mediaId)}
                    />
                  ),
                }
              : /* Le bingo : chaque case se clique pour choisir son objectif (04/11/2026). */
                type === "bingo" && isOwner
                ? {
                    label: t("profile.blocks.bingo.manage"),
                    node: (
                      <BingoBlock
                        days={days}
                        entries={entries}
                        saved={saved(id)}
                        size={Number(optionValue(id, "bingoSize")) || 3}
                        isOwner
                        owner={who?.tag ?? undefined}
                        editing
                        onPatch={(p) => setOptions(id, p)}
                      />
                    ),
                  }
                : /* L'affinité : l'ordre et les amis affichés, au crayon (04/11/2026, Luc). */
                type === "affinity" && isOwner
                ? {
                    label: t("profile.blocks.affinity.manage"),
                    node: (
                      <AffinityEditor
                        entries={entries}
                        owner={who?.tag ?? undefined}
                        prefs={affinityPrefs()}
                        onChange={(p) =>
                          setOptions(id, {
                            ...(p.custom !== undefined ? { affinitySort: p.custom ? "custom" : "affinity" } : {}),
                            ...(p.order ? { affOrder: JSON.stringify(p.order) } : {}),
                            ...(p.hidden ? { affHidden: JSON.stringify(p.hidden) } : {}),
                          })
                        }
                      />
                    ),
                  }
                : undefined,
      body: body(id),
    };
  }

  /* Les réglages du bloc `id` : ce que le propriétaire a rangé dans la
     disposition, sinon les défauts du catalogue. */
  function saved(id: string) {
    const s = layout?.find((o) => o.i === id)?.s;
    if (s || !menuPreview.current || !isOwner) return s;
    /* L'APERÇU DU MENU MONTRE LE WIDGET TEL QU'ON L'A LAISSÉ (08/11/2026,
       Luc) : retiré, il garde ses réglages sur l'appareil (`stashRemoved`),
       et c'est eux que l'aperçu montre, pas l'exemple. */
    try {
      return readRemoved()[id]?.s;
    } catch {
      return undefined;
    }
  }
  function optionOn(id: string, key: string): boolean {
    return blockOption(id, key, saved(id));
  }
  /** Un réglage libre, rangé tel quel (les épinglés, les génériques). */
  function savedString(id: string, key: string): string | undefined {
    const v = saved(id)?.[key];
    return typeof v === "string" ? v : undefined;
  }
  function optionValue(id: string, key: string): string {
    return blockOptionValue(id, key, saved(id), customValues);
  }
  /** Les listes cochées de « Répartition ». Un profil qui avait allumé l'ancien
      interrupteur `customLists` retrouve ses listes perso cochées. */
  function statusLists(): string[] {
    const s = saved("statuses");
    return blockOptionList(
      "statuses",
      "lists",
      s,
      customValues,
      s?.customLists === true ? customValues : undefined,
    );
  }
  /** Toutes les cases cochées sont des listes perso : le titre le dit. */
  function onlyCustom(): boolean {
    const l = statusLists();
    return l.length > 0 && l.every((v) => v.startsWith(CUSTOM_PREFIX));
  }

  /* Les listes personnalisées de CE profil, telles que sa liste les porte. Elles
     ne sont dans aucun catalogue — chacun invente les siennes — donc elles se
     lisent dans les entrées, et le préfixe les empêche de se confondre avec une
     liste de statut qui porterait le même nom. */
  /**
   * LES VARIANTES DE TITRE, par `mediaId`, pour les deux widgets d'activité.
   *
   * L'historique du lecteur ne garde qu'une chaîne — le titre tel qu'il
   * s'affichait pendant la lecture — donc ces deux blocs étaient les seuls du
   * site à ignorer le réglage « romaji / anglais ». La liste du profil, elle,
   * porte les variantes : il suffisait de les leur passer, sans rien demander au
   * réseau et sans dépendre d'AniList au moment du rendu.
   */
  const titlesById = useMemo(() => {
    const map = new Map<number, ProfileTitle | null>();
    for (const e of entries) map.set(e.mediaId, e.title);
    return map;
  }, [entries]);

  /* Le nombre d'épisodes, pour que « Reprendre » ne propose pas un épisode
     après le dernier. */
  const totalsById = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const e of entries) map.set(e.mediaId, e.total);
    return map;
  }, [entries]);

  /* Y a-t-il seulement un favori déclaré ? C'est ce qui décide du TITRE de la
     vitrine : sans favori, elle montre les mieux notés, et l'annoncer comme
     « favoris » présenterait comme tels des titres qui ne le sont pas. Une
     liste locale n'a pas la notion, un profil AniList sans favori non plus. */
  const hasFavourites = useMemo(() => entries.some((e) => e.favourite), [entries]);

  const customLists = useMemo(() => customListNames(entries), [entries]);
  const customValues = useMemo(
    () => customLists.map((n) => `${CUSTOM_PREFIX}${n}`),
    [customLists],
  );

  /** Un réglage changé, écrit dans la disposition et sauvegardé. */
  function setOption(id: string, key: string, value: boolean | string) {
    setOptions(id, { [key]: value });
  }
  /** Plusieurs réglages d'un coup : deux `setOption` de suite partiraient de
      la même disposition, et le second effacerait le premier. */
  function setOptions(id: string, patch: Record<string, boolean | string>) {
    commit(
      (layout || []).map((o) =>
        o.i === id ? { ...o, s: { ...(o.s ?? {}), ...patch } } : o,
      ),
    );
  }
  /** Les réglages de l'affinité : l'ordre, l'ajout auto, et le crayon. */
  function affinityPrefs() {
    return {
      custom: savedString("affinity", "affinitySort") === "custom",
      auto: optionOn("affinity", "affAuto"),
      order: parseTags(savedString("affinity", "affOrder")),
      hidden: parseTags(savedString("affinity", "affHidden")),
    };
  }

  /**
   * Le nom qu'on a donné au bloc, ou rien.
   *
   * Il vit dans les réglages du bloc, sous la clé réservée `title` — le même
   * canal que les interrupteurs, donc la même colonne, la même route et le même
   * nettoyage (`sanitizeLayout` plafonne déjà une valeur de réglage à 48
   * caractères, ce qui est aussi la bonne longueur pour un titre de carte).
   * Aucun bloc du catalogue n'a de réglage nommé ainsi, et c'est la condition
   * pour que la clé reste libre.
   */
  function customName(id: string): string {
    const v = saved(id)?.title;
    return typeof v === "string" ? v : "";
  }

  /** Renommer. Un nom vidé n'est pas un nom vide : le bloc reprend le sien.
      La longueur est celle qu'une valeur de réglage supporte (`sanitizeLayout`,
      lib/profile/grid.ts) : la couper ici évite qu'un nom écrit soit accepté à
      l'écran puis jeté au nettoyage, ce qui se lirait comme une perte. */
  function setName(id: string, raw: string) {
    const name = raw.slice(0, MAX_NAME).trimStart();
    commit(
      (layout || []).map((o) => {
        if (o.i !== id) return o;
        const s = { ...(o.s ?? {}) };
        if (name.trim()) s.title = name;
        else delete s.title;
        return { ...o, s };
      }),
    );
  }

  /**
   * Les réglages d'un bloc, traduits et résolus, pour le panneau de la grille.
   *
   * Le catalogue n'est traversé qu'ICI : ni la grille ni son panneau ne savent
   * ce qu'une clé signifie. Les choix d'un menu déroulant portent déjà leur
   * libellé — pour `source`, ce sont les noms de listes du reste du site
   * (`listLabel`), donc « Terminés » veut dire ici ce qu'il veut dire ailleurs.
   */
  function widgetOptions(id: string): WidgetOption[] {
    const def = blockDef(id);
    return blockOptions(id).map((o) => {
      const common = {
        key: o.key,
        label: t(`profile.widgets.options.${o.key}`),
        desc: t(`profile.widgets.options.${o.key}Desc`),
      };
      if ("range" in o) {
        const [from, to] = blockOptionRange(id, o.key, saved(id));
        return { ...common, min: o.range[0], max: o.range[1], step: o.step, from, to };
      }
      if ("slider" in o) {
        return {
          ...common,
          single: {
            min: o.slider[0],
            max: o.slider[1],
            value: blockOptionNumber(id, o.key, saved(id)),
            zeroLabel: o.zero ? t(`profile.widgets.options.${o.key}Choice.${o.zero}`) : undefined,
            step: o.step,
            input: o.input,
          },
        };
      }
      if ("multi" in o) {
        /* Les statuts dans l'ordre du site, puis les listes perso — même ordre
           et mêmes pastilles que le menu de la vitrine. */
        return {
          ...common,
          values: id === "statuses" ? statusLists() : [],
          multi: [
            ...o.multi.map((k) => ({
              value: k,
              label: listLabel(t, STATUS_TO_LIST[k] || k),
              color: LIST_COLORS[STATUS_TO_LIST[k]],
              group: "status",
              groupLabel: t("profile.widgets.options.groupStatuses"),
            })),
            ...customLists.map((n) => ({
              value: `${CUSTOM_PREFIX}${n}`,
              label: n,
              color: customListColor(n),
              group: "custom",
              groupLabel: t("profile.widgets.options.groupCustom"),
            })),
          ],
        };
      }
      /* Un menu qui n'est PAS une liste (« Par ligne ») : ses choix se
         traduisent sous `<clé>Choice.<valeur>`, sans pastille ni listes perso. */
      if ("choices" in o && o.key !== "source") {
        return {
          ...common,
          value: optionValue(id, o.key),
          segmented: o.segmented,
          choices: o.choices.map((c) => ({
            value: c,
            label: t(`profile.widgets.options.${o.key}Choice.${c}`, c),
          })),
        };
      }
      return "choices" in o
        ? {
            ...common,
            value: optionValue(id, o.key),
            /* Les listes de statut d'abord, dans l'ordre du site, puis les
               listes personnalisées À LA SUITE — c'est l'ordre de l'éditeur de
               liste, où les listes inventées viennent aussi après. Chacune
               porte SA couleur : celle du site pour les six listes de statut,
               celle déduite de son nom pour les autres (`customListColor`),
               exactement les pastilles de l'éditeur. */
            choices: [
              ...o.choices.map((c) => ({
                value: c,
                label:
                  c === "favourites"
                    ? t("profile.widgets.options.sourceFavourites")
                    : listLabel(t, c),
                color: c === "favourites" ? def?.color : LIST_COLORS[c],
                heart: c === "favourites",
                /* Les favoris seuls en tête, puis les statuts, puis les
                   listes perso, chaque section séparée (WidgetSettings). */
                group: c === "favourites" ? "fav" : "status",
                groupLabel:
                  c === "favourites" ? undefined : t("profile.widgets.options.groupStatuses"),
              })),
              ...customLists.map((n) => ({
                value: `${CUSTOM_PREFIX}${n}`,
                label: n,
                color: customListColor(n),
                group: "custom",
                groupLabel: t("profile.widgets.options.groupCustom"),
              })),
            ],
          }
        : { ...common, on: optionOn(id, o.key) };
    });
  }

  /**
   * Le nom d'un bloc, tel que son en-tête l'affiche.
   *
   * Il n'est plus toujours celui du catalogue : la vitrine des favoris peut
   * montrer une AUTRE liste que les favoris, et garder alors le titre
   * « Animés favoris » serait un mensonge sur son contenu. Le titre suit donc le
   * réglage — « Animes favoris Terminé » — en reprenant le NOM DE LISTE du
   * reste du site plutôt qu'un mot à lui.
   *
   * Le nom est POSÉ à la suite, sans l'annoncer. Il l'a d'abord été derrière un
   * « · Liste : », qui disait à quoi servait ce mot mais coûtait trois mots sur
   * cinq à un titre déjà coupé sur un bloc de deux colonnes. Une liste
   * personnalisée suit la même forme, sous son propre nom — le français s'en
   * accommode parce que le libellé y est un nom (« Terminés », « Prévus »), là
   * où l'anglais garde son point médian (« Favourite anime · Planning ») faute
   * de quoi le libellé se lirait comme un adjectif.
   *
   * LE LIBELLÉ EST AU PLURIEL, et il vient donc d'une table à lui
   * (`favorites.listPlural`) plutôt que de `listLabel`. Ailleurs sur le site le
   * nom d'une liste titre UNE liste — « Terminé » — alors qu'ici il qualifie
   * plusieurs animes. Traduire les deux avec la même clé aurait forcé à choisir
   * un nombre pour tous les emplois. Une liste personnalisée garde son nom tel
   * que son auteur l'a écrit : lui accorder quoi que ce soit serait deviner.
   */
  /**
   * Le titre d'un bloc — un nœud, parce que celui de la vitrine a DEUX FORMES.
   *
   * « Animes favoris · En cours » tient sur une carte large ; sur un téléphone,
   * où la carte fait toute la largeur de l'écran soit à peine plus de 300 px, il
   * touchait les flèches du carrousel. La carte étroite garde donc UNE SEULE
   * moitié, et laquelle dépend de ce que la vitrine montre :
   *
   *   — les cœurs (`favourites`) gardent « Animes favoris », leur nom propre ;
   *   — toute autre liste garde SON nom — « En cours », « Terminés », ou celui
   *     que le propriétaire a donné à sa liste personnalisée.
   *
   * Autrement dit, l'en-tête nomme toujours ce qu'on regarde, en un seul mot
   * quand il n'y a la place que pour un. Un nom trop long s'arrête sur trois
   * points : c'est le `truncate` de l'en-tête (WidgetGrid.tsx), et la place des
   * flèches lui est déjà réservée par `endRoom`.
   *
   * Les deux formes sont rendues et c'est le CSS qui choisit, sur une REQUÊTE DE
   * CONTENEUR (`.as-head-full` / `.as-head-short`, globals.css) : ce qui décide
   * est la largeur de la CARTE, pas celle de l'écran — la même carte est étroite
   * en 1×1 et large en 2×4 dans la même fenêtre.
   */
  function blockTitle(id: string, other: boolean): React.ReactNode {
    const type = blockType(id);
    if (type === "favorites") {
      const src = optionValue(id, "source");
      if (src && src !== "favourites") {
        const custom = src.startsWith(CUSTOM_PREFIX);
        const list = custom
          ? src.slice(CUSTOM_PREFIX.length)
          : t(`profile.blocks.favorites.listPlural.${src}`, listLabel(t, src));
        return (
          <>
            <span className="as-head-full">
              {t("profile.blocks.favorites.titleList", { list })}
            </span>
            {/* La forme courte n'a besoin d'AUCUNE traduction de plus : c'est le
                nom de la liste, déjà traduit juste au-dessus. Les cœurs, eux, ne
                passent jamais ici — sans liste choisie, le titre du bloc est
                rendu tel quel, plus bas, et il est déjà court. */}
            <span className="as-head-short">{list}</span>
          </>
        );
      }
      /* Sans favori déclaré, la vitrine montre les MIEUX NOTÉS (le repli de
         `favoriteShowcase`) : le titre doit alors dire cela et pas « favoris »,
         sinon le bloc présente comme favoris treize titres qui ne le sont
         pas. */
      if (!hasFavourites) return t("profile.blocks.favorites.titleTopRated");
    }
    /* Le bloc ne compte plus des statuts : son nom doit le dire. Sans ça,
       « Répartition par statut » chapeautait une liste de noms inventés. */
    if (type === "statuses" && onlyCustom()) {
      return t("profile.blocks.statuses.titleCustom");
    }
    return t(other ? "profile.blocks.resume.titleOther" : `profile.blocks.${type}.title`);
  }

  /**
   * Le même titre, mais EN TEXTE — ce que le champ de renommage affiche en
   * suggestion tant qu'on n'a rien écrit.
   *
   * `blockTitle` rend un nœud (il porte deux formes, longue et courte, que le
   * CSS choisit), et un attribut `placeholder` ne prend qu'une chaîne. D'où ces
   * quelques lignes qui refont le même choix sans le balisage : c'est la forme
   * LONGUE qu'on suggère, celle qu'on lirait sur une carte large.
   */
  function blockName(id: string, other: boolean): string {
    const type = blockType(id);
    if (type === "favorites") {
      const src = optionValue(id, "source");
      if (src && src !== "favourites") {
        const list = src.startsWith(CUSTOM_PREFIX)
          ? src.slice(CUSTOM_PREFIX.length)
          : t(`profile.blocks.favorites.listPlural.${src}`, listLabel(t, src));
        return t("profile.blocks.favorites.titleList", { list });
      }
      if (!hasFavourites) return t("profile.blocks.favorites.titleTopRated");
    }
    if (type === "statuses" && onlyCustom()) {
      return t("profile.blocks.statuses.titleCustom");
    }
    return t(other ? "profile.blocks.resume.titleOther" : `profile.blocks.${type}.title`);
  }

  function body(id: string): React.ReactNode {
    const served = isOwner ? undefined : (activity ?? undefined);
    switch (blockType(id)) {
      /* `served` reste indéfini chez soi, et c'est délibéré : les deux blocs
         retombent alors sur le localStorage de cet appareil, qui est plus frais
         que la dernière synchronisation et qui se met à jour PENDANT qu'on
         regarde (PROGRESS_EVENT). Servir sa propre sauvegarde au propriétaire
         lui montrerait un épisode en retard sur ce qu'il vient de lancer. */
      case "resume": {
        /* 2 de haut et 2 ou 3 de large : l'image passe au-dessus du texte
           (23/10/2026, Luc). Les autres tailles (2×1…4×1, et 4×2 où la vignette
           a la place d'être à gauche) la gardent à gauche. */
        const item = layout?.find((o) => o.i === id);
        return (
          <ResumeBlock
            stacked={item?.h === 2 && (item?.w === 2 || item?.w === 3)}
            rows={served}
            other={!isOwner}
            titles={titlesById}
            totals={totalsById}
            ambient={optionOn(id, "ambient")}
          />
        );
      }
      case "recents":
        return (
          <RecentsBlock
            rows={served}
            extra={isOwner ? ownerProgress ?? null : null}
            other={!isOwner}
            titles={titlesById}
            streak={streak ?? 0}
            streakOn={optionOn(id, "streak")}
            coverArt={optionOn(id, "coverArt")}
            editing={editing}
          />
        );
      case "favorites":
        return (
          <FavoritesBlock
            entries={entries}
            source={optionValue(id, "source")}
            scores={blockOptionRange(id, "scores", saved(id))}
            unrated={optionOn(id, "unrated")}
            trailer={optionOn(id, "trailer")}
            editing={editing && isOwner}
          />
        );
      case "statuses":
        return (
          <StatusesBlock entries={entries} lists={statusLists()} />
        );
      case "scores":
        return (
          <ScoresBlock
            entries={entries}
            completedOnly={optionOn(id, "completedOnly")}
            editing={editing}
            onPick={
              onPickScore
                ? (score) => onPickScore(score, optionOn(id, "completedOnly"))
                : undefined
            }
          />
        );
      case "genres":
        return (
          <GenresBlock
            entries={entries}
            completedOnly={optionOn(id, "completedOnly")}
          />
        );
      case "years":
        return (
          <YearsBlock
            entries={entries}
            completedOnly={optionOn(id, "completedOnly")}
            skipEmpty={optionOn(id, "skipEmpty")}
          />
        );
      case "studios":
        return (
          <StudiosBlock entries={entries} completedOnly={optionOn(id, "completedOnly")} />
        );
      case "season":
        return (
          <SeasonBlock
            entries={entries}
            rewatching={optionOn(id, "rewatching")}
            airingFirst={optionOn(id, "airingFirst")}
            perRow={blockOptionNumber(id, "perRow", saved(id))}
            size={optionValue(id, "cardSize") as "small" | "normal" | "large"}
          />
        );
      case "characters":
        return (
          <CharactersBlock
            characters={characters}
            showFrom={optionOn(id, "showFrom")}
            size={optionValue(id, "cardSize") as "small" | "normal" | "large"}
            isOwner={isOwner}
          />
        );
      case "heatmap":
        return (
          <HeatmapBlock
            served={isOwner ? (ownDays ?? undefined) : (watchDays ?? {})}
            editing={editing}
            streak={optionOn(id, "heatStreak")}
          />
        );
      case "calendar":
        return (
          <CalendarBlock
            served={isOwner ? (ownDays ?? undefined) : (watchDays ?? {})}
            entries={entries}
            bubbles={optionOn(id, "calBubbles")}
          />
        );
      case "binge":
        return (
          <BingeBlock
            served={isOwner ? undefined : (binge ?? null)}
            account={binge ?? null}
            entries={entries}
            order={optionValue(id, "bingeOrder") === "watched" ? "watched" : "most"}
          />
        );
      case "goal":
        return (
          <GoalBlock
            days={days}
            unit={optionValue(id, "goalUnit") === "animes" ? "animes" : "episodes"}
            target={blockOptionNumber(id, "goalTarget", saved(id)) || 250}
            colored={optionOn(id, "goalColor")}
          />
        );
      case "pinned": {
        /* UN EXEMPLE DANS LE MENU WIDGETS (08/11/2026, Luc : « met des exemples
           par défaut pour que l'utilisateur comprenne ») : sans épinglés, ses
           trois titres les mieux notés, avec une phrase d'exemple. */
        const pins = parsePins(savedString(id, "pins"));
        /* Aussi sur le profil, chez le propriétaire (08/11/2026, Luc : « vide,
           regarde sur le profil ») ; un visiteur ne voit jamais de phrases
           prêtées au propriétaire. */
        return (
          <PinnedBlock
            pins={pins}
            sample={menuPreview.current || isOwner ? sampleEntries(entries, 3).map((e) => e.mediaId) : undefined}
            entries={entries}
            isOwner={isOwner}
            showScore={optionOn(id, "pinScore")}
          />
        );
      }
      case "themes":
        return (
          <ThemesBlock
            favs={parseThemes(savedString(id, "themes"))}
            entries={entries}
            isOwner={isOwner}
            byKind={optionValue(id, "themesSort") === "kind"}
            /* L'exemple du menu Widgets : l'opening de ses cinq titres les
               mieux notés (08/11/2026, Luc). */
            sample={menuPreview.current || isOwner ? sampleEntries(entries, 5).map((e) => e.mediaId) : undefined}
          />
        );
      case "affinity":
        return (
          <AffinityBlock
            isOwner={isOwner}
            owner={isOwner ? who?.tag ?? undefined : undefined}
            entries={entries}
            name={who?.name ?? ""}
            prefs={isOwner ? affinityPrefs() : undefined}
            onKnown={isOwner ? (tags) => setOption(id, "affOrder", JSON.stringify(tags)) : undefined}
          />
        );
      case "bingo": {
        /* DANS LE MENU WIDGETS, UN BINGO QUI SE VOIT (08/11/2026, Luc) : « mon
           bingo » sans carte n'est qu'une grille de cases vides. L'aperçu
           montre alors celui de la saison, en lecture seule. */
        const s = saved(id);
        let mine: unknown = [];
        try {
          mine = JSON.parse(String(s?.bingoCells ?? "[]"));
        } catch {
          /* illisible : traité comme vide */
        }
        const showcase =
          menuPreview.current &&
          s?.bingoMode !== "season" &&
          !(Array.isArray(mine) && mine.some((c) => typeof c === "string" && c && c !== "-"));
        return (
          <BingoBlock
            days={days}
            entries={entries}
            saved={showcase ? { ...s, bingoMode: "season" } : s}
            size={Number(optionValue(id, "bingoSize")) || 3}
            isOwner={isOwner}
            owner={isOwner ? who?.tag ?? undefined : undefined}
            name={who?.name ?? ""}
            onPatch={isOwner && !showcase ? (p) => setOptions(id, p) : undefined}
          />
        );
      }
      default:
        // Les blocs `soon` : la mise en page est là, et le bloc dit lui-même ce
        // qui lui manque plutôt que d'afficher un chiffre inventé.
        return <EmptyBlock note={t(`profile.blocks.${blockType(id)}.soon`)} />;
    }
  }

  /* L'aperçu du menu Widgets : `menuPreview` dit au contenu qu'il est dessiné
     pour le menu, le temps de le construire. */
  previewRef.current = (id) => {
    menuPreview.current = true;
    try {
      const chrome = renderBlock(id);
      if (!chrome) return null;
      /* LA TAILLE QUI REMPLIT LA CASE (08/11/2026, Luc : « ceux où tu peux
         réduire la taille, affiche la taille parfaite pour remplir le
         rectangle ») : parmi les tailles permises au bloc, celle dont les
         proportions collent le mieux à la case (2:1) ; à égalité, la plus
         proche de sa taille par défaut. Un bloc à taille fixe garde la sienne. */
      /* La dernière largeur mesurée quand la grille n'est plus montée (autre
         onglet) : sans elle, les aperçus du menu verrouillé étaient dessinés à
         une autre taille (08/11/2026, Luc). */
      const measured = gridBox.current?.offsetWidth || 0;
      if (measured) lastGridW = measured;
      const gridW = measured || lastGridW;
      const b = blockBounds(id);
      const [dw, dh] = blockSize(id);
      let best = { w: dw, h: dh, fill: -1, dist: Infinity };
      /* Les blocs carrés (Bingo, calendrier : `square` dans blocks.ts) restent
         carrés : étirés en 2:1, ils ne ressemblent plus à eux-mêmes
         (08/11/2026, Luc). */
      if (blockDef(id)?.square || AT_DEFAULT_SIZE.has(id)) return { chrome, w: dw, h: dh, gridW };
      for (let w = b.minW; w <= b.maxW; w++)
        for (let h = b.minH; h <= b.maxH; h++) {
          const r = pixelRect({ i: id, x: 0, y: 0, w, h }, gridW || 1100);
          const a = r.width / r.height / TILE_RATIO;
          const fill = Math.round(Math.min(a, 1 / a) * 100);
          const dist = Math.abs(w - dw) + Math.abs(h - dh);
          if (fill > best.fill || (fill === best.fill && dist < best.dist)) best = { w, h, fill, dist };
        }
      return { chrome, w: best.w, h: best.h, gridW };
    } finally {
      menuPreview.current = false;
    }
  };

  if (!layout) {
    // Tant que le stockage n'a pas répondu : la hauteur de la grille par défaut,
    // pour que la page ne saute pas au premier rendu client.
    return <div className="h-[30rem]" />;
  }

  return (
    <div>
      {/* Piloté par la page (studio), plus de « Ajouter un bloc » ni de
          « Personnaliser » au-dessus de la grille (08/11/2026, Luc) : le
          bouton « Personnaliser le profil » de l'en-tête ouvre le studio, et
          on ajoute un widget depuis son menu ou le bouton sous la grille.
          Les Statistiques aussi : elles passent en édition avec le studio. */}
      {isOwner && !controlled ? (
        <div className="mb-5 flex flex-wrap items-center justify-end gap-2.5">
          {variant === "stats" ? null : (
          <button
            type="button"
            onClick={() => setLibrary(true)}
            className="inline-flex items-center gap-2 rounded-full bg-action px-4 py-2.5 font-karla text-xs font-bold text-white shadow-glow transition-transform hover:scale-105"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3.5 w-3.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t("profile.widgets.add")}
          </button>
          )}
          {/* Piloté par la page, le bouton disparaît pendant l'édition : c'est
              le dock du studio qui la termine, en enregistrant le fond avec. */}
          {controlled && editing ? null : (
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2.5 font-karla text-xs font-bold text-white ring-1 transition-colors ${
              editing ? "bg-action ring-action" : "bg-white/5 ring-white/15 hover:ring-white/30"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              <polyline points="8 6 12 2 16 6" />
              <polyline points="16 18 12 22 8 18" />
              <line x1="12" y1="2" x2="12" y2="22" />
            </svg>
            {editing
              ? t("profile.widgets.done")
              : controlled
                ? t("profile.studioCustomize")
                : t("profile.widgets.rearrange")}
          </button>
          )}
        </div>
      ) : null}

      {/* Plus de bandeau « Mode réorganisation » au-dessus de la grille
          (retiré le 16/10/2026) : la grille en édition se lit d'elle-même, et
          « Réinitialiser » vit dans la bibliothèque de blocs. */}
      <div ref={gridBox}>
      <WidgetGrid
        layout={layout}
        onLayout={commit}
        renderBlock={renderBlock}
        limits={blockBounds}
        options={widgetOptions}
        onOption={setOption}
        onRename={setName}
        editing={editing && isOwner}
        removable={variant !== "stats"}
      />
      </div>

      {/* AJOUTER UN WIDGET, SOUS LA GRILLE (07/11/2026, Luc) : en édition, il
          ouvre le menu Widgets du studio ; sinon, la bibliothèque. Plus épais
          et plus haut, et effacé en fondu tant que le menu Widgets est ouvert :
          il ferait doublon (08/11/2026, Luc). La place reste réservée, la
          grille ne saute pas. */}
      {isOwner && editing && variant !== "stats" ? (
        <button
          type="button"
          onClick={() =>
            controlled ? window.dispatchEvent(new Event(WIDGETS_MENU_EVENT)) : setLibrary(true)
          }
          tabIndex={widgetsMenuOpen ? -1 : undefined}
          aria-hidden={widgetsMenuOpen || undefined}
          /* LE MÊME ÉCART QU'ENTRE DEUX WIDGETS (08/11/2026, Luc). En édition
             la grille garde une demi-rangée vide sous elle (WidgetGrid, pour
             glisser un bloc vers le bas) : le bouton remonte d'autant. */
          style={{ marginTop: GAP - ROW / 2 }}
          className={`relative flex w-full items-center justify-center gap-3 rounded-2xl border-[3px] border-dashed border-white/25 py-12 font-outfit text-lg font-bold text-white/75 transition-[opacity,color,background-color,border-color] duration-300 hover:border-action hover:bg-action/10 hover:text-white ${
            widgetsMenuOpen ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <WidgetAddIcon className="h-8 w-8" />
          {t("profile.widgets.addWidget")}
        </button>
      ) : null}

      {isOwner && variant !== "stats" ? (
        <BlockLibrary
          open={library}
          onClose={() => setLibrary(false)}
          blocks={BLOCKS.filter((b) => visibleTo(isOwner, b.id))}
          posed={posed}
          count={count}
          onToggle={toggleBlock}
          onRearrange={() => {
            setLibrary(false);
            setEditing(true);
          }}
          onReset={resetLayout}
        />
      ) : null}
    </div>
  );
}
