import { useEffect, useRef, useState } from "react";
import { notify } from "@/lib/notifications/noticeStore";

/**
 * Per-anime metadata editor for the admin Metadata page.
 *
 * Workflow:
 *   1. Admin types a query → /api/v2/admin/search-anime returns matches
 *      via the Turso FTS index. Debounced 300ms.
 *   2. Admin clicks a result → "Scrape & upsert" hits AniList for fresh
 *      data and writes it back to Turso, replacing whatever was cached.
 *
 * For more invasive edits (overriding fields by hand), use the admin DB
 * console directly — building a per-field editor for every Tier-1 column
 * would be a lot of UI for a rarely-used flow.
 */
export default function MetadataEditor() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(null);
  const debRef = useRef(null);

  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    debRef.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await fetch(
          `/api/v2/admin/search-anime?q=${encodeURIComponent(q.trim())}&limit=20`
        );
        if (r.ok) {
          const data = await r.json();
          setResults(data.results || []);
        }
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => debRef.current && clearTimeout(debRef.current);
  }, [q]);

  const handleRefresh = async (id) => {
    setRefreshing(id);
    try {
      const r = await fetch("/api/v2/admin/scrape-anime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await r.json();
      if (r.ok) {
        notify.success(`Refreshed: ${data.anime?.title || id}`);
        // Re-run search so the row reflects the new data.
        setQ((cur) => cur);
      } else {
        notify.error(data.error || "Refresh failed");
      }
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <div className="bg-secondary rounded-md p-5">
      <h3 className="font-outfit font-semibold text-white mb-3">
        Metadata editor
      </h3>

      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search anime by title…"
        className="w-full mb-4 px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent"
      />

      {busy && <p className="text-sm text-white/40 font-karla">Searching…</p>}
      {!busy && q && results.length === 0 && (
        <p className="text-sm text-white/40 font-karla">No matches.</p>
      )}

      <div className="space-y-2 max-h-[480px] overflow-y-auto">
        {results.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-3 bg-primary/40 rounded p-2 font-karla"
          >
            {a.coverImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.coverImage}
                alt=""
                className="w-12 h-16 rounded object-cover"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold truncate">{a.title}</p>
              <p className="text-xs text-white/50 truncate">
                {a.english || `#${a.id}`} · {a.status || "—"} · pop {a.popularity ?? "—"} · score {a.averageScore ?? "—"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleRefresh(a.id)}
              disabled={refreshing === a.id}
              className="px-3 py-1.5 rounded-md bg-action text-white text-xs font-semibold hover:bg-action/90 disabled:opacity-40 shrink-0"
            >
              {refreshing === a.id ? "…" : "Refresh"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
