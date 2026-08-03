import { useEffect, useState } from "react";
import Link from "next/link";
import { notify } from "@/lib/notifications/noticeStore";

/**
 * Dedicated Reports admin page. Same data as the dashboard's report card,
 * with more room and richer filtering: severity, status (open / all),
 * search by title/description, and a manual refresh trigger.
 */
export default function AdminReports() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState("All");
  const [kind, setKind] = useState("All"); // All | Site | Anime
  const [search, setSearch] = useState("");
  // Status filter — both Open and Pending live in the unresolved list (the
  // GET endpoint already filters resolved_at IS NULL); we just split them
  // visually so the admin can focus on either bucket.
  const [status, setStatus] = useState("All"); // All | Open | Pending

  const fetchReports = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/v2/admin/bug-report", { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        setReports(data.reports || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
    const t = setInterval(fetchReports, 20_000);
    return () => clearInterval(t);
  }, []);

  const handleResolved = async (id) => {
    try {
      const r = await fetch("/api/v2/admin/bug-report", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: id }),
      });
      const data = await r.json();
      if (r.status === 200) {
        notify.success(data.message);
        setReports((cur) => cur.filter((r) => r.id !== id));
      } else {
        notify.error("Failed");
      }
    } catch {
      notify.error("Failed");
    }
  };

  // Optimistic toggle: flip the pending_at on the local row immediately so
  // the badge changes feel instant. Roll back if the server rejects it.
  const handleTogglePending = async (id, nextPending) => {
    const now = Math.floor(Date.now() / 1000);
    setReports((cur) =>
      cur.map((r) =>
        r.id === id ? { ...r, pending_at: nextPending ? now : null } : r,
      ),
    );
    try {
      const r = await fetch("/api/v2/admin/bug-report", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: id, pending: nextPending }),
      });
      const data = await r.json();
      if (r.status !== 200) throw new Error(data?.error || "Failed");
      notify.success(data.message);
    } catch (e) {
      // Roll back on failure.
      setReports((cur) =>
        cur.map((r) =>
          r.id === id ? { ...r, pending_at: nextPending ? null : now } : r,
        ),
      );
      notify.error(e.message || "Failed");
    }
  };

  // Filter + sort the list. Critical first.
  const sevRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  // Kind is encoded by the report submitter: the title is prefixed
  // with `[SITE]` for site bugs and `[ANIME] <title> · EP N` for
  // anime bugs (severity is "anime" for the latter). Either signal
  // identifies the report kind.
  const kindOf = (r) => {
    if (r.severity === "anime") return "Anime";
    const t = (r.title || "").trim();
    if (t.startsWith("[ANIME]")) return "Anime";
    if (t.startsWith("[SITE]")) return "Site";
    return "Site"; // legacy reports without a prefix default to Site
  };
  const statusOf = (r) => (r.pending_at ? "Pending" : "Open");
  const filtered = reports
    .filter((r) => (severity === "All" ? true : r.severity === severity))
    .filter((r) => (kind === "All" ? true : kindOf(r) === kind))
    .filter((r) => (status === "All" ? true : statusOf(r) === status))
    .filter((r) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        (r.title || "").toLowerCase().includes(q) ||
        (r.desc || "").toLowerCase().includes(q) ||
        (r.reporter || "").toLowerCase().includes(q)
      );
    })
    // Open reports float above Pending ones (Pending is "I think this is
    // done" → lower urgency). Inside each bucket, sort by severity rank so
    // Critical still leads.
    .sort((a, b) => {
      const aPending = a.pending_at ? 1 : 0;
      const bPending = b.pending_at ? 1 : 0;
      if (aPending !== bPending) return aPending - bPending;
      return (sevRank[a.severity] ?? 99) - (sevRank[b.severity] ?? 99);
    });

  return (
    <div className="px-6 py-8 space-y-5">
      <div className="flex flex-col gap-1">
        <h1 className="font-outfit text-2xl font-bold text-white">
          Bug reports
        </h1>
        <p className="font-karla text-sm text-white/50">
          {loading
            ? "Loading…"
            : `${filtered.length} of ${reports.length} unresolved`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, description, reporter…"
          className="flex-1 min-w-[200px] bg-as-surface text-white ring-1 ring-white/10 rounded px-3 py-2 outline-none focus:ring-as-accent font-karla text-sm"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="bg-as-surface text-white/85 ring-1 ring-white/10 rounded px-3 py-2 text-sm font-karla outline-none focus:ring-as-accent"
          title="Report kind"
        >
          {["All", "Site", "Anime"].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="bg-as-surface text-white/85 ring-1 ring-white/10 rounded px-3 py-2 text-sm font-karla outline-none focus:ring-as-accent"
          title="Status"
        >
          {["All", "Open", "Pending"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="bg-as-surface text-white/85 ring-1 ring-white/10 rounded px-3 py-2 text-sm font-karla outline-none focus:ring-as-accent"
        >
          {["All", "Critical", "High", "Medium", "Low"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={fetchReports}
          className="px-3 py-2 rounded bg-action text-white text-sm font-semibold hover:bg-action/90"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {filtered.length === 0 && !loading && (
          <div className="bg-secondary rounded-md p-6 text-center text-white/40 font-karla">
            No reports.
          </div>
        )}
        {filtered.map((r) => (
          <ReportRow
            key={r.id}
            report={r}
            onResolve={handleResolved}
            onTogglePending={handleTogglePending}
          />
        ))}
      </div>
    </div>
  );
}

function ReportRow({ report, onResolve, onTogglePending }) {
  const isPending = !!report.pending_at;
  return (
    <div
      className={`bg-secondary rounded-md p-4 ring-1 transition-colors ${
        isPending ? "ring-amber-500/30 opacity-80" : "ring-white/5"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <SeverityBadge severity={report.severity} />
            {isPending && <PendingBadge ts={Number(report.pending_at)} />}
            <Link
              href={report.url || "#"}
              className="text-white font-outfit font-semibold hover:text-action break-words"
            >
              {report.title || "(untitled)"}
            </Link>
          </div>
          {report.desc && (
            <p className="text-sm text-white/80 font-karla whitespace-pre-wrap break-words">
              {report.desc}
            </p>
          )}
          <p className="text-[11px] text-white/40 font-karla mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {report.reporter && <span>{report.reporter}</span>}
            {report.reporter_ip && (
              <span className="font-mono">{report.reporter_ip}</span>
            )}
            {report.created_at && (
              <span>
                {new Date(Number(report.created_at) * 1000).toLocaleString()}
              </span>
            )}
            {report.url && (
              <Link
                href={report.url}
                className="text-action hover:underline truncate max-w-[200px]"
              >
                {report.url.replace(/^https?:\/\//, "")}
              </Link>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onTogglePending(report.id, !isPending)}
            title={
              isPending
                ? "Move back to Open — the fix didn't hold"
                : "Mark as Pending — fix shipped, awaiting verification"
            }
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              isPending
                ? "bg-amber-500/30 text-amber-200 hover:bg-amber-500/40"
                : "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
            }`}
          >
            {isPending ? "Un-pending" : "Pending"}
          </button>
          <button
            type="button"
            onClick={() => onResolve(report.id)}
            className="px-3 py-1.5 rounded-md bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 text-xs font-semibold"
          >
            Resolve
          </button>
        </div>
      </div>

      {Array.isArray(report.images) && report.images.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {report.images.map((src, i) => (
            <button
              type="button"
              key={i}
              onClick={() => openImageInNewTab(src)}
              className="block w-20 h-20"
              title="Open full size"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt=""
                className="w-full h-full rounded object-cover ring-1 ring-white/10 hover:ring-action transition-all"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PendingBadge({ ts }) {
  // Surface how long the report has been pending so the admin can spot
  // ones that have aged out without ever being confirmed/resolved.
  const ageH = ts ? Math.floor((Date.now() / 1000 - ts) / 3600) : null;
  const label =
    ageH == null
      ? "PENDING"
      : ageH < 1
      ? "PENDING · <1h"
      : ageH < 24
      ? `PENDING · ${ageH}h`
      : `PENDING · ${Math.floor(ageH / 24)}d`;
  return (
    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-bold font-karla bg-amber-500/20 text-amber-300">
      {label}
    </span>
  );
}

function SeverityBadge({ severity }) {
  const styles = {
    Critical: "bg-red-700 text-white",
    High: "bg-rose-500/20 text-rose-300",
    Medium: "bg-amber-500/20 text-amber-300",
    Low: "bg-emerald-500/20 text-emerald-300",
  };
  return (
    <span
      className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-bold font-karla ${styles[severity] || "bg-white/10 text-white/70"}`}
    >
      {severity || "—"}
    </span>
  );
}

function openImageInNewTab(dataUrl) {
  try {
    const [meta, b64] = dataUrl.split(",");
    if (!b64) return;
    const mime = (meta.match(/data:([^;]+);base64/) || [])[1] || "image/png";
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: mime });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {}
}
