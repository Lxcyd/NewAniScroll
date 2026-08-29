/**
 * Confirmation button you have to hold down.
 *
 * Used for every action on the site that destroys data the visitor cannot get
 * back — clearing the local list, the watch history, the settings, replacing
 * this device's data with the account's, deleting the account. A click is one
 * twitch away from an accident; holding for a second is a decision.
 *
 * Two things make the gesture forgiving, and both were mistakes in the first
 * version:
 *
 *   - **Pointer capture.** The button captures the pointer on press, so a
 *     finger or mouse that drifts a few pixels off the button keeps holding
 *     instead of silently cancelling. Only lifting cancels. Without this, a
 *     small target is nearly impossible to hold on a phone.
 *   - **A large target.** It renders full-width in a dialog rather than as a
 *     small button in a corner.
 *
 * The remaining time is shown twice — a filling bar and a live countdown —
 * because a bar alone doesn't say "keep going".
 *
 * Keyboard: Space or Enter held down does the same. `onKeyDown` repeats while
 * a key is held, hence the `repeat` guard: without it every repeat would
 * restart the timer and the action would never fire.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export default function HoldButton({
  onConfirm,
  label,
  holdMs = 1000,
  disabled = false,
  className = "",
}: {
  onConfirm: () => void;
  /** Idle caption. While held, the progress hint replaces it. */
  label: string;
  holdMs?: number;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [holding, setHolding] = useState(false);
  /** 0 → 1, for the countdown text. The bar animates in CSS, not from this. */
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number>(0);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    cancelAnimationFrame(frame.current);
    setHolding(false);
    setProgress(0);
  }, []);

  const start = useCallback(
    (e?: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled || timer.current) return;

      // Keep receiving events even if the pointer drifts off the button.
      if (e) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* not all pointer types support capture — the hold still works */
        }
      }

      setHolding(true);
      const started = performance.now();
      const tick = () => {
        const done = Math.min((performance.now() - started) / holdMs, 1);
        setProgress(done);
        if (done < 1) frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);

      timer.current = setTimeout(() => {
        timer.current = null;
        cancelAnimationFrame(frame.current);
        setHolding(false);
        setProgress(0);
        onConfirm();
      }, holdMs);
    },
    [disabled, holdMs, onConfirm]
  );

  useEffect(() => () => cancel(), [cancel]);

  const remaining = Math.max(0, Math.ceil((holdMs * (1 - progress)) / 100) / 10);

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if (e.repeat) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={cancel}
      onBlur={cancel}
      className={`relative w-full overflow-hidden select-none touch-none rounded-lg px-4 py-3 text-sm font-semibold text-white transition-transform ${
        holding ? "scale-[0.99] bg-red-600" : "bg-red-500/90 hover:bg-red-500"
      } disabled:opacity-50 ${className}`}
    >
      {/* The fill is a plain width transition on the same clock as the
          timeout, so what you see is exactly what will happen. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-white/30"
        style={{
          width: holding ? "100%" : "0%",
          transitionProperty: "width",
          transitionDuration: holding ? `${holdMs}ms` : "180ms",
          transitionTimingFunction: "linear",
        }}
      />
      <span className="relative flex items-center justify-center gap-2">
        {holding ? (
          <>
            {t("common.holdToConfirm")}
            <span className="tabular-nums opacity-80">{remaining.toFixed(1)}s</span>
          </>
        ) : (
          label
        )}
      </span>
    </button>
  );
}
