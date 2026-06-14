import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getQueue } from "@/lib/list/queue";
import { getLocalList } from "@/lib/list/localList";

/**
 * "Surprise me" — picks a random anime to watch next. Prefers the manual queue
 * (those are the user's deliberate picks); falls back to PLANNING entries. Pure
 * client-side: reads the queue + local list from localStorage and navigates.
 */
export default function SurpriseButton() {
  const { t } = useTranslation();
  const router = useRouter();

  const pick = () => {
    // Candidate pool: queued ids first, then Planning entries.
    const queue = getQueue().map((q) => q.mediaId);
    const planning = Object.values(getLocalList())
      .filter((e) => e.status === "PLANNING")
      .map((e) => e.mediaId);
    // De-dupe, keeping queue priority but still allowing planning to fill in.
    const pool = Array.from(new Set([...queue, ...planning]));
    if (pool.length === 0) {
      toast.error(t("surprise.empty"));
      return;
    }
    const id = pool[Math.floor(Math.random() * pool.length)];
    router.push(`/en/anime/${id}`);
  };

  return (
    <button
      type="button"
      onClick={pick}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-action/10 ring-1 ring-action/40 text-action text-sm font-medium hover:bg-action/20 transition-colors"
    >
      {/* Material "casino" (dice) icon */}
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM7.5 18C6.67 18 6 17.33 6 16.5S6.67 15 7.5 15s1.5.67 1.5 1.5S8.33 18 7.5 18zm0-9C6.67 9 6 8.33 6 7.5S6.67 6 7.5 6 9 6.67 9 7.5 8.33 9 7.5 9zm4.5 4.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5 4.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm0-9c-.83 0-1.5-.67-1.5-1.5S15.67 6 16.5 6 18 6.67 18 7.5 17.33 9 16.5 9z" />
      </svg>
      {t("surprise.button")}
    </button>
  );
}
