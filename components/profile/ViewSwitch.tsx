/**
 * Le choix d'affichage (Cartes, Grille, Compacte), commun à Ma liste et aux
 * Badges : un seul composant pour que les deux onglets restent identiques.
 */

import { useTranslation } from "react-i18next";

export type View = "cards" | "grid" | "compact";
export const VIEWS: View[] = ["cards", "grid", "compact"];

export default function ViewSwitch({
  value,
  onChange,
}: {
  value: View;
  onChange: (v: View) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("listMenu.view")} className="relative flex h-[42px] shrink-0 items-center gap-0.5 as-stat-card rounded-[12px] border border-white/[0.12] p-0.5">
      {/* Le carre de selection GLISSE d'une vue a l'autre, a droite ou a
          gauche selon la place de la nouvelle (10/11/2026, Luc). 38 px =
          la largeur d'un bouton (36) + l'ecart (2). */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-9 rounded-[9px] bg-white/[0.12] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ transform: `translateX(${VIEWS.indexOf(value) * 38}px)` }}
      />
      {VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          aria-label={t(`listMenu.views.${v}`)}
          title={t(`listMenu.views.${v}`)}
          className={`relative z-10 grid h-full w-9 place-items-center rounded-[9px] transition-colors ${value === v ? "text-white" : "text-white/40 hover:text-white/80"}`}
        >
          <ViewIcon v={v} />
        </button>
      ))}
    </div>
  );
}

function ViewIcon({ v }: { v: View }) {
  const p =
    v === "cards"
      /* Deux rectangles bien séparés (20/11/2026, Luc). */
      ? <><rect x="3" y="3" width="18" height="6" rx="1" /><rect x="3" y="15" width="18" height="6" rx="1" /></>
      : v === "grid"
        ? <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>
        /* Un peu d'air entre les lignes (20/11/2026, Luc). */
        : <path d="M8 4.5h13M8 12h13M8 19.5h13M3 4.5h.01M3 12h.01M3 19.5h.01" />;
  return (
    // La liste, un peu plus épaisse (20/11/2026, Luc).
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={v === "compact" ? 2.6 : 2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {p}
    </svg>
  );
}
