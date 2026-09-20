import { ComponentType, useEffect, useState } from "react";

/*
 * Un composant dont le code vit dans son propre chunk, et qu'on peut precharger.
 *
 * Pourquoi pas `next/dynamic` : le composant qu'il renvoie est enveloppe dans un
 * `forwardRef` qui n'expose pas `.preload()`, et meme un chunk deja telecharge
 * passe par un rendu `loading` (une image vide) avant le vrai contenu. Ici, une
 * fois `preload()` resolu, le premier rendu est DIRECTEMENT le composant : un
 * onglet precharge s'affiche exactement comme s'il avait ete importe en dur.
 *
 * A reserver aux composants jamais rendus au SSR (sinon le serveur rendrait
 * `null` a leur place).
 */
export function lazyWithPreload<P extends object>(
  loader: () => Promise<{ default: ComponentType<P> }>,
) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;

  const preload = (): Promise<ComponentType<P>> => {
    if (loaded) return Promise.resolve(loaded);
    if (!pending) {
      pending = loader().then(
        (m) => (loaded = m.default),
        (err) => {
          pending = null; // un chunk rate (reseau) doit pouvoir etre retente
          throw err;
        },
      );
    }
    return pending;
  };

  function Lazy(props: P) {
    const [Comp, setComp] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (Comp) return;
      let alive = true;
      preload().then(
        (c) => alive && setComp(() => c),
        () => {},
      );
      return () => {
        alive = false;
      };
    }, [Comp]);
    return Comp ? <Comp {...props} /> : null;
  }

  return Object.assign(Lazy, { preload });
}

/* Precharge au repos, apres le premier rendu : le visiteur ne paie rien sur le
   chemin critique, et le clic sur un onglet trouve deja son code. */
export function preloadWhenIdle(...preloads: Array<() => Promise<unknown>>) {
  if (typeof window === "undefined") return () => {};
  const run = () => preloads.forEach((p) => p().catch(() => {}));
  const w = window as any;
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(run, { timeout: 4000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}
