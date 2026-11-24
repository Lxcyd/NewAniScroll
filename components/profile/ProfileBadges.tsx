/**
 * L'onglet Badges d'un profil.
 *
 * Une LISTE, pas une grille : jeton à gauche, titre, condition et barre à
 * droite, les uns sous les autres. Une grille de cent quatre-vingts jetons est
 * jolie et illisible — on ne peut y mettre ni la condition, ni l'avancement, ni
 * la date, qui sont précisément ce qu'on vient lire.
 *
 * ── LES PALIERS ──────────────────────────────────────────────────────────────
 * Une échelle (1 → 25 → 250 → 1 000 épisodes) n'affiche qu'UNE ligne : le
 * premier palier non atteint, avec sa barre. À neuf épisodes, on voit donc le
 * badge des vingt-cinq à 9/25, et non six lignes dont cinq sont hors de portée.
 * Le chevron au bout de la ligne ouvre un panneau avec TOUS les paliers.
 *
 * ── LE PROPRIÉTAIRE ET LE VISITEUR ───────────────────────────────────────────
 * `live` distingue les deux. Chez soi, tout est recalculé depuis les stores de
 * l'appareil, donc les barres avancent. Chez quelqu'un d'autre, on n'a que sa
 * collection (sauvegardée dans `user_data`) : les badges obtenus s'affichent
 * avec leur date, les autres restent verrouillés SANS barre — inventer un
 * avancement qu'on n'a pas mesuré serait un chiffre faux.
 */

import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { MdFormatListBulleted, MdGridView } from "react-icons/md";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  BADGES, BY_ID, LADDERS, MAIN, RARITY_ORDER, SECRETS,
  type BadgeDef, type Rarity,
} from "@/lib/badges/catalog";
import { beginQuiet, endQuiet, flush, progressAll } from "@/lib/badges/evaluate";
import type { Derived } from "@/lib/badges/derive";
import { detailKind, detailOf, detailYear, type Detail, type DetailCell } from "@/lib/badges/detail";
import { genreLabel } from "@/lib/i18n/genreLabel";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import type { LocalEntry } from "@/lib/list/localList";
import { backfillMetadata } from "@/lib/badges/metaBackfill";
import { backfillAiring } from "@/lib/badges/airingBackfill";
import { recordFlag } from "@/lib/badges/facts";
import { revealAnchor, revealTarget } from "@/lib/badges/reveal";
import { SECTION_ORDER, sectionOf } from "@/lib/badges/sections";
import { mergeBadgeState, NO_DATE, useBadgeState, type BadgeState } from "@/lib/badges/store";
import { Bar } from "./widgets/common";
import { Dropdown } from "./WidgetSettings";
import BadgeDefs from "./badges/BadgeDefs";
import BadgeToken from "./badges/BadgeToken";
import ViewSwitch, { VIEWS, type View } from "./ViewSwitch";
import { useScrollLock, useSheetPresence } from "./useSheetPresence";
import { RARITY, RING_HUE, ringSwatch } from "./badges/rarity";

type Filter = "all" | "got" | "todo";
type Progress = [number, number] | null;
/** Le menu de rareté : toutes, ou une seule. */
type RarityPick = "all" | Rarity;

/**
 * Le côté d'un jeton, en px.
 *
 * Le dessin de la maquette est fait pour 118 : en dessous d'une centaine, la
 * plaque de palier et la constellation deviennent des taches. On s'en approche
 * dans la liste, et on garde le palier du panneau à une taille de vignette — il
 * est là pour situer, pas pour se regarder.
 *
 * Le jeton grossit encore de 4 % au survol (.as-badge-token), donc la ligne
 * réserve un peu plus que `ROW_TOKEN`.
 */
const ROW_TOKEN = 100;
/** Les jetons des vues Grille et Compacte. */
const TILE_TOKEN = 84;
const COMPACT_TOKEN = 48;
/* Une préférence de l'appareil, comme la vue de Ma liste. */
const VIEW_KEY = "as-profile-badges-view";
/** Sans accents ni majuscules : « legende » trouve « Légende ». */
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const famAnchor = (k: string) => `badges-fam-${k}`;
const TIER_TOKEN = 54;
/** Le palier sélectionné dans le panneau : un cran au-dessus des autres. */
const TIER_TOKEN_SEL = TIER_TOKEN + 12;
/**
 * Le trajet du cadre de sélection, en ms. Un peu plus long que le dépli des
 * lignes (`.as-pop-more`, 320 ms) : il arrive sur une ligne qui a fini de bouger.
 */
const FRAME_MOVE_MS = 420;

/* La dernière mesure des badges et le rattrapage déjà fait, gardés pour la
   visite (cf. l'effet de mesure plus bas). */
let lastLive: { progress: Map<string, Progress>; d: Derived } | null = null;
let backfilled = false;

