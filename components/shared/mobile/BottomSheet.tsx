import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Panneau qui monte du bas de l'ecran — la forme mobile d'un menu ou d'une
 * fenetre. Sert partout ou le PC ouvre un menu au survol ou une fenetre centree.
 *
 * - porte dans <body> : un `position: fixed` sous la barre du haut (qui a un
 *   `transform`) se calerait sur elle, pas sur l'ecran ;
 * - se ferme au fond, a Echap, et en tirant la poignee vers le bas ;
 * - bloque le defilement de la page derriere ;
 * - respecte la zone sure du bas (barre d'accueil de l'iPhone).
 */
type Props = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Hauteur maximale, en part de l'ecran (defaut 85 %). */
  maxHeight?: string;
};

export default function BottomSheet({ open, onClose, title, children, maxHeight = "85dvh" }: Props) {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [drag, setDrag] = useState(0);
  const startY = useRef<number | null>(null);

  // Monte, puis anime l'entree a l'image suivante ; a la fermeture, laisse
  // l'animation de sortie finir avant de demonter.
  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[10000]" role="dialog" aria-modal="true">
      <div
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        className="absolute left-0 right-0 bottom-0 flex flex-col rounded-t-2xl bg-[#17171f] text-white shadow-2xl ring-1 ring-white/10 transition-transform duration-200 ease-out"
        style={{
          maxHeight,
          paddingBottom: "env(safe-area-inset-bottom)",
          transform: shown ? `translateY(${drag}px)` : "translateY(100%)",
          transitionDuration: startY.current !== null ? "0ms" : undefined,
        }}
      >
        <div
          className="flex shrink-0 justify-center pt-2.5 pb-1.5 touch-none cursor-grab"
          onPointerDown={(e) => {
            startY.current = e.clientY;
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (startY.current !== null) setDrag(Math.max(0, e.clientY - startY.current));
          }}
          onPointerUp={() => {
            const d = drag;
            startY.current = null;
            setDrag(0);
            if (d > 80) onClose();
          }}
          onPointerCancel={() => {
            startY.current = null;
            setDrag(0);
          }}
        >
          <span className="h-1.5 w-10 rounded-full bg-white/25" />
        </div>
        {title && <div className="shrink-0 px-5 pb-2 pt-1 font-outfit text-lg font-semibold">{title}</div>}
        <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
