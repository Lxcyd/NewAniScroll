import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { toggleQueue, useIsQueued } from "@/lib/list/queue";
import type { LocalTitle } from "@/lib/list/localList";

/**
 * "Watch next" queue toggle for the anime info page. Self-contained: it reads /
 * writes the queue store directly (no prop plumbing through Hero/InfoPage), so
 * it can be dropped next to the favourite / share buttons.
 */
export default function QueueButton({
  mediaId,
  title,
  coverImage,
  size = 56,
}: {
  mediaId: number;
  title?: LocalTitle;
  coverImage?: string | null;
  /** Square button side in px (56 desktop, 44 mobile). */
  size?: number;
}) {
  const { t } = useTranslation();
  const queued = useIsQueued(mediaId);

  const onClick = () => {
    const nowQueued = toggleQueue({ mediaId, title, coverImage });
    toast.success(nowQueued ? t("queue.added") : t("queue.removed"));
  };

  return (
    <button
      onClick={onClick}
      aria-label={queued ? t("queue.remove") : t("queue.add")}
      title={queued ? t("queue.remove") : t("queue.add")}
      style={{
        flex: "0 0 auto",
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        borderRadius: 11,
        background: queued
          ? "color-mix(in srgb, var(--accent) 8%, transparent)"
          : "rgba(255,255,255,0.04)",
        border: queued
          ? "1px solid color-mix(in srgb, var(--accent) 30%, transparent)"
          : "1px solid var(--line-2)",
        color: queued ? "var(--accent)" : "var(--txt-1)",
        cursor: "pointer",
        transition: "background .25s ease, border-color .25s ease, color .25s ease",
      }}
    >
      {/* Material "playlist_add" / "playlist_add_check" */}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
        {queued ? (
          <path d="M2 14h8v-2H2v2zm0-4h12V8H2v2zm0-4h12V4H2v2zm14.59 11.59L13.76 14l-1.41 1.41L16.59 19 22 13.59 20.59 12l-4 5.59zM2 18h8v-2H2v2z" />
        ) : (
          <path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm19.5-4.5L23 13l-6.99 7-4.51-4.5L13 14l3.01 3 5.49-5.5z" />
        )}
      </svg>
    </button>
  );
}
