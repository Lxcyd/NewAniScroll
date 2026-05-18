import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "../api/auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import Head from "next/head";
import Link from "next/link";
import { ArrowLeftIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";

/**
 * /admin/fanarts-by-anime — browse every fanart of a single anime and
 * reclassify any of them by clicking. Complements /admin/fanarts-review,
 * which is keyboard-first triage across the whole DB. This page is
 * targeted exploration: "show me everything for Solo Leveling and let me
 * fix the bad calls."
 *
 * Flow:
 *   1. Type in the search box → hits /api/v2/admin/search-anime (FTS).
 *   2. Pick a result → loads /api/v2/admin/fanarts-by-anime?anime=ID.
 *   3. Click any tile → reclassify menu pops next to it (same labels as
 *      the review page) → POSTs /api/v2/admin/fanarts-flag.
 *
 * Reclassification is optimistic: the tile's label updates immediately,
 * then we persist in the background. On failure we roll the label back
 * and surface an error toast.
 */

export async function getServerSideProps(ctx: any) {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  if (!isAdminSession(session)) {
    return { redirect: { destination: "/", permanent: false } };
  }
  return { props: {} };
}

type SearchResult = {
  id: number;
  title: string;
  english: string | null;
  coverImage: string | null;
  status: string | null;
  popularity: number | null;
  averageScore: number | null;
};

type FanartItem = {
  id: number;
  animeId: number;
  type: string;
  url: string;
  language: string | null;
  likes: number;
  season: number | null;
  label: string | null;
  nsfwScore: number | null;
  scores: {
    drawing: number | null;
    hentai: number | null;
    neutral: number | null;
    porn: number | null;
    sexy: number | null;
  };
  classifiedAt: number | null;
};

type ByAnimePayload = {
  animeId: number;
  title: string | null;
  cover: string | null;
  banner: string | null;
  counts: {
    total: number;
    safe: number;
    suggestive: number;
    nsfw: number;
    error: number;
    unclassified: number;
    manual: number;
  };
  items: FanartItem[];
};

const DECISIONS = [
  { value: "safe",       label: "Safe",       color: "bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-100" },
  { value: "suggestive", label: "Suggestive", color: "bg-yellow-700/40 hover:bg-yellow-700/60 text-yellow-100" },
  { value: "nsfw",       label: "NSFW",       color: "bg-red-700/40 hover:bg-red-700/60 text-red-100" },
  { value: "explicit",   label: "Explicit",   color: "bg-red-900/60 hover:bg-red-900/80 text-red-100" },
  { value: "error",      label: "Error",      color: "bg-gray-700/40 hover:bg-gray-700/60 text-gray-100" },
  { value: "reset",      label: "Reset",      color: "bg-blue-700/40 hover:bg-blue-700/60 text-blue-100" },
];

type LabelFilter =
  | "all"
  | "safe"
  | "suggestive"
  | "nsfw"
  | "error"
  | "unclassified"
  | "manual";
type TypeFilter = "all" | string;

export default function FanartsByAnimePage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [data, setData] = useState<ByAnimePayload | null>(null);
  const [loadingFanarts, setLoadingFanarts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelFilter, setLabelFilter] = useState<LabelFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [lightbox, setLightbox] = useState<FanartItem | null>(null);

  // Debounce the search input so we don't hit the FTS endpoint on every
  // keystroke. 250ms is short enough that typing "solo leveling" feels
  // instant but skips the network on each letter.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/v2/admin/search-anime?q=${encodeURIComponent(q)}&limit=12`
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        setResults(j.results || []);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query]);

  const loadFanarts = useCallback(async (animeId: number) => {
    setLoadingFanarts(true);
    setError(null);
    setData(null);
    try {
      const r = await fetch(`/api/v2/admin/fanarts-by-anime?anime=${animeId}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as ByAnimePayload;
      setData(j);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingFanarts(false);
    }
  }, []);

  function pickAnime(a: SearchResult) {
    setSelected(a);
    setResults([]);
    setQuery(a.title);
    setLabelFilter("all");
    setTypeFilter("all");
    loadFanarts(a.id);
  }

  function clearSelection() {
    setSelected(null);
    setData(null);
    setQuery("");
    setResults([]);
  }

  /** Reclassify a fanart. URL-level update — all rows sharing the URL get
   *  the same label, matching how /api/v2/admin/fanarts-flag fans out. */
  const applyDecision = useCallback(
    async (item: FanartItem, decision: string) => {
      if (!data) return;
      const prevLabel = item.label;
      const newLabel = decision === "reset" ? null : `manual-${decision}`;

      // Optimistic — update every row sharing the same URL.
      setData((d) =>
        d
          ? {
              ...d,
              items: d.items.map((it) =>
                it.url === item.url ? { ...it, label: newLabel } : it
              ),
              counts: recomputeCounts(
                d.items.map((it) =>
                  it.url === item.url ? { ...it, label: newLabel } : it
                )
              ),
            }
          : d
      );

      try {
        const r = await fetch("/api/v2/admin/fanarts-flag", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, decision }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
      } catch (e: any) {
        // Roll back the label on every row sharing the URL.
        setError(`Save failed for #${item.id}: ${e.message}`);
        setData((d) =>
          d
            ? {
                ...d,
                items: d.items.map((it) =>
                  it.url === item.url ? { ...it, label: prevLabel } : it
                ),
                counts: recomputeCounts(
                  d.items.map((it) =>
                    it.url === item.url ? { ...it, label: prevLabel } : it
                  )
                ),
              }
            : d
        );
      }
    },
    [data]
  );

  /** Types present in the loaded set — used to build the type filter chips. */
  const presentTypes = useMemo(() => {
    if (!data) return [];
    const s = new Set<string>();
    for (const it of data.items) s.add(it.type);
    return Array.from(s).sort();
  }, [data]);

  /** Apply both filters in memory. The full payload is in `data.items`;
   *  filtering is cheap enough to redo on every render. */
  const visibleItems = useMemo(() => {
    if (!data) return [];
    return data.items.filter((it) => {
      if (typeFilter !== "all" && it.type !== typeFilter) return false;
      if (labelFilter === "all") return true;
      const l = it.label;
      switch (labelFilter) {
        case "safe":
          return l === "safe" || l === "safe-skipped" || l === "manual-safe";
        case "suggestive":
          return l === "suggestive" || l === "manual-suggestive";
        case "nsfw":
          return (
            l === "nsfw" ||
            l === "manual-nsfw" ||
            l === "manual-explicit"
          );
        case "error":
          return l === "error-perm" || l === "manual-error";
        case "unclassified":
          return l == null;
        case "manual":
          return typeof l === "string" && l.startsWith("manual-");
        default:
          return true;
      }
    });
  }, [data, labelFilter, typeFilter]);

  // Close lightbox on Escape.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  return (
    <>
      <Head>
        <title>Fanarts by anime</title>
      </Head>
      <main className="min-h-screen bg-secondary text-white p-4 md:p-8 flex flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link
              href="/admin"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 ring-1 ring-white/10 hover:ring-white/30 text-white/80 text-sm font-karla transition-all"
              title="Retour au panel admin"
            >
              <ArrowLeftIcon className="w-4 h-4" />
              Admin
            </Link>
            <div>
              <h1 className="text-2xl font-bold font-outfit">Fanarts by anime</h1>
              <p className="text-xs text-white/50 font-karla mt-0.5">
                Recherche un anime et reclasse n&apos;importe quel fanart en
                cliquant dessus.
              </p>
            </div>
          </div>
          <Link
            href="/admin/fanarts-review"
            className="px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 ring-1 ring-white/10 text-white/80 text-sm font-karla"
          >
            Review queue →
          </Link>
        </header>

        {/* Search bar + result dropdown. The dropdown anchors below the
            input and disappears once an anime is selected. */}
        <section className="relative max-w-2xl w-full">
          <div className="relative">
            <MagnifyingGlassIcon className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              placeholder="Search an anime by name…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (selected) setSelected(null);
              }}
              className="w-full pl-10 pr-10 py-2.5 bg-black/40 border border-white/10 rounded-lg text-white placeholder:text-white/30 focus:outline-none focus:border-action/60 font-karla"
            />
            {(query || selected) && (
              <button
                type="button"
                onClick={clearSelection}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white text-sm"
                aria-label="Clear"
              >
                ✕
              </button>
            )}
          </div>
          {!selected && query.trim() && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-tersier/95 backdrop-blur-md border border-white/10 rounded-lg shadow-xl max-h-[60vh] overflow-y-auto z-20">
              {searching && (
                <div className="p-3 text-sm text-white/50 font-karla">
                  Searching…
                </div>
              )}
              {!searching && results.length === 0 && (
                <div className="p-3 text-sm text-white/50 font-karla">
                  No results.
                </div>
              )}
              {results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => pickAnime(r)}
                  className="w-full flex items-center gap-3 p-2.5 hover:bg-white/5 text-left transition-colors"
                >
                  <div className="w-10 h-14 bg-black/40 rounded overflow-hidden flex-shrink-0">
                    {r.coverImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.coverImage}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm font-karla truncate">
                      {r.title}
                    </div>
                    {r.english && r.english !== r.title && (
                      <div className="text-xs text-white/50 truncate">
                        {r.english}
                      </div>
                    )}
                    <div className="text-[10px] text-white/40 mt-0.5">
                      ID {r.id}
                      {r.status ? ` · ${r.status}` : ""}
                      {r.averageScore ? ` · ${r.averageScore}` : ""}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {error && (
          <div className="p-3 rounded bg-red-700/30 text-red-100 text-sm font-karla">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-3 underline opacity-70 hover:opacity-100"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Loading state once an anime is picked */}
        {loadingFanarts && (
          <div className="text-white/50 font-karla text-sm">
            Loading fanarts…
          </div>
        )}

        {/* Main panel — only renders once we have a payload */}
        {data && (
          <section className="flex flex-col gap-4">
            {/* Anime header card */}
            <div className="relative rounded-xl overflow-hidden ring-1 ring-white/10">
              {data.banner ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={data.banner}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover opacity-30"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/30 to-rose-900/30" />
              )}
              <div className="relative flex items-center gap-4 p-4 bg-black/40 backdrop-blur-sm">
                {data.cover && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={data.cover}
                    alt=""
                    className="w-16 h-24 object-cover rounded ring-1 ring-white/10"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs uppercase text-white/40 mb-0.5">
                    AniList {data.animeId}
                  </div>
                  <div className="text-xl font-bold font-outfit truncate">
                    {data.title || `Anime #${data.animeId}`}
                  </div>
                  <div className="text-xs text-white/60 mt-1 font-karla">
                    {data.counts.total} fanarts ·{" "}
                    <span className="text-emerald-300">{data.counts.safe} safe</span>{" "}
                    ·{" "}
                    <span className="text-yellow-300">
                      {data.counts.suggestive} suggestive
                    </span>{" "}
                    · <span className="text-red-300">{data.counts.nsfw} nsfw</span>{" "}
                    · <span className="text-gray-300">{data.counts.error} error</span>{" "}
                    ·{" "}
                    <span className="text-white/50">
                      {data.counts.unclassified} unclassified
                    </span>{" "}
                    ·{" "}
                    <span className="text-blue-300">
                      {data.counts.manual} manual
                    </span>
                  </div>
                </div>
                <Link
                  href={`/en/anime/${data.animeId}`}
                  target="_blank"
                  className="px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 ring-1 ring-white/10 text-white/80 text-xs font-karla whitespace-nowrap"
                >
                  Open page ↗
                </Link>
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-[10px] uppercase text-white/40 font-karla mr-1">
                Label
              </span>
              {(
                [
                  ["all", `All ${data.counts.total}`, "bg-white/5 text-white/80"],
                  ["safe", `Safe ${data.counts.safe}`, "bg-emerald-700/40 text-emerald-200"],
                  ["suggestive", `Suggestive ${data.counts.suggestive}`, "bg-yellow-700/40 text-yellow-200"],
                  ["nsfw", `NSFW ${data.counts.nsfw}`, "bg-red-700/40 text-red-200"],
                  ["error", `Error ${data.counts.error}`, "bg-gray-700/40 text-gray-200"],
                  ["unclassified", `Unclassified ${data.counts.unclassified}`, "bg-white/10 text-white/70"],
                  ["manual", `Manual ${data.counts.manual}`, "bg-blue-700/40 text-blue-200"],
                ] as Array<[LabelFilter, string, string]>
              ).map(([id, label, color]) => (
                <FilterChip
                  key={id}
                  color={color}
                  active={labelFilter === id}
                  onClick={() => setLabelFilter(id)}
                >
                  {label}
                </FilterChip>
              ))}
            </div>

            {presentTypes.length > 1 && (
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-[10px] uppercase text-white/40 font-karla mr-1">
                  Type
                </span>
                <FilterChip
                  color="bg-white/5 text-white/80"
                  active={typeFilter === "all"}
                  onClick={() => setTypeFilter("all")}
                >
                  All
                </FilterChip>
                {presentTypes.map((t) => (
                  <FilterChip
                    key={t}
                    color="bg-white/5 text-white/80"
                    active={typeFilter === t}
                    onClick={() => setTypeFilter(t)}
                  >
                    {t} ({data.items.filter((i) => i.type === t).length})
                  </FilterChip>
                ))}
              </div>
            )}

            {/* Grid of fanart tiles */}
            {visibleItems.length === 0 ? (
              <div className="text-white/40 text-sm font-karla">
                No fanart matches the current filters.
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                {visibleItems.map((it) => (
                  <FanartTile
                    key={it.id}
                    item={it}
                    onDecision={(d) => applyDecision(it, d)}
                    onOpen={() => setLightbox(it)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* Lightbox */}
        {lightbox && (
          <div
            onClick={() => setLightbox(null)}
            className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
            role="dialog"
            aria-modal="true"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.url}
              alt=""
              className="max-w-[95vw] max-h-[92vh] object-contain rounded shadow-2xl"
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox(null);
              }}
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 ring-1 ring-white/20 text-white"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        )}
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tiles                                                              */
/* ------------------------------------------------------------------ */

function FanartTile({
  item,
  onDecision,
  onOpen,
}: {
  item: FanartItem;
  onDecision: (decision: string) => void;
  onOpen: () => void;
}) {
  const isManual = !!item.label?.startsWith("manual-");
  const labelTone = labelStyle(item.label);

  return (
    <div className="group relative flex flex-col bg-tersier/40 rounded-lg overflow-hidden ring-1 ring-white/5 hover:ring-white/20 transition">
      {/* Image. Transparent fanarts (logos/clearart) get a checkerboard
          backdrop so we can see the alpha channel without surprises. */}
      <button
        type="button"
        onClick={onOpen}
        className="relative block w-full h-44 cursor-zoom-in"
        style={{
          backgroundColor: "#5a5a5a",
          backgroundImage:
            "linear-gradient(45deg, #404040 25%, transparent 25%, transparent 75%, #404040 75%, #404040), " +
            "linear-gradient(45deg, #404040 25%, transparent 25%, transparent 75%, #404040 75%, #404040)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 8px 8px",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.url}
          alt=""
          className="absolute inset-0 w-full h-full object-contain"
          loading="lazy"
          decoding="async"
        />
        <span
          className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-bold tracking-wide uppercase ${labelTone}`}
        >
          {item.label || "unclassified"}
          {isManual && <span className="ml-1 opacity-70">(manual)</span>}
        </span>
        <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-black/60 text-white/80">
          {item.type}
        </span>
      </button>

      {/* Meta */}
      <div className="p-2.5 flex flex-col gap-2">
        <div className="flex items-center justify-between text-[11px] text-white/50 font-karla">
          <span>♥ {item.likes}</span>
          <span>{item.language || "—"}</span>
          {item.nsfwScore != null && (
            <span title="NSFW score (max of porn/sexy/hentai)">
              {(item.nsfwScore * 100).toFixed(0)}%
            </span>
          )}
        </div>
        {/* Decision row — tight one-click buttons. Reset is icon-only to
            keep the row scannable. */}
        <div className="grid grid-cols-3 gap-1">
          {DECISIONS.filter((d) => d.value !== "reset").map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => onDecision(d.value)}
              className={`text-[10.5px] font-bold py-1 rounded transition ${d.color}`}
              title={d.label}
            >
              {d.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onDecision("reset")}
          className="text-[10px] py-1 rounded bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/90"
          title="Clear the label and re-queue for the classifier"
        >
          ↻ Reset / Re-classify
        </button>
      </div>
    </div>
  );
}

function FilterChip({
  color,
  active,
  onClick,
  children,
}: {
  color: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-karla transition-all ${color} ${
        active
          ? "ring-2 ring-white/80 shadow-[0_0_12px_rgba(255,255,255,0.25)]"
          : "hover:ring-1 hover:ring-white/40"
      }`}
    >
      {active && <span className="mr-1">●</span>}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function labelStyle(label: string | null): string {
  if (!label) return "bg-white/15 text-white/90";
  if (label === "safe" || label === "safe-skipped" || label === "manual-safe")
    return "bg-emerald-700/70 text-emerald-50";
  if (label === "suggestive" || label === "manual-suggestive")
    return "bg-yellow-700/70 text-yellow-50";
  if (label === "nsfw" || label === "manual-nsfw" || label === "manual-explicit")
    return "bg-red-700/80 text-red-50";
  if (label === "error-perm" || label === "manual-error")
    return "bg-gray-700/70 text-gray-100";
  return "bg-white/15 text-white/90";
}

/** Rebuild the counts from the items array. We keep this client-side so
 *  optimistic updates show their effect on the badges immediately. */
function recomputeCounts(items: FanartItem[]): ByAnimePayload["counts"] {
  const c = {
    total: items.length,
    safe: 0,
    suggestive: 0,
    nsfw: 0,
    error: 0,
    unclassified: 0,
    manual: 0,
  };
  for (const it of items) {
    if (!it.label) c.unclassified += 1;
    else if (it.label.startsWith("manual-")) c.manual += 1;
    if (it.label === "safe" || it.label === "safe-skipped" || it.label === "manual-safe")
      c.safe += 1;
    else if (it.label === "suggestive" || it.label === "manual-suggestive")
      c.suggestive += 1;
    else if (it.label === "nsfw" || it.label === "manual-nsfw" || it.label === "manual-explicit")
      c.nsfw += 1;
    else if (it.label === "error-perm" || it.label === "manual-error")
      c.error += 1;
  }
  return c;
}
