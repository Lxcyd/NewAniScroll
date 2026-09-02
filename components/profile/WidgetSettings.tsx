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

/** Le nom d'un réglage et sa phrase d'explication — commun aux deux formes. */
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
  choices: { value: string; label: string; color?: string }[];
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = choices.find((c) => c.value === value) ?? choices[0];

  const dot = (color?: string) => (
    <span
      className="le-dd-dot"
      style={
        color
          ? { background: color, boxShadow: `0 0 6px ${color}b3` }
          : { background: "rgba(255,255,255,0.25)" }
      }
    />
  );

  return (
    <div className="le-dd-field le-dd-compact mt-1.5">
      <button type="button" className="le-dd-trigger" onClick={() => setOpen((o) => !o)}>
        {dot(current?.color)}
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
              onClick={() => {
                onPick(c.value);
                setOpen(false);
              }}
            >
              {dot(c.color)}
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
                className="flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]"
              >
                <Label label={o.label} desc={o.desc} />
                {/* La seule couleur du panneau : un interrupteur allumé. */}
                <span
                  className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${
                    o.on ? "bg-action" : "bg-white/15"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      o.on ? "translate-x-[16px]" : "translate-x-0.5"
                    }`}
                  />
                </span>
              </button>
            ) : (
              <div key={o.key} className="rounded-xl px-2.5 py-2">
                <Label label={o.label} desc={o.desc} />
                <Dropdown
                  value={o.value}
                  choices={o.choices}
                  onPick={(v) => onOption(o.key, v)}
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
