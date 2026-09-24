/**
 * Les dégradés et masques du jeton, déclarés UNE SEULE FOIS par page.
 *
 * Un `<linearGradient>` vit dans le document, pas dans le SVG qui l'utilise :
 * `stroke="url(#asRgMythic)"` va le chercher par son id où qu'il soit. Les
 * poser dans chaque jeton donnerait cent quatre-vingts définitions identiques
 * — et cent quatre-vingts fois le même id, ce qui est invalide.
 *
 * Ce bloc est donc monté une fois, en tête de l'onglet Badges et dans la
 * notification d'achievement. Les deux peuvent coexister : si les deux sont à
 * l'écran, les ids sont dupliqués et le navigateur prend le premier — les
 * définitions étant identiques, le rendu ne change pas.
 *
 * Les ids sont préfixés `as` (AniScroll) pour ne pas entrer en collision avec
 * ceux d'un autre SVG de la page.
 */

import { CLIP_SCALE, HEX, RING_STOPS } from "./rarity";
import type { Rarity } from "@/lib/badges/catalog";

const RARITIES: Rarity[] = ["c", "u", "r", "e", "l", "m"];
/** Les ids que `RARITY[*].ring` référence (`url(#asRgMythic)`…). */
const RING_IDS: [Exclude<Rarity, "c">, string][] = [
  ["u", "asRgUncommon"],
  ["r", "asRgRare"],
  ["e", "asRgEpic"],
  ["l", "asRgLegendary"],
  ["m", "asRgMythic"],
];

export default function BadgeDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        {/* Les anneaux. Leurs couleurs vivent dans rarity.ts (RING_STOPS),
            que le menu de rareté lit aussi. */}
        {RING_IDS.map(([k, id]) => (
          <linearGradient key={id} id={id} x1="0" y1="0" x2=".5" y2="1">
            {RING_STOPS[k].map(([o, c]) => (
              <stop key={o} offset={o} stopColor={c} />
            ))}
          </linearGradient>
        ))}

        {/* Le fond du jeton : la même plaque sombre pour toutes les raretés,
            pour que seul l'anneau porte la hiérarchie. */}
        <linearGradient id="asPlate" x1="0" y1="0" x2=".4" y2="1">
          <stop offset="0" stopColor="#20202c" />
          <stop offset="1" stopColor="#15151f" />
        </linearGradient>

        {/* Le reflet qui balaie les jetons légendaires et mythiques. */}
        <linearGradient id="asSweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".3" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>

        {/* Un masque par rareté : le balayage doit s'arrêter au bord de
            l'anneau, dont l'épaisseur change d'une rareté à l'autre. */}
        {RARITIES.map((k) => (
          <clipPath
            key={k}
            id={`asHexC_${k}`}
            transform={`translate(59 59) scale(${CLIP_SCALE[k]}) translate(-59 -59)`}
          >
            <path d={HEX} />
          </clipPath>
        ))}
      </defs>
    </svg>
  );
}
