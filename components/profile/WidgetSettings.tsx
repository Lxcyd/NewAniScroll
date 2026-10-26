import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { WidgetOption } from "./WidgetGrid";

/**
 * Le panneau de réglages d'un widget — le contenu seul.
 *
 * Il ne se positionne pas : WidgetGrid le pose sur la carte du bloc concerné et
 * l'anime, parce que la grille est la seule à savoir où cette carte se trouve à
 * l'instant. Ici il n'y a qu'un titre, des interrupteurs, et de quoi fermer.
 *
 * SOBRE, ET C'EST LE CAHIER DES CHARGES. Il a d'abord été une fenêtre centrée
 * calquée sur l'éditeur de liste : pastille d'icône, en-tête teinté de la
 * couleur du bloc, ombre portée. C'était beaucoup de cérémonie pour deux
 * interrupteurs, et un aller-retour au centre de l'écran pour régler un bloc
 * qu'on est en train de regarder. Il s'ouvre maintenant SUR la carte : pas
 * d'emoji, pas de couleur d'accent en dehors de l'interrupteur allumé, et la
 * proximité fait le lien que la couleur faisait avant.
 *
 * Il ne connaît toujours aucun bloc : des interrupteurs déjà traduits et déjà
 * résolus à leur état, et des bascules en retour. Un bloc qui n'a rien à régler
 * le DIT — c'est ce qui autorise la roue dentée à être offerte sur toutes les
 * cartes plutôt que sur quelques-unes.
 */

type Props = {
  options: WidgetOption[];
  onOption: (key: string, value: boolean | string) => void;
  onClose: () => void;
};

/** Le nom d'un réglage et sa phrase d'explication — commun à toutes les formes. */
/**
 * BOUTONS SEGMENTÉS (25/10/2026, Luc : « trouve une meilleure interface qu'un
 * dropdown » pour la taille des cartes). Tous les choix visibles, un clic pour
 * changer ; la pastille d'accent glisse sous le choix actif.
 */
