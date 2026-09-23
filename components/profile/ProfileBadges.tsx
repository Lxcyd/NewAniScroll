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

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  BADGES, BY_ID, LADDERS, MAIN, RARITY_ORDER, SECRETS,
  type BadgeDef, type Rarity,
} from "@/lib/badges/catalog";
import { announce } from "@/lib/badges/achievementStore";
import { beginQuiet, endQuiet, flush, progressAll } from "@/lib/badges/evaluate";
import { backfillMetadata } from "@/lib/badges/metaBackfill";
import { recordFlag } from "@/lib/badges/facts";
import { clearUnseen } from "@/lib/badges/dock";
import { revealAnchor, revealTarget } from "@/lib/badges/reveal";
import { mergeBadgeState, useBadgeState, type BadgeState } from "@/lib/badges/store";
import { Bar } from "./widgets/common";
import BadgeDefs from "./badges/BadgeDefs";
import BadgeToken from "./badges/BadgeToken";
import { RARITY } from "./badges/rarity";

type Filter = "all" | "got" | "todo";
type Progress = [number, number] | null;

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
 * Le jeton grossit encore de 8 % au survol (.as-badge-token), donc la ligne
 * réserve un peu plus que `ROW_TOKEN`.
 */
const ROW_TOKEN = 100;
const TIER_TOKEN = 54;

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

  /* Chez soi, ouvrir l'onglet SUFFIT à tout marquer comme vu : la pastille de
     l'avatar existe pour ramener ici, elle n'a plus de raison d'être une fois
     qu'on y est. Chez quelqu'un d'autre, on ne touche à rien — ses badges ne
     sont pas les nôtres. */
  useEffect(() => {
    if (live) clearUnseen();
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
        const head = BY_ID[ladderHead.get(b.ladder) ?? b.id];
        /* Le filtre s'applique au palier MONTRÉ : « à obtenir » sur une échelle
           entièrement faite doit la faire disparaître, pas afficher son dernier
           barreau. */
        if (keep(head)) out.push(head);
        continue;
      }
      if (keep(b)) out.push(b);
    }
    return out;
  };

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
          nul par défaut, donc gratuit pour tous les autres profils). */}
      <div className="as-stat-card flex flex-wrap items-center justify-between gap-4 rounded-xl px-4 py-3 ring-1 ring-white/[.08]">
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
        <div className="flex flex-wrap gap-2">
          {live && <PreviewButton />}
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
  const step = useRef(0);

  const fire = () => {
    const rarity = RARITY_ORDER[step.current % RARITY_ORDER.length];
    step.current += 1;
    const pool = BADGES.filter((b) => b.rarity === rarity && !b.secret);
    const pick = (pool.length ? pool : BADGES)[
      Math.floor(Math.random() * (pool.length || BADGES.length))
    ];
    announce([pick.id]);
  };

  return (
    <button
      type="button"
      onClick={fire}
      title="Temporaire : rejoue l'animation de déblocage, sans rien accorder."
      className="font-outfit rounded-md border border-dashed border-[#FF7F57]/60 bg-[#FF7F57]/10 px-3 py-1.5 text-[12px] font-semibold text-[#FF7F57] transition-colors hocus:bg-[#FF7F57]/20"
    >
      Test
    </button>
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
      className="as-badge-row as-stat-card scroll-mt-28 flex flex-col rounded-xl px-3.5 py-3 ring-1 ring-white/[.08] transition-colors hocus:ring-white/[.16]"
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
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-outfit text-[15.5px] font-semibold text-white">
              {t(`badges.${def.id}.name`)}
            </span>
            <span
              className="font-karla text-[9px] uppercase tracking-[.16em]"
              style={{ color: unlocked ? R.ic : "rgba(255,255,255,.28)" }}
            >
              {t(`badges.ui.rarity.${def.rarity}`, def.rarity)}
            </span>
            {unlocked && (
              <span className="ml-auto font-karla text-[11px] tabular-nums text-white/35">
                <ObtainedOn at={at} />
              </span>
            )}
          </div>

          <Condition def={def} hidden={hidden && !unlocked} />

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
 * La condition. Pour un secret verrouillé, le VRAI TEXTE N'EST PAS RENDU.
 *
 * Un `filter: blur()` n'est qu'un effet de peinture : le texte reste dans le
 * DOM et l'inspecteur du navigateur le donne en deux clics — autant l'afficher
 * en clair. On rend donc une chaîne de remplissage de longueur comparable, et
 * on la floute pour l'allure.
 */
function Condition({ def, hidden }: { def: BadgeDef; hidden: boolean }) {
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
    <p className="m-0 mt-1 font-karla text-[12.5px] leading-snug text-white/45">
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
 * Le panneau d'une échelle : TOUS les paliers, avec leur barre.
 *
 * Porté sur `document.body` : la ligne d'où il part vit dans une carte qui a son
 * propre contexte d'empilement et un fond flouté — un panneau rendu là-dedans
 * se retrouverait coincé derrière la ligne suivante.
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

  /* Échap ferme, et le défilement de la page est gelé tant que le panneau est
     ouvert — sinon la molette fait glisser la liste DERRIÈRE lui. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  const done = ids.filter((id) => state.got[id] != null).length;
  const current = ids.find((id) => state.got[id] == null) ?? ids[ids.length - 1];

  return createPortal(
    <div
      className="as-pop-back"
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
      <div
        className="as-pop-card"
        /* Le clic sur le panneau ne doit pas traverser jusqu'au fond, qui ferme. */
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "min(82vh, 760px)",
          overflowY: "auto",
          borderRadius: 18,
          border: "1px solid rgba(255,255,255,.1)",
          background: `linear-gradient(180deg, ${color}14, rgba(18,18,26,.98) 22%, rgba(14,14,20,.98))`,
          boxShadow: `0 24px 70px rgba(0,0,0,.6), 0 0 40px ${color}1f`,
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

        <div className="flex flex-col gap-2">
          {ids.map((id, i) => {
            const def = BY_ID[id];
            const at = state.got[id];
            const p = live ? progress.get(id) ?? null : null;
            const isCurrent = id === current;
            const R = RARITY[def.rarity];
            return (
              <div
                key={id}
                className="as-pop-row flex items-center gap-3 rounded-xl px-2.5 py-2"
                style={{
                  /* Le palier du moment est le seul à porter un fond et un
                     liseré : c'est lui qu'on est venu regarder. */
                  background: isCurrent ? `${R.ic}14` : "transparent",
                  border: `1px solid ${isCurrent ? `${R.ic}59` : "transparent"}`,
                  /* Les lignes arrivent l'une après l'autre, de haut en bas :
                     l'échelle se lit dans l'ordre où elle se gravit. */
                  animationDelay: `${40 + i * 45}ms`,
                }}
              >
                <BadgeToken
                  id={def.id}
                  rarity={def.rarity}
                  icon={def.icon}
                  tag={def.tag}
                  unlocked={at != null}
                  size={isCurrent ? TIER_TOKEN + 12 : TIER_TOKEN}
                  animate={false}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span
                      className="font-outfit truncate text-[13px]"
                      style={{ color: at != null ? "#fff" : "rgba(255,255,255,.72)" }}
                    >
                      {t(`badges.${id}.name`)}
                    </span>
                    <span className="ml-auto shrink-0 font-karla text-[10.5px] tabular-nums text-white/35">
                      {at != null ? <ObtainedOn at={at} /> : null}
                    </span>
                  </div>
                  {at == null && live && p && p[1] > 1 ? (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <Bar pct={Math.min(100, (p[0] / p[1]) * 100)} color={R.ic} />
                      </div>
                      <span className="font-karla shrink-0 text-[10px] tabular-nums text-white/40">
                        {p[0].toLocaleString(i18n.language || undefined)} /{" "}
                        {p[1].toLocaleString(i18n.language || undefined)}
                      </span>
                    </div>
                  ) : null}
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
