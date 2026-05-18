import { useEffect, useRef, useState } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "../api/auth/[...nextauth]";
import Head from "next/head";
import Link from "next/link";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";

/**
 * /admin/fanarts-review — keyboard-first triage UI for fanart NSFW labels.
 *
 * Shows one image at a time among the IA-flagged set (suggestive | nsfw |
 * error-perm). The admin slams Space/Enter to confirm and move on, arrows
 * to navigate, or picks a precise label from the dropdown.
 *
 * Progress is appended-only (manual-* labels), so the back button is for
 * navigation only — it does NOT undo a previous decision.
 */

type Item = {
  id: number;
  animeId: number;
  title: string;
  type: string;
  url: string;
  label: string;
  nsfwScore: number | null;
  likes: number;
  language: string | null;
  season: number | null;
  isAdult: boolean;
  color: string | null;
};

type Counts = {
  suggestive: number;
  nsfw: number;
  errorPerm: number;
  reviewed: number;
};

export async function getServerSideProps(ctx: any) {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  if (!session) return { redirect: { destination: "/", permanent: false } };
  const isAdmin = session.user?.name === process.env.ADMIN_USERNAME;
  if (!isAdmin) return { redirect: { destination: "/", permanent: false } };
  return { props: {} };
}

const DECISIONS = [
  { value: "safe",        label: "Safe",        hint: "Faux positif" },
  { value: "suggestive",  label: "Suggestive",  hint: "Borderline confirmé" },
  { value: "nsfw",        label: "NSFW",        hint: "Vrai positif" },
  { value: "explicit",    label: "Explicit",    hint: "Très NSFW" },
  { value: "error",       label: "Error",       hint: "Image cassée / inutilisable" },
  { value: "reset",       label: "Reset (re-classify)", hint: "Renvoyer au classifier" },
];

type FilterMode = "all" | "suggestive" | "nsfw" | "error" | "reviewed";