export function Segmented({
  label,
  value,
  choices,
  onPick,
  className = "mt-2.5",
}: {
  label: string;
  value: string;
  choices: { value: string; label: string }[];
  onPick: (v: string) => void;
  /** Exporté pour le switch Personnage / Anime du widget des personnages. */
  className?: string;
}) {
  const idx = Math.max(0, choices.findIndex((c) => c.value === value));
  const w = 100 / choices.length;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`relative flex rounded-xl bg-white/[0.06] p-1 ring-1 ring-inset ring-white/[0.08] ${className}`}
    >
      <span
        aria-hidden
        className="absolute bottom-1 top-1 rounded-lg bg-action transition-[left] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ left: `calc(${idx * w}% + 4px - ${(idx * 8) / choices.length}px)`, width: `calc(${w}% - ${8 / choices.length}px)` }}
      />
      {choices.map((c) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(c.value)}
            className={`relative z-[1] flex-1 rounded-lg px-2 py-1.5 font-karla text-[13px] font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/40 ${
              on ? "text-white" : "text-white/55 hover:text-white/85"
            }`}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function Label({ label, desc }: { label: string; desc?: string }) {
  return (
    <span className="block min-w-0 flex-1">
      {/* Corps relevés le 25/10/2026 (Luc : « illisible ») : 13 → 15 px pour le
          nom, 11 → 13 px et 35 → 55 % de blanc pour l'explication. */}
      <span className="block font-karla text-[15px] font-bold text-white">{label}</span>
      {desc ? (
        <span className="mt-1 block font-karla text-[13px] leading-snug text-white/55">
          {desc}
        </span>
      ) : null}
    </span>
  );
}

/**
 * LA MISE EN VALEUR AU SURVOL, SUR TOUTE SECTION.
 *
 * Chaque réglage est une section, et toute section s'éclaire quand le curseur
 * la traverse — pas seulement les interrupteurs, qui étaient les seuls à le
 * faire parce qu'ils sont des boutons et que le fond venait avec. Une liste
 * déroulante ou un curseur ne sont pas des boutons, mais ce sont des sections
 * au même titre : sans ce fond, le panneau se lisait comme deux réglages
 * cliquables et deux zones mortes.
 *
 * Vaut pour les réglages de TOUS les widgets, présents et à venir : c'est la
 * raison d'être de cette enveloppe plutôt que d'une classe recopiée trois fois.
 */
const SECTION = "rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.05]";

/**
 * Le menu déroulant des listes — CELUI de l'éditeur de liste.
 *
 * Pas un `<select>` natif, et pas un dessin de plus : les classes `.le-dd-*`
 * viennent de styles/listEditor.css, importé globalement, donc le menu qui
 * choisit une liste ici est au pixel celui qui ajoute un anime à une liste
 * là-bas — même pastille, même chevron, même ouverture. Ce sont les mêmes
 * listes ; les montrer autrement aurait été les faire passer pour autre chose.
 *
 * `.le-dd-compact` (globals.css) resserre seulement les espacements : le
 * panneau fait 260 px de large, contre les 700 de la fenêtre d'origine.
 *
 * Exporté : le filtre de rareté de l'onglet Badges est le même geste, il
 * prend le même menu.
 */
export function Dropdown({
  value,
  choices,
  onPick,
  className = "mt-1.5",
  label,
}: {
  value: string;
  choices: {
    value: string;
    label: string;
    color?: string;
    swatch?: string;
    glow?: string;
    heart?: boolean;
    /** La section du menu ; un changement de groupe trace une séparation. */
    group?: string;
    groupLabel?: string;
  }[];
  onPick: (value: string) => void;
  className?: string;
  /** Nom accessible du bouton, quand rien autour ne dit à quoi il sert. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = choices.find((c) => c.value === value) ?? choices[0];
  const boxRef = useRef<HTMLDivElement>(null);

  /* Se referme au clic à côté et à Échap. Dans le panneau des réglages, fermer
     le panneau suffisait à le faire disparaître ; posé seul sur une page, il
     restait ouvert jusqu'à ce qu'on rechoisisse. `mousedown` et pas `click` :
     le second arrive après que l'option a fait son travail. */
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  /* Le repere d'un choix : la pastille de sa liste, ou un COEUR pour les
     favoris. Les favoris ne sont pas une liste de plus — on n'y range pas, on y
     epingle — et une septieme pastille ronde les aurait rangés avec les six
     autres. Il brille de la meme facon qu'elles (`box-shadow` / `drop-shadow`),
     donc il reste de la meme famille. */
  const mark = (c?: { color?: string; swatch?: string; glow?: string; heart?: boolean }) =>
    c?.heart ? (
      <svg
        /* LA BOÎTE COLLE AU DESSIN, ET LA LUEUR EN SORT.
           En `0 0 24 24` le tracé n'occupait que 2→22 en largeur et 3→21,35 en
           hauteur : le cœur était donc décentré vers le bas dans sa boîte, et
           surtout un SVG rogne à ses bords — la lueur du `drop-shadow` était
           coupée net en haut, ce qui se lisait comme une rangée de pixels
           parasites au-dessus du cœur. La boîte épouse maintenant le tracé
           (centré sur son propre milieu, 12,175), et le débordement est laissé
           libre pour que la lueur s'éteigne d'elle-même — comme celle des
           pastilles, qui n'ont jamais rien eu qui les rogne. */
        viewBox="2 2.175 20 20"
        fill={c.color || "#E94560"}
        className="as-dd-mark"
        style={{
          overflow: "visible",
          filter: `drop-shadow(0 0 4px ${c.color || "#E94560"})`,
        }}
      >
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
    ) : (
      /* LA COLONNE DES REPÈRES A UNE LARGEUR À ELLE (`.as-dd-mark`), la même
         pour tous. Le cœur y tient sa taille — 12 px, celle qu'il faut pour se
         lire comme un cœur et pas comme une tache — et les pastilles, plus
         petites, y sont centrées. Toutes les marques partagent donc le même axe
         ET le même encombrement, ce que ni un cœur rétréci au diamètre d'une
         pastille (il devenait illisible) ni un cœur débordant d'une boîte de
         pastille (son bord gauche sortait de la colonne) ne donnaient. */
      <span className="as-dd-mark">
        <span
          className="le-dd-dot"
          /* `swatch` peint la pastille quand une teinte pleine ne dit pas tout
             (l'anneau dégradé d'une rareté) ; `color` garde la lueur, qu'un
             dégradé ne sait pas porter — sauf à la donner toute faite dans
             `glow` (plusieurs ombres, une par couleur). */
          style={
            c?.swatch || c?.color
              ? {
                  background: c.swatch ?? c.color,
                  boxShadow: c.glow ?? (c.color ? `0 0 6px ${c.color}` : undefined),
                }
              : { background: "rgba(255,255,255,0.25)" }
          }
        />
      </span>
    );

  /* LE BOUTON PREND LA COULEUR DE LA LISTE CHOISIE, comme dans le menu qui
     ajoute un anime a une liste (`.le-dd-trigger-completed` et ses freres).
     La-bas les six couleurs sont ecrites en dur dans le CSS ; ici une liste
     personnalisee peut avoir n'importe quelle teinte, alors la meme regle est
     appliquee par `color-mix` a partir de la couleur du choix : bordure a 40 %,
     texte eclairci vers le blanc. Une seule formule au lieu de six classes, et
     elle vaut pour les listes qu'on ne connait pas encore. */
  const tint = current?.color
    ? {
        borderColor: `color-mix(in srgb, ${current.color} 40%, transparent)`,
        color: `color-mix(in srgb, ${current.color} 55%, white)`,
      }
    : undefined;

  return (
    <div ref={boxRef} className={`le-dd-field le-dd-compact ${className}`}>
      <button
        type="button"
        className="le-dd-trigger"
        style={tint}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {mark(current)}
        <span className="le-dd-trigger-text">{current?.label}</span>
        <svg
          className={`le-dd-chevron ${open ? "open" : ""}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open ? (
        /* Barre de défilement visible (`as-scroller`) et SECTIONS : quand un
           choix change de `group`, un trait et son intitulé le séparent du
           précédent (favoris | statuts | listes perso, 25/10/2026). Un menu
           sans groupes (la rareté des badges) reste une seule colonne. */
        <div className="le-dd-list as-scroller" style={{ maxHeight: 360, overflowY: "auto" }}>
          {choices.map((c, i) => (
            <Fragment key={c.value}>
            {i > 0 && c.group !== choices[i - 1].group ? (
              <div className="mt-1 border-t border-white/[0.07] px-3 pb-0.5 pt-2">
                {c.groupLabel ? (
                  <span className="font-karla text-[11px] font-bold uppercase tracking-wider text-white/45">
                    {c.groupLabel}
                  </span>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className={`le-dd-option !border-b-0 ${c.value === value ? "selected" : ""}`}
              style={
                c.value === value && c.color
                  ? {
                      background: `color-mix(in srgb, ${c.color} 12%, transparent)`,
                      color: `color-mix(in srgb, ${c.color} 55%, white)`,
                    }
                  : undefined
              }
              onClick={() => {
                onPick(c.value);
                setOpen(false);
              }}
            >
              {mark(c)}
              <span className="le-dd-option-text">{c.label}</span>
              {c.value === value ? (
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={3}
                  strokeLinecap="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : null}
            </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * LE MÊME MENU, À CASES À COCHER (25/10/2026, Luc) : choisir PLUSIEURS listes.
 * Mêmes classes `.le-dd-*` que `Dropdown` ; un clic sur une ligne coche ou
 * décoche sans refermer le menu, puisqu'on en coche souvent plusieurs d'affilée.
 */
export function MultiDropdown({
  values,
  choices,
  onChange,
  className = "mt-1.5",
}: {
  values: string[];
  /** `group` / `groupLabel` : la section du menu où la ligne se range. */
  choices: { value: string; label: string; color?: string; group?: string; groupLabel?: string }[];
  onChange: (values: string[]) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const picked = new Set(values);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  /* L'ordre rangé est celui du menu, quel que soit l'ordre des clics : le bloc
     peint ses lignes dans cet ordre-là. */
  const toggle = (v: string) =>
    onChange(choices.map((c) => c.value).filter((x) => (x === v ? !picked.has(x) : picked.has(x))));
  /* Les sections, dans l'ordre où les choix arrivent. */
  const groups: { id: string; label: string; items: typeof choices }[] = [];
  for (const c of choices) {
    const id = c.group ?? "";
    let g = groups.find((x) => x.id === id);
    if (!g) groups.push((g = { id, label: c.groupLabel ?? "", items: [] }));
    g.items.push(c);
  }

  const shown = choices.filter((c) => picked.has(c.value));
  const summary =
    shown.length === 0
      ? t("profile.widgets.options.listsNone")
      : shown.length === 1
        ? shown[0].label
        : shown.length === choices.length
          ? t("profile.widgets.options.listsAll")
          : t("profile.widgets.options.listsCount", { count: shown.length });

  const dot = (color?: string) => (
    <span className="as-dd-mark">
      <span
        className="le-dd-dot"
        style={
          color
            ? { background: color, boxShadow: `0 0 6px ${color}` }
            : { background: "rgba(255,255,255,0.25)" }
        }
      />
    </span>
  );

  return (
    <div ref={boxRef} className={`le-dd-field le-dd-compact ${className}`}>
      <button
        type="button"
        className="le-dd-trigger outline-none focus-visible:ring-1 focus-visible:ring-action"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {/* Les pastilles des cochées, en grappe, à la place de la pastille unique. */}
        <span className="flex shrink-0 items-center -space-x-1">
          {shown.slice(0, 4).map((c) => (
            <span
              key={c.value}
              className="le-dd-dot ring-1 ring-[#15161d]"
              style={{ background: c.color || "rgba(255,255,255,0.25)" }}
            />
          ))}
        </span>
        <span className="le-dd-trigger-text">{summary}</span>
        <svg
          className={`le-dd-chevron ${open ? "open" : ""}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open ? (
        /* DES SECTIONS, PAS UNE COLONNE (25/10/2026, Luc) : les statuts puis les
           listes perso, chacune sous son intitulé. Aucun
           fond de couleur sur les lignes cochées : la pastille porte la couleur
           de la liste, la case dit si elle est cochée, et c'est assez. */
        <div className="le-dd-list as-scroller px-1 py-1" style={{ maxHeight: 360, overflowY: "auto" }}>
          {groups.map((g, gi) => {
            return (
              <div key={g.id} className={gi ? "mt-1 border-t border-white/[0.07] pt-1" : ""}>
                <div className="px-2.5 pb-0.5 pt-1.5">
                  <span className="font-karla text-[11px] font-bold uppercase tracking-wider text-white/45">
                    {g.label}
                  </span>
                </div>
                {g.items.map((c) => {
                  const on = picked.has(c.value);
                  return (
                    <button
                      type="button"
                      key={c.value}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      onClick={() => toggle(c.value)}
                      /* Pas le contour bleu du navigateur au clic : un liseré
                         d'accent, au clavier seulement. */
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left font-karla text-sm outline-none transition-colors hover:bg-white/[0.05] focus-visible:ring-1 focus-visible:ring-action ${
                        on ? "font-semibold text-white" : "text-white/50"
                      }`}
                    >
                      {dot(c.color)}
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {/* La case : la couleur d'accent du site quand elle est
                          cochée — celle des interrupteurs du même panneau —, un
                          creux discret sinon. */}
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md transition-colors ${
                          on
                            ? "bg-action"
                            : /* Un gris DONNÉ, pas un blanc translucide : sur le
                                 fond bleu nuit du menu, le translucide virait
                                 au bleu (25/10/2026, Luc). */
                              "ring-[1.5px] ring-inset ring-[#4a4a4f]"
                        }`}
                        style={
                          on
                            ? {
                                boxShadow:
                                  "0 0 8px color-mix(in srgb, var(--brand-primary, #E94560) 45%, transparent)",
                              }
                            : undefined
                        }
                      >
                        {on ? (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#fff"
                            strokeWidth={3.5}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * La plage de notes — le double curseur du panneau de tri de « Ma liste ».
 *
 * DEUX `<input type="range">` SUPERPOSÉS, pas un composant. C'est la façon
 * connue de faire un double curseur sans dépendance : les deux occupent la même
 * boîte, le rail visible est peint dessous, et chacun ne reçoit le pointeur que
 * sur sa poignée (`pointer-events: none` sur la piste, `auto` sur le pouce, cf.
 * `.as-range` dans globals.css). Sans cette règle, celui du dessus attraperait
 * tous les clics et la borne basse serait injoignable.
 *
 * Les deux bornes ne se croisent pas : chacune s'arrête au pas suivant l'autre,
 * plutôt que de les échanger en cours de glissement — un intervalle qui se
 * retourne sous la main est désorientant, et « de 8 à 3 » ne veut rien dire.
 */
export function Range({
  min,
  max,
  step,
  from,
  to,
  onChange,
}: {
  min: number;
  max: number;
  step: number;
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
}) {
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const show = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

  return (
    <div className="mt-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="rounded-md bg-white/[0.07] px-2 py-0.5 font-karla text-[13px] font-bold text-white/80">
          {show(from)}
        </span>
        <span className="as-range relative h-4 flex-1">
          {/* Le rail, puis le segment retenu par-dessus. */}
          <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.16]" />
          <span
            className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-action"
            style={{ left: `${pct(from)}%`, right: `${100 - pct(to)}%` }}
          />
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={from}
            onChange={(e) => onChange(Math.min(Number(e.target.value), to), to)}
          />
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={to}
            onChange={(e) => onChange(from, Math.max(Number(e.target.value), from))}
          />
        </span>
        <span className="rounded-md bg-white/[0.07] px-2 py-0.5 font-karla text-[13px] font-bold text-white/80">
          {show(to)}
        </span>
      </div>
    </div>
  );
}

/**
 * Le curseur à UNE poignée (« Titres par ligne », 25/10/2026). Même rail, même
 * pouce et même pastille de valeur que la plage à deux poignées (`.as-range`) :
 * un seul `<input type="range">` dans la même boîte.
 */
function Single({
  min,
  max,
  value,
  zeroLabel,
  onChange,
  label,
}: {
  min: number;
  max: number;
  value: number;
  zeroLabel?: string;
  onChange: (v: number) => void;
  label: string;
}) {
  /* LE CURSEUR DU « FLOU » DU STUDIO, À L'IDENTIQUE (25/10/2026, Luc) : rail
     fin, remplissage d'accent, une poignée, et le rail entier cliquable
     (`pointerEvents: auto` en ligne, `.as-range` coupant les clics sinon). La
     valeur s'affiche dans la pastille à droite du titre (cf. plus bas). */
  return (
    <span className="as-range relative mt-2.5 block h-4 w-full min-w-0">
      <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.14]" />
      <span
        className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-action"
        style={{ width: `${((value - min) / (max - min)) * 100}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ pointerEvents: "auto" }}
        aria-label={label}
        aria-valuetext={value === 0 && zeroLabel ? zeroLabel : String(value)}
      />
    </span>
  );
}

export default function WidgetSettings({ options, onOption, onClose }: Props) {
  const { t } = useTranslation();

  return (
    /* PAS d'`overflow-hidden` ici : le menu déroulant des listes s'ouvre en
       absolu sous son bouton et serait coupé au bord du panneau. Rien d'autre
       ne dépassait de toute façon. */
    <div className="rounded-2xl border-2 border-[#2c2d36] bg-[#15161d] shadow-[0_18px_44px_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
        {/* « Paramètres du widget », et rien d'autre — pas le nom du bloc : le
            panneau s'ouvre SUR sa carte, dont l'en-tête porte déjà ce nom à
            deux centimètres au-dessus. Le pluriel suit le nombre de paramètres
            (i18next, `settingsTitle_one` / `_other`), y compris à zéro, où le
            français comme l'anglais mettent le pluriel. C'est la formule de
            TOUS les widgets, celui-ci n'a rien de particulier. */}
        <p className="min-w-0 truncate font-outfit text-base font-bold text-white">
          {t("profile.widgets.settingsTitle", { count: options.length })}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("profile.library.close")}
          className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3.5 w-3.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="p-2">
        {options.length ? (
          options.map((o) =>
            "on" in o ? (
              <button
                key={o.key}
                type="button"
                role="switch"
                aria-checked={o.on}
                onClick={() => onOption(o.key, !o.on)}
                className={`flex w-full items-center justify-between gap-3 text-left ${SECTION}`}
              >
                <Label label={o.label} desc={o.desc} />
                {/* ÉTEINT SE VOIT AUSSI. À 15 % de blanc l'interrupteur se
                    fondait dans le panneau : on ne distinguait plus « éteint »
                    de « pas d'interrupteur ». La piste éteinte est donc deux
                    fois plus claire et cerclée, et son pouce descend à 70 % de
                    blanc — assez pour se lire, pas assez pour qu'on la prenne
                    pour l'état allumé, qui reste le seul à porter la couleur. */}
                <span
                  className={`relative h-[22px] w-10 shrink-0 rounded-full transition-colors ${
                    o.on ? "bg-action" : "bg-white/[0.14] ring-1 ring-inset ring-white/25"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-4 w-4 rounded-full transition-transform ${
                      o.on ? "translate-x-[21px] bg-white" : "translate-x-[3px] bg-white/70"
                    }`}
                  />
                </span>
              </button>
            ) : "single" in o ? (
              <div key={o.key} className={SECTION}>
                {/* La valeur en pastille À DROITE DU TITRE, comme « 10 px » sur
                    le flou du studio. */}
                <div className="flex items-start justify-between gap-3">
                  <Label label={o.label} desc={o.desc} />
                  <span className="shrink-0 rounded-md bg-white/[0.07] px-1.5 py-0.5 font-karla text-[11px] font-bold text-white/80">
                    {o.single.value === 0 && o.single.zeroLabel
                      ? o.single.zeroLabel
                      : o.single.value}
                  </span>
                </div>
                <Single
                  {...o.single}
                  label={o.label}
                  onChange={(v) => onOption(o.key, String(v))}
                />
              </div>
            ) : "multi" in o ? (
              <div key={o.key} className={SECTION}>
                <Label label={o.label} desc={o.desc} />
                <MultiDropdown
                  values={o.values}
                  choices={o.multi}
                  onChange={(v) => onOption(o.key, JSON.stringify(v))}
                />
              </div>
            ) : "choices" in o ? (
              <div key={o.key} className={SECTION}>
                <Label label={o.label} desc={o.desc} />
                {o.segmented ? (
                  <Segmented
                    label={o.label}
                    value={o.value}
                    choices={o.choices}
                    onPick={(v) => onOption(o.key, v)}
                  />
                ) : (
                  <Dropdown
                    value={o.value}
                    choices={o.choices}
                    onPick={(v) => onOption(o.key, v)}
                  />
                )}
              </div>
            ) : (
              <div key={o.key} className={SECTION}>
                <Label label={o.label} desc={o.desc} />
                <Range
                  min={o.min}
                  max={o.max}
                  step={o.step}
                  from={o.from}
                  to={o.to}
                  onChange={(a, b) => onOption(o.key, `${a}-${b}`)}
                />
              </div>
            ),
          )
        ) : (
          <p className="px-3 py-3 text-center font-karla text-[13px] leading-relaxed text-white/55">
            {t("profile.widgets.noOptions")}
          </p>
        )}
      </div>
    </div>
  );
}
