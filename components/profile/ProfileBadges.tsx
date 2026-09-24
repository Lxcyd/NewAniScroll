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

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { MdCheck } from "react-icons/md";
import { useTranslation } from "react-i18next";
import {
  BADGES, BY_ID, LADDERS, MAIN, RARITY_ORDER, SECRETS,
  type BadgeDef, type Rarity,
} from "@/lib/badges/catalog";
import { announce } from "@/lib/badges/achievementStore";
import { beginQuiet, endQuiet, flush, progressAll } from "@/lib/badges/evaluate";
import { backfillMetadata } from "@/lib/badges/metaBackfill";
import { recordFlag } from "@/lib/badges/facts";
import { revealAnchor, revealTarget } from "@/lib/badges/reveal";
import { mergeBadgeState, useBadgeState, type BadgeState } from "@/lib/badges/store";
import { Bar } from "./widgets/common";
import { Dropdown } from "./WidgetSettings";
import BadgeDefs from "./badges/BadgeDefs";
import BadgeToken from "./badges/BadgeToken";
import { RARITY } from "./badges/rarity";

type Filter = "all" | "got" | "todo";
type Progress = [number, number] | null;
/** Le menu de rareté : toutes, ou une seule. */
type RarityPick = "all" | Rarity;

const FAMILY_ORDER = [
  "episodes", "time", "sessions", "finished",
  "discovery", "genres", "franchise", "regularity", "profile",
] as const;

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
const TIER_TOKEN = 54;
/** Le palier sélectionné dans le panneau : un cran au-dessus des autres. */
const TIER_TOKEN_SEL = TIER_TOKEN + 12;
/**
 * Le trajet du cadre de sélection, en ms. Un peu plus long que le dépli des
 * lignes (`.as-pop-more`, 320 ms) : il arrive sur une ligne qui a fini de bouger.
 */
