import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { BY_ID } from "@/lib/badges/catalog";
import { revealAnchor } from "@/lib/badges/reveal";
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
  const row = useRef<HTMLDivElement | null>(null);
  const key = shown.join(",");

  /* LA RANGÉE SE CALE SUR LE PIXEL (25/10/2026, Luc : badges flous, puis « ils
     se décalent d'un coup » à la fin du grossissement au survol). Elle suit le
     pseudo, dont la largeur est fractionnaire : les jetons tombaient entre
     deux pixels. Sur une couche à eux (`will-change`), Chrome rééchantillonnait
     — flou ; sans couche, il en créait une le temps de l'animation et la
     retirait à la fin — saut d'une fraction de pixel. Recalée ici sur un pixel
     d'ÉCRAN entier (devicePixelRatio compris : 125 %, 150 %), la rangée peut
     garder ses couches en permanence : net au repos, rien ne bouge à la fin. */
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    let dx = 0;
    let dy = 0;
    const snap = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = r.left - dx;
      const y = r.top - dy;
      dx = Math.round(x * dpr) / dpr - x;
      dy = Math.round(y * dpr) / dpr - y;
      el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
    };
    snap();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(snap) : null;
    /* Le parent ET ses enfants : c'est la largeur du PSEUDO qui place la
       rangée, et elle change quand sa police arrive sans que la boîte du
       parent bouge (mesuré : rangée restée à x = 463,09 après le calage). */
    if (ro && el.parentElement) {
      ro.observe(el.parentElement);
      for (const c of Array.from(el.parentElement.children)) if (c !== el) ro.observe(c);
    }
    /* Et la page entière : une barre de défilement qui apparaît rétrécit la
       zone utile et fait glisser tout ce qui est centré, sans « resize ». */
    ro?.observe(document.documentElement);
    window.addEventListener("load", snap);
    const late = [400, 1500].map((ms) => setTimeout(snap, ms));
    window.addEventListener("resize", snap);
    /* Ce qui se charge plus haut (image, police) peut la redécaler : un
       recalage au passage de la souris, juste avant le grossissement. */
    el.addEventListener("pointerenter", snap);
    void document.fonts?.ready.then(snap);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", snap);
      el.removeEventListener("pointerenter", snap);
      window.removeEventListener("load", snap);
      late.forEach(clearTimeout);
    };
  }, [key, size]);

  if (!shown.length) return null;

  return (
    <div ref={row} className={`flex items-center gap-1.5 ${className}`}>
      <BadgeDefs />
      {shown.map((id) => {
        const def = BY_ID[id];
        const name = t(`badges.${id}.name`);
        return (
          /* Un lien vers l'onglet Badges DE CETTE PAGE, sur ce badge : le seul
             fragment `#badge-<id>`, sans chemin. `revealHref` n'irait pas —
             il mène à `/en/profile/me`, le profil du VISITEUR, faux sur celui
             de quelqu'un d'autre. Le fragment ouvre l'onglet ([user].tsx,
             `lireOnglet`) et ProfileBadges y fait défiler puis surligne. */
          <a
            key={id}
            href={`#${revealAnchor(id)}`}
            title={name}
            aria-label={name}
            /* `will-change` en permanence : la couche ne naît ni ne meurt avec
               le survol (cf. le calage de la rangée, plus haut). */
            className="block rounded-lg outline-none transition-transform duration-200 will-change-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <BadgeToken
              id={id}
              rarity={def.rarity}
              icon={def.icon}
              tag={def.tag}
              unlocked
              size={size}
            />
          </a>
        );
      })}
    </div>
  );
}
