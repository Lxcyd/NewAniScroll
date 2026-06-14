import { useTranslation } from "react-i18next";
import { useStreak } from "@/lib/stats/streak";

/**
 * Compact watch-streak chip for the NavBar (visible app-wide, unlike the larger
 * badge on /my-list). Hidden at 0 so it's never noise; tooltip shows the best.
 */
export default function StreakChip() {
  const { t } = useTranslation();
  const { current, best } = useStreak();
  if (current <= 0) return null;
  return (
    <div
      className="flex items-center gap-1 rounded-full bg-white/5 ring-1 ring-white/10 px-2 py-1 shrink-0"
      title={t("myList.bestStreak", { count: best })}
      aria-label={t("myList.streakDays", { count: current })}
    >
      <span className="text-sm leading-none">🔥</span>
      <span className="text-sm font-bold leading-none">{current}</span>
    </div>
  );
}
