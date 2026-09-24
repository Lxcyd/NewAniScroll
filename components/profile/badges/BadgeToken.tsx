/**
 * Le jeton hexagonal d'un badge.
 *
 * Transposition du SVG de la maquette : anneau dégradé par rareté, halo
 * extérieur, deux liserés internes, balayage lumineux sur les hautes raretés,
 * constellation d'étoiles, plaque de palier. Les définitions partagées
 * (dégradés, masques) vivent dans <BadgeDefs/>, monté une fois par page.
 *
 * TROIS ÉTATS, et ils doivent se distinguer sans lire le texte :
 *   - obtenu    : pleine opacité, étoiles, balayage, liserés nets ;
 *   - à obtenir : la MÊME couleur de rareté, simplement moins opaque et sans
 *                 animation — on voit ce qu'on vise, et de quelle rareté il
 *                 est ;
 *   - secret    : un point d'interrogation à la place de l'icône.
 *
 * Le SURVOL agrandit le jeton. En CSS et pas en state React : la page de profil
 * en aligne cent quatre-vingts, et faire passer un survol par React ferait
 * re-rendre la liste à chaque mouvement de souris.
 */

import { memo } from "react";
import { MdCheck } from "react-icons/md";
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
  /** Pose la coche d'obtention en haut à droite (onglet Badges, panneau
      d'échelle). Pas dans la notification : elle annonce déjà l'obtention. */
  check?: boolean;
};

/** La taille de référence du dessin : tout le reste est une mise à l'échelle. */
const BASE = 118;

function BadgeTokenInner({
  id, rarity, icon, tag = "", unlocked = false, hidden = false,
  size = BASE, animate = true, check = false,
}: BadgeTokenProps) {
  const R = RARITY[rarity];
  const Icon = hidden ? SECRET_ICON : iconFor(icon);
  const scale = size / BASE;

  /* Un badge non obtenu ne scintille pas et ne brille pas : les étoiles et le
     balayage sont la récompense, pas la promesse. */
  const lit = unlocked && animate;
  const stars = lit && !hidden ? starsFor(id + rarity, R.stars, R.starColors) : [];

  /* UN BADGE NON OBTENU EST TAILLÉ DANS LA PIERRE (24/09/2026).
     Deux essais avant celui-ci gardaient la couleur de rareté sur les jetons
     verrouillés, en jouant sur l'opacité (0,72 puis 0,8) : illisible. Un
     Commun est gris dans les deux états, et sur un profil à illustration le
     fond traversait tout pareil — un Peu commun verrouillé paraissait même
     plus vif qu'un badge obtenu.

     La pierre : anneau et plaque gris sombre, icône gravée (sombre, liseré
     clair dessous), plus de liserés internes. La rareté reste lisible à
     l'ÉPAISSEUR de l'anneau, et au libellé de la ligne. Idée tirée des succès
     de Clash of Clans, pour la compréhension seulement : rien d'autre de son
     style. Un compte neuf est donc tout en pierre, et c'est assumé. */
  const stone = !unlocked;
  const ink = stone ? "#16171c" : R.ic;
  const ring = stone ? "url(#asStoneRing)" : R.ring;

  return (
    <div
      className="as-badge-token"
      style={{
        position: "relative",
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
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
        <path
          d={HEX}
          fill="none"
          stroke={stone ? "#000" : ink}
          strokeOpacity={stone ? 0.35 : 0.2}
          strokeWidth={R.sw + 3}
        />
        <path d={HEX} fill={stone ? "url(#asStone)" : "url(#asPlate)"} stroke={ring} strokeWidth={R.sw} />
        {/* L'ombre intérieure, décalée vers le bas : la plaque paraît creusée. */}
        {stone && (
          <path
            transform="translate(59 61) scale(.9) translate(-59 -59)"
            d={HEX}
            fill="none"
            stroke="rgba(0,0,0,.55)"
            strokeWidth={3}
          />
        )}
        {!stone && R.inner && (
          <path
            transform="translate(59 59) scale(.89) translate(-59 -59)"
            d={HEX}
            fill="none"
            stroke={R.inner}
            strokeWidth={1.2}
          />
        )}
        {!stone && R.deep && (
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
        style={{
          position: "relative",
          marginBottom: (tag ? 13 : 0) * scale,
          /* La gravure : un liseré clair juste sous l'icône sombre. */
          filter: stone
            ? `drop-shadow(0 ${Math.max(1, 1.5 * scale)}px 0 rgba(255,255,255,.14))`
            : undefined,
        }}
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
            background: stone ? "linear-gradient(90deg,#4a4c55,#2c2d33)" : R.plaque[0],
            fontFamily: "Outfit, sans-serif",
            fontWeight: 700,
            fontSize: 11 * scale,
            lineHeight: 1,
            color: stone ? "#9a9ca6" : R.plaque[1],
          }}
        >
          {tag}
        </div>
      ) : null}

      {/* LA COCHE, et non plus seulement l'opacité : dans le panneau d'échelle,
          où rien n'est animé, un palier gagné et un palier à venir ne
          différaient que de quelques points de transparence. Un plancher à
          16 px pour qu'elle reste une coche sur les jetons de 54. */}
      {check && unlocked ? (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            right: -2 * scale,
            top: 4 * scale,
            width: Math.max(16, 26 * scale),
            height: Math.max(16, 26 * scale),
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            background: ink,
            boxShadow: "0 0 0 2px #12131a, 0 2px 8px rgba(0,0,0,.5)",
          }}
        >
          <MdCheck size={Math.max(16, 26 * scale) * 0.72} color="#12131a" />
        </div>
      ) : null}
    </div>
  );
}

/* Mémoïsé : l'onglet en affiche jusqu'à cent quatre-vingts, et un changement
   de filtre ne doit pas tous les redessiner — seuls ceux dont les props
   bougent. */
export default memo(BadgeTokenInner);
