import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useTranslation } from "react-i18next";
import { useNotifications } from "@/lib/notifications/useNotifications";

/**
 * NavBar bell — in-app notifications (new episodes + resume reminders).
 * Computed client-side from the local list + AniList airing schedule; no push.
 * The dropdown closes on outside click / Escape, and opening it marks all
 * current notifications as read (clears the unread badge).
 */
export default function NotificationBell() {
  const { t } = useTranslation();
  const { notifications, unreadCount, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      // Opening clears the badge — the user has now seen them.
      if (next && unreadCount > 0) markAllRead();
      return next;
    });
  };

  const bodyFor = (n: (typeof notifications)[number]): string => {
    if (n.kind === "new-episode") {
      return (n.count ?? 1) > 1
        ? t("notifications.newEpisodes", { count: n.count, episode: n.episode })
        : t("notifications.newEpisode", { episode: n.episode });
    }
    if (n.kind === "next-season") {
      return t("notifications.nextSeasonBody");
    }
    return t("notifications.resumeBody", { days: n.days });
  };

  return (
    <div className="relative flex items-center" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-label={t("notifications.title")}
        title={t("notifications.title")}
        className="relative w-6 h-6 text-white/80 hover:text-white transition-colors"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
          <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-action text-[10px] font-bold leading-4 text-white text-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 w-80 max-h-[70vh] overflow-y-auto rounded-xl bg-secondary ring-1 ring-white/10 shadow-2xl z-50">
          <div className="px-4 py-3 border-b border-white/10 font-semibold text-sm">
            {t("notifications.title")}
          </div>
          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-white/50 text-sm">
              {t("notifications.empty")}
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {notifications.map((n) => (
                <li key={n.id}>
                  <Link
                    href={`/en/anime/${n.mediaId}`}
                    onClick={() => setOpen(false)}
                    className="flex gap-3 px-4 py-3 hover:bg-white/5 transition-colors"
                  >
                    {n.coverImage ? (
                      <Image
                        src={n.coverImage}
                        alt=""
                        width={40}
                        height={56}
                        className="w-10 h-14 object-cover rounded-md shrink-0 ring-1 ring-white/10"
                      />
                    ) : (
                      <div className="w-10 h-14 rounded-md bg-white/10 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium line-clamp-1">{n.title}</div>
                      <div className="text-xs text-white/60 mt-0.5 line-clamp-2">
                        {bodyFor(n)}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