export default function FanartsReview() {
  const [items, setItems] = useState<Item[]>([]);
  const [index, setIndex] = useState(0);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  // Keep last-seen id so we can paginate forward without reusing the cursor 0
  const lastIdRef = useRef<number | null>(null);
  const reviewedSession = useRef(0);

  const current = items[index] ?? null;

  // A monotonic id incremented every time the filter changes. Each in-flight
  // request remembers the id at the time it started; if the id has changed by
  // the time the response comes back, we discard it. Without this, switching
  // filters quickly would let stale results win the race and append to a
  // wiped list.
  const filterRequestIdRef = useRef(0);

  // Coalesce concurrent loadMore calls. Two effects can race for forward
  // pagination (auto-fetch effect + initial load), and they'd both fire with
  // the same cursor → the same items get appended twice. The Promise lock
  // keeps only one in-flight at a time per direction.
  const inFlightForwardRef = useRef<Promise<void> | null>(null);
  const inFlightBackwardRef = useRef<Promise<void> | null>(null);

  async function loadMore(
    direction: "forward" | "backward" = "forward",
    overrideFilter?: FilterMode,
    overrideCursor?: number | null,
  ) {
    const dirRef = direction === "forward" ? inFlightForwardRef : inFlightBackwardRef;
    if (dirRef.current) return dirRef.current;

    const promise = (async () => {
      setLoading(true);
      setError(null);
      const myRequestId = filterRequestIdRef.current;
      try {
        const activeFilter = overrideFilter ?? filter;
        const url = new URL("/api/v2/admin/fanarts-pending", window.location.origin);
        url.searchParams.set("limit", "60");
        url.searchParams.set("filter", activeFilter);
        // `null` (explicit) means "start over". `undefined` means "use ref".
        const cursor = overrideCursor !== undefined ? overrideCursor : lastIdRef.current;
        if (direction === "forward" && cursor != null) {
          url.searchParams.set("cursor", String(cursor));
        } else if (direction === "backward" && items[0]) {
          url.searchParams.set("before", String(items[0].id));
        }
        const r = await fetch(url.toString());
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();

        if (filterRequestIdRef.current !== myRequestId) return;

        if (data.items.length === 0) {
          if (direction === "forward") {
            setError("Plus de fanarts à reviewer 🎉");
          }
        } else if (direction === "forward") {
          // Dedupe against existing ids — protects against any race I haven't
          // anticipated. Cheap (~ms) for our list sizes.
          setItems((prev) => {
            const known = new Set(prev.map((p) => p.id));
            const fresh = data.items.filter((it: Item) => !known.has(it.id));
            if (fresh.length === 0) return prev;
            return [...prev, ...fresh];
          });
          lastIdRef.current = data.items[data.items.length - 1].id;
        } else {
          setItems((prev) => {
            const known = new Set(prev.map((p) => p.id));
            const fresh = data.items.filter((it: Item) => !known.has(it.id));
            if (fresh.length === 0) return prev;
            return [...fresh, ...prev];
          });
          setIndex((i) => i + data.items.length);
        }
        setCounts(data.counts);
      } catch (e: any) {
        if (filterRequestIdRef.current === myRequestId) setError(e.message);
      } finally {
        if (filterRequestIdRef.current === myRequestId) setLoading(false);
        dirRef.current = null;
      }
    })();

    dirRef.current = promise;
    return promise;
  }

  // Switching filter wipes the local list and starts over. We bump
  // filterRequestIdRef so any in-flight loadMore from the OLD filter knows to
  // discard its response when it finally arrives.
  function switchFilter(next: FilterMode) {
    if (next === filter) return;
    filterRequestIdRef.current += 1;
    setFilter(next);
    setItems([]);
    setIndex(0);
    lastIdRef.current = null;
    setError(null);
    // Pass cursor=null so we don't accidentally read a stale ref value.
    loadMore("forward", next, null);
  }

  // Initial load
  useEffect(() => {
    loadMore("forward");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fetch more pages when we're 8 items from the end. Wider window so
  // a fast reviewer never out-paces the cursor. We depend on `filter` too so
  // the captured `filter` in the loadMore closure is always the current one
  // — otherwise switching filters quickly leaves a stale closure that fetches
  // the previous filter's data.
  useEffect(() => {
    if (items.length === 0) return;
    if (index >= items.length - 8) {
      loadMore("forward");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, filter]);

  // Aggressive prefetch: keep an 8-image rolling window ahead of the cursor
  // (and 1 behind for the back arrow). Browser image cache handles it; we
  // hold the Image objects in a ref so GC doesn't drop them mid-fetch.
  const prefetchedRef = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    if (items.length === 0) return;
    const PREFETCH_AHEAD = 8;
    const PREFETCH_BEHIND = 1;
    const start = Math.max(0, index - PREFETCH_BEHIND);
    const end = Math.min(items.length - 1, index + PREFETCH_AHEAD);
    const live: HTMLImageElement[] = [];
    for (let i = start; i <= end; i++) {
      const img = new window.Image();
      img.decoding = "async";
      img.src = items[i].url;
      live.push(img);
    }
    prefetchedRef.current = live;
  }, [index, items]);

  /** Map a decision (or current label) to which counter bucket it lives in. */
  function bucketFor(label: string | null | undefined): keyof Counts | null {
    if (!label) return null;
    if (label === "suggestive" || label === "manual-suggestive") return "suggestive";
    if (label === "nsfw" || label === "manual-nsfw" || label === "manual-explicit") return "nsfw";
    if (label === "error-perm" || label === "manual-error") return "errorPerm";
    return null;
  }
  function bucketForDecision(decision: string): keyof Counts | null {
    if (decision === "suggestive") return "suggestive";
    if (decision === "nsfw" || decision === "explicit") return "nsfw";
    if (decision === "error") return "errorPerm";
    if (decision === "safe") return null;     // safe → out of "pending" buckets
    if (decision === "reset") return null;
    return null;
  }

  function applyDecision(decision: string, advance = true) {
    // Snapshot what we're operating on right now — by the time the POST
    // resolves the user will have moved on, so we can't rely on `current`.
    const target = current;
    if (!target) return;

    // === OPTIMISTIC UI: advance + update counters synchronously ===
    // The whole point: pressing Space/Enter must move to the next image
    // *immediately*, no network wait. The POST goes off in the background.
    reviewedSession.current += 1;

    const fromBucket = bucketFor(target.label);
    const toBucket = decision === "reset" ? null : bucketForDecision(decision);
    const wasManual = (target.label || "").startsWith("manual-");
    const becomesManual = decision !== "reset";
    setCounts((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      if (fromBucket && fromBucket !== toBucket) next[fromBucket] = Math.max(0, next[fromBucket] - 1);
      if (toBucket && fromBucket !== toBucket) next[toBucket] += 1;
      if (!wasManual && becomesManual) next.reviewed += 1;
      else if (wasManual && !becomesManual) next.reviewed = Math.max(0, next.reviewed - 1);
      return next;
    });

    const newLabel = decision === "reset" ? null : `manual-${decision}`;
    setItems((arr) => arr.map((it) => (it.id === target.id ? { ...it, label: newLabel as any } : it)));
    if (advance) setIndex((i) => i + 1);

    // === BACKGROUND PERSIST ===
    // Fire-and-forget. On error we surface the message and rewind the
    // optimistic counter changes for THIS item only — the user's position
    // in the queue is left alone (rewinding it would be confusing if they
    // already moved on a few images).
    fetch("/api/v2/admin/fanarts-flag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: target.id, decision }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${r.status}`);
        }
      })
      .catch((e: any) => {
        setError(`Save failed for #${target.id}: ${e.message}`);
        // Roll back the local label and counters so the badges reflect reality.
        setItems((arr) => arr.map((it) => (it.id === target.id ? { ...it, label: target.label } : it)));
        setCounts((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          if (toBucket && fromBucket !== toBucket) next[toBucket] = Math.max(0, next[toBucket] - 1);
          if (fromBucket && fromBucket !== toBucket) next[fromBucket] += 1;
          if (!wasManual && becomesManual) next.reviewed = Math.max(0, next.reviewed - 1);
          else if (wasManual && !becomesManual) next.reviewed += 1;
          return next;
        });
        reviewedSession.current = Math.max(0, reviewedSession.current - 1);
      });
  }

  // Keyboard handler — global for the page
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't hijack typing in inputs/selects
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === " ") {
        e.preventDefault();
        applyDecision("safe");
      } else if (e.key === "Enter") {
        e.preventDefault();
        applyDecision("nsfw");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((i) => Math.min(items.length - 1, i + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
        // If we hit the start, fetch backward
        if (index === 0) loadMore("backward");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, items.length, index]);

  const pending = counts ? counts.suggestive + counts.nsfw + counts.errorPerm : 0;

  return (
    <>
      <Head><title>Fanarts Review</title></Head>
      <main className="min-h-screen bg-secondary text-white p-4 md:p-8 flex flex-col">
        {/* Header / counters — badges are clickable filters */}
        <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
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
              <h1 className="text-2xl font-bold font-outfit">Fanarts Review</h1>
            </div>
            <Link
              href="/admin/fanarts-by-anime"
              className="px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 ring-1 ring-white/10 text-white/80 text-sm font-karla"
              title="Browse all fanarts of a specific anime"
            >
              Search by anime →
            </Link>
          </div>
          {counts && (
            <div className="flex flex-wrap gap-3 text-sm font-karla">
              <FilterBadge
                color="bg-white/5 text-white/80"
                active={filter === "all"}
                onClick={() => switchFilter("all")}
              >
                Tout {counts.suggestive + counts.nsfw + counts.errorPerm}
              </FilterBadge>
              <FilterBadge
                color="bg-yellow-700/40 text-yellow-200"
                active={filter === "suggestive"}
                onClick={() => switchFilter("suggestive")}
              >
                Suggestive {counts.suggestive}
              </FilterBadge>
              <FilterBadge
                color="bg-red-700/40 text-red-200"
                active={filter === "nsfw"}
                onClick={() => switchFilter("nsfw")}
              >
                NSFW {counts.nsfw}
              </FilterBadge>
              <FilterBadge
                color="bg-gray-700/40 text-gray-200"
                active={filter === "error"}
                onClick={() => switchFilter("error")}
              >
                Error {counts.errorPerm}
              </FilterBadge>
              <FilterBadge
                color="bg-emerald-700/40 text-emerald-200"
                active={filter === "reviewed"}
                onClick={() => switchFilter("reviewed")}
              >
                Reviewed {counts.reviewed}
              </FilterBadge>
              <span className="px-3 py-1 rounded-full bg-blue-700/40 text-blue-200">
                Session: {reviewedSession.current}
              </span>
            </div>
          )}
        </header>

        {error && (
          <div className="mb-4 p-3 rounded bg-red-700/30 text-red-100 text-sm font-karla">
            {error}
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-white/50">Chargement…</div>
        ) : !current ? (
          <div className="flex-1 flex items-center justify-center text-white/50">
            {pending === 0 ? "Aucun fanart en attente 🎉" : "Fin de la liste"}
          </div>
        ) : (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-6">
            {/* Image — checkerboard so transparent PNGs (logos / clearart)
                show their alpha rather than blending into a solid color. */}
            <div
              className="relative flex items-center justify-center rounded-xl overflow-hidden ring-1 ring-white/10 min-h-[400px]"
              style={{
                // 16×16 checkerboard generated with two linear-gradients.
                // Same trick Figma / Photoshop use for transparency.
                backgroundColor: "#5a5a5a",
                backgroundImage:
                  "linear-gradient(45deg, #404040 25%, transparent 25%, transparent 75%, #404040 75%, #404040), " +
                  "linear-gradient(45deg, #404040 25%, transparent 25%, transparent 75%, #404040 75%, #404040)",
                backgroundSize: "20px 20px",
                backgroundPosition: "0 0, 10px 10px",
              }}
            >
              <ReviewImage url={current.url} alt={current.title} />
            </div>

            {/* Side panel */}
            <aside className="bg-tersier/40 rounded-xl p-5 flex flex-col gap-4 ring-1 ring-white/5 font-karla text-sm">
              <div>
                <div className="text-xs uppercase text-white/40 mb-1">Anime</div>
                <div className="font-bold text-base">{current.title}</div>
                <div className="text-xs text-white/40 mt-1">
                  AniList ID {current.animeId} {current.isAdult && "· isAdult"}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <Field label="Type" value={current.type} />
                <Field label="Likes" value={String(current.likes)} />
                <Field
                  label="Score IA"
                  value={current.nsfwScore != null ? `${(current.nsfwScore * 100).toFixed(1)}%` : "—"}
                />
                <Field label="Label IA" value={current.label} />
                {current.season != null && <Field label="Season" value={String(current.season)} />}
                {current.language && <Field label="Lang" value={current.language} />}
              </div>

              <hr className="border-white/10" />

              <div>
                <div className="text-xs uppercase text-white/40 mb-2">Décision</div>
                <select
                  className="w-full rounded bg-black/40 border border-white/10 px-3 py-2 text-white"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) applyDecision(e.target.value);
                    e.target.value = "";
                  }}
                >
                  <option value="">— choisir… —</option>
                  {DECISIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label} — {d.hint}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <button
                    type="button"
                    onClick={() => applyDecision("safe")}
                    className="rounded bg-emerald-700/40 hover:bg-emerald-700/60 px-3 py-2 text-emerald-100"
                  >
                    Safe (Espace)
                  </button>
                  <button
                    type="button"
                    onClick={() => applyDecision("nsfw")}
                    className="rounded bg-red-700/40 hover:bg-red-700/60 px-3 py-2 text-red-100"
                  >
                    NSFW (Entrée)
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIndex((i) => Math.max(0, i - 1));
                      if (index === 0) loadMore("backward");
                    }}
                    className="rounded bg-white/5 hover:bg-white/10 px-3 py-2 text-white/80"
                  >
                    ← Précédent
                  </button>
                  <button
                    type="button"
                    onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
                    className="rounded bg-white/5 hover:bg-white/10 px-3 py-2 text-white/80"
                  >
                    Suivant →
                  </button>
                </div>
              </div>

              <div className="text-xs text-white/40 mt-auto">
                {(() => {
                  if (!counts) return `${index + 1}`;
                  const total =
                    filter === "all"        ? counts.suggestive + counts.nsfw + counts.errorPerm
                    : filter === "suggestive" ? counts.suggestive
                    : filter === "nsfw"     ? counts.nsfw
                    : filter === "error"    ? counts.errorPerm
                    : filter === "reviewed" ? counts.reviewed
                    : 0;
                  return `${index + 1} / ${total}`;
                })()}
              </div>
            </aside>
          </div>
        )}
      </main>
    </>
  );
}

