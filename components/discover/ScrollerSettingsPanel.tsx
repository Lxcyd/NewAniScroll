import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Status } from "@/lib/list/types";
import {
  SwipeSettings,
  SWIPE_STATUS_OPTIONS,
  STATUS_COLOR,
  STATUS_ICON,
  STATUS_LABEL_KEY,
} from "@/lib/discover/swipeSettings";
import styles from "./scroll.module.css";

type Props = {
  isVisible: boolean;
  current: SwipeSettings;
  onChange: (s: SwipeSettings) => void;
  onClose: () => void;
};

const X_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const EDIT_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

/** translucent hex helper: "#RRGGBB" + alpha-hex suffix */
const withAlpha = (hex: string, a: string) => `${hex}${a}`;

export default function ScrollerSettingsPanel({
  isVisible,
  current,
  onChange,
  onClose,
}: Props) {
  const { t } = useTranslation();
  // null = picker closed; otherwise which side is being edited.
  const [picking, setPicking] = useState<"right" | "left" | null>(null);

  if (!isVisible) return null;

  const statusLabel = (s: Status) => t(`discover.status.${STATUS_LABEL_KEY[s]}`);

  const Zone = ({ side }: { side: "right" | "left" }) => {
    const status = side === "right" ? current.rightStatus : current.leftStatus;
    const color = STATUS_COLOR[status];
    const isRight = side === "right";
    return (
      <div
        className={styles.swsetZone}
        style={{ ["--zc" as any]: color }}
      >
        <div
          className={`${styles.swsetZoneContent} ${isRight ? styles.swsetZoneContentR : ""}`}
        >
          <div
            className={`${styles.swsetZoneHint} ${isRight ? styles.swsetZoneHintR : ""}`}
            style={{ color, borderColor: withAlpha(color, "80") }}
          >
            {!isRight && (
              <span dangerouslySetInnerHTML={{ __html: STATUS_ICON[status] }} style={{ display: "inline-flex" }} />
            )}
            <span>{statusLabel(status)}</span>
            {isRight && (
              <span dangerouslySetInnerHTML={{ __html: STATUS_ICON[status] }} style={{ display: "inline-flex" }} />
            )}
          </div>
          <button
            type="button"
            className={styles.swsetZoneEdit}
            style={{ color, borderColor: withAlpha(color, "80") }}
            onClick={() => setPicking(side)}
          >
            {EDIT_ICON}
            {t("discover.edit")}
          </button>
        </div>
      </div>
    );
  };

  const leftColor = STATUS_COLOR[current.leftStatus];
  const rightColor = STATUS_COLOR[current.rightStatus];

  const pickColor =
    picking === "right" ? rightColor : picking === "left" ? leftColor : "#fff";

  const pick = (status: Status) => {
    if (picking === "right") onChange({ ...current, rightStatus: status });
    else if (picking === "left") onChange({ ...current, leftStatus: status });
    setPicking(null);
  };

  return (
    <div className={styles.swsetOverlay} onClick={onClose}>
      <div className={styles.swsetScreen} onClick={(e) => e.stopPropagation()}>
        {/* Top bar */}
        <div className={styles.swsetTopbar}>
          <div style={{ width: 36 }} />
          <div className={styles.swsetTopbarCenter}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className={styles.swsetTitle}>{t("discover.swipeSettings")}</span>
          </div>
          <button type="button" className={styles.swsetCloseBtn} onClick={onClose} aria-label={t("common.close")}>
            {X_ICON}
          </button>
        </div>

        {/* Preview section: left zone | skeleton card | right zone */}
        <div className={styles.swsetSectionBlock}>
          <div className={styles.swsetRow}>
            <div
              className={`${styles.swsetGradOverlay} ${styles.swsetGradLeft}`}
              style={{
                background: `linear-gradient(to right, color-mix(in srgb, ${leftColor} 42%, #08080f) 0%, color-mix(in srgb, ${leftColor} 22%, transparent) 38%, color-mix(in srgb, ${leftColor} 8%, transparent) 65%, transparent 100%)`,
              }}
            />
            <Zone side="left" />

            <div className={styles.swsetSkeleton}>
              <div className={styles.swsetSkImg}>
                <div className={styles.swsetSkPoster} />
              </div>
              <div className={styles.swsetSkInfo}>
                <div className={`${styles.swsetSkLine} ${styles.swsetSkTitle}`} style={{ width: "72%", animationDelay: ".05s" }} />
                <div className={`${styles.swsetSkLine} ${styles.swsetSkSeason}`} style={{ width: "34%", animationDelay: ".09s" }} />
                <div className={styles.swsetSkGenres} style={{ animationDelay: ".13s" }}>
                  <div className={styles.swsetSkGenre} style={{ width: 46 }} />
                  <div className={styles.swsetSkGenre} style={{ width: 38 }} />
                  <div className={styles.swsetSkGenre} style={{ width: 52 }} />
                </div>
                <div className={styles.swsetSkStats} style={{ animationDelay: ".17s" }}>
                  <div className={styles.swsetSkBadge} style={{ width: 44 }} />
                  <div className={styles.swsetSkBadge} style={{ width: 52 }} />
                </div>
                <div className={styles.swsetSkDescWrap}>
                  <div className={`${styles.swsetSkLine} ${styles.swsetSkDesc}`} style={{ width: "100%", animationDelay: ".21s" }} />
                  <div className={`${styles.swsetSkLine} ${styles.swsetSkDesc}`} style={{ width: "92%", animationDelay: ".24s" }} />
                  <div className={`${styles.swsetSkLine} ${styles.swsetSkDesc}`} style={{ width: "80%", animationDelay: ".27s" }} />
                </div>
                <div className={styles.swsetSkReadmore} style={{ animationDelay: ".31s" }} />
              </div>
            </div>

            <div
              className={`${styles.swsetGradOverlay} ${styles.swsetGradRight}`}
              style={{
                background: `linear-gradient(to left, color-mix(in srgb, ${rightColor} 42%, #08080f) 0%, color-mix(in srgb, ${rightColor} 22%, transparent) 38%, color-mix(in srgb, ${rightColor} 8%, transparent) 65%, transparent 100%)`,
              }}
            />
            <Zone side="right" />
          </div>
        </div>

        {/* Bottom-sheet status picker */}
        {picking && (
          <>
            <div className={styles.swsetPickerBackdrop} onClick={() => setPicking(null)} />
            <div className={styles.swsetPickerScreen} onClick={(e) => e.stopPropagation()}>
              <div className={styles.swsetPickerHeader}>
                <div
                  className={styles.swsetPickerDirectionBadge}
                  style={{
                    background: `color-mix(in srgb, ${pickColor} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${pickColor} 35%, transparent)`,
                    color: pickColor,
                  }}
                >
                  {picking === "right" ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round"><polyline points="9 18 15 12 9 6" /></svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round"><polyline points="15 18 9 12 15 6" /></svg>
                  )}
                  <span>{picking === "right" ? t("discover.swipeRight") : t("discover.swipeLeft")}</span>
                </div>
                <button type="button" className={styles.swsetCloseBtn} onClick={() => setPicking(null)} aria-label={t("common.close")}>
                  {X_ICON}
                </button>
              </div>

              <div className={styles.swsetPickerScroll}>
                <div className={styles.swsetPickerSectionLabel}>{t("discover.statusLists")}</div>
                <div className={styles.swsetPickerGrid}>
                  {SWIPE_STATUS_OPTIONS.map((status) => {
                    const color = STATUS_COLOR[status];
                    const selected =
                      picking === "right"
                        ? current.rightStatus === status
                        : current.leftStatus === status;
                    return (
                      <button
                        key={status}
                        type="button"
                        className={styles.swsetPickerItem}
                        style={
                          selected
                            ? {
                                borderColor: withAlpha(color, "55"),
                                background: `color-mix(in srgb, ${color} 14%, transparent)`,
                                color,
                                fontWeight: 700,
                              }
                            : undefined
                        }
                        onClick={() => pick(status)}
                      >
                        <span className={styles.swsetPickerDot} style={{ background: color, boxShadow: `0 0 5px ${withAlpha(color, "88")}` }} />
                        <span className={styles.swsetPickerName}>{statusLabel(status)}</span>
                        {selected && (
                          <svg className={styles.swsetPickerCheck} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
