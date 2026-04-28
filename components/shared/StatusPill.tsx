import { ReactNode } from "react";

// Maps AniList list statuses + our custom dropped/paused to AniScroll dot colors.
const STATUS = {
  CURRENT:   { label: "Watching",   color: "#10B981", bg: "bg-as-watching/15",   ring: "ring-as-watching/40",   text: "text-emerald-400" },
  WATCHING:  { label: "Watching",   color: "#10B981", bg: "bg-as-watching/15",   ring: "ring-as-watching/40",   text: "text-emerald-400" },
  REPEATING: { label: "Rewatching", color: "#06B6D4", bg: "bg-as-rewatching/15", ring: "ring-as-rewatching/40", text: "text-cyan-400"    },
  REWATCHING:{ label: "Rewatching", color: "#06B6D4", bg: "bg-as-rewatching/15", ring: "ring-as-rewatching/40", text: "text-cyan-400"    },
  COMPLETED: { label: "Completed",  color: "#3B82F6", bg: "bg-as-completed/15",  ring: "ring-as-completed/40",  text: "text-blue-400"    },
  PLANNING:  { label: "Planning",   color: "#A855F7", bg: "bg-as-planning/15",   ring: "ring-as-planning/40",   text: "text-purple-400"  },
  PLAN_TO_WATCH: { label: "Planning", color: "#A855F7", bg: "bg-as-planning/15", ring: "ring-as-planning/40", text: "text-purple-400"  },
  PAUSED:    { label: "Paused",     color: "#F59E0B", bg: "bg-as-paused/15",     ring: "ring-as-paused/40",     text: "text-amber-400"   },
  ON_HOLD:   { label: "Paused",     color: "#F59E0B", bg: "bg-as-paused/15",     ring: "ring-as-paused/40",     text: "text-amber-400"   },
  DROPPED:   { label: "Dropped",    color: "#EF4444", bg: "bg-as-dropped/15",    ring: "ring-as-dropped/40",    text: "text-red-400"     },
} as const;

type StatusKey = keyof typeof STATUS;

export default function StatusPill({
  status,
  label,
  size = "md",
  className = "",
  children,
}: {
  status: StatusKey | string | null | undefined;
  label?: string;
  size?: "sm" | "md";
  className?: string;
  children?: ReactNode;
}) {
  if (!status) return null;
  const key = String(status).toUpperCase() as StatusKey;
  const def = STATUS[key];
  if (!def) return null;

  const padding = size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill ${padding} font-karla font-semibold ring-1 ${def.bg} ${def.ring} ${def.text} ${className}`}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: def.color, boxShadow: `0 0 6px ${def.color}` }}
      />
      {label || def.label}
      {children}
    </span>
  );
}
