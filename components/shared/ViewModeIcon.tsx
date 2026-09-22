/** The three ways an episode list can be laid out — shared by the info page's
 *  Episodes tab and the watch page's sidebar. */
export type EpisodeView = "detailed" | "compact" | "grid";

/* The icon of the view you are currently IN: a picture for the thumbnail
   mode, rules for the one-line list, tiles for the grid of numbers. */
export default function ViewModeIcon({ view }: { view: EpisodeView }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
  } as const;
  if (view === "detailed") {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
        <path d="m4 18 5-5 4 4 3-3 4 4" />
      </svg>
    );
  }
  if (view === "compact") {
    return (
      <svg {...common}>
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
