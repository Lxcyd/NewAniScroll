import { useAniList } from "@/lib/anilist/useAnilist";
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import { upsertLocalEntry } from "@/lib/list/localList";
import { todayFuzzy } from "@/lib/list/types";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notifications/noticeStore";

type Props = {
  toggle: boolean;
  setToggle: (prev: any) => void;
  session: any;
};

/**
 * Rate-on-complete popup. Shown (centred) when an anime's last episode is
 * nearly over — see SkipOverlay's RATE_PROMPT_LEAD trigger. Scores on a 1-10
 * scale (POINT_10): we store that value straight into the local list and send
 * `scoreRaw = score * 10` to AniList (which uses a 100-point raw scale).
 */
export default function RateModal({ toggle, setToggle, session }: Props) {
  const { t, i18n } = useTranslation();
  const { markComplete } = useAniList(session);
  const { dataMedia } = useWatchProvider();

  // 0 = nothing picked yet. Hover state previews the star fill.
  const [score, setScore] = useState(0);
  const [hover, setHover] = useState(0);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const title =
    dataMedia?.title?.userPreferred ||
    dataMedia?.title?.english ||
    dataMedia?.title?.romaji ||
    "";

  function close() {
    setToggle((prev: any) => ({ ...prev, isOpen: false }));
    // Reset for a potential next anime in the same session.
    setScore(0);
    setHover(0);
    setNotes("");
  }

  async function submit() {
    const mediaId = dataMedia?.id;
    if (!score || mediaId == null) {
      close();
      return;
    }
    setBusy(true);
    try {
      // Local list = the resilient mirror; persist even for guests.
      upsertLocalEntry(Number(mediaId), {
        status: "COMPLETED",
        score, // POINT_10_DECIMAL
        notes: notes.trim() ? notes.trim() : null,
        completedAt: todayFuzzy(),
      });
      // Push to AniList when connected (no-op for guests). scoreRaw is /100.
      await markComplete(mediaId, { notes, scoreRaw: score * 10 });
      notify.success(t("rate.success"));
      close();
    } catch {
      notify.error(t("rate.error"));
    } finally {
      setBusy(false);
    }
  }

  const shown = hover || score;

  return (
    <div
      aria-hidden={!toggle}
      onClick={close}
      className={`fixed inset-0 z-[120] flex items-center justify-center px-4 transition-opacity duration-300 ${
        toggle ? "opacity-100" : "opacity-0 pointer-events-none"
      }`}
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-sm rounded-2xl bg-secondary ring-1 ring-white/10 shadow-2xl p-6 text-white font-karla transition-all duration-300 ${
          toggle ? "translate-y-0 scale-100" : "translate-y-4 scale-95"
        }`}
      >
        {dataMedia?.coverImage?.large && (
          <img
            src={dataMedia.coverImage.large}
            alt=""
            className="w-16 h-24 object-cover rounded-lg mx-auto mb-4 ring-1 ring-white/10"
          />
        )}
        <h3 className="text-xl font-semibold text-center">{t("rate.title")}</h3>
        {title && (
          <p className="text-white/60 text-sm text-center mt-1 line-clamp-2">{title}</p>
        )}

        {/* 0.5–10 star row. Each star is two half-width hit zones: the left
            half sets X.5, the right half sets X.0 — so a decimal score (8.5)
            is reachable with a click, matching AniList's POINT_10_DECIMAL. */}
        <div
          className="flex justify-center gap-1 mt-5"
          onMouseLeave={() => setHover(0)}
        >
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
            // Fill fraction of THIS star given the shown value: full, half, or empty.
            const fill = shown >= n ? 1 : shown >= n - 0.5 ? 0.5 : 0;
            return (
              <div key={n} className="relative w-6 h-6">
                {/* Empty base star */}
                <svg
                  viewBox="0 0 24 24"
                  className="absolute inset-0 w-6 h-6 text-white/20"
                  fill="currentColor"
                >
                  <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                </svg>
                {/* Accent overlay, clipped to the fill fraction (0 / 50% / 100%). */}
                {fill > 0 && (
                  <div
                    className="absolute inset-0 overflow-hidden"
                    style={{ width: `${fill * 100}%` }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="w-6 h-6 text-action"
                      fill="currentColor"
                    >
                      <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                    </svg>
                  </div>
                )}
                {/* Two half-width hit zones: left = n-0.5, right = n. */}
                <button
                  type="button"
                  aria-label={`${n - 0.5}/10`}
                  onMouseEnter={() => setHover(n - 0.5)}
                  onClick={() => setScore(n - 0.5)}
                  className="absolute inset-y-0 left-0 w-1/2 transition-transform hover:scale-110 focus:outline-none"
                />
                <button
                  type="button"
                  aria-label={`${n}/10`}
                  onMouseEnter={() => setHover(n)}
                  onClick={() => setScore(n)}
                  className="absolute inset-y-0 right-0 w-1/2 transition-transform hover:scale-110 focus:outline-none"
                />
              </div>
            );
          })}
        </div>
        <p className="text-center text-sm mt-2 h-5 text-white/70">
          {shown
            ? t("rate.scoreOutOf", {
                // Locale-format the decimal so FR shows "8,5/10", not "8.5/10".
                score: shown.toLocaleString(i18n.language, {
                  maximumFractionDigits: 1,
                }),
              })
            : t("rate.tapToRate")}
        </p>

        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("rate.notesPlaceholder")}
          className="mt-4 w-full bg-white/10 rounded-lg px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-action placeholder-white/40"
        />

        <div className="flex gap-3 mt-5">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="flex-1 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm font-medium hover:bg-white/15 disabled:opacity-40"
          >
            {t("rate.skip")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !score}
            className="flex-1 py-2 rounded-lg bg-action text-white text-sm font-medium hover:opacity-90 disabled:opacity-40"
          >
            {busy ? t("rate.saving") : t("rate.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
