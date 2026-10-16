import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MdVolumeOff, MdVolumeUp } from "react-icons/md";

/**
 * Le volume des aperçus au survol (TrailerStage), en composant : une icône
 * seule, qui coupe et rétablit au clic ; au survol, un rail vertical pour
 * régler le niveau. Tirer jusqu'en bas coupe, remonter rétablit — comme sur
 * l'aperçu. Repris tel quel pour la musique du profil, son fond vidéo et le
 * lecteur du studio (16/10/2026) : un seul geste de volume sur tout le site.
 *
 * Le rail s'ouvre dans un PORTAIL, en position fixe : dans la barre du studio
 * (bord arrondi, `overflow-hidden`, couches translatées), un enfant absolu
 * était rogné au premier pixel qui dépassait.
 */
type Props = {
  muted: boolean;
  /** 0 à 1. */
  volume: number;
  onMuted: (next: boolean) => void;
  onVolume: (v: number) => void;
  /** Où s'ouvre le rail : sous l'icône (en haut d'écran) ou au-dessus. */
  placement?: "down" | "up";
  /** Rétablir à zéro remonte à ce niveau, comme l'aperçu. */
  fallback?: number;
  size?: number;
  label?: string;
  className?: string;
};

export default function HoverVolume({
  muted,
  volume,
  onMuted,
  onVolume,
  placement = "down",
  fallback = 0.15,
  size = 21,
  label,
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = muted ? 0 : volume;

  const openIt = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeIt = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 260);
  };
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  /* Le rail suit l'icône, y compris pendant qu'elle glisse avec sa barre. */
  useLayoutEffect(() => {
    if (!open) return;
    let raf = 0;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setPos((p) => {
        const x = r.left + r.width / 2;
        const y = placement === "down" ? r.bottom : r.top;
        return p && p.x === x && p.y === y ? p : { x, y };
      });
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [open, placement]);

  const apply = (raw: number) => {
    const v = Math.min(1, Math.max(0, raw));
    onVolume(v);
    if (v === 0 && !muted) onMuted(true);
    if (v > 0 && muted) onMuted(false);
  };
  const fromEvent = (e: React.PointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    if (r) apply(1 - (e.clientY - r.top) / r.height);
  };

  const rail =
    open && pos && typeof document !== "undefined"
      ? createPortal(
          <div
            onPointerEnter={openIt}
            onPointerLeave={closeIt}
            className="as-preview-voltrack fixed z-[10050] flex justify-center px-1.5 py-2"
            style={{
              left: pos.x,
              top: pos.y,
              transform: placement === "down" ? "translate(-50%, 6px)" : "translate(-50%, calc(-100% - 6px))",
            }}
          >
            <div
              ref={track}
              role="slider"
              aria-label={label ?? "Volume"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(shown * 100)}
              tabIndex={0}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                fromEvent(e);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) fromEvent(e);
              }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 0.2 : 0.05;
                if (e.key === "ArrowUp" || e.key === "ArrowRight") apply(shown + step);
                else if (e.key === "ArrowDown" || e.key === "ArrowLeft") apply(shown - step);
                else return;
                e.preventDefault();
              }}
              className="relative h-20 w-[5px] cursor-pointer touch-none rounded-full bg-white/25"
            >
              <div
                className="absolute bottom-0 left-0 w-full rounded-full"
                style={{ height: `${shown * 100}%`, background: "var(--brand-primary, #ff3b5c)" }}
              />
              <div
                className="pointer-events-none absolute left-1/2 h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full bg-white"
                style={{ bottom: `${shown * 100}%`, boxShadow: "0 1px 4px rgba(0,0,0,.6)" }}
              />
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`flex shrink-0 items-center ${className}`} onPointerEnter={openIt} onPointerLeave={closeIt}>
      <button
        ref={btn}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const next = !muted;
          onMuted(next);
          if (!next && volume <= 0) onVolume(fallback);
        }}
        aria-label={label ?? (muted ? "Unmute" : "Mute")}
        title={label}
        className="as-preview-videobtn h-7 w-7"
      >
        {muted ? <MdVolumeOff size={size} /> : <MdVolumeUp size={size} />}
      </button>
      {rail}
    </div>
  );
}
