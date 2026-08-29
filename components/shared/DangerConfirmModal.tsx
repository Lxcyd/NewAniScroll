/**
 * The one confirmation dialog for irreversible actions.
 *
 * Replaces the four hand-rolled copies that had drifted apart (clear list,
 * clear history, restore defaults, and the three-way cloud chooser). One
 * shell, one behaviour: a warning, a cancel, and a HoldButton — so every
 * data-destroying action on the site asks in exactly the same way and the
 * gesture is learned once.
 *
 * `details` is for the consequence you want spelled out separately from the
 * prose: what exactly is going to be replaced or lost.
 */

import { useTranslation } from "react-i18next";
import HoldButton from "./HoldButton";

export default function DangerConfirmModal({
  open,
  title,
  body,
  details,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  children,
}: {
  open: boolean;
  title: string;
  body: string;
  details?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Anything the action needs before it can proceed — a password field. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-secondary ring-1 ring-white/10 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-white/70 text-sm">{body}</p>
        {details && (
          <p className="mt-3 rounded-lg bg-red-500/10 ring-1 ring-red-500/20 px-3 py-2 text-red-200/90 text-xs">
            {details}
          </p>
        )}

        {children && <div className="mt-4">{children}</div>}

        <div className="flex justify-end items-center gap-3 mt-6">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm hover:bg-white/15 disabled:opacity-50"
          >
            {t("settings.list.clearCancel")}
          </button>
          <HoldButton label={confirmLabel} onConfirm={onConfirm} disabled={busy} />
        </div>
      </div>
    </div>
  );
}
