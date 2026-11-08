import { useEffect, useLayoutEffect, type RefObject } from "react";

/* LA POSITION DE DÉFILEMENT DES MENUS DU MODE ÉDITION (08/11/2026, Luc).
   Fermer puis rouvrir le studio retombe sur le même menu, à la même hauteur ;
   changer de menu repart du haut. On ne retient donc qu'UN menu à la fois :
   en ouvrir un autre efface tout. `slot` distingue les listes d'un même menu
   (la colonne, la liste des badges…). En sessionStorage : survit au
   rechargement de l'onglet, pas au-delà. */

const KEY = "as-studio-scroll";
type Memo = { menu: string; tops: Record<string, number> };

let memo: Memo | null = null;
function read(): Memo {
  if (memo) return memo;
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (v && typeof v.menu === "string" && v.tops) return (memo = v);
  } catch {
    /* stockage refusé : on part du haut */
  }
  return (memo = { menu: "", tops: {} });
}
function write(m: Memo) {
  memo = m;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* rien à retenir */
  }
}

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Retient le défilement de `ref` pour le menu `menu`, et le rend quand le menu
 * revient. `menu` null : rien (studio fermé). La liste se remplit souvent après
 * coup (images, squelettes) : on recale tant qu'elle grandit, 2,5 s au plus,
 * et on lâche dès que l'utilisateur fait défiler lui-même.
 */
export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  menu: string | null,
  slot = "main",
) {
  useIso(() => {
    const box = ref.current;
    if (!menu || !box) return;
    let m = read();
    if (m.menu !== menu) write((m = { menu, tops: {} }));
    const target = m.tops[slot] ?? 0;

    let restoring = target > 0;
    box.scrollTop = target;
    const settle = () => {
      if (!restoring) return;
      box.scrollTop = target;
      if (Math.abs(box.scrollTop - target) <= 1) stop();
    };
    const ro = new ResizeObserver(settle);
    const watch = () => Array.from(box.children).forEach((c) => ro.observe(c));
    const mo = new MutationObserver(() => {
      watch();
      settle();
    });
    const stop = () => {
      restoring = false;
      ro.disconnect();
      mo.disconnect();
    };
    if (restoring) {
      watch();
      mo.observe(box, { childList: true });
      settle();
    }
    const timer = setTimeout(stop, 2500);
    const byUser = () => stop();
    const onScroll = () => {
      if (restoring) return;
      const cur = read();
      if (cur.menu !== menu) return;
      write({ menu, tops: { ...cur.tops, [slot]: box.scrollTop } });
    };
    box.addEventListener("wheel", byUser, { passive: true });
    box.addEventListener("pointerdown", byUser);
    box.addEventListener("touchstart", byUser, { passive: true });
    box.addEventListener("keydown", byUser);
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stop();
      clearTimeout(timer);
      box.removeEventListener("wheel", byUser);
      box.removeEventListener("pointerdown", byUser);
      box.removeEventListener("touchstart", byUser);
      box.removeEventListener("keydown", byUser);
      box.removeEventListener("scroll", onScroll);
    };
  }, [ref, menu, slot]);
}
