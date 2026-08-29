/**
 * Arbitration when the cloud backup and this device disagree.
 *
 * Only shown for the categories that moved on BOTH sides since the last pull
 * (lib/list/cloudSync.ts reports them); everything unambiguous has already
 * been applied by the time this appears. Three answers, and none of them is
 * silent:
 *
 *   - keepCloud  → the server copy replaces this device's;
 *   - keepDevice → this device's copy is pushed up;
 *   - merge      → keep the cloud copy for the disputed categories and push
 *                  everything else, which is the conservative reading of
 *                  "don't make me choose".
 *
 * Same shell as SyncDirectionModal.
 */

import { useTranslation } from "react-i18next";
import type { DataKind } from "@/lib/auth/userData";

export type MergeChoice = "keepCloud" | "keepDevice" | "merge";

export default function CloudMergeModal({
  open,
  conflicts,
  onChoose,
  onCancel,
  busy = false,
}: {
  open: boolean;
  conflicts: DataKind[];
  onChoose: (choice: MergeChoice) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const options: { key: MergeChoice; ring?: string }[] = [
    { key: "keepCloud" },
    { key: "keepDevice" },
    { key: "merge", ring: "hover:ring-white/20" },
  ];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-secondary ring-1 ring-white/10 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-1">{t("auth.merge.title")}</h3>
        <p className="text-white/60 text-sm mb-4">{t("auth.merge.body")}</p>

        {/* Naming the disputed categories is what makes the choice informed. */}
        <p className="text-white/40 text-xs mb-5">
          {t("auth.merge.affected")}{" "}
          {conflicts.map((kind) => t(`auth.merge.kind.${kind}`, kind)).join(", ")}
        </p>

        <div className="flex flex-col gap-3">
          {options.map(({ key, ring }) => (
            <button
              key={key}
              type="button"
              disabled={busy}
              onClick={() => onChoose(key)}
              className={`text-left rounded-lg bg-white/5 ring-1 ring-white/10 p-4 hover:bg-white/10 ${
                ring ?? "hover:ring-action/40"
              } transition disabled:opacity-50`}
            >
              <span className="block font-medium text-sm mb-0.5">
                {t(`auth.merge.${key}Title`)}
              </span>
              <span className="block text-white/60 text-xs">
                {t(`auth.merge.${key}Desc`)}
              </span>
            </button>
          ))}
        </div>

        <div className="flex justify-end mt-5">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm hover:bg-white/15 disabled:opacity-50"
          >
            {busy ? t("auth.working") : t("settings.sync.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
