import { useTranslation } from "react-i18next";

/**
 * Le petit outillage partagé par les widgets du profil.
 *
 * `EmptyBlock` est le plus important des trois : c'est lui qui tient la règle
 * posée le 31/08/2026 — un bloc dont la source n'existe pas encore garde sa
 * place et DIT ce qui lui manque, au lieu d'afficher des chiffres inventés.
 */

export function EmptyBlock({ note }: { note: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="h-6 w-6 text-white/25"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <p className="max-w-[26rem] font-karla text-[11px] leading-relaxed text-white/40">
        {note}
      </p>
    </div>
  );
}

/**
 * Barre horizontale d'un classement. `pct` est déjà borné par l'appelant.
 *
 * Son épaisseur est une VARIABLE et pas une classe : « Répartition par statut »
 * la fait grandir avec sa carte, par requête de conteneur, et une classe
 * Tailwind ajoutée par-dessus une autre ne gagne pas — à spécificité égale
 * c'est l'ordre dans la feuille qui tranche, pas l'ordre dans l'attribut. Les
 * autres appelants ne déclarent rien et gardent les 5 px d'origine.
 */
export function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <span
      className="block w-full overflow-hidden rounded-full bg-white/[0.07]"
      style={{ height: "var(--as-bar-h, 5px)" }}
    >
      <span
        className="block h-full rounded-full"
        style={{
          /* Le plancher est en `%` — 2 % de la piste — mais une piste epaisse le
             rend ridicule : a 11 px de haut, ces 2 % dessinent une pastille
             ECRASEE, plus haute que large, et le petit statut a l'air casse
             plutot que petit. Le plancher est donc aussi de la hauteur de la
             barre, ce qui en fait un disque propre. */
          minWidth: "var(--as-bar-h, 5px)",
          width: `${Math.max(2, Math.min(100, pct))}%`,
          background:
            color ||
            "linear-gradient(90deg, var(--brand-primary, #E94560), var(--brand-secondary, #FF7F57))",
        }}
      />
    </span>
  );
}

/** Colonne d'un histogramme, hauteur en % de la plus haute. */
export function Column({
  pct,
  label,
  color,
}: {
  pct: number;
  label: string;
  color?: string;
}) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-end gap-2">
      <div
        className="w-full rounded-t-md"
        style={{
          height: `${Math.max(4, Math.min(100, pct))}%`,
          background:
            color ||
            "linear-gradient(180deg, var(--brand-primary, #E94560), rgba(233,69,96,0.15))",
        }}
      />
      <span className="font-karla text-[10px] text-white/35">{label}</span>
    </div>
  );
}

/** « aujourd'hui », « il y a 3 j » — la fraîcheur d'une lecture, sans librairie. */
export function useAgo(): (timestamp: number) => string {
  const { t } = useTranslation();
  return (timestamp: number) => {
    const mins = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (mins < 60) return t("profile.ago.minutes", { count: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t("profile.ago.hours", { count: hours });
    const days = Math.round(hours / 24);
    if (days < 7) return t("profile.ago.days", { count: days });
    return t("profile.ago.weeks", { count: Math.round(days / 7) });
  };
}
