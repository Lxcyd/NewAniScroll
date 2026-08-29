import { useState } from "react";
import dynamic from "next/dynamic";
import { FlagIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import type { AnimeReportContext } from "./ReportModal";
import { useMountedOnce } from "@/lib/hooks/useMountedOnce";

// This button sits in the navbar, so it is on every page — and the dialog
// behind it is a full report form (tabs, validation, upload) that most visits
// never open. Split out, and fetched on the first click.
const ReportModal = dynamic(() => import("./ReportModal"), { ssr: false });

/**
 * Universal report button.
 *
 *   - In the navbar (no `anime` prop): opens the modal on the
 *     generic "Site bug" tab; the "Anime bug" tab is greyed out
 *     because there's nothing to attach it to.
 *   - On an anime / watch page (pass `anime={{...}}`): opens
 *     directly on the "Anime bug" tab with the id + title (and
 *     episode, on the watch page) prefilled.
 *
 * Same flag icon everywhere so the affordance reads as one feature
 * regardless of context.
 */
type Props = {
  anime?: AnimeReportContext | null;
};

export default function ReportButton({ anime = null }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const everOpened = useMountedOnce(open);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={anime ? t("report.reportAnimeIssue") : t("report.reportBug")}
        aria-label={t("report.reportBug")}
        /* nav-chrome: recoloured when the navbar sits on light artwork
           (styles/globals.css + lib/color/navContrast). */
        className="nav-chrome flex-center w-9 h-9 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
      >
        <FlagIcon className="w-5 h-5" />
      </button>

      {everOpened && (
        <ReportModal isOpen={open} setIsOpen={setOpen} animeContext={anime} />
      )}
    </>
  );
}
