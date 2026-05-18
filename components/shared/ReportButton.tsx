import { useState } from "react";
import { FlagIcon } from "@heroicons/react/24/outline";
import BugReportForm from "./bugReport";

/**
 * Report button in the navbar. Uses the same flag icon as the in-player
 * "report" button (pages/en/anime/watch/[...info].js) for consistency.
 */
export default function ReportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Report a bug"
        aria-label="Report a bug"
        className="flex-center w-9 h-9 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
      >
        <FlagIcon className="w-5 h-5" />
      </button>

      <BugReportForm isOpen={open} setIsOpen={setOpen} />
    </>
  );
}
