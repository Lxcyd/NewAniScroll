/**
 * Les onglets d'un profil. Un simple sélecteur en pilules — l'état vit chez la
 * page, qui décide aussi lesquels ont un sens (un profil sans liste n'a pas
 * d'onglet statistiques à proposer).
 *
 * LA PILULE ROUGE GLISSE d'un onglet à l'autre. C'est UN élément, posé sous les
 * boutons et déplacé vers celui qui est actif — pas un fond par bouton, qui ne
 * pourrait que s'éteindre ici et s'allumer là. Mesurée après le rendu : au
 * premier passage (rendu serveur compris) c'est le bouton actif qui porte son
 * propre fond, puis la pilule le relaie au même endroit, sans rien qui bouge.
 *
 * ELLE NE GLISSE QUE POUR UN VRAI CHANGEMENT D'ONGLET (08/11/2026, Luc : « au
 * rechargement l'animation se refait »). La page démarre sur « Aperçu » puis
 * restaure l'onglet du fragment (`#list`) juste après le montage : ce saut-là
 * se pose sans glisser. De même quand seule la LARGEUR bouge (le compteur de
 * « Ma liste » qui arrive, la police) : la pilule suit sans transition.
 */

import { useEffect, useRef, useState } from "react";

export type ProfileTab = {
  key: string;
  label: string;
  /** Compteur discret à droite du libellé. */
  count?: number | null;
};

type Pill = { x: number; y: number; w: number; h: number; slide: boolean };

export default function ProfileTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: ProfileTab[];
  active: string;
  onChange: (key: string) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef(new Map<string, HTMLButtonElement>());
  const [pill, setPill] = useState<Pill | null>(null);
  /** L'onglet sur lequel la pilule est posée — pour distinguer un changement
   *  d'onglet d'une simple nouvelle mesure. */
  const lastActive = useRef<string | null>(null);
  /** Vrai deux images après le montage : la restauration depuis le fragment est
   *  passée, un changement d'onglet vient désormais de l'utilisateur. */
  const settled = useRef(false);
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        settled.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);

  useEffect(() => {
    const switched = lastActive.current !== null && lastActive.current !== active;
    lastActive.current = active;
    const measure = (slide: boolean) => {
      const b = btnRefs.current.get(active);
      if (!b) return;
      const next = { x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.offsetHeight, slide };
      // Même valeur, même objet : sans ça, chaque mesure relancerait un rendu.
      setPill((p) =>
        p && p.x === next.x && p.y === next.y && p.w === next.w && p.h === next.h ? p : next,
      );
    };
    measure(switched && settled.current);
    /* Un libellé qui change de largeur (le compteur de « Ma liste » arrive
       après coup, la langue change, la police finit de charger) déplace les
       onglets : la pilule suit, sans glisser. */
    const ro = new ResizeObserver(() => measure(false));
    if (barRef.current) ro.observe(barRef.current);
    return () => ro.disconnect();
  }, [active]);

  return (
    /* `as-stat-card` comme toutes les surfaces du profil : elle porte le fond
       sombre ET le flou que règle le studio de bannière. Sans elle, la barre
       était la seule à laisser l'illustration nette derrière son texte. */
    <div
      ref={barRef}
      /* Telephone : jamais plus large que l'ecran ; s'il le faut, la rangee
         defile (la pilule, enfant de la barre, defile avec elle). */
      className="as-stat-card flex w-max max-sm:max-w-full max-sm:overflow-x-auto max-sm:scrollbar-hide items-center gap-1 rounded-full p-[5px] ring-1 ring-white/[0.07]"
    >
      {pill ? (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 rounded-full bg-action shadow-glow"
          style={{
            width: pill.w,
            height: pill.h,
            transform: `translate(${pill.x}px, ${pill.y}px)`,
            transition: pill.slide
              ? "transform 420ms cubic-bezier(0.22, 1, 0.36, 1), width 420ms cubic-bezier(0.22, 1, 0.36, 1)"
              : "none",
          }}
        />
      ) : null}
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              if (el) btnRefs.current.set(tab.key, el);
              else btnRefs.current.delete(tab.key);
            }}
            type="button"
            onClick={() => onChange(tab.key)}
            aria-current={on ? "page" : undefined}
            className={`relative shrink-0 rounded-full px-4 max-sm:px-3 py-2 font-karla text-[13px] font-bold transition-colors duration-300 sm:px-[18px] ${
              on
                ? /* Son propre fond seulement tant que la pilule n'est pas posée. */
                  `text-white ${pill ? "" : "bg-action shadow-glow"}`
                : "text-white/55 hover:text-white"
            }`}
          >
            {tab.label}
            {tab.count != null ? (
              <span className="ml-1.5 opacity-55">{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
