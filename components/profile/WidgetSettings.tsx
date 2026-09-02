import { useState } from "react";
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
function Label({ label, desc }: { label: string; desc?: string }) {
  return (
    <span className="block min-w-0 flex-1">
      <span className="block font-karla text-[13px] font-bold text-white">{label}</span>
      {desc ? (
        <span className="mt-0.5 block font-karla text-[11px] leading-snug text-white/35">
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
const SECTION = "rounded-xl px-2.5 py-2 transition-colors hover:bg-white/[0.05]";

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
 */
function Dropdown({
  value,
  choices,
  onPick,
}: {
  value: string;
  choices: { value: string; label: string; color?: string; heart?: boolean }[];
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = choices.find((c) => c.value === value) ?? choices[0];

  /* Le repere d'un choix : la pastille de sa liste, ou un COEUR pour les
     favoris. Les favoris ne sont pas une liste de plus — on n'y range pas, on y
     epingle — et une septieme pastille ronde les aurait rangés avec les six
     autres. Il brille de la meme facon qu'elles (`box-shadow` / `drop-shadow`),
     donc il reste de la meme famille. */
  const mark = (c?: { color?: string; heart?: boolean }) =>
    c?.heart ? (
      /* LE CŒUR REMPLIT EXACTEMENT LA BOÎTE D'UNE PASTILLE.
         Il a d'abord été centré DANS cette boîte tout en gardant sa taille
         propre — 12 px contre 8 — et débordait donc de deux pixels de chaque
         côté : son bord gauche commençait avant celui des pastilles, ce qui se
         lisait comme un défaut d'alignement même si le centre, lui, tombait
         juste. Il fait maintenant 100 % de la boîte, comme un disque en ferait
         100 %, et les deux colonnes — repère et nom — s'alignent au pixel.
         Le tracé est celui de Material : son encre est centrée dans le viewBox,
         là où un cœur dessiné à la main penche vers le bas et paraît descendu. */
      <span
        className="le-dd-dot"
        style={{ background: "none", display: "grid", placeItems: "center" }}
      >
        <svg
          viewBox="0 0 24 24"
          fill={c.color || "#E94560"}
          style={{
            width: "100%",
            height: "100%",
            filter: `drop-shadow(0 0 4px ${c.color || "#E94560"})`,
          }}
        >
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>
      </span>
    ) : (
      <span
        className="le-dd-dot"
        style={
          c?.color
            ? { background: c.color, boxShadow: `0 0 6px ${c.color}` }
            : { background: "rgba(255,255,255,0.25)" }
        }
      />
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
    <div className="le-dd-field le-dd-compact mt-1.5">
      <button
        type="button"
        className="le-dd-trigger"
        style={tint}
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
        <div className="le-dd-list">
          {choices.map((c) => (
            <button
              type="button"
              key={c.value}
              className={`le-dd-option ${c.value === value ? "selected" : ""}`}
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
          ))}
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
function Range({
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
        <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-karla text-[11px] font-bold text-white/80">
          {show(from)}
        </span>
        <span className="as-range relative h-4 flex-1">
          {/* Le rail, puis le segment retenu par-dessus. */}
          <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/12" />
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
        <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-karla text-[11px] font-bold text-white/80">
          {show(to)}
        </span>
      </div>
    </div>
  );
}

export default function WidgetSettings({ options, onOption, onClose }: Props) {
  const { t } = useTranslation();

  return (
    /* PAS d'`overflow-hidden` ici : le menu déroulant des listes s'ouvre en
       absolu sous son bouton et serait coupé au bord du panneau. Rien d'autre
       ne dépassait de toute façon. */
    <div className="rounded-2xl bg-[#15161d] ring-1 ring-white/10 shadow-[0_18px_44px_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-3.5 py-2.5">
        {/* « Paramètres du widget », et rien d'autre — pas le nom du bloc : le
            panneau s'ouvre SUR sa carte, dont l'en-tête porte déjà ce nom à
            deux centimètres au-dessus. Le pluriel suit le nombre de paramètres
            (i18next, `settingsTitle_one` / `_other`), y compris à zéro, où le
            français comme l'anglais mettent le pluriel. C'est la formule de
            TOUS les widgets, celui-ci n'a rien de particulier. */}
        <p className="min-w-0 truncate font-outfit text-sm font-bold text-white">
          {t("profile.widgets.settingsTitle", { count: options.length })}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("profile.library.close")}
          className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3 w-3">
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
                  className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${
                    o.on ? "bg-action" : "bg-white/[0.14] ring-1 ring-inset ring-white/25"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-transform ${
                      o.on ? "translate-x-[16px] bg-white" : "translate-x-0.5 bg-white/70"
                    }`}
                  />
                </span>
              </button>
            ) : "choices" in o ? (
              <div key={o.key} className={SECTION}>
                <Label label={o.label} desc={o.desc} />
                <Dropdown
                  value={o.value}
                  choices={o.choices}
                  onPick={(v) => onOption(o.key, v)}
                />
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
          <p className="px-2.5 py-3 text-center font-karla text-[11px] leading-relaxed text-white/35">
            {t("profile.widgets.noOptions")}
          </p>
        )}
      </div>
    </div>
  );
}