export default function ProfileBadges({
  state: saved,
  live = false,
}: {
  state: BadgeState;
  /** Vrai sur son propre profil : les barres sont alors mesurables. */
  live?: boolean;
}) {
  const { t } = useTranslation();

  /* ── CHEZ SOI, C'EST LE MAGASIN LOCAL QUI FAIT FOI ──────────────────────────
     `saved` est la collection telle qu'elle est EN BASE, lue au rendu serveur
     (pages/en/profile/[user].tsx). Elle a un retard structurel : l'évaluation
     tourne dans le navigateur, écrit dans `aniscroll:badges`, et la sauvegarde
     cloud part après. Un badge gagné pendant la visite — ou par le `flush()`
     ci-dessous, qui est justement le premier à voir le compteur franchir son
     palier — n'apparaissait donc qu'AU CHARGEMENT SUIVANT : la barre restait à
     « 5208 / 5000 », sur un palier déjà acquis, et l'échelle ne montait pas.

     `useBadgeState()` s'abonne au magasin (événement maison + `storage`), et la
     fusion garde la date la PLUS ANCIENNE des deux côtés — l'invariant du
     magasin : un badge obtenu ne se reperd jamais, et ne se redate pas. */
  const localState = useBadgeState();
  const state = useMemo(
    () => (live ? mergeBadgeState(saved, localState) : saved),
    [live, saved, localState],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const [filter, setFilter] = useState<Filter>("all");
  const [rarity, setRarity] = useState<RarityPick>("all");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searched = useDeferredValue(query);
  /* Même mécanique que Ma liste : le bouton bouge tout de suite, la liste suit
     en différé. Lu à la création : cet onglet n'est jamais rendu par le serveur
     (lazyTabs.ts). */
  const [pickedView, setPickedView] = useState<View>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY) as View | null;
      if (v && VIEWS.includes(v)) return v;
    } catch {}
    return "cards";
  });
  const view = useDeferredValue(pickedView);
  const [viewSwitched, setViewSwitched] = useState(false);
  const chooseView = (v: View) => {
    if (v !== pickedView) setViewSwitched(true);
    setPickedView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch {}
  };
  /* Ce que la recherche peut lire. */
  const searchIndex = useMemo(
    () => new Map(BADGES.map((b) => {
      const name = norm(t(`badges.${b.id}.name`));
      return [b.id, { name, all: `${name} ${norm(t(`badges.${b.id}.cond`))}` }];
    })),
    [t],
  );
  const terms = useMemo(() => norm(searched).split(/\s+/).filter(Boolean), [searched]);
  /* Le dernier résultat connu d'abord (cache du module) : l'onglet s'affiche
     tout de suite avec ses barres, la nouvelle mesure arrive après. */
  const [progress, setProgress] = useState<Map<string, Progress>>(() => (live && lastLive?.progress) || new Map());
  /** Les mesures elles-mêmes, pour le DÉTAIL d'un badge (lib/badges/detail.ts). */
  const [derived, setDerived] = useState<Derived | null>(() => (live && lastLive?.d) || null);

  /* Chez soi : on mesure, et on lance le rattrapage des métadonnées.
     Les DEUX sont ici et pas au chargement du site — personne ne doit payer,
     en requêtes comme en calcul, pour un onglet qu'il n'ouvre pas. */
  useEffect(() => {
    if (!live) return;
    /* APRÈS LA PREMIÈRE PEINTURE (21/11/2026) : `progressAll()` mesure les 176
       badges d'un bloc ; lancé au montage, il retardait l'affichage de
       l'onglet. Au repos, l'onglet est déjà là quand il tourne. */
    let alive = true;
    const run = () => {
    recordFlag("badgesTab");
    /* Évalué TOUT DE SUITE, avant d'ouvrir la portée silencieuse : « Vitrine
       ouverte » est un vrai geste et mérite sa notification. Sans ce passage
       immédiat, l'évaluation débouncée du drapeau tomberait deux secondes plus
       tard, c'est-à-dire pendant le rattrapage — et serait tue avec lui. */
    flush();
    const first = progressAll(undefined, stateRef.current);
    lastLive = first;
    if (!alive) return;
    setProgress(first.progress);
    setDerived(first.d);
    /* Le rattrapage AniList une fois par visite du site : l'onglet gardé
       monté ne le relance plus, une nouvelle visite du profil non plus. */
    if (backfilled) return;
    backfilled = true;

    /* LE RATTRAPAGE EST SILENCIEUX, ET C'EST ICI QU'ON LE DÉCIDE.
       Il rend mesurables d'un coup les familles Genres et Découverte pour toute
       la liste : sans cette portée, la première ouverture de l'onglet déroule
       quarante notifications d'affilée pour des anime terminés il y a deux ans.
       Les badges sont bien accordés, avec leur vraie date — ils se découvrent
       dans l'onglet au lieu d'être annoncés.

       `flush()` AVANT `endQuiet()` : chaque lot écrit dans la liste et
       programme une évaluation débouncée à deux secondes. Rendre la main sans
       la forcer maintenant la laisserait tomber une fois la portée refermée,
       c'est-à-dire en annonçant — précisément ce qu'on évite. */
    beginQuiet();
    void backfillMetadata()
      .catch(() => {})
      .then(() => backfillAiring())
      .catch(() => {})
      .finally(() => {
      flush();
      endQuiet();
      const next = progressAll(undefined, stateRef.current);
      lastLive = next;
      if (!alive) return;
      setProgress(next.progress);
      setDerived(next.d);
    });
    };
    const idle = typeof window.requestIdleCallback === "function";
    const id = idle ? window.requestIdleCallback(run, { timeout: 600 }) : window.setTimeout(run, 50);
    return () => {
      alive = false;
      if (idle) window.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };
  }, [live]);

  /* Les badges qui comptent des badges suivent la collection AFFICHÉE : sans ça,
     « Grand collectionneur » gardait 71 quand le compteur du haut disait 72. */
  useEffect(() => {
    if (!live) return;
    const id = window.setTimeout(() => {
      const next = progressAll(undefined, state);
      lastLive = next;
      setProgress(next.progress);
      setDerived(next.d);
    }, 0);
    return () => window.clearTimeout(id);
  }, [live, state]);

  /**
   * LA RÉVÉLATION — la notification a envoyé ici avec un `#badge-<id>`.
   *
   * Un `requestAnimationFrame` avant de chercher l'élément : l'onglet vient
   * d'être monté par le parent, et l'ancre n'existe dans le DOM qu'après la
   * peinture. Chercher tout de suite ne trouve rien une fois sur deux.
   *
   * LE FRAGMENT EST EFFACÉ APRÈS COUP, par `replaceState` et non par une
   * navigation : laisser `#badge-x` dans la barre d'adresse ferait rejouer le
   * surlignage à chaque retour arrière, et `router.replace()` refroidirait la
   * page entière pour une histoire de fragment.
   */
  /* REJOUÉE à chaque `hashchange`, et pas seulement au montage : les badges
     mis en avant à côté du pseudo (FeaturedBadges) envoient ici depuis la
     même page — l'onglet peut être déjà ouvert, et rien ne se remonte.
     Les filtres reviennent à « tout » : un badge caché par « À obtenir » ou
     par une rareté ne serait pas trouvé. Et un palier d'ÉCHELLE déjà franchi
     n'a pas de ligne à lui (l'échelle se replie sur son palier du moment) :
     on surligne alors la ligne de l'échelle. */
  const gotRef = useRef(state.got);
  gotRef.current = state.got;
  useEffect(() => {
    let sorti = false;
    let t = 0;
    const reveler = () => {
      const cible = revealTarget();
      if (!cible) return;
      setFilter("all");
      setRarity("all");
      setQuery("");
      cancelAnimationFrame(t);
      /* Deux images : les filtres remis à zéro doivent avoir rendu la ligne. */
      const chercher = (essais: number) => {
        const def = BY_ID[cible];
        const tiers = def?.ladder ? LADDERS[def.ladder] ?? [] : [];
        const head = tiers.find((id) => gotRef.current[id] == null) ?? tiers[tiers.length - 1];
        const el =
          document.getElementById(revealAnchor(cible)) ??
          (head ? document.getElementById(revealAnchor(head)) : null);
        if (!el) {
          if (essais > 0) t = requestAnimationFrame(() => chercher(essais - 1));
          return;
        }
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("as-badge-flash");
        window.setTimeout(() => {
          if (!sorti) el.classList.remove("as-badge-flash");
        }, 2600);
        try {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        } catch {
          /* au mieux */
        }
      };
      /* Deux images au moins : les filtres remis à zéro doivent avoir rendu. */
      t = requestAnimationFrame(() => {
        t = requestAnimationFrame(() => chercher(30));
      });
    };
    reveler();
    window.addEventListener("hashchange", reveler);
    return () => {
      sorti = true;
      cancelAnimationFrame(t);
      window.removeEventListener("hashchange", reveler);
    };
  }, []);

  const got = state.got;
  const gotCount = MAIN.filter((b) => got[b.id] != null).length;
  const secretCount = SECRETS.filter((b) => got[b.id] != null).length;

  /* Le palier VISIBLE d'une échelle : le premier non atteint, ou le dernier
     quand tout est fait. Les autres partent dans le dépli. */
  const ladderHead = useMemo(() => {
    const head = new Map<string, string>();
    for (const [name, ids] of Object.entries(LADDERS)) {
      const open = ids.find((id) => got[id] == null);
      head.set(name, open ?? ids[ids.length - 1]);
    }
    return head;
  }, [got]);

  /* UN SECRET VERROUILLÉ NE SE CHERCHE QUE PAR SON NOM, déjà affiché : chercher
     dans sa condition masquée permettrait de la deviner mot à mot. */
  const matches = (b: BadgeDef) => {
    if (!terms.length) return true;
    const e = searchIndex.get(b.id);
    if (!e) return false;
    const hay = b.secret && got[b.id] == null ? e.name : e.all;
    return terms.every((x) => hay.includes(x));
  };

  const keep = (b: BadgeDef) => {
    if (!matches(b)) return false;
    /* Un secret VERROUILLÉ ne répond à aucune rareté : son jeton la cache, et
       le ranger sous « Mythique » la donnerait quand même. Il ne reste visible
       que sous « Toutes ». */
    if (rarity !== "all" && (b.rarity !== rarity || (b.secret && got[b.id] == null))) {
      return false;
    }
    if (filter === "got") return got[b.id] != null;
    if (filter === "todo") return got[b.id] == null;
    return true;
  };

  /** Les lignes d'une section, échelles repliées sur leur palier courant. */
  const rowsOf = (section: string): BadgeDef[] => {
    const out: BadgeDef[] = [];
    const seen = new Set<string>();
    for (const b of BADGES) {
      if (sectionOf(b) !== section) continue;
      if (b.ladder) {
        if (seen.has(b.ladder)) continue;
        seen.add(b.ladder);
        let shown = BY_ID[ladderHead.get(b.ladder) ?? b.id];
        /* Une rareté choisie montre le palier DE CETTE RARETÉ, même quand ce
           n'est pas le palier du moment : sous « Mythique » on veut voir
           « Légende », pas perdre l'échelle parce qu'on en est à « Habitué ».
           Même règle que le palier du moment, restreinte à la rareté : le
           premier non atteint, sinon le dernier (« streak » en a deux peu
           communs). */
        if (rarity !== "all" && shown.rarity !== rarity) {
          const tiers = (LADDERS[b.ladder] ?? []).filter((id) => BY_ID[id].rarity === rarity);
          if (!tiers.length) continue;
          shown = BY_ID[tiers.find((id) => got[id] == null) ?? tiers[tiers.length - 1]];
        }
        /* Une recherche vise un palier précis : « Légende » doit le trouver même
           si l'échelle en est à un autre. */
        if (terms.length && !keep(shown)) {
          shown = (LADDERS[b.ladder] ?? []).map((id) => BY_ID[id]).find(keep) ?? shown;
        }
        /* Le filtre s'applique au palier MONTRÉ : « à obtenir » sur une échelle
           entièrement faite doit la faire disparaître, pas afficher son dernier
           barreau. */
        if (keep(shown)) out.push(shown);
        continue;
      }
      if (keep(b)) out.push(b);
    }
    return out;
  };

  /* Les pastilles sont les ANNEAUX, pas les icônes : c'est la couleur qu'on
     retient d'un jeton (cf. RING_STOPS). « Toutes » les réunit en une roue, et
     sa lueur aussi : une ombre par rareté, décalée vers l'angle où la roue
     porte sa couleur (0° en haut, 60° par rareté, dans le sens horaire). */
  const rarityChoices: {
    value: RarityPick; label: string; color?: string; swatch?: string; glow?: string;
  }[] = [
    {
      value: "all",
      label: t("badges.ui.rarityFilter.all", "Toutes les raretés"),
      swatch: `conic-gradient(${RARITY_ORDER.map((r) => RING_HUE[r]).join(", ")}, ${RING_HUE.c})`,
      /* Six ombres à 22 % et pas six pleines : elles se cumulent, et à pleine
         teinte la roue brillait six fois plus que ses voisines. À 22 % leur
         somme (1 − 0,78⁶ ≈ 0,77) retombe sur la lueur d'UNE pastille — même
         flou de 6 px que les autres, seules les couleurs changent de côté. */
      glow: RARITY_ORDER.map((r, i) => {
        const a = (i / RARITY_ORDER.length) * 2 * Math.PI;
        const x = (Math.sin(a) * 1.5).toFixed(1);
        const y = (-Math.cos(a) * 1.5).toFixed(1);
        return `${x}px ${y}px 6px ${RING_HUE[r]}38`;
      }).join(", "),
    },
    ...RARITY_ORDER.map((r) => ({
      value: r,
      label: t(`badges.ui.rarity.${r}`, r),
      color: RING_HUE[r],
      swatch: ringSwatch(r),
    })),
  ];

  const chips: { k: Filter; label: string; n: number }[] = [
    { k: "all", label: t("badges.ui.all", "Tous"), n: BADGES.length },
    { k: "got", label: t("badges.ui.got", "Obtenus"), n: gotCount + secretCount },
    { k: "todo", label: t("badges.ui.todo", "À obtenir"), n: BADGES.length - gotCount - secretCount },
  ];

  const sections = SECTION_ORDER.map((section) => ({ section, rows: rowsOf(section) }));
  const secretRows = SECRETS.filter(keep);
  const nothing = !secretRows.length && sections.every((s) => !s.rows.length);
  const navItems: NavItem[] = [
    ...sections.map(({ section, rows }) => {
      const all = BADGES.filter((b) => sectionOf(b) === section);
      return {
        key: section,
        label: t(`badges.ui.section.${section}`, section),
        done: all.filter((b) => got[b.id] != null).length,
        total: all.length,
        enabled: rows.length > 0,
      };
    }),
    {
      key: "secret",
      label: t("badges.ui.family.secret", "Secret"),
      done: secretCount,
      total: SECRETS.length,
      enabled: secretRows.length > 0,
    },
  ];
  const clearAll = () => {
    setQuery("");
    setFilter("all");
    setRarity("all");
  };

  return (
    <div className="flex flex-col gap-3">
      <BadgeDefs />

      {/* La barre d'outils, comme celle de Ma liste : pas de boîte derrière,
          chaque contrôle porte sa plaque (`as-stat-card`), lisible sur une
          illustration de fond.

          `z-20` : le menu de rareté déborde vers le bas, et chaque carte de la
          liste est son propre contexte d'empilement (`isolation`) peint APRÈS
          cette barre — sans lui, la liste recouvrait le menu. */}
      <div className="relative z-20 flex flex-wrap items-center gap-2">
        {/* La recherche prend toute la place libre de la barre (22/11/2026, Luc). */}
        <label className="as-list-field as-stat-card min-w-0 flex-[3_1_220px] cursor-text focus-within:!border-action">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" className="shrink-0 text-white/40"><path d="M9.5,16q-2.72,0-4.61-1.89Q3,12.23 3,9.5Q3,6.77 4.89,4.89T9.5,3t4.61,1.89T16,9.5q0,1.1-0.35,2.07T14.7,13.3l5.6,5.6q0.28,0.28 0.28,0.7q0,0.42-0.28,0.7q-0.27,0.27-0.7,0.27T18.9,20.3l-5.6-5.6q-0.75,0.6-1.72,0.95T9.5,16Zm0-2q1.88,0 3.19-1.31T14,9.5T12.69,6.31T9.5,5T6.31,6.31T5,9.5t1.31,3.19T9.5,14Z" /></svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
            placeholder={t("badges.ui.search", "Chercher un badge…")}
            aria-label={t("badges.ui.search", "Chercher un badge…")}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-white/35"
          />
          {query ? (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); setQuery(""); searchRef.current?.focus(); }}
              aria-label={t("listMenu.clearSearch")}
              title={t("listMenu.clearSearch")}
              className="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          ) : null}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Dropdown
            className="as-dd-full as-dd-page as-stat-card w-[190px] rounded-[12px]"
            flip
            label={t("badges.ui.rarityFilter.label", "Filtrer par rareté")}
            value={rarity}
            choices={rarityChoices}
            onPick={(v) => setRarity(v as RarityPick)}
          />
          <FilterChips chips={chips} value={filter} onPick={setFilter} label={t("badges.ui.total", "badges obtenus")} />
          <ViewSwitch value={pickedView} onChange={chooseView} />
        </div>
      </div>

      {nothing ? (
        <div className="flex justify-center py-10">
          <div className="as-stat-card flex w-full max-w-md flex-col items-center gap-2 rounded-[14px] border border-white/[0.12] px-6 py-7 text-center">
            <p className="font-bold text-white">{t("listMenu.nothing")}</p>
            <p className="text-sm text-white/75">{t("badges.ui.searchHint", "Essaie un autre mot, une autre rareté ou un autre filtre.")}</p>
            <button type="button" onClick={clearAll} className="as-sfp-apply as-list-clear mt-3 px-6" style={{ flex: "none" }}>
              {t("listMenu.clearAll")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 grid items-start gap-5 lg:grid-cols-[190px_minmax(0,1fr)]">
          <BadgeNav items={navItems} done={gotCount} total={MAIN.length} secrets={secretCount} />
          <div
            key={view}
            className={`flex min-w-0 flex-col gap-8${viewSwitched ? " as-list-viewin" : ""}${pickedView !== view ? " is-pending" : ""}`}
          >
            {sections.map(({ section, rows }) => {
              if (!rows.length) return null;
              return (
                <section key={section} id={famAnchor(section)} className="flex scroll-mt-40 flex-col gap-3 lg:scroll-mt-24">
                  <div className="as-stat-card flex items-baseline gap-3 rounded-lg border-l-2 border-as-accent py-2 pl-3 pr-4">
                    <h3 className="font-outfit m-0 text-lg font-semibold text-white">
                      {t(`badges.ui.section.${section}`, section)}
                    </h3>
                    <span className="font-karla text-[12px] text-white/40">
                      {t(`badges.ui.sectionDesc.${section}`, "")}
                    </span>
                  </div>
                  <BadgeList
                    rows={rows}
                    view={view}
                    state={state}
                    progress={progress}
                    live={live}
                    filter={filter}
                    derived={derived}
                  />
                </section>
              );
            })}

            {/* Les secrets, à part et hors du total. */}
            <SecretSection
              rows={secretRows}
              view={view}
              state={state}
              progress={progress}
              live={live}
              filter={filter}
              derived={derived}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Le sommaire ────────────────────────────────────────────────────────────── */

/**
 * Tous / Obtenus / À obtenir : la case colorée GLISSE vers le filtre choisi.
 * En `transform` seul (comme la pilule de ProfileTabs) : le changement de
 * filtre re-rend la liste, une transition de `width` saccaderait. Pas de garde
 * `prefers-reduced-motion` : ce poste répond `reduce` et ne verrait rien.
 */
function FilterChips({
  chips,
  value,
  onPick,
  label,
}: {
  chips: { k: Filter; label: string; n: number }[];
  value: Filter;
  onPick: (f: Filter) => void;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const last = useRef<{ x: number; w: number } | null>(null);

  const place = (slide: boolean) => {
    const b = box.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    const el = pill.current;
    if (!b || !el) return;
    const to = { x: b.offsetLeft, w: b.offsetWidth };
    const old = last.current;
    last.current = to;
    el.style.width = `${to.w}px`;
    el.style.transform = `translateX(${to.x}px)`;
    if (!slide || !old || old.x === to.x) return;
    let from = old;
    const running = el.getAnimations();
    if (running.length) {
      // Reprise en plein vol : on repart de là où la case se trouve à l'écran.
      const m = new DOMMatrix(getComputedStyle(el).transform);
      from = { x: m.e, w: m.a * old.w };
      running.forEach((a) => a.cancel());
    }
    el.animate(
      [
        { transform: `translateX(${from.x}px) scaleX(${from.w / to.w})` },
        { transform: `translateX(${to.x}px) scaleX(1)` },
      ],
      { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  };

  (typeof window === "undefined" ? useEffect : useLayoutEffect)(() => place(true), [value]);
  /* Un compteur qui arrive ou la police qui charge change la largeur des
     boutons : la case suit, sans glisser. */
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} role="group" aria-label={label} className="as-stat-card relative flex h-[42px] shrink-0 items-center gap-0.5 rounded-[12px] border border-white/[0.12] p-0.5">
      <span ref={pill} aria-hidden className="pointer-events-none absolute bottom-0.5 left-0 top-0.5 origin-left rounded-[9px] bg-as-accent" />
      {chips.map((c) => (
        <button
          key={c.k}
          type="button"
          aria-pressed={value === c.k}
          onClick={() => onPick(c.k)}
          className={
            "font-outfit relative z-10 h-full whitespace-nowrap rounded-[9px] px-3 text-[12px] font-semibold transition-colors " +
            (value === c.k ? "text-white" : "text-white/60 hocus:text-white/85")
          }
        >
          {c.label}
          <span className="ml-1.5 text-[10px] opacity-60">{c.n}</span>
        </button>
      ))}
    </div>
  );
}

type NavItem = { key: string; label: string; done: number; total: number; enabled: boolean };

/**
 * Le sommaire collant : une colonne sur ordinateur, une bande qui défile sur
 * téléphone. Il suit la section lue et y saute au clic. Une famille sans
 * résultat pour la recherche ou les filtres reste listée, éteinte. Le total de
 * la collection est en tête : hors de la bande qui défile sur téléphone, il
 * reste donc toujours visible.
 */
function BadgeNav({
  items,
  done,
  total,
  secrets,
}: {
  items: NavItem[];
  done: number;
  total: number;
  secrets: number;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState(items[0]?.key ?? "");
  const strip = useRef<HTMLElement | null>(null);
  const enabledKey = items.filter((i) => i.enabled).map((i) => i.key).join(",");

  /* `body { overflow-x: hidden }` en fait un conteneur de défilement qui ne
     défile jamais : tout `sticky` de la page s'y accroche et ne colle pas.
     `clip` coupe le débordement pareil sans créer ce conteneur ; limité au
     temps où le sommaire est affiché. */
  useEffect(() => {
    document.body.classList.add("as-sticky-page");
    return () => document.body.classList.remove("as-sticky-page");
  }, []);

  useEffect(() => {
    const keys = enabledKey ? enabledKey.split(",") : [];
    let raf = 0;
    const measure = () => {
      raf = 0;
      let cur = keys[0] ?? "";
      /* Sous 1024 px, le sommaire collant porte aussi le total : il est plus haut. */
      const seuil = window.innerWidth < 1024 ? 170 : 140;
      for (const k of keys) {
        const el = document.getElementById(famAnchor(k));
        if (el && el.getBoundingClientRect().top <= seuil) cur = k;
      }
      /* Tout en bas, la dernière section est trop courte pour monter jusqu'au
         seuil : c'est pourtant elle qu'on lit. */
      const doc = document.documentElement;
      if (keys.length && window.scrollY + window.innerHeight >= doc.scrollHeight - 2) {
        cur = keys[keys.length - 1];
      }
      setActive(cur);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabledKey]);

  /* Sur téléphone, la pastille active reste visible dans la bande. */
  useEffect(() => {
    const box = strip.current;
    if (!box || box.scrollWidth <= box.clientWidth) return;
    const btn = box.querySelector<HTMLElement>('[aria-current="true"]');
    if (btn) box.scrollTo({ left: btn.offsetLeft - (box.clientWidth - btn.offsetWidth) / 2 });
  }, [active]);

  return (
    <div className="as-badge-nav as-stat-card sticky top-16 z-10 min-w-0 rounded-xl p-1.5 ring-1 ring-white/[.08] lg:top-20">
    <div className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-white/[.08] px-2.5 pb-2 pt-1">
      <p className="font-outfit m-0 shrink-0 whitespace-nowrap text-xl font-semibold leading-tight text-white">
        {done}
        <span className="text-white/35"> / {total}</span>
        <span className="sr-only"> {t("badges.ui.total", "badges obtenus")}</span>
      </p>
      {secrets > 0 ? (
        <p className="font-outfit m-0 shrink-0 whitespace-nowrap text-[11px] font-semibold text-[#FF7F57]">
          + {secrets} {t("badges.ui.secretsShort", "secrets")}
        </p>
      ) : null}
    </div>
    <nav
      ref={strip}
      aria-label={t("badges.ui.nav", "Sommaire des badges")}
      className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible"
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          disabled={!it.enabled}
          aria-current={active === it.key ? "true" : undefined}
          onClick={() => {
            setActive(it.key);
            const el = document.getElementById(famAnchor(it.key));
            if (!el) return;
            el.scrollIntoView({ behavior: "smooth", block: "start" });
            /* Les lignes hors écran ont une hauteur estimée (content-visibility) :
               mesurées pendant le trajet, elles décalent l'arrivée. On recale. */
            const recale = (n = 8) => {
              const marge = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
              if (Math.abs(el.getBoundingClientRect().top - marge) > 2) {
                el.scrollIntoView({ behavior: "instant", block: "start" });
              }
              if (n > 0) requestAnimationFrame(() => recale(n - 1));
            };
            const auBout = () => recale();
            window.addEventListener("scrollend", auBout, { once: true });
            window.setTimeout(() => window.removeEventListener("scrollend", auBout), 1500);
          }}
          className={
            "font-outfit flex shrink-0 items-center justify-between gap-3 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] font-semibold transition-colors disabled:cursor-default disabled:opacity-30 " +
            (active === it.key ? "bg-as-accent text-white" : "text-white/65 enabled:hocus:bg-white/[.07] enabled:hocus:text-white")
          }
        >
          <span>{it.label}</span>
          <span className="text-[10.5px] tabular-nums opacity-70">{Math.round((it.done / it.total) * 100)} %</span>
        </button>
      ))}
    </nav>
    </div>
  );
}

/** Le bouton Détail s'affiche-t-il sur cette ligne ? */
function showsDetail(
  def: BadgeDef, unlocked: boolean, hidden: boolean, progress: Progress, derived: Derived | null,
  got?: Record<string, number>,
): boolean {
  if (!derived || (hidden && !unlocked)) return false;
  if (!unlocked && !(progress && progress[1] > 1)) return false;
  return !!detailKind(def, derived, got);
}

/** Largeur d'un bouton de ligne en vue Compacte, et leur écart. */
const SLOT = 42;
const SLOT_GAP = 4;

/** Les lignes d'une section, dans la vue choisie. */
function BadgeList({
  rows, view, state, progress, live, filter, derived, hidden = false,
}: {
  rows: BadgeDef[];
  view: View;
  state: BadgeState;
  progress: Map<string, Progress>;
  live: boolean;
  filter: Filter;
  derived: Derived | null;
  hidden?: boolean;
}) {
  /* Compacte : la place des boutons est la même sur toute la section, sinon
     les dates et les barres se décalent d'une ligne à l'autre. */
  const slots = view !== "compact" ? 0 :
    (rows.some((b) => b.ladder) ? 1 : 0) +
    (rows.some((b) => showsDetail(b, state.got[b.id] != null, hidden, live ? progress.get(b.id) ?? null : null, live ? derived : null, state.got)) ? 1 : 0);
  const items = rows.map((b) => (
    <BadgeRow
      key={b.id}
      def={b}
      view={view}
      slots={slots}
      state={state}
      progress={live ? progress.get(b.id) ?? null : null}
      live={live}
      filter={filter}
      ladderProgress={progress}
      derived={live ? derived : null}
      hidden={hidden}
    />
  ));
  /* Grille et Compacte : UN panneau flou par section, comme Ma liste. */
  if (view === "grid") {
    return (
      <div className="as-stat-card grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 rounded-2xl p-2.5 ring-1 ring-white/[.07] sm:p-3">
        {items}
      </div>
    );
  }
  if (view === "compact") {
    return <div className="as-stat-card overflow-hidden rounded-xl ring-1 ring-white/[.07]">{items}</div>;
  }
  return <div className="flex flex-col gap-1.5">{items}</div>;
}

/* ── Une ligne ──────────────────────────────────────────────────────────────── */

function BadgeRow({
  def, view = "cards", slots = 0, state, progress, live, filter, ladderProgress, derived, hidden = false,
}: {
  def: BadgeDef;
  view?: View;
  /** Compacte : combien de boutons réserver au bout de la ligne. */
  slots?: number;
  state: BadgeState;
  progress: Progress;
  live: boolean;
  filter: Filter;
  ladderProgress: Map<string, Progress>;
  /** Chez soi seulement : les mesures d'où sort le détail. `null` ailleurs. */
  derived: Derived | null;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const at = state.got[def.id];
  const unlocked = at != null;
  const R = RARITY[def.rarity];

  if (view !== "cards") {
    const detailBtn = showsDetail(def, unlocked, hidden, progress, derived, state.got) && derived ? (
      <DetailButton def={def} derived={derived} progress={progress} got={state.got} small />
    ) : null;
    const ladderBtn = def.ladder ? (
      <LadderButton ladder={def.ladder} state={state} progress={ladderProgress} live={live} color={R.ic} small />
    ) : null;
    const token = (size: number) => (
      <BadgeToken
        id={def.id}
        rarity={def.rarity}
        icon={def.icon}
        tag={def.tag}
        unlocked={unlocked}
        hidden={hidden && !unlocked}
        size={size}
        check
      />
    );
    const name = (
      <span
        className="font-outfit block truncate text-[13.5px] font-semibold"
        title={t(`badges.${def.id}.name`)}
        style={{ color: unlocked ? "#fff" : "rgba(255,255,255,.85)" }}
      >
        {t(`badges.${def.id}.name`)}
      </span>
    );
    const rarityLabel = <RarityLine def={def} at={at} center={view === "grid"} />;

    if (view === "grid") {
      return (
        <div
          id={revealAnchor(def.id)}
          className={
            "as-badge-row as-badge-tile scroll-mt-28 flex min-w-0 flex-col rounded-xl p-2.5 text-center transition-colors " +
            (unlocked
              ? "ring-1 ring-white/[.08] hocus:ring-white/[.16]"
              : "is-locked outline-dashed outline-1 -outline-offset-1 outline-white/[.16] hocus:outline-white/30")
          }
          style={unlocked ? { backgroundImage: `linear-gradient(180deg, ${R.ic}24, transparent 70%)` } : undefined}
        >
          <div className="as-badge-row-in flex min-w-0 flex-1 flex-col items-center">
            {token(TILE_TOKEN)}
            <div className="mt-1 w-full min-w-0">{name}{rarityLabel}</div>
            {/* Deux lignes réservées : les barres s'alignent d'une case à l'autre. */}
            <div className="w-full min-w-0 [&>p]:line-clamp-2 [&>p]:min-h-[2.6em] [&>p]:break-all [&>p]:text-[11.5px] [&>p:not(.as-badge-blur)]:break-normal">
              <Condition def={def} hidden={hidden && !unlocked} unlocked={unlocked} />
            </div>
            <div className="w-full"><ProgressLine def={def} progress={progress} unlocked={unlocked} live={live} color={R.ic} /></div>
          </div>
          <div className={`mt-2 flex-wrap items-center justify-center gap-1 ${detailBtn || ladderBtn ? "flex min-h-7" : "hidden"}`}>
            {detailBtn}
            {ladderBtn}
          </div>
        </div>
      );
    }

    return (
      <div
        id={revealAnchor(def.id)}
        className={
          "as-badge-row as-badge-row-compact scroll-mt-28 flex items-center gap-2 px-3 py-1.5 shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)] transition-[background-color] last:shadow-none hover:bg-white/[0.06]" +
          (unlocked ? "" : " is-locked")
        }
        style={unlocked ? { backgroundImage: `linear-gradient(90deg, ${R.ic}1f, transparent 45%)` } : undefined}
      >
        <div className="as-badge-row-in flex min-w-0 flex-1 items-center gap-3">
          <div className="shrink-0">{token(COMPACT_TOKEN)}</div>
          <div className="min-w-0 flex-1 sm:w-[175px] sm:flex-none max-sm:[&>span:first-child]:line-clamp-2 max-sm:[&>span:first-child]:whitespace-normal max-sm:[&>span:first-child]:leading-tight">{name}{rarityLabel}</div>
          <div className="hidden min-w-0 flex-1 sm:block [&>p]:mt-0 [&>p]:line-clamp-2">
            <Condition def={def} hidden={hidden && !unlocked} unlocked={unlocked} />
          </div>
          {/* La barre des badges à obtenir ; la colonne reste vide sur PC pour
              garder les boutons alignés, et rend sa place sur téléphone. */}
          <div className={`w-[72px] shrink-0 justify-end sm:flex sm:w-[150px] [&>div]:mt-0 [&>div]:w-full [&>p]:mt-0 [&>p]:leading-tight max-sm:[&>div>div:first-child]:hidden max-sm:[&>div]:justify-end ${unlocked ? "hidden" : "flex"}`}>
            {unlocked ? null : (
              <ProgressLine def={def} progress={progress} unlocked={unlocked} live={live} color={R.ic} />
            )}
          </div>
        </div>
        {slots > 0 ? (
          <div
            className="flex shrink-0 items-center justify-end"
            style={{ width: slots * SLOT + (slots - 1) * SLOT_GAP, gap: SLOT_GAP }}
          >
            {detailBtn}
            {ladderBtn}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      /* L'ancre de la notification. `scroll-mt-28` dégage la hauteur de la
         navbar collante : sans elle, `scrollIntoView` pose la ligne visée
         PILE dessous, donc invisible. */
      id={revealAnchor(def.id)}
      /* À obtenir : une case vide, sans fond, bordée de pointillés. Obtenu : la
         carte pleine. C'est la ligne qui dit la possession — le jeton, lui,
         garde sa couleur de rareté, trop forte pour porter les deux.
         `as-stat-card` reste sur les deux : c'est elle qui porte le flou du
         studio (son `::before`). Seul son fond est retiré, en ligne plus bas. */
      className={
        "as-badge-row as-stat-card scroll-mt-28 flex flex-col rounded-xl px-3.5 py-3 transition-colors " +
        (unlocked
          ? "ring-1 ring-white/[.08] hocus:ring-white/[.16]"
          : "is-locked outline-dashed outline-1 -outline-offset-1 outline-white/[.16] hocus:outline-white/30")
      }
      /* Obtenu : la ligne se teinte à la couleur de rareté, liseré compris.
         Le dégradé de plaque est repris tel quel (mêmes variables que
         .as-stat-card) : un `background` en ligne écrase celui de la classe. */
      style={
        unlocked
          ? ({
              background: `linear-gradient(90deg, ${R.ic}26, transparent 60%), linear-gradient(145deg, rgba(20,22,28,var(--as-plate-a1,.72)), rgba(12,13,16,var(--as-plate-a2,.58)))`,
              "--tw-ring-color": `${R.ic}61`,
            } as CSSProperties)
          : { background: "transparent" }
      }
    >
      <div className="flex items-center gap-4">
        <div className="as-badge-row-in shrink-0">
          <BadgeToken
            id={def.id}
            rarity={def.rarity}
            icon={def.icon}
            tag={def.tag}
            unlocked={unlocked}
            hidden={hidden && !unlocked}
            size={ROW_TOKEN}
            check
          />
        </div>

        <div className="as-badge-row-in min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="font-outfit text-[15.5px] font-semibold"
              style={{ color: unlocked ? "#fff" : "rgba(255,255,255,.85)" }}
            >
              {t(`badges.${def.id}.name`)}
            </span>
            <RarityLine def={def} at={at} />
          </div>

          <Condition def={def} hidden={hidden && !unlocked} unlocked={unlocked} />

          <ProgressLine
            def={def}
            progress={progress}
            unlocked={unlocked}
            live={live}
            color={R.ic}
            fixed
          />
          {!unlocked && derived && !hidden ? <MissingLine def={def} derived={derived} /> : null}
        </div>

        {/* Le détail : QUOI remplit le badge, case par case. Jamais sur un
            secret verrouillé — sa condition est cachée, ses cases la
            donneraient — ni sur un badge à UN SEUL anime pas encore obtenu
            (« Pépite méconnue ») : sa liste serait vide. */}
        {(() => {
          const detail = derived && !(hidden && !unlocked) && (unlocked || (progress && progress[1] > 1));
          if (!detail && !def.ladder) return null;
          return (
            <div className="flex shrink-0 items-center gap-1.5">
              {detail && derived ? <DetailButton def={def} derived={derived} progress={progress} got={state.got} /> : null}
              {/* L'échelle complète s'ouvre dans un panneau : les six paliers,
                  celui du moment compris et mis en avant. */}
              {def.ladder ? (
                <LadderButton ladder={def.ladder} state={state} progress={ladderProgress} live={live} color={R.ic} />
              ) : null}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/**
 * La date d'obtention, formatée APRÈS le montage.
 *
 * `toLocaleDateString` dépend du fuseau et de la locale du navigateur : rendue
 * côté serveur elle donne autre chose que côté client, et React rejette
 * l'hydratation. C'est exactement le défaut qui a rendu la page profil « très
 * longue à charger » le 02/09/2026 (devlog/site.md) — une date formatée contre
 * l'environnement faisait rendre la page deux fois. On rend donc un tiret au
 * premier passage, et la date ensuite.
 */
function ObtainedOn({ at }: { at: number }) {
  const { i18n } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    /* La langue de l'INTERFACE, pas celle du navigateur : quelqu'un qui lit le
       site en français sur un Chrome en anglais doit lire « sept. », pas
       « Sep ». C'est la langue qu'il a choisie qui gouverne. */
    setText(
      new Date(at).toLocaleDateString(i18n.language || undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
    );
  }, [at, i18n.language]);
  return <>{text ?? "—"}</>;
}

/**
 * La rareté, puis la date d'obtention derrière une barre fine. Pas de mention
 * « Obtenu » : le jeton a sa coche et la case sa teinte.
 */
function RarityLine({ def, at, center = false }: { def: BadgeDef; at?: number; center?: boolean }) {
  const { t } = useTranslation();
  const unlocked = at != null;
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 ${center ? "justify-center" : ""}`}>
      <span
        className="font-karla truncate text-[9px] uppercase tracking-[.16em]"
        style={{ color: unlocked ? RARITY[def.rarity].ic : "rgba(255,255,255,.6)" }}
      >
        {t(`badges.ui.rarity.${def.rarity}`, def.rarity)}
      </span>
      {unlocked && at !== NO_DATE ? (
        <>
          <span aria-hidden className="h-2.5 w-px shrink-0 bg-white/25" />
          <span className="shrink-0 whitespace-nowrap font-karla text-[10.5px] leading-none tabular-nums text-white/75">
            <ObtainedOn at={at} />
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * La condition. Pour un secret verrouillé, le VRAI TEXTE N'EST PAS RENDU.
 *
 * Un `filter: blur()` n'est qu'un effet de peinture : le texte reste dans le
 * DOM et l'inspecteur du navigateur le donne en deux clics — autant l'afficher
 * en clair. On rend donc une chaîne de remplissage de longueur comparable, et
 * on la floute pour l'allure.
 */
function Condition({
  def, hidden, unlocked,
}: {
  def: BadgeDef;
  hidden: boolean;
  unlocked: boolean;
}) {
  const { t } = useTranslation();
  if (hidden) {
    return (
      <p
        className="as-badge-blur m-0 mt-1 font-karla text-[12.5px] leading-snug text-white/30"
        aria-label={t("badges.ui.secretHidden", "Condition masquée")}
      >
        {"▒".repeat(34)}
      </p>
    );
  }
  return (
    <p
      className="m-0 mt-1 font-karla text-[12.5px] leading-snug"
      style={{ color: unlocked ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.68)" }}
    >
      {t(`badges.${def.id}.cond`)}
    </p>
  );
}

/**
 * La barre. Trois états, et ils disent trois choses différentes :
 *   - obtenu            : pas de barre, la date suffit ;
 *   - mesurable         : la barre et « 9 / 10 » ;
 *   - pas mesurable     : une phrase, PAS une barre à 0 %. Une barre vide dit
 *                         « tu n'en as aucun » ; la vérité est « je ne sais
 *                         pas encore ». Cf. le contrat du `null` dans
 *                         lib/badges/measure.ts.
 */
/**
 * « 88 / 100 j » — l'avancement dans l'unité QUE LE BADGE AFFICHE.
 *
 * Les compteurs de temps sont en minutes (`of: "minutes"`), et la barre des
 * « Cent jours d'anime » lisait donc « 126 982 / 144 000 » sous une plaque qui
 * dit « 100 J ». L'unité se lit sur le seuil : un multiple de 1 440 minutes se
 * compte en jours (1 J, 7 J… 365 J), le reste en heures (10 H). Arrondi vers
 * le BAS : 143 999 minutes ne sont pas encore cent jours.
 */
function progressText(
  def: BadgeDef,
  cur: number,
  target: number,
  lang: string | undefined,
  t: (k: string, d: string) => string,
): string {
  const fmt = (n: number) => n.toLocaleString(lang || undefined);
  const m = def.metric;
  /* « Un an déjà » compte des jours : « 85 / 365j » (24/11/2026, Luc). */
  if (m.k === "accountAge") return `${fmt(cur)} / ${fmt(target)}${t("badges.ui.unit.d", "j")}`;
  if (m.k !== "count" || m.of !== "minutes") return `${fmt(cur)} / ${fmt(target)}`;
  const days = target % 1440 === 0;
  const div = days ? 1440 : 60;
  const unit = days ? t("badges.ui.unit.d", "j") : t("badges.ui.unit.h", "h");
  return `${fmt(Math.floor(cur / div))} / ${fmt(target / div)} ${unit}`;
}

function ProgressLine({
  def, progress, unlocked, live, color, fixed = false,
}: {
  def: BadgeDef;
  progress: Progress;
  unlocked: boolean;
  live: boolean;
  color: string;
  /** Vue Cartes : même longueur de barre sur toutes les lignes dès la tablette. */
  fixed?: boolean;
}) {
  const { t, i18n } = useTranslation();
  if (unlocked) return null;
  if (!live) return null;
  if (!progress) {
    return (
      <p className="m-0 mt-1.5 font-karla text-[10.5px] italic text-white/55">
        {t("badges.ui.notMeasurable", "Pas encore mesurable")}
      </p>
    );
  }
  const [cur, target] = progress;
  if (target <= 1) return null; // un fait binaire n'a pas d'avancement à montrer
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className={fixed ? "min-w-0 flex-1 sm:w-[280px] sm:flex-none" : "min-w-0 flex-1"}>
        <Bar pct={Math.min(100, (cur / target) * 100)} color={color} />
      </div>
      <span className="shrink-0 font-karla text-[10.5px] tabular-nums text-white/65">
        {/* Le séparateur de milliers suit la langue choisie : « 10 000 » en
            français, « 10,000 » en anglais. Il était figé en fr-FR. */}
        {progressText(def, cur, target, i18n.language, t)}
      </span>
    </div>
  );
}

/* ── L'échelle complète, dans un panneau ───────────────────────────────────── */

/** Le chevron au bout de la ligne, et le panneau qu'il ouvre. */
function LadderButton({
  ladder, state, progress, live, color, small = false,
}: {
  ladder: string;
  state: BadgeState;
  progress: Map<string, Progress>;
  live: boolean;
  color: string;
  /** Le format des vues Grille et Compacte. */
  small?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ids = LADDERS[ladder] ?? [];
  const done = ids.filter((id) => state.got[id] != null).length;
  if (ids.length < 2) return null;
  /* Le palier OÙ L'ON EST, celui qu'on est en train de faire (et non le dernier
     obtenu), à sa couleur : cinq paliers obtenus sur six = 6/6 Mythique. */
  const palier = Math.min(done + 1, ids.length);
  const rarete = BY_ID[ids[palier - 1]].rarity;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("badges.ui.seeTiers", "Voir tous les paliers")}
        aria-label={t("badges.ui.seeTiers", "Voir tous les paliers")}
        className={
          "flex shrink-0 items-center justify-center rounded-full bg-white/[.09] text-white transition-colors hocus:bg-white/[.17] " +
          (small ? "h-8 p-[3px]" : "h-10 gap-2 p-1.5 sm:pl-4")
        }
        style={small ? { width: SLOT } : undefined}
      >
        {small ? null : (
          <span className="hidden font-outfit text-[13.5px] font-semibold leading-none sm:inline">
            {t("badges.ui.tiers", "Paliers")}
          </span>
        )}
        <span
          className={
            "grid place-items-center rounded-full font-karla font-bold tabular-nums leading-none " +
            (small ? "h-[26px] w-full text-[11px]" : "h-7 min-w-[38px] px-1.5 text-[12px]")
          }
          style={{ background: RING_HUE[rarete], color: RARITY[rarete].plaque[1] }}
        >
          {palier}/{ids.length}
        </span>
      </button>
      {open && (
        <LadderPopup
          ids={ids}
          state={state}
          progress={progress}
          live={live}
          color={color}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * La coque des panneaux de l'onglet (paliers, détail) : portée sur le corps du
 * document, un voile, une carte de verre, Échap et le bouton Fermer.
 *
 * Portée sur `document.body` : la ligne d'où part un panneau vit dans une carte
 * qui a son propre contexte d'empilement et un fond flouté — rendu là-dedans,
 * il se retrouverait coincé derrière la ligne suivante.
 */
function PopShell({
  title, meta, onClose, children,
}: {
  title: React.ReactNode;
  /** Le compteur à droite du titre. */
  meta?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  /* La fenêtre de « Trier & filtrer » (21/11/2026, Luc) : mêmes classes, même
     voile, même entrée et même sortie. Seule sa largeur est celle d'une liste. */
  const [open, setOpen] = useState(true);
  const { shown, closing } = useSheetPresence(open);
  useScrollLock(true);

  useEffect(() => {
    if (!shown) onClose();
  }, [shown, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`as-sfp-overlay${closing ? " is-closing" : ""}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div className="as-sfp" role="dialog" aria-modal="true" style={{ maxWidth: 560 }}>
        <div className="as-sfp-head">
          <h3 className="m-0 min-w-0 flex-1 truncate">{title}</h3>
          {meta ? <span className="as-sfp-rv shrink-0">{meta}</span> : null}
          <button type="button" className="as-sfp-x shrink-0" onClick={() => setOpen(false)} aria-label={t("listMenu.close")}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="as-sfp-body">
          <div className="px-[18px] py-3">{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Le panneau d'une échelle : TOUS les paliers, et UN palier sélectionné.
 *
 * ── LA SÉLECTION ─────────────────────────────────────────────────────────────
 * Le panneau s'ouvre sur le palier du moment, et un clic sur n'importe quel
 * autre le sélectionne à son tour : son jeton grandit, sa condition et sa barre
 * se déplient, et LE CADRE Y GLISSE en prenant la couleur de sa rareté.
 *
 * Le cadre est UN seul élément, pas une bordure par ligne : c'est ce qui lui
 * permet de voyager d'une case à l'autre au lieu de s'éteindre ici et de
 * s'allumer là. Il est déplacé en JS et non par une transition CSS, parce que
 * sa cible BOUGE pendant le trajet — la ligne quittée se replie, la ligne
 * visée se déplie, et une transition partie vers la position de départ
 * arriverait à côté. Chaque image vise donc la position COURANTE de la ligne.
 */
function LadderPopup({
  ids, state, progress, live, color, onClose,
}: {
  ids: string[];
  state: BadgeState;
  progress: Map<string, Progress>;
  live: boolean;
  color: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const done = ids.filter((id) => state.got[id] != null).length;
  const current = ids.find((id) => state.got[id] == null) ?? ids[ids.length - 1];
  const [sel, setSel] = useState(current);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /** Où le cadre est posé, pour partir de là au prochain clic. */
  const framePos = useRef<{ top: number; h: number } | null>(null);

  /* Le trajet du cadre. Au premier passage il est POSÉ, sans trajet : il
     arrive avec les lignes. Ensuite il part de là où il est et vise, à chaque
     image, la position COURANTE de la ligne sélectionnée (cf. l'en-tête). La
     durée couvre le dépli des lignes (`.as-pop-more`, 320 ms), si bien qu'il
     finit exactement sur une ligne qui a fini de bouger. */
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const place = (top: number, h: number) => {
      frame.style.transform = `translateY(${top}px)`;
      frame.style.height = `${h}px`;
      framePos.current = { top, h };
    };
    const target = () => rowRefs.current.get(sel) ?? null;
    const snap = () => {
      const el = target();
      if (el) place(el.offsetTop, el.offsetHeight);
    };

    let raf = 0;
    let moving = false;
    const from = framePos.current;
    if (!from) snap();
    else {
      moving = true;
      const t0 = performance.now();
      const tick = (now: number) => {
        const el = target();
        if (!el) return;
        const k = Math.min(1, (now - t0) / FRAME_MOVE_MS);
        const e = 1 - Math.pow(1 - k, 4);
        place(
          from.top + (el.offsetTop - from.top) * e,
          from.h + (el.offsetHeight - from.h) * e,
        );
        if (k < 1) raf = requestAnimationFrame(tick);
        else moving = false;
      };
      raf = requestAnimationFrame(tick);
    }

    /* Et il reste collé une fois arrivé : une largeur de fenêtre qui change
       replie autrement le texte, et la ligne change de hauteur sous lui. */
    const list = frame.parentElement;
    const ro = new ResizeObserver(() => {
      if (!moving) snap();
    });
    if (list) ro.observe(list);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [sel]);

  const S = RARITY[BY_ID[sel].rarity];

  // La lueur suit la sélection, comme le cadre.
  return (
    <PopShell
      title={<>{t(`badges.${ids[0]}.name`)}<span className="text-white/30">{" → "}{t(`badges.${ids[ids.length - 1]}.name`)}</span></>}
      meta={`${done} / ${ids.length}`}
      onClose={onClose}
    >
        <div className="relative flex flex-col gap-2">
          {/* LE cadre. Premier dans le DOM : les lignes, positionnées, se
              peignent par-dessus lui — il est derrière leur texte, pas dessus. */}
          <div
            ref={frameRef}
            aria-hidden
            className="as-pop-frame pointer-events-none absolute left-0 right-0 top-0 rounded-xl"
            style={{
              border: `1px solid ${S.ic}66`,
              background: `${S.ic}17`,
              boxShadow: `0 0 22px ${S.ic}26`,
            }}
          />
          {ids.map((id, i) => {
            const def = BY_ID[id];
            const at = state.got[id];
            const p = live ? progress.get(id) ?? null : null;
            const isSel = id === sel;
            const R = RARITY[def.rarity];
            /* Un palier obtenu montre une barre PLEINE : c'est ce qu'il a
               accompli, pas l'avancement du compteur vers un palier plus haut. */
            const reach = p && p[1] > 1 ? (at != null ? Math.max(p[0], p[1]) : Math.min(p[0], p[1])) : null;
            return (
              <div
                key={id}
                ref={(el) => {
                  if (el) rowRefs.current.set(id, el);
                  else rowRefs.current.delete(id);
                }}
                role="button"
                tabIndex={0}
                aria-current={isSel ? "true" : undefined}
                onClick={() => setSel(id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSel(id);
                  }
                }}
                /* À obtenir : les pointillés de l'onglet, la même case vide.
                   Retirés sur la ligne sélectionnée, où le cadre dessine déjà
                   le bord — deux liserés l'un sur l'autre se brouillaient.

                   AUCUNE BORDURE, même transparente : c'était le trait coloré
                   au bord droit de chaque case. Un fond se cale sur la boîte
                   INTÉRIEURE et se répète sous la bordure — la colonne de 1 px
                   de droite reprenait donc le début du dégradé, sa partie
                   teintée. Le cadre de sélection a sa propre bordure.

                   Obtenu : la carte de l'onglet, bord compris — un anneau
                   `inset` de la couleur de rareté (une ombre, donc pas de
                   bordure sous laquelle le fond se répéterait) et une plaque
                   sur toute la largeur. Sans elle le dégradé s'éteignait à
                   70 % et la case n'avait plus de bord droit. */
                className={
                  "as-pop-row relative flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 focus-visible:ring-1 focus-visible:ring-white/30 " +
                  (at != null
                    ? "outline-none ring-1 ring-inset"
                    : !isSel
                      ? "outline-dashed outline-1 -outline-offset-1 outline-white/[.16] hover:outline-white/30"
                      : "outline-none")
                }
                style={{
                  background:
                    at != null
                      ? `linear-gradient(90deg, ${R.ic}24, transparent 65%), rgba(255,255,255,.035)`
                      : "transparent",
                  ...(at != null ? { "--tw-ring-color": `${R.ic}52` } : null),
                  /* Les lignes arrivent l'une après l'autre, de haut en bas :
                     l'échelle se lit dans l'ordre où elle se gravit. */
                  animationDelay: `${40 + i * 45}ms`,
                }}
              >
                {/* Le jeton est dessiné une fois à la grande taille et réduit
                    par `transform` : la taille d'un SVG ne se transitionne pas,
                    une échelle si. La boîte autour suit la même courbe, pour
                    que la ligne grandisse avec lui au lieu de sauter. */}
                <div
                  className="as-pop-tokenbox shrink-0"
                  style={{ width: isSel ? TIER_TOKEN_SEL : TIER_TOKEN, height: isSel ? TIER_TOKEN_SEL : TIER_TOKEN }}
                >
                  <div
                    className="as-pop-tokenscale"
                    style={{ transform: `scale(${isSel ? 1 : TIER_TOKEN / TIER_TOKEN_SEL})` }}
                  >
                    <BadgeToken
                      id={def.id}
                      rarity={def.rarity}
                      icon={def.icon}
                      tag={def.tag}
                      unlocked={at != null}
                      size={TIER_TOKEN_SEL}
                      animate={false}
                      check
                    />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="font-outfit truncate text-[13px]"
                      style={{ color: at != null ? "#fff" : "rgba(255,255,255,.5)" }}
                    >
                      {t(`badges.${id}.name`)}
                    </span>
                    {at != null && at !== NO_DATE ? <span className="ml-auto shrink-0 whitespace-nowrap font-karla text-[10.5px] tabular-nums text-white/75"><ObtainedOn at={at} /></span> : null}
                  </div>
                  {/* Rendu pour toutes les lignes et replié hors sélection : un
                      dépli qui n'existerait que sélectionné ne pourrait pas se
                      replier, il disparaîtrait d'un coup. */}
                  <div className="as-pop-more">
                    <div className="min-h-0 overflow-hidden">
                      <Condition def={def} hidden={false} unlocked={at != null} />
                      {reach != null && p ? (
                        <div className="as-pop-bar mt-1.5 flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <Bar pct={Math.min(100, (reach / p[1]) * 100)} color={R.ic} />
                          </div>
                          <span className="font-karla shrink-0 text-[10px] tabular-nums text-white/40">
                            {progressText(def, reach, p[1], i18n.language, t)}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

    </PopShell>
  );
}

/* ── Le détail d'un badge ───────────────────────────────────────────────────── */

/**
 * Le bouton « Détail » d'une ligne, et le panneau qu'il ouvre.
 *
 * Le détail n'est calculé qu'à l'ouverture (`detailOf`) : la ligne ne demande
 * que sa FORME (`detailKind`), pour l'icône — une grille de cases ou une liste
 * d'anime.
 */
function DetailButton({
  def, derived, progress, got, small = false,
}: {
  def: BadgeDef;
  derived: Derived;
  progress: Progress;
  /** Les badges obtenus : le détail de « Chasseur de secrets » les liste. */
  got?: Record<string, number>;
  /** Le format des vues Grille et Compacte : l'icône seule. */
  small?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const kind = detailKind(def, derived, got);
  const detail = useMemo(() => (open ? detailOf(def, derived, got) : null), [open, def, derived, got]);
  if (!kind) return null;
  const Icon = kind === "grid" ? MdGridView : MdFormatListBulleted;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("badges.ui.detail.open", "Voir le détail")}
        aria-label={t("badges.ui.detail.open", "Voir le détail")}
        className={
          "flex shrink-0 items-center justify-center rounded-full bg-white/[.09] text-white/75 transition-colors hocus:bg-white/[.17] hocus:text-white " +
          (small ? "h-8 w-8" : "h-10 w-10")
        }
      >
        <Icon size={small ? 15 : 17} aria-hidden="true" />
      </button>
      {open && detail ? (
        <DetailPopup def={def} detail={detail} derived={derived} progress={progress} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** Quand chaque anime a été fini d'après le fil AniList du compte (ms), lu une
 *  fois par visite et seulement à l'ouverture d'un détail. Vide sans compte. */
let finsDuFil: Promise<Map<number, number>> | null = null;
function useFinsDuFil() {
  const [fins, setFins] = useState<Map<number, number>>(() => new Map());
  useEffect(() => {
    let vivant = true;
    const lire = () => {
      finsDuFil ??= fetch("/api/v2/account/anilist-feed?fins=1")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => new Map(Object.entries(j?.f ?? {}).map(([id, s]) => [Number(id), Number(s) * 1000])))
        .catch(() => new Map<number, number>());
      void finsDuFil.then((m) => { if (vivant) setFins(m); });
    };
    /* L'import des lignes « terminé » tourne peut-être en ce moment. */
    const relire = () => { finsDuFil = null; lire(); };
    lire();
    window.addEventListener("aniscroll:anilistFeedFins", relire);
    return () => {
      vivant = false;
      window.removeEventListener("aniscroll:anilistFeedFins", relire);
    };
  }, []);
  return fins;
}

function DetailPopup({
  def, detail, derived, progress, onClose,
}: {
  def: BadgeDef;
  detail: Detail;
  derived: Derived;
  progress: Progress;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const R = RARITY[def.rarity];
  const fins = useFinsDuFil();
  /* Le fil d'abord : il date la PREMIÈRE fin, le site la dernière lecture. */
  const yearOf = (e: LocalEntry) =>
    detailYear(def, e, fins.get(e.mediaId) ?? derived.lastSeenAt.get(e.mediaId));

  return (
    <PopShell
      title={t(`badges.${def.id}.name`)}
      meta={
        progress && progress[1] > 1
          ? progressText(def, progress[0], progress[1], i18n.language, t)
          : detail.kind === "list"
            ? t("badges.ui.detail.animeCount", { count: detail.items.length, defaultValue: "{{count}} anime" })
            : undefined
      }
      onClose={onClose}
    >
      <p className="m-0 mb-4 font-karla text-[12px] leading-snug text-white/40">
        {t(`badges.${def.id}.cond`)}
      </p>
      {detail.kind === "grid" ? (
        <DetailGrid yearOf={yearOf} detail={detail} color={R.ic} />
      ) : detail.groups ? (
        detail.items.length ? (
          detail.groups.filter((g) => g.items.length).map((g) => (
            <div key={g.min} className="mb-4 last:mb-0">
              <p className="m-0 mb-2 font-outfit text-[12px] font-semibold" style={{ color: R.ic }}>
                {t("badges.ui.detail.seasonsPlus", { count: g.min, defaultValue: "{{count}} saisons et plus" })} ·{" "}
                {t("badges.ui.detail.animeCount", { count: g.items.length, defaultValue: "{{count}} anime" })}
              </p>
              <AnimeList yearOf={yearOf} items={g.items} />
            </div>
          ))
        ) : (
          <AnimeList yearOf={yearOf} items={[]} />
        )
      ) : (
        <AnimeList yearOf={yearOf} items={detail.items} episodes={detail.episodes} />
      )}
    </PopShell>
  );
}

/**
 * La grille : une case par élément à couvrir, les manquantes en pointillés
 * (la case vide de l'onglet), et un clic sur une case remplie pour voir les
 * anime qui la remplissent.
 */
function DetailGrid({
  yearOf, detail, color,
}: {
  yearOf: (e: LocalEntry) => number | null;
  detail: Extract<Detail, { kind: "grid" }>;
  color: string;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState<string | null>(null);
  const [show, setShow] = useState<"all" | "missing" | "done">("all");
  const missing = detail.cells.filter((c) => !c.done).length;
  const covered = detail.cells.length - missing;
  const cells = detail.cells.filter((c) =>
    show === "missing" ? !c.done : show === "done" ? c.done : true,
  );
  const picked = detail.cells.find((c) => c.key === pick) ?? null;
  const label = (c: DetailCell) => cellLabel(detail, c, t);

  /* Des badges (« Chasseur de secrets ») : leur jeton plutôt qu'une pastille
     de texte (24/11/2026, Luc). Le nom reste dessous, en petit. */
  if (detail.labels === "badge") {
    return (
      <div className="grid grid-cols-4 gap-x-2 gap-y-3 sm:grid-cols-5">
        {detail.cells.map((c) => {
          const def = BY_ID[c.key];
          if (!def) return null;
          return (
            <div key={c.key} className="flex min-w-0 flex-col items-center gap-1" title={label(c)}>
              <BadgeToken id={def.id} rarity={def.rarity} icon={def.icon} tag={def.tag} unlocked size={56} animate={false} />
              <span className="w-full truncate text-center font-karla text-[10.5px] leading-tight text-white/55">
                {label(c)}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  const filters: { k: typeof show; label: string; n: number }[] = [
    { k: "all", label: t("badges.ui.detail.all", "Tous"), n: detail.cells.length },
    { k: "missing", label: t("badges.ui.detail.missing", "Manquants"), n: missing },
    { k: "done", label: t("badges.ui.detail.covered", "Couverts"), n: covered },
  ];

  return (
    <>
      {/* Les filtres ne servent que s'il y a les deux sortes de cases : le
          classement des studios, par exemple, n'a pas de case vide. */}
      {missing > 0 && covered > 0 ? (
        <div className="as-sfp-chips mb-3">
          {filters.map((f) => (
            <button
              key={f.k}
              type="button"
              onClick={() => setShow(f.k)}
              aria-pressed={show === f.k}
              className={`as-sfp-chip${show === f.k ? " is-on" : ""}`}
            >
              {f.label}
              <span className="as-sfp-chipn">{f.n}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="as-sfp-chips">
        {cells.map((c) => {
          const on = c.key === pick;
          const clickable = detail.browsable && c.done;
          return (
            <button
              key={c.key}
              type="button"
              disabled={!clickable}
              aria-pressed={clickable ? on : undefined}
              onClick={() => setPick(on ? null : c.key)}
              className={`as-sfp-chip${on ? " is-on" : ""}${c.done ? "" : " is-zero"}${clickable ? "" : " pointer-events-none"}`}
            >
              {label(c)}
              {c.value != null ? (
                <span className="as-sfp-chipn">
                  {t("profile.blocks.bingo.points", { points: c.value })}
                </span>
              ) : detail.browsable && c.done ? (
                <span className="as-sfp-chipn">{c.items.length}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {detail.browsable ? (
        picked ? (
          <div className="mt-4">
            <p className="m-0 mb-2 font-outfit text-[12px] font-semibold" style={{ color }}>
              {label(picked)} ·{" "}
              {t("badges.ui.detail.animeCount", {
                count: picked.items.length,
                defaultValue: "{{count}} anime",
              })}
            </p>
            <AnimeList yearOf={yearOf} items={picked.items} />
          </div>
        ) : covered > 0 ? (
          <p className="m-0 mt-4 font-karla text-[11.5px] italic text-white/30">
            {t("badges.ui.detail.pick", "Choisis une case remplie pour voir ses anime.")}
          </p>
        ) : null
      ) : null}
    </>
  );
}

/** Le libellé d'une case : genre traduit, saison de bingo lisible, ou tel quel. */
function cellLabel(
  detail: Extract<Detail, { kind: "grid" }>,
  c: DetailCell,
  t: TFunction,
): string {
  if (detail.labels === "genre") return genreLabel(t, c.label);
  if (detail.labels === "badge") return t(`badges.${c.label}.name`);
  if (detail.labels === "season") {
    const [year, season] = c.label.split("-");
    return season ? `${t(`profile.blocks.bingo.season.${season.toLowerCase()}`)} ${year}` : c.label;
  }
  return c.label;
}

/**
 * CE QUI MANQUE, SUR LA LIGNE MÊME (09/11/2026, Luc : « De A à Z ne te dit
 * même pas quelles lettres sont manquantes »). Le détail le disait, derrière
 * un bouton qu'on ne voyait pas ; quand il reste peu de cases, on les écrit
 * sous la barre.
 */
const MISSING_INLINE = 12;
function MissingLine({ def, derived }: { def: BadgeDef; derived: Derived }) {
  const { t } = useTranslation();
  const missing = useMemo(() => {
    /* « De A à Z » sans « Il manque : E » (24/11/2026, Luc). */
    if (def.metric.k === "alphabet" || detailKind(def, derived) !== "grid") return null;
    const d = detailOf(def, derived);
    if (!d || d.kind !== "grid" || d.labels === "season") return null;
    const m = d.cells.filter((c) => !c.done);
    return m.length && m.length <= MISSING_INLINE ? m.map((c) => cellLabel(d, c, t)) : null;
  }, [def, derived, t]);
  if (!missing) return null;
  return (
    <p className="m-0 mt-1.5 font-karla text-[11.5px] leading-snug text-white/45">
      <span className="text-white/30">{t("badges.ui.detail.missingInline", "Il manque :")}</span>{" "}
      <span className="font-semibold text-white/70">{missing.join(" · ")}</span>
    </p>
  );
}

/** Les anime d'une case ou d'un seuil : vignette, titre, année — et un lien. */
function AnimeList({ yearOf, items, episodes }: {
  yearOf: (e: LocalEntry) => number | null;
  items: LocalEntry[];
  episodes?: Map<number, number>;
}) {
  const { t, i18n } = useTranslation();
  const epLabel = i18n.language?.startsWith("fr") ? "ép." : "ep";
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  if (!items.length) {
    return (
      <p className="m-0 font-karla text-[12px] italic text-white/30">
        {t("badges.ui.detail.empty", "Aucun anime terminé ne compte encore.")}
      </p>
    );
  }
  return (
    <ul className="-mx-2 m-0 flex list-none flex-col gap-0.5 p-0">
      {items.map((e) => (
        <li key={e.mediaId}>
          <Link
            href={animeHref(e.mediaId, clickTarget)}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[.06]"
          >
            {e.coverImage ? (
              <Image
                src={e.coverImage}
                alt=""
                width={30}
                height={42}
                className="h-[42px] w-[30px] shrink-0 rounded object-cover"
              />
            ) : (
              <span className="h-[42px] w-[30px] shrink-0 rounded bg-white/10" />
            )}
            <span className="min-w-0 flex-1 truncate font-karla text-[13px] text-white/85">
              {pickTitle(e.title, titlePref)}
            </span>
            {episodes?.has(e.mediaId) ? (
              <span className="shrink-0 font-karla text-[11px] tabular-nums text-white/35">
                {episodes.get(e.mediaId)} {epLabel}
              </span>
            ) : yearOf(e) ? (
              <span className="shrink-0 font-karla text-[11px] tabular-nums text-white/35">
                {yearOf(e)}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ── Les secrets ────────────────────────────────────────────────────────────── */

function SecretSection({
  rows, view, state, progress, live, filter, derived,
}: {
  rows: BadgeDef[];
  view: View;
  state: BadgeState;
  progress: Map<string, Progress>;
  live: boolean;
  filter: Filter;
  derived: Derived | null;
}) {
  const { t } = useTranslation();
  if (!rows.length) return null;
  const done = SECRETS.filter((b) => state.got[b.id] != null).length;

  return (
    <section id={famAnchor("secret")} className="flex scroll-mt-40 flex-col gap-3 lg:scroll-mt-24">
      <div className="as-stat-card flex items-baseline gap-3 rounded-lg border-l-2 border-[#FF7F57] py-2 pl-3 pr-4">
        <h3 className="font-outfit m-0 text-lg font-semibold text-white">
          {t("badges.ui.family.secret", "Secret")}
        </h3>
        <span className="font-outfit rounded border border-white/10 bg-white/[.04] px-2 py-0.5 text-[11px] font-semibold text-[#FF7F57]">
          {done} / {SECRETS.length}
        </span>
        <span className="font-karla text-[12px] text-white/40">
          {t("badges.ui.familyDesc.secret", "")}
        </span>
      </div>
      <BadgeList
        rows={rows}
        view={view}
        state={state}
        progress={progress}
        live={live}
        filter={filter}
        derived={derived}
        hidden
      />
    </section>
  );
}

export { RARITY_ORDER };
export type { Rarity };
