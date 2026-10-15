import { useTranslation } from "react-i18next";
import { BY_ID } from "@/lib/badges/catalog";
import BadgeDefs from "./badges/BadgeDefs";
import BadgeToken from "./badges/BadgeToken";

/** Combien de badges un profil peut mettre en avant à côté de son pseudo. */
export const FEATURED_MAX = 3;

/**
 * Les badges mis en avant, à côté du pseudo (haut de profil et colonne).
 *
 * Le choix vit dans l'habillage (`Dressing.badges`, posé au studio) ; ce qui
 * s'affiche est ce choix FILTRÉ par ce que le profil a réellement obtenu
 * (`earned`, l'état de badges que la page a déjà). Un badge retiré du
 * catalogue, ou un état de badges qui ne le porte plus, ne laisse donc jamais
 * une case vide ni un jeton gagné qu'on n'a pas.
 *
 * Les définitions SVG des jetons (`<BadgeDefs/>`) sont montées ici : la page
 * ne les monte sinon que dans l'onglet Badges. Deux montages à l'écran
 * dupliquent les ids, ce qui est sans effet (cf. BadgeDefs).
 */
export default function FeaturedBadges({
  ids,
  earned,
  size,
  className = "",
}: {
  ids: string[] | null | undefined;
  earned: Record<string, number> | null | undefined;
  /** Côté du jeton en px. */
  size: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const shown = (ids ?? [])
    .filter((id) => BY_ID[id] && earned?.[id])
    .slice(0, FEATURED_MAX);
  if (!shown.length) return null;

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <BadgeDefs />
      {shown.map((id) => {
        const def = BY_ID[id];
        const name = t(`badges.${id}.name`);
        return (
          /* Pas de lien : `revealHref` mène à `/en/profile/me`, le profil du
             VISITEUR — faux sur le profil de quelqu'un d'autre. */
          <span
            key={id}
            title={name}
            role="img"
            aria-label={name}
            className="block transition-transform duration-200 hover:scale-110"
          >
            <BadgeToken
              id={id}
              rarity={def.rarity}
              icon={def.icon}
              tag={def.tag}
              unlocked
              size={size}
            />
          </span>
        );
      })}
    </div>
  );
}