/**
 * Two-layer image swap. Keeps the previously-loaded image visible while the
 * new one is being decoded so there's never an empty/flash frame, even on a
 * cold fetch. We use img.decode() (Promise) which resolves only once the
 * pixels are ready to paint — much faster than waiting for the load event.
 *
 * The component is keyed on `url`, so React preserves the DOM nodes between
 * renders — only the `src` of the active layer changes.
 */
function ReviewImage({ url, alt }: { url: string; alt: string }) {
  const [shown, setShown] = useState(url);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (url === shown) return;
    let cancelled = false;
    setPending(url);
    const img = new window.Image();
    img.decoding = "async";
    img.src = url;
    // decode() returns when the bitmap is ready; failover to a normal onload.
    const ready = img.decode ? img.decode() : new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("image error"));
    });
    ready
      .then(() => {
        if (!cancelled) {
          setShown(url);
          setPending(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Even on error, swap so the user sees the broken-image placeholder
          setShown(url);
          setPending(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, shown]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shown}
        alt={alt}
        className="max-h-[80vh] max-w-full object-contain"
        decoding="async"
        loading="eager"
      />
      {/* Tiny progress indicator overlay while the next image is being fetched */}
      {pending && (
        <div className="absolute top-3 right-3 bg-black/60 text-white/80 text-xs font-karla px-2 py-1 rounded backdrop-blur-sm">
          loading…
        </div>
      )}
    </>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return <span className={`px-3 py-1 rounded-full ${color}`}>{children}</span>;
}

function FilterBadge({
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
      className={`px-3 py-1 rounded-full transition-all ${color} ${
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-white/40">{label}</div>
      <div className="text-white/90 truncate">{value}</div>
    </div>
  );
}