const FRAME_MOVE_MS = 420;

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
  const [filter, setFilter] = useState<Filter>("all");
  const [rarity, setRarity] = useState<RarityPick>("all");
  const [progress, setProgress] = useState<Map<string, Progress>>(new Map());

  /* Chez soi : on mesure, et on lance le rattrapage des métadonnées.
     Les DEUX sont ici et pas au chargement du site — personne ne doit payer,
     en requêtes comme en calcul, pour un onglet qu'il n'ouvre pas. */
  useEffect(() => {
    if (!live) return;
    recordFlag("badgesTab");
    /* Évalué TOUT DE SUITE, avant d'ouvrir la portée silencieuse : « Vitrine
       ouverte » est un vrai geste et mérite sa notification. Sans ce passage
       immédiat, l'évaluation débouncée du drapeau tomberait deux secondes plus
       tard, c'est-à-dire pendant le rattrapage — et serait tue avec lui. */
    flush();
    setProgress(progressAll().progress);

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
    void backfillMetadata().finally(() => {
      flush();
      endQuiet();
      setProgress(progressAll().progress);
    });
  }, [live]);

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
  useEffect(() => {
    const cible = revealTarget();
    if (!cible) return;
    let sorti = false;
    const t = requestAnimationFrame(() => {
      const el = document.getElementById(revealAnchor(cible));
      if (!el) return;
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
    });
    return () => {
      sorti = true;
      cancelAnimationFrame(t);
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

  const keep = (b: BadgeDef) => {
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

  /** Les lignes d'une famille, échelles repliées sur leur palier courant. */
  const rowsOf = (family: string): BadgeDef[] => {
    const out: BadgeDef[] = [];
    const seen = new Set<string>();
    for (const b of BADGES) {
      if (b.family !== family) continue;
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

  const rarityChoices: { value: RarityPick; label: string; color?: string }[] = [
    { value: "all", label: t("badges.ui.rarityFilter.all", "Toutes les raretés") },
    ...RARITY_ORDER.map((r) => ({
      value: r,
      label: t(`badges.ui.rarity.${r}`, r),
      color: RARITY[r].ic,
    })),
  ];

  const chips: { k: Filter; label: string; n: number }[] = [
    { k: "all", label: t("badges.ui.all", "Tous"), n: BADGES.length },
    { k: "got", label: t("badges.ui.got", "Obtenus"), n: gotCount + secretCount },
    { k: "todo", label: t("badges.ui.todo", "À obtenir"), n: BADGES.length - gotCount - secretCount },
  ];

  return (
    <div className="flex flex-col gap-8">
      <BadgeDefs />

      {/* En-tête : où en est la collection, et les trois filtres.
          `as-stat-card` comme partout ailleurs sur le profil : quand le
          propriétaire a posé une illustration en fond de page, un texte nu
          par-dessus ne se lit pas. La classe porte le fond sombre ET le flou
          d'arrière-plan que le studio de bannière règle (`--as-plate-blur`,
          nul par défaut, donc gratuit pour tous les autres profils).

          `z-20` : le menu de rareté déborde de cette carte vers le bas, et chaque
          carte de la liste est son propre contexte d'empilement (`isolation`)
          peint APRÈS celle-ci — sans lui, la liste recouvrait le menu. */}
      <div className="as-stat-card z-20 flex flex-wrap items-center justify-between gap-4 rounded-xl px-4 py-3 ring-1 ring-white/[.08]">
        <div className="flex items-baseline gap-3">
          <span className="font-outfit text-2xl font-semibold text-white">
            {gotCount}
            <span className="text-white/35"> / {MAIN.length}</span>
          </span>
          <span className="font-karla text-[11px] uppercase tracking-[.16em] text-white/40">
            {t("badges.ui.total", "badges obtenus")}
          </span>
          {secretCount > 0 && (
            <span className="font-outfit text-[11px] font-semibold text-[#FF7F57]">
              + {secretCount} {t("badges.ui.secretsShort", "secrets")}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {live && <PreviewButton />}
          <Dropdown
            className="w-[190px]"
            label={t("badges.ui.rarityFilter.label", "Filtrer par rareté")}
            value={rarity}
            choices={rarityChoices}
            onPick={(v) => setRarity(v as RarityPick)}
          />
          {chips.map((c) => (
            <button
              key={c.k}
              type="button"
              onClick={() => setFilter(c.k)}
              className={
                "font-outfit rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors " +
                (filter === c.k
                  ? "border-as-accent bg-as-accent text-white"
                  : "border-white/10 bg-white/[.04] text-white/60 hocus:text-white/85")
              }
            >
              {c.label}
              <span className="ml-1.5 text-[10px] opacity-60">{c.n}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Les familles. */}
      {FAMILY_ORDER.map((family) => {
        const rows = rowsOf(family);
        if (!rows.length) return null;
        return (
          <section key={family} className="flex flex-col gap-3">
            <div className="as-stat-card flex items-baseline gap-3 rounded-lg border-l-2 border-as-accent py-2 pl-3 pr-4">
              <h3 className="font-outfit m-0 text-lg font-semibold text-white">
                {t(`badges.ui.family.${family}`, family)}
              </h3>
              <span className="font-karla text-[12px] text-white/40">
                {t(`badges.ui.familyDesc.${family}`, "")}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {rows.map((b) => (
                <BadgeRow
                  key={b.id}
                  def={b}
                  state={state}
                  progress={live ? progress.get(b.id) ?? null : null}
                  live={live}
                  filter={filter}
                  ladderProgress={progress}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* Les secrets, à part et hors du total. */}
      <SecretSection
        state={state}
        progress={progress}
        live={live}
        filter={filter}
        keep={keep}
      />
    </div>
  );
}

/* ── ⚠ TEMPORAIRE — le bouton d'essai de la notification ────────────────────
 *
 * À RETIRER une fois l'animation validée. Tout ce qui le concerne tient dans ce
 * bloc et dans le `{live && <PreviewButton />}` de l'en-tête : deux suppressions
 * et il n'en reste rien.
 *
 * Il N'ACCORDE AUCUN BADGE — il ne touche ni `aniscroll:badges`, ni les faits,
 * ni la sauvegarde. Il pousse un id dans la file d'affichage, point. Un bouton
 * d'essai qui accorderait pour de vrai fabriquerait une fausse collection qu'il
 * faudrait ensuite démêler, et l'invariant « un badge obtenu ne se reperd
 * jamais » rend ce démêlage impossible.
 *
 * Chaque clic avance d'une RARETÉ : les six ont des couleurs, des étoiles et un
 * balayage différents, et c'est justement ça qu'on vient regarder.
 *
 * Son libellé n'est PAS traduit, et c'est délibéré : ajouter deux clés dans les
 * deux locales pour un bouton qu'on va enlever laisserait deux orphelines
 * derrière lui. « Test » se lit dans les deux langues.
 */
function PreviewButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  /* DEUX refs, parce qu'il y a maintenant deux morceaux dans deux arbres : le
     bouton reste en place, le panneau est portalé sur le corps du document. Un
     clic « dehors » doit épargner les deux, sinon cliquer le bouton fermerait
     puis rouvrirait le panneau dans le même geste. */
  const boite = useRef<HTMLDivElement | null>(null);
  const panneau = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  /** Où poser le panneau à l'écran. Mesuré à l'ouverture. */
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  /* Fermer au clic dehors et à Échap. Un `mousedown` et pas un `click` : le
     second se déclenche APRÈS que le bouton du panneau a fait son travail, donc
     un clic sur un badge fermerait le panneau deux fois. */
  useEffect(() => {
    if (!open) return;
    const dehors = (e: MouseEvent) => {
      const n = e.target as Node;
      if (boite.current?.contains(n) || panneau.current?.contains(n)) return;
      setOpen(false);
    };
    const echap = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", dehors);
    window.addEventListener("keydown", echap);
    return () => {
      document.removeEventListener("mousedown", dehors);
      window.removeEventListener("keydown", echap);
    };
  }, [open]);

  /* Cent soixante-seize badges : sans recherche, la liste est un mur. On filtre
     sur le NOM TRADUIT et pas sur l'id — c'est le nom qui est affiché, et
     personne ne connaît les ids par cœur. */
  const listes = useMemo(() => {
    const terme = q.trim().toLowerCase();
    const garde = (b: BadgeDef) =>
      !terme || t(`badges.${b.id}.name`).toLowerCase().includes(terme);
    return RARITY_ORDER.map((r) => ({
      rarity: r,
      rows: BADGES.filter((b) => b.rarity === r && garde(b)),
    })).filter((g) => g.rows.length);
  }, [q, t]);

  const basculer = () => {
    /* La position est prise AU MOMENT du clic : le panneau est fixé à l'écran,
       donc il lui faut des coordonnées d'écran, pas la promesse d'un parent. */
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 8, right: window.innerWidth - r.right });
    setOpen((v) => !v);
  };

  return (
    <div className="relative" ref={boite}>
      <button
        ref={btn}
        type="button"
        onClick={basculer}
        aria-expanded={open}
        title="Temporaire : rejoue l'animation de déblocage, sans rien accorder."
        className="font-outfit rounded-md border border-dashed border-[#FF7F57]/60 bg-[#FF7F57]/10 px-3 py-1.5 text-[12px] font-semibold text-[#FF7F57] transition-colors hocus:bg-[#FF7F57]/20"
      >
        Test
      </button>

      {/* ── LE PANNEAU EST PORTALÉ SUR `document.body` ─────────────────────────
          Il passait DERRIÈRE la liste des badges. Ce n'est pas le `z-50` qui
          était faux : un z-index ne vaut que dans son contexte d'empilement, et
          les cartes de la liste en créent chacune un (elles portent un
          `backdrop-filter`). Monter le nombre n'aurait servi à rien — il aurait
          fallu remonter tout l'ancêtre, c'est-à-dire empiler la barre de
          filtres au-dessus du contenu pour un panneau qu'on ouvre trois fois
          par mois.

          Un portal sur le corps du document sort de la question : il n'y a plus
          d'ancêtre à battre. Le prix est de porter soi-même les coordonnées,
          d'où `position: fixed` et la mesure au clic. */}
      {open && pos
        ? createPortal(
            <div
              ref={panneau}
              style={{ top: pos.top, right: pos.right }}
              className="fixed z-[1000] flex max-h-[70vh] w-[300px] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#12121a] shadow-2xl"
            >
          <div className="border-b border-white/10 p-2">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Chercher un badge…"
              className="font-karla w-full rounded-lg bg-white/5 px-3 py-2 text-[13px] text-white outline-none ring-1 ring-white/10 placeholder:text-white/30 focus:ring-white/25"
            />
          </div>

          {/* Une entrée PAR RARETÉ en tête : c'est ce que le bouton faisait
              avant (il tournait sur les six), et c'est le geste le plus
              fréquent — on vient presque toujours regarder un mythique. */}
          <div className="flex flex-wrap gap-1 border-b border-white/10 p-2">
            {RARITY_ORDER.map((r) => {
              const pool = BADGES.filter((b) => b.rarity === r && !b.secret);
              if (!pool.length) return null;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    announce([pool[Math.floor(Math.random() * pool.length)].id]);
                    setOpen(false);
                  }}
                  className="font-karla rounded-md px-2 py-1 text-[11px] font-semibold transition-colors hocus:bg-white/10"
                  style={{ color: RARITY[r].ic }}
                >
                  {t(`badges.ui.rarity.${r}`, r)}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {listes.length === 0 ? (
              <div className="font-karla px-3 py-6 text-center text-[12px] text-white/35">
                Aucun badge
              </div>
            ) : (
              listes.map((g) => (
                <div key={g.rarity}>
                  <div
                    className="font-karla px-3 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[.18em]"
                    style={{ color: RARITY[g.rarity].ic }}
                  >
                    {t(`badges.ui.rarity.${g.rarity}`, g.rarity)}
                  </div>
                  {g.rows.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => {
                        announce([b.id]);
                        setOpen(false);
                      }}
                      className="font-karla flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] text-white/80 transition-colors hocus:bg-white/10 hocus:text-white"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: RARITY[b.rarity].ic }}
                      />
                      <span className="truncate">{t(`badges.${b.id}.name`)}</span>
                      {b.secret ? (
                        <span className="ml-auto shrink-0 text-[10px] text-white/30">secret</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/* ── Une ligne ──────────────────────────────────────────────────────────────── */

function BadgeRow({
  def, state, progress, live, filter, ladderProgress, hidden = false,
}: {
  def: BadgeDef;
  state: BadgeState;
  progress: Progress;
  live: boolean;
  filter: Filter;
  ladderProgress: Map<string, Progress>;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const at = state.got[def.id];
  const unlocked = at != null;
  const R = RARITY[def.rarity];

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
          : "outline-dashed outline-1 -outline-offset-1 outline-white/[.16] hocus:outline-white/30")
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
        <div className="shrink-0">
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

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="font-outfit text-[15.5px] font-semibold"
              style={{ color: unlocked ? "#fff" : "rgba(255,255,255,.58)" }}
            >
              {t(`badges.${def.id}.name`)}
            </span>
            <span
              className="font-karla text-[9px] uppercase tracking-[.16em]"
              style={{ color: unlocked ? R.ic : "rgba(255,255,255,.28)" }}
            >
              {t(`badges.ui.rarity.${def.rarity}`, def.rarity)}
            </span>
            {unlocked && (
              <DatePill at={at} color={R.ic} label={t("badges.ui.obtained", "Obtenu")} />
            )}
          </div>

          <Condition def={def} hidden={hidden && !unlocked} unlocked={unlocked} />

          <ProgressLine
            progress={progress}
            unlocked={unlocked}
            live={live}
            color={R.ic}
          />
        </div>

        {/* L'ÉCHELLE COMPLÈTE S'OUVRE, ELLE NE SE DÉPLIE PLUS.
            Le dépli montrait les AUTRES paliers : la suite avait donc un trou à
            l'endroit du palier courant — on lisait 1, puis 250, et le 25 qu'on
            est justement en train de viser manquait. Un panneau montre les six,
            celui du moment compris et mis en avant. */}
        {def.ladder && (
          <LadderButton
            ladder={def.ladder}
            state={state}
            progress={ladderProgress}
            live={live}
            color={R.ic}
          />
        )}
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
 * La pastille d'obtention : coche, « Obtenu · » et la date, dans la couleur de
 * la rareté. Sans `label` (panneau d'échelle, où la place manque), la coche et
 * la date seules.
 */
function DatePill({ at, color, label }: { at: number; color: string; label?: string }) {
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full py-[3px] pl-1.5 pr-2 font-outfit text-[10.5px] font-bold leading-none tabular-nums"
      style={{
        color,
        background: `${color}29`,
        boxShadow: `inset 0 0 0 1px ${color}66`,
      }}
    >
      <MdCheck size={12} aria-hidden="true" />
      {label ? <>{label} · </> : null}
      <ObtainedOn at={at} />
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
      style={{ color: unlocked ? "rgba(255,255,255,.45)" : "rgba(255,255,255,.32)" }}
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
function ProgressLine({
  progress, unlocked, live, color,
}: {
  progress: Progress;
  unlocked: boolean;
  live: boolean;
  color: string;
}) {
  const { t, i18n } = useTranslation();
  if (unlocked) return null;
  if (!live) return null;
  if (!progress) {
    return (
      <p className="m-0 mt-1.5 font-karla text-[10.5px] italic text-white/25">
        {t("badges.ui.notMeasurable", "Pas encore mesurable")}
      </p>
    );
  }
  const [cur, target] = progress;
  if (target <= 1) return null; // un fait binaire n'a pas d'avancement à montrer
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Bar pct={Math.min(100, (cur / target) * 100)} color={color} />
      </div>
      <span className="font-karla text-[10.5px] tabular-nums text-white/40">
        {/* Le séparateur de milliers suit la langue choisie : « 10 000 » en
            français, « 10,000 » en anglais. Il était figé en fr-FR. */}
        {cur.toLocaleString(i18n.language || undefined)} /{" "}
        {target.toLocaleString(i18n.language || undefined)}
      </span>
    </div>
  );
}

/* ── L'échelle complète, dans un panneau ───────────────────────────────────── */

/** Le chevron au bout de la ligne, et le panneau qu'il ouvre. */
function LadderButton({
  ladder, state, progress, live, color,
}: {
  ladder: string;
  state: BadgeState;
  progress: Map<string, Progress>;
  live: boolean;
  color: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ids = LADDERS[ladder] ?? [];
  const done = ids.filter((id) => state.got[id] != null).length;
  if (ids.length < 2) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("badges.ui.seeTiers", "Voir tous les paliers")}
        aria-label={t("badges.ui.seeTiers", "Voir tous les paliers")}
        className="ml-1 flex shrink-0 flex-col items-center gap-1 rounded-lg border border-white/10 bg-white/[.04] px-2.5 py-2 transition-colors hocus:border-white/25 hocus:bg-white/[.08]"
      >
        <span className="font-outfit text-[15px] leading-none text-white/45">›</span>
        <span className="font-karla text-[9px] tabular-nums leading-none text-white/30">
          {done}/{ids.length}
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
 * Le panneau d'une échelle : TOUS les paliers, et UN palier sélectionné.
 *
 * Porté sur `document.body` : la ligne d'où il part vit dans une carte qui a son
 * propre contexte d'empilement et un fond flouté — un panneau rendu là-dedans
 * se retrouverait coincé derrière la ligne suivante.
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

  /* Échap ferme, et le défilement de la page est gelé tant que le panneau est
     ouvert — sinon la molette fait glisser la liste DERRIÈRE lui.

     SUR `html`, PAS SEULEMENT SUR `body`, et c'est ce qui manquait. `html`
     porte `overflow-x: clip` (globals.css) : dès que sa propre valeur n'est plus
     `visible`, celle de `body` ne remonte plus jusqu'à la fenêtre et ne gèle
     que `body` lui-même, qui n'a rien à faire défiler. La page continuait donc
     de glisser sous le panneau. Même remède que la visionneuse d'Artworks. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const html = document.documentElement.style;
    const body = document.body.style;
    const prev = [html.overflow, body.overflow];
    html.overflow = "hidden";
    body.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      [html.overflow, body.overflow] = prev;
    };
  }, [onClose]);

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

  if (typeof document === "undefined") return null;
  const S = RARITY[BY_ID[sel].rarity];

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      {/* Le voile est un calque FRÈRE du panneau, et non son parent. Un
          élément qui porte un `backdrop-filter` devient la racine de fond de ses
          descendants : le flou du panneau n'aurait vu que la teinte unie du
          voile, pas la page. Frères, le panneau floute ce que le voile montre. */}
      <div className="as-pop-back" aria-hidden style={{ position: "absolute", inset: 0 }} />
      <div
        className="as-pop-card"
        /* Le clic sur le panneau ne doit pas traverser jusqu'au fond, qui ferme. */
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: "min(560px, 100%)",
          maxHeight: "min(82vh, 760px)",
          overflowY: "auto",
          overscrollBehavior: "contain",
          borderRadius: 18,
          border: "1px solid rgba(255,255,255,.1)",
          /* Du verre, pas une plaque : la page se devine au travers, floutée.
             Assez de teinte pour que le texte se lise sur une illustration
             claire, pas assez pour la cacher. */
          background: `linear-gradient(180deg, ${color}1a, rgba(18,18,26,.5) 24%, rgba(14,14,20,.44))`,
          backdropFilter: "blur(24px) saturate(1.4)",
          WebkitBackdropFilter: "blur(24px) saturate(1.4)",
          // La lueur suit la sélection, comme le cadre.
          boxShadow: `0 24px 70px rgba(0,0,0,.55), 0 0 40px ${S.ic}24`,
          transition: "box-shadow 380ms ease",
          padding: 18,
        }}
      >
        <div className="mb-4 flex items-baseline gap-3">
          <h3 className="font-outfit m-0 text-[16px] font-semibold text-white">
            {t(`badges.${ids[0]}.name`)}
            <span className="text-white/30">
              {" → "}
              {t(`badges.${ids[ids.length - 1]}.name`)}
            </span>
          </h3>
          <span
            className="font-karla ml-auto shrink-0 text-[11px] tabular-nums"
            style={{ color }}
          >
            {done} / {ids.length}
          </span>
        </div>

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
            const reach = p && p[1] > 1 ? (at != null ? p[1] : Math.min(p[0], p[1])) : null;
            const fmt = (n: number) => n.toLocaleString(i18n.language || undefined);
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
                   le bord — deux liserés l'un sur l'autre se brouillaient. */
                className={
                  "as-pop-row relative flex cursor-pointer items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 focus-visible:ring-1 focus-visible:ring-white/30 " +
                  (at == null && !isSel
                    ? "outline-dashed outline-1 -outline-offset-1 outline-white/[.16] hover:outline-white/30"
                    : "outline-none")
                }
                style={{
                  /* Les paliers gagnés portent la teinte de la ligne obtenue de
                     l'onglet. Le liseré de la sélection, lui, est le cadre. */
                  background:
                    at != null
                      ? `linear-gradient(90deg, ${R.ic}1c, transparent 70%)`
                      : "transparent",
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
                    {at != null ? <DatePill at={at} color={R.ic} /> : null}
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
                            {fmt(reach)} / {fmt(p[1])}
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

        <button
          type="button"
          onClick={onClose}
          className="font-outfit mt-4 w-full rounded-lg border border-white/10 bg-white/[.04] py-2 text-[12px] font-semibold text-white/60 transition-colors hocus:bg-white/[.08] hocus:text-white/90"
        >
          {t("badges.ui.close", "Fermer")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/* ── Les secrets ────────────────────────────────────────────────────────────── */

function SecretSection({
  state, progress, live, filter, keep,
}: {
  state: BadgeState;
  progress: Map<string, Progress>;
  live: boolean;
  filter: Filter;
  keep: (b: BadgeDef) => boolean;
}) {
  const { t } = useTranslation();
  const rows = SECRETS.filter(keep);
  if (!rows.length) return null;
  const done = SECRETS.filter((b) => state.got[b.id] != null).length;

  return (
    <section className="flex flex-col gap-3">
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
      <div className="flex flex-col gap-1.5">
        {rows.map((b) => (
          <BadgeRow
            key={b.id}
            def={b}
            state={state}
            progress={live ? progress.get(b.id) ?? null : null}
            live={live}
            filter={filter}
            ladderProgress={progress}
            hidden
          />
        ))}
      </div>
    </section>
  );
}

export { RARITY_ORDER };
export type { Rarity };
