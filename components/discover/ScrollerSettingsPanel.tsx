import { useTranslation } from "react-i18next";
import { XMarkIcon } from "@heroicons/react/24/solid";
import type { Status } from "@/lib/list/types";
import {
  SwipeSettings,
  SWIPE_STATUS_OPTIONS,
  STATUS_COLOR,
  STATUS_ICON,
  STATUS_LABEL_KEY,
} from "@/lib/discover/swipeSettings";

type Props = {
  isVisible: boolean;
  current: SwipeSettings;
  onChange: (s: SwipeSettings) => void;
  onClose: () => void;
};

/** Status picker row — a horizontal scroll of selectable status chips. */
function StatusRow({
  selected,
  onPick,
}: {
  selected: Status;
  onPick: (s: Status) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      {SWIPE_STATUS_OPTIONS.map((status) => {
        const active = status === selected;
        const color = STATUS_COLOR[status];
        return (
          <button
            key={status}
            type="button"
            onClick={() => onPick(status)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-karla font-bold uppercase tracking-wide transition-all"
            style={{
              color: active ? "#fff" : color,
              background: active ? color : "rgba(255,255,255,0.06)",
              border: `1.5px solid ${active ? color : "rgba(255,255,255,0.12)"}`,
            }}
          >
            <span
              dangerouslySetInnerHTML={{ __html: STATUS_ICON[status] }}
              style={{ display: "inline-flex" }}
            />
            {t(`discover.status.${STATUS_LABEL_KEY[status]}`)}
          </button>
        );
      })}
    </div>
  );
}

export default function ScrollerSettingsPanel({
  isVisible,
  current,
  onChange,
  onClose,
}: Props) {
  const { t } = useTranslation();
  if (!isVisible) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-card bg-as-card p-5 ring-1 ring-white/10 sm:rounded-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-outfit text-lg font-extrabold text-white">
            {t("discover.swipeSettings")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
            aria-label={t("common.close")}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-5 font-karla text-xs text-white/50">
          {t("discover.swipeSettingsHint")}
        </p>

        <div className="mb-5">
          <div className="mb-2 font-karla text-sm font-bold text-white/80">
            {t("discover.swipeRight")}
          </div>
          <StatusRow
            selected={current.rightStatus}
            onPick={(rightStatus) => onChange({ ...current, rightStatus })}
          />
        </div>

        <div>
          <div className="mb-2 font-karla text-sm font-bold text-white/80">
            {t("discover.swipeLeft")}
          </div>
          <StatusRow
            selected={current.leftStatus}
            onPick={(leftStatus) => onChange({ ...current, leftStatus })}
          />
        </div>
      </div>
    </div>
  );
}
