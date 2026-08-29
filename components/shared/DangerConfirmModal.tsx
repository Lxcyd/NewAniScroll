/**
 * The one confirmation dialog for irreversible actions.
 *
 * Replaces the four hand-rolled copies that had drifted apart (clear list,
 * clear history, restore defaults, and the three-way cloud chooser). One
 * shell, one behaviour, so the gesture is learned once.
 *
 * **Only the two buttons dismiss it.** No backdrop click, no Escape: this
 * dialog is shown when something irreversible is about to happen, and a stray
 * click on the page must not count as an answer either way. Every other modal
 * on the site closes on the backdrop — that is right for them and wrong here.
 *
 * The confirm is a HoldButton, full width so the hold has a real target.
 */

import { useTranslation } from "react-i18next";
import HoldButton from "./HoldButton";

export default function DangerConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  confirmDisabled = false,
  children,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Blocks confirming while `children` is incomplete — cancel stays live. */
  confirmDisabled?: boolean;
  /** Anything the action needs before it can proceed — a password field. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
    >
      <div className="w-full max-w-sm rounded-xl bg-secondary ring-1 ring-white/10 p-6">
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-white/70 text-sm leading-relaxed">{body}</p>

        {children && <div className="mt-4">{children}</div>}

        {/* Confirm on top and full width — it is the target that has to be
            held. Cancel sits under it, quieter, and is a plain click. */}
        <div className="mt-6 flex flex-col gap-2">
          <HoldButton
            label={confirmLabel}
            onConfirm={onConfirm}
            disabled={busy || confirmDisabled}
          />
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="w-full px-4 py-2.5 rounded-lg text-sm text-white/70 hover:text-white hover:bg-white/5 disabled:opacity-50"
          >
            {t("settings.list.clearCancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
