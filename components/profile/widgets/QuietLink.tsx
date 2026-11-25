import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/router";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string };

/**
 * UN LIEN SANS ADRESSE EN BAS DE L'ÉCRAN (24/11/2026, Luc : « n'affiche pas
 * ça en bas »). Chrome montre l'URL de tout `<a href>` survolé ; les widgets du
 * profil en sont couverts. Ici le `<a>` n'a pas d'`href` : la navigation passe
 * par le routeur. Ce qu'un vrai lien sait faire est gardé — Ctrl/⌘/Maj-clic et
 * clic molette ouvrent un onglet, Entrée suit le lien, le survol précharge la
 * page. Même signature que `next/link` pour les usages des widgets.
 */
const QuietLink = forwardRef<HTMLAnchorElement, Props>(function QuietLink(
  { href, onClick, onAuxClick, onKeyDown, onPointerEnter, className, ...rest },
  ref,
) {
  const router = useRouter();
  const go = (newTab: boolean) => {
    if (newTab) window.open(href, "_blank", "noopener");
    else void router.push(href);
  };
  return (
    <a
      ref={ref}
      role="link"
      tabIndex={rest["aria-hidden"] ? -1 : 0}
      className={`cursor-pointer ${className ?? ""}`}
      {...rest}
      onPointerEnter={(e) => {
        onPointerEnter?.(e);
        void router.prefetch(href, undefined, { priority: true }).catch(() => {});
      }}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        go(e.ctrlKey || e.metaKey || e.shiftKey);
      }}
      onAuxClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onAuxClick?.(e);
        if (!e.defaultPrevented && e.button === 1) go(true);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => {
        onKeyDown?.(e);
        if (!e.defaultPrevented && e.key === "Enter") go(e.ctrlKey || e.metaKey);
      }}
    />
  );
});

export default QuietLink;
