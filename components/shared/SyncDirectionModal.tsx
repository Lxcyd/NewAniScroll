/**
 * Sync-direction chooser.
 *
 * Shown once at the first AniList login (from _app.tsx) and whenever the user
 * re-enables sync from Settings. Replaces the old one-way "we'll overwrite your
 * local list" confirmation with an explicit choice of how the two lists should
 * reconcile:
 *
 *   - "fromAniList" → AniList replaces the local list (hard override). This
 *      device becomes a mirror of the AniList account. Icon: AniList logo.
 *   - "toAniList"   → merge both lists, AniScroll winning any conflict, and push
 *      the result up to AniList. Icon: AniScroll logo.
 *   - "off"         → don't sync; both lists are left untouched. Icon: sync.
 *
 * The component is presentational: it renders the three choices and hands the
 * picked direction back to the caller, which owns the actual sync calls
 * (fullSyncFromAniList / fullSyncToAniList).
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

/** AniList "A" mark (same artwork as components/media/aniList.js), sized for a
 *  button icon slot. */
function AniListIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 41 30" fill="none" aria-hidden>
      <g clipPath="url(#sdm_clip)">
        <path
          fill="#00A8FF"
          d="M27.825 21.773V2.977c0-1.077-.613-1.672-1.725-1.672h-3.795c-1.111 0-1.725.595-1.725 1.672v8.927c0 .251 2.5 1.418 2.565 1.665 1.904 7.21.414 12.982-1.392 13.251 2.952.142 3.277 1.517 1.078.578.337-3.848 1.65-3.84 5.422-.142.032.032.774 1.539.82 1.539h8.91c1.113 0 1.726-.594 1.726-1.672v-3.677c0-1.078-.614-1.672-1.725-1.672H27.825z"
        />
        <path
          fill="#fff"
          d="M12.07 1.306l-9.966 27.49h7.743l1.687-4.756h8.433l1.649 4.755h7.705l-9.929-27.49H12.07zm1.227 16.642l2.415-7.615 2.645 7.615h-5.06z"
        />
      </g>
      <defs>
        <clipPath id="sdm_clip">
          <path fill="#fff" d="M0 0H40V29H0z" transform="translate(.957 .5)" />
        </clipPath>
      </defs>
    </svg>
  );
}

/** Material "sync" glyph. */
function SyncIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
    </svg>
  );
}

function OptionButton({
  icon,
  title,
  desc,
  onClick,
  disabled,
  hoverRing = "hover:ring-action/40",
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
  hoverRing?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-3.5 text-left rounded-lg bg-white/5 ring-1 ring-white/10 p-4 hover:bg-white/10 ${hoverRing} transition disabled:opacity-50`}
    >
      <span className="flex-none grid place-items-center w-10 h-10 rounded-lg bg-white/5 ring-1 ring-white/10 text-white/80">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-sm mb-0.5">{title}</span>
        <span className="block text-white/60 text-xs">{desc}</span>
      </span>
    </button>
  );
}

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
          {/* AniList → local: this device mirrors AniList. */}
          <OptionButton
            icon={<AniListIcon />}
            title={t("settings.sync.dirFromTitle")}
            desc={t("settings.sync.dirFromDesc")}
            onClick={() => onChoose("fromAniList")}
            disabled={busy}
          />

          {/* merge, AniScroll wins conflicts, then push up. */}
          <OptionButton
            icon={
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src="/logo.png"
                alt=""
                width={26}
                height={26}
                className="rounded"
              />
            }
            title={t("settings.sync.dirToTitle")}
            desc={t("settings.sync.dirToDesc")}
            onClick={() => onChoose("toAniList")}
            disabled={busy}
          />

          {/* Don't sync — leave both lists as they are, sync stays off. */}
          <OptionButton
            icon={<SyncIcon />}
            title={t("settings.sync.dirOffTitle")}
            desc={t("settings.sync.dirOffDesc")}
            onClick={() => onChoose("off")}
            disabled={busy}
            hoverRing="hover:ring-white/20"
          />
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
