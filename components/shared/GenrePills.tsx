/**
 * Pink/red genre pills (AniScroll-style).
 * Can render as pills (default) or inline separated by bullets (compact).
 */
export default function GenrePills({
  genres,
  variant = "pills",
  max,
}: {
  genres?: string[];
  variant?: "pills" | "inline";
  max?: number;
}) {
  if (!genres?.length) return null;
  const list = max ? genres.slice(0, max) : genres;

  if (variant === "inline") {
    return (
      <div className="flex items-center gap-1.5 text-xs font-karla font-semibold text-as-accent lg:text-sm">
        {list.map((g, i) => (
          <span key={g} className="flex items-center gap-1.5">
            {i > 0 && <span className="opacity-50">•</span>}
            <span>{g}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((g) => (
        <span
          key={g}
          className="inline-flex items-center rounded-pill bg-as-accent/15 px-2.5 py-1 text-[11px] font-karla font-semibold text-as-accent ring-1 ring-as-accent/30"
        >
          {g}
        </span>
      ))}
    </div>
  );
}
