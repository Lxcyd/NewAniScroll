/**
 * Confirmation button you have to hold down.
 *
 * Used for every action on the site that destroys data the visitor cannot get
 * back — clearing the local list, the watch history, the settings, replacing
 * this device's data with the account's, deleting the account. A click is one
 * twitch away from an accident; holding for a second is a decision, and the
 * filling bar tells you it is happening before it happens.
 *
 * Releasing early cancels: nothing fires until the bar is full.
 *
 * Keyboard: Space or Enter held down does the same thing, so the affordance
 * isn't mouse-only. `onKeyDown` repeats while a key is held, hence the
 * `repeat` guard — without it every repeat would restart the timer and the
 * action would never fire.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export default function HoldButton({
  onConfirm,
  label,
  holdMs = 1200,
  disabled = false,
  className = "",
}: {
  onConfirm: () => void;
  /** Idle caption. While held, the "hold to confirm" hint replaces it. */
  label: string;
  holdMs?: number;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onConfirm();
    }, holdMs);
  }, [disabled, holdMs, onConfirm]);

  // A pointer released outside the button never fires pointerup on it, so the
  // timer would keep running after the user let go somewhere else.
  useEffect(() => {
    if (!holding) return;
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [holding, cancel]);

  useEffect(() => () => cancel(), [cancel]);

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerLeave={cancel}
      onKeyDown={(e) => {
        if (e.repeat) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={cancel}
      onBlur={cancel}
      className={`relative overflow-hidden select-none touch-none px-4 py-2 rounded-lg bg-red-500/90 text-white text-sm font-medium hover:bg-red-500 disabled:opacity-50 ${className}`}
    >
      {/* The fill is a plain width transition: it starts at 0, is told to go
          to 100% over holdMs, and snaps back fast when the hold is cancelled.
          Same clock as the timeout, so what you see is what will happen. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-white/25"
        style={{
          width: holding ? "100%" : "0%",
          transitionProperty: "width",
          transitionDuration: holding ? `${holdMs}ms` : "150ms",
          transitionTimingFunction: "linear",
        }}
      />
      <span className="relative">{holding ? t("common.holdToConfirm") : label}</span>
    </button>
  );
}
