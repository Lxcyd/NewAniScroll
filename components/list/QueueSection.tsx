import Link from "next/link";
import Image from "next/image";
import { useTranslation } from "react-i18next";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useQueue, moveInQueue, removeFromQueue } from "@/lib/list/queue";

/**
 * "Watch next" queue list — the manual, ordered queue rendered on both the local
 * My List page and the (owner's) AniList profile page. Client-only (reads
 * localStorage), renders nothing when the queue is empty.
 */
export default function QueueSection() {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const queue = useQueue();
  if (queue.length === 0) return null;

  return (
    <section className="mb-10">
      <h2 className="flex items-center gap-2 font-bold text-lg mb-3">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-action">
          <path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm19.5-4.5L23 13l-6.99 7-4.51-4.5L13 14l3.01 3 5.49-5.5z" />
        </svg>
        {t("queue.title")}
      </h2>
      <div className="overflow-hidden rounded-lg bg-white/[0.03] ring-1 ring-white/5">
        {queue.map((q, i) => (
          <div
            key={q.mediaId}
            className="flex items-center gap-3 px-3 py-2 hover:bg-action/5 transition-colors"
          >
            <span className="text-xs text-white/40 w-5 text-center shrink-0">
              {i + 1}
            </span>
            <Link
              href={`/en/anime/${q.mediaId}`}
              className="flex items-center gap-3 flex-1 min-w-0"
            >
              {q.coverImage ? (
                <Image
                  src={q.coverImage}
                  alt=""
                  width={40}
                  height={40}
                  className="w-10 h-10 rounded-md object-cover shrink-0"
                />
              ) : (
                <div className="w-10 h-10 rounded-md bg-white/10 shrink-0" />
              )}
              <span className="flex-1 min-w-0 text-sm font-medium truncate">
                {pickTitle(q.title, titlePref)}
              </span>
            </Link>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => moveInQueue(q.mediaId, -1)}
                disabled={i === 0}
                aria-label={t("queue.moveUp")}
                className="p-1.5 rounded hover:bg-white/10 disabled:opacity-25"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </button>
              <button
                onClick={() => moveInQueue(q.mediaId, 1)}
                disabled={i === queue.length - 1}
                aria-label={t("queue.moveDown")}
                className="p-1.5 rounded hover:bg-white/10 disabled:opacity-25"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <button
                onClick={() => removeFromQueue(q.mediaId)}
                aria-label={t("queue.remove")}
                className="p-1.5 rounded hover:bg-white/10 text-white/50 hover:text-white"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
