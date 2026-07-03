/**
 * Sync-direction chooser.
 *
 * Shown once at the first AniList login (from _app.tsx) and whenever the user
 * re-enables sync from Settings. Replaces the old one-way "we'll overwrite your
 * local list" confirmation with an explicit choice of WHICH list wins the first
 * reconcile:
 *
 *   - "fromAniList" → AniList replaces the local list (hard override). The
 *      classic behaviour: this device becomes a mirror of the AniList account.
 *   - "toAniList"   → the local list is pushed up to AniList (add/overwrite),
 *      so the anime tracked on this site land on the AniList account. AniList
 *      entries not present locally are left untouched.
 *
 * The component is presentational: it renders the two choices + cancel and
 * hands the picked direction back to the caller, which owns the actual sync
 * calls (fullSyncFromAniList / fullSyncToAniList).
 */

import { useTranslation } from "react-i18next";

export type SyncDirection = "fromAniList" | "toAniList" | "off";

type Props = {
  open: boolean;
  onChoose: (direction: SyncDirection) => void;
  onCancel: () => void;
  /** Disable buttons while a sync is running. */
  busy?: boolean;
};

export default function SyncDirectionModal({
  open,
  onChoose,
  onCancel,
  busy = false,
}: Props) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-secondary ring-1 ring-white/10 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-1">
          {t("settings.sync.directionTitle")}
        </h3>
        <p className="text-white/60 text-sm mb-5">
          {t("settings.sync.directionBody")}
        </p>

        <div className="flex flex-col gap-3">
          {/* AniList → local (this device mirrors AniList) */}
          <button
            type="button"
            disabled={busy}
            onClick={() => onChoose("fromAniList")}
            className="text-left rounded-lg bg-white/5 ring-1 ring-white/10 p-4 hover:bg-white/10 hover:ring-action/40 transition disabled:opacity-50"
          >
            <div className="font-medium text-sm mb-0.5">
              {t("settings.sync.dirFromTitle")}
            </div>
            <div className="text-white/60 text-xs">
              {t("settings.sync.dirFromDesc")}
            </div>
          </button>

          {/* local → AniList (push this site's list up to AniList) */}
          <button
            type="button"
            disabled={busy}
            onClick={() => onChoose("toAniList")}
            className="text-left rounded-lg bg-white/5 ring-1 ring-white/10 p-4 hover:bg-white/10 hover:ring-action/40 transition disabled:opacity-50"
          >
            <div className="font-medium text-sm mb-0.5">
              {t("settings.sync.dirToTitle")}
            </div>
            <div className="text-white/60 text-xs">
              {t("settings.sync.dirToDesc")}
            </div>
          </button>

          {/* Don't sync — leave both lists as they are, sync stays off. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => onChoose("off")}
            className="text-left rounded-lg bg-white/5 ring-1 ring-white/10 p-4 hover:bg-white/10 hover:ring-white/20 transition disabled:opacity-50"
          >
            <div className="font-medium text-sm mb-0.5">
              {t("settings.sync.dirOffTitle")}
            </div>
            <div className="text-white/60 text-xs">
              {t("settings.sync.dirOffDesc")}
            </div>
          </button>
        </div>

        <div className="flex justify-end mt-5">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm hover:bg-white/15 disabled:opacity-50"
          >
            {busy ? t("settings.sync.syncing") : t("settings.sync.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
