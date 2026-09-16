/**
 * Le jeton hexagonal d'un badge.
 *
 * Transposition du SVG de la maquette : anneau dégradé par rareté, halo
 * extérieur, deux liserés internes, balayage lumineux sur les hautes raretés,
 * constellation d'étoiles, plaque de palier. Les définitions partagées
 * (dégradés, masques) vivent dans <BadgeDefs/>, monté une fois par page.
 *
 * TROIS ÉTATS, et ils doivent se distinguer sans lire le texte :
 *   - obtenu    : en couleur, animé ;
 *   - à obtenir : désaturé et assombri, sans étoiles ni balayage — il est là,
 *                 on voit ce qu'on vise, mais il n'a pas l'air gagné ;
 *   - secret    : un point d'interrogation à la place de l'icône, anneau neutre.
 *
 * Le SURVOL agrandit le jeton. En CSS et pas en state React : la page de profil
 * en aligne cent quatre-vingts, et faire passer un survol par React ferait
 * re-rendre la liste à chaque mouvement de souris.
 */

import { memo } from "react";
import { iconFor, SECRET_ICON } from "@/lib/badges/icons";
import { HEX, RARITY, starsFor } from "./rarity";
import type { Rarity } from "@/lib/badges/catalog";

export type BadgeTokenProps = {
  /** Sert de graine à la constellation : le même badge a toujours les mêmes étoiles. */
  id: string;
  rarity: Rarity;
  /** Clé d'icône (lib/badges/icons.ts). Ignorée pour un secret verrouillé. */
  icon: string;
  /** Le texte de la plaque. Vide = pas de plaque. */
  tag?: string;
  unlocked?: boolean;
  /** Secret non débloqué : on ne montre ni l'icône, ni la vraie rareté. */
  hidden?: boolean;
  /** Côté du jeton en px (la maquette le dessine à 118). */
  size?: number;
  /** Anime les étoiles et le balayage. Coupé dans les longues listes. */
  animate?: boolean;
};

/** La taille de référence du dessin : tout le reste est une mise à l'échelle. */
const BASE = 118;

function BadgeTokenInner({
  id, rarity, icon, tag = "", unlocked = false, hidden = false,
  size = BASE, animate = true,
}: BadgeTokenProps) {
  const R = RARITY[rarity];
  const Icon = hidden ? SECRET_ICON : iconFor(icon);
  const scale = size / BASE;

  /* Un badge non obtenu ne scintille pas et ne brille pas : les étoiles et le
     balayage sont la récompense, pas la promesse. */
  const lit = unlocked && animate;
  const stars = lit && !hidden ? starsFor(id + rarity, R.stars, R.starColors) : [];

  /* Verrouillé : on garde la FORME (l'anneau dit déjà la rareté visée) et on
     retire la couleur. Un jeton grisé à côté d'un jeton doré se lit tout de
     suite, là où deux jetons dorés dont l'un serait juste un peu pâle non. */
  const ink = unlocked ? R.ic : "#6b7280";
  const ring = unlocked ? R.ring : "rgba(148,163,184,.35)";

  return (
    <div
      className="as-badge-token"
      style={{
        position: "relative",
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        opacity: unlocked ? 1 : 0.55,
        /* Le grossissement au survol. `will-change` évite que le navigateur
           redessine le SVG à chaque image de la transition. */
        willChange: "transform",
      }}
    >
      <svg
        viewBox="-9 -9 136 136"
        width={136 * scale}
        height={136 * scale}
        style={{ position: "absolute", left: -9 * scale, top: -9 * scale }}
        aria-hidden="true"
      >
        {/* Le halo extérieur : la même forme, très transparente, qui détache le
            jeton du fond sans ajouter de trait net. */}
        <path d={HEX} fill="none" stroke={ink} strokeOpacity={0.2} strokeWidth={R.sw + 3} />
        <path d={HEX} fill="url(#asPlate)" stroke={ring} strokeWidth={R.sw} />
        {unlocked && R.inner && (
          <path
            transform="translate(59 59) scale(.89) translate(-59 -59)"
            d={HEX}
            fill="none"
            stroke={R.inner}
            strokeWidth={1.2}
          />
        )}
        {unlocked && R.deep && (
          <path
            transform="translate(59 59) scale(.76) translate(-59 -59)"
            d={HEX}
            fill="none"
            stroke={R.deep}
            strokeWidth={1}
          />
        )}
        {lit && R.sweep > 0 && (
          <g clipPath={`url(#asHexC_${rarity})`}>
            <g transform="skewX(-14)">
              <rect
                x={-46}
                y={-24}
                width={R.sweep}
                height={168}
                fill="url(#asSweep)"
                style={{ animation: "asSweep 5.5s ease-in-out infinite" }}
              />
            </g>
          </g>
        )}
      </svg>

      {stars.map((st, i) => (
        <svg
          key={i}
          viewBox="0 0 12 12"
          width={st.s * scale}
          height={st.s * scale}
          style={{
            position: "absolute",
            left: st.x * scale,
            top: st.y * scale,
            opacity: 0,
            animation: st.anim,
            pointerEvents: "none",
          }}
          aria-hidden="true"
        >
          <path d="M6 0 6.9 5.1 12 6 6.9 6.9 6 12 5.1 6.9 0 6 5.1 5.1Z" fill={st.f} />
        </svg>
      ))}

      <Icon
        size={42 * scale}
        color={ink}
        style={{ position: "relative", marginBottom: (tag ? 13 : 0) * scale }}
        aria-hidden="true"
      />

      {tag ? (
        <div
          style={{
            position: "absolute",
            bottom: 14 * scale,
            left: "50%",
            transform: "translateX(-50%)",
            borderRadius: 8 * scale,
            whiteSpace: "nowrap",
            boxShadow: "0 3px 10px rgba(0,0,0,.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: 21 * scale,
            padding: `0 ${10 * scale}px`,
            background: unlocked ? R.plaque[0] : "linear-gradient(90deg,#9ca3af,#4b5563)",
            fontFamily: "Outfit, sans-serif",
            fontWeight: 700,
            fontSize: 11 * scale,
            lineHeight: 1,
            color: unlocked ? R.plaque[1] : "#111827",
          }}
        >
          {tag}
        </div>
      ) : null}
    </div>
  );
}

/* Mémoïsé : l'onglet en affiche jusqu'à cent quatre-vingts, et un changement
   de filtre ne doit pas tous les redessiner — seuls ceux dont les props
   bougent. */
export default memo(BadgeTokenInner);
