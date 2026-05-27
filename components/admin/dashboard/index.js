import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Admin dashboard. Real Turso stats, broadcast control, recent bug reports,
 * manual single-anime scrape tool, and IP-ban management.
 *
 * All data comes from /api/v2/admin/* endpoints which gate on isAdminSession.
 * We fetch on mount and re-fetch after every mutation so the cards stay
 * current without a full page reload.
 */
export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [broadcast, setBroadcast] = useState(null);
  const [reports, setReports] = useState([]);

  const fetchStats = async () => {
    try {
      const r = await fetch("/api/v2/admin/stats");
      if (r.ok) setStats(await r.json());
    } catch {}
  };
  const fetchBroadcast = async () => {
    try {
      const r = await fetch("/api/v2/admin/broadcast", {
        headers: { "X-Broadcast-Key": "get-broadcast" },
      });
      if (r.ok) setBroadcast(await r.json());
    } catch {}
  };
  const fetchReports = async () => {
    try {
      // cache: "no-store" — Turso writes are not always visible to the
      // browser's HTTP cache on the next read, which made fresh reports
      // "appear every other refresh". Disabling cache forces a hit.
      const r = await fetch("/api/v2/admin/bug-report", { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        setReports(data.reports || []);
      }
    } catch {}
  };

  useEffect(() => {
    fetchStats();
    fetchBroadcast();
    fetchReports();
    // Poll reports + broadcast every 20s so the admin sees new ones
    // without having to refresh the page.
    const t = setInterval(() => {
      fetchReports();
      fetchBroadcast();
      fetchStats();
    }, 20_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex flex-col gap-8 px-6 py-8">
      <StatsGrid stats={stats} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BroadcastCard broadcast={broadcast} onUpdate={fetchBroadcast} />
        <ScrapeCard onSuccess={fetchStats} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BulkRefreshCard onSuccess={fetchStats} />
        <BannedIpsCard />
      </div>

      <ReportsCard report={reports} onResolve={fetchReports} />
    </div>
  );
}

// ── Stats grid ──────────────────────────────────────────────────────────
function StatsGrid({ stats }) {
  const sections = [
    {
      title: "Visitors",
      items: [
        { label: "Today (24h)",  value: stats?.uniqueVisitors24h,    accent: "text-sky-400" },
        { label: "This week",    value: stats?.uniqueVisitorsWeek,   accent: "text-sky-400" },
        { label: "This month",   value: stats?.uniqueVisitorsMonth,  accent: "text-sky-400" },
        { label: "All time",     value: stats?.uniqueVisitorsAll,    accent: "text-sky-400" },
        { label: "Pageviews 24h",value: stats?.pageviews24h,         accent: "text-sky-300" },
      ],
    },
    {
      title: "Cache",
      items: [
        { label: "Anime",        value: stats?.anime,        accent: "text-action" },
        { label: "Stale",        value: stats?.animeStale,   accent: "text-amber-400" },
        { label: "Fanarts",      value: stats?.fanarts,      accent: "text-action" },
        { label: "Classified",   value: stats?.classified,   accent: "text-emerald-400" },
        { label: "Pending",      value: stats?.unclassified, accent: "text-amber-400" },
        { label: "NSFW",         value: stats?.nsfw,         accent: "text-rose-400" },
        { label: "Safe",         value: stats?.safe,         accent: "text-emerald-400" },
      ],
    },
    {
      title: "Moderation",
      items: [
        { label: "Banned IPs",   value: stats?.bannedIps,  accent: "text-rose-400" },
        { label: "Open reports", value: stats?.bugReports, accent: "text-amber-400" },
      ],
    },
  ];
  return (
    <div className="space-y-4">
      {sections.map((s) => (
        <div key={s.title}>
          <p className="mb-2 font-outfit font-semibold text-white/70 text-sm uppercase tracking-wider">
            {s.title}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {s.items.map((it) => (
              <div
                key={it.label}
                className="flex flex-col items-start gap-1 bg-secondary rounded-md p-4"
              >
                <p className={`font-karla text-3xl font-bold ${it.accent}`}>
                  {it.value ?? "—"}
                </p>
                <p className="font-karla text-xs text-white/60 uppercase tracking-wider">
                  {it.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Broadcast card ──────────────────────────────────────────────────────
function BroadcastCard({ broadcast, onUpdate }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [busy, setBusy] = useState(false);
  // Date-picker modal state. Native datetime inputs fire onChange multiple
  // times as the user scrolls the calendar, which previously inserted
  // duplicate tokens. We open a small modal with explicit Confirm / Cancel
  // so only an intentional Confirm injects.
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [datePickerValue, setDatePickerValue] = useState("");
  // (insertDateInputRef removed — switched to a Confirm/Cancel modal so
  // we no longer rely on the native input's onChange.)

  // Convert epoch-seconds → datetime-local string in the admin's TZ.
  const toLocalInput = (epoch) => {
    if (!epoch) return "";
    const d = new Date(Number(epoch) * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  useEffect(() => {
    if (broadcast?.title != null) setTitle(broadcast.title || "");
    if (broadcast?.message != null) setMessage(broadcast.message || "");
    setStartAt(toLocalInput(broadcast?.startAt));
    setEndAt(toLocalInput(broadcast?.endAt));
  }, [broadcast?.title, broadcast?.message, broadcast?.startAt, broadcast?.endAt]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const startEpoch = startAt
        ? Math.floor(new Date(startAt).getTime() / 1000)
        : undefined;
      const endEpoch = endAt
        ? Math.floor(new Date(endAt).getTime() / 1000)
        : undefined;
      const r = await fetch("/api/v2/admin/broadcast", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Broadcast-Key": "get-broadcast",
        },
        body: JSON.stringify({
          title: title.trim() || null,
          message,
          startAt: startEpoch,
          endAt: endEpoch,
          show: true,
        }),
      });
      if (r.ok) {
        toast.success("Broadcast updated");
        onUpdate();
      } else toast.error("Broadcast failed");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/v2/admin/broadcast", {
        method: "DELETE",
        headers: { "X-Broadcast-Key": "get-broadcast" },
      });
      if (r.ok) {
        toast.success("Broadcast cleared");
        setTitle("");
        setMessage("");
        setStartAt("");
        setEndAt("");
        onUpdate();
      } else toast.error("Failed to clear");
    } finally {
      setBusy(false);
    }
  };

  // Open the modal date-picker. The admin must click Confirm before the
  // token is injected — avoids the duplicate-insert bug we had with the
  // raw `<input onChange>` approach where the browser fires multiple
  // change events while the user navigates the calendar.
  const openDateTokenPicker = () => {
    // Default to "now" so confirming without changing anything still
    // produces a meaningful token.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    setDatePickerValue(local);
    setDatePickerOpen(true);
  };

  const confirmDateToken = () => {
    if (!datePickerValue) {
      setDatePickerOpen(false);
      return;
    }
    const epoch = Math.floor(new Date(datePickerValue).getTime() / 1000);
    setMessage((cur) => `${cur} {{date:${epoch}}}`);
    setDatePickerOpen(false);
  };

  const isLive = broadcast?.show === true;

  return (
    <Card
      title="Global broadcast"
      pill={
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-karla ${
            isLive ? "text-emerald-400" : "text-white/40"
          }`}
        >
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isLive ? "bg-emerald-500" : "bg-white/30"
            }`}
          />
          {isLive ? "Live" : "Inactive"}
        </span>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Field label="Title">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Update notice (default if empty)"
            maxLength={80}
            className="w-full px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent font-karla"
          />
        </Field>
        <Field label="Message">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            rows={3}
            placeholder={`Maintenance on {{date:2026-12-25T15:00}} — service may be brief.`}
            className="w-full px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent font-karla resize-y"
          />
          <div className="mt-1 flex items-center justify-between">
            <p className="text-[10px] text-white/40 font-karla">
              Use <code className="bg-white/10 px-1 rounded">{`{{date:…}}`}</code>{" "}
              to embed a date — rendered in each visitor's local time.
            </p>
            <button
              type="button"
              onClick={openDateTokenPicker}
              className="text-[10px] uppercase tracking-wider text-action hover:text-action/80"
            >
              + Insert date
            </button>
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start (optional)">
            <input
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent"
            />
          </Field>
          <Field label="End (optional)">
            <input
              type="datetime-local"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent"
            />
          </Field>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy || !message.trim()}
            className="flex-1 px-4 py-2 rounded-md bg-action text-white font-semibold hover:bg-action/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? "…" : isLive ? "Update" : "Broadcast"}
          </button>
          {isLive && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={busy}
              className="px-4 py-2 rounded-md bg-rose-600/80 text-white hover:bg-rose-600 transition-colors disabled:opacity-40"
            >
              Clear
            </button>
          )}
        </div>
      </form>

      {/* Date-picker modal — confirms before injecting a token. */}
      {datePickerOpen && (
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setDatePickerOpen(false)}
        >
          <div
            className="w-full max-w-sm bg-as-card rounded-card ring-1 ring-white/10 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-outfit font-bold text-white text-lg mb-3">
              Insert date
            </h4>
            <input
              type="datetime-local"
              value={datePickerValue}
              onChange={(e) => setDatePickerValue(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent"
            />
            <p className="mt-2 text-[10px] text-white/40 font-karla">
              The date is stored as a Unix timestamp and shown to each
              visitor in their own timezone.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setDatePickerOpen(false)}
                className="flex-1 px-4 py-2 rounded-md bg-white/5 text-white/70 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDateToken}
                disabled={!datePickerValue}
                className="flex-1 px-4 py-2 rounded-md bg-action text-white font-semibold hover:bg-action/90 disabled:opacity-40"
              >
                Insert
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Manual scrape card ──────────────────────────────────────────────────
function ScrapeCard({ onSuccess }) {
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!id) return;
    setBusy(true);
    try {
      const r = await fetch("/api/v2/admin/scrape-anime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(id) }),
      });
      const data = await r.json();
      if (r.ok) {
        toast.success(`Scraped: ${data.anime?.title || data.anime?.id}`);
        setResult(data);
        onSuccess?.();
      } else {
        toast.error(data.error || "Scrape failed");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Manual scrape (single anime)">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Field label="AniList ID">
          <input
            type="number"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. 21 (One Piece)"
            className="w-full px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent"
          />
        </Field>
        <button
          type="submit"
          disabled={busy || !id}
          className="px-4 py-2 rounded-md bg-action text-white font-semibold hover:bg-action/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Fetching…" : "Scrape & upsert"}
        </button>
      </form>
      {result?.anime && <ScrapePreview data={result} />}
    </Card>
  );
}

function ScrapePreview({ data }) {
  const a = data.anime;
  const f = data.fanart || { counts: {}, total: 0, samples: [] };
  return (
    <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
      <div className="flex gap-3">
        {a.coverImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={a.coverImage}
            alt=""
            className="w-20 h-28 rounded object-cover shrink-0"
          />
        )}
        <div className="min-w-0 flex-1 text-sm font-karla">
          <p className="text-white font-semibold truncate">{a.title}</p>
          <p className="text-white/50 text-xs">
            #{a.id} {a.idMal ? `· MAL ${a.idMal}` : ""}
          </p>
          <p className="text-white/60 text-xs mt-1">
            {a.format} · {a.status} · {a.episodes ?? "?"} ep · {a.duration ?? "?"}m
          </p>
          <p className="text-white/60 text-xs">
            pop {a.popularity ?? "—"} · score {a.averageScore ?? "—"}
            {a.isAdult ? " · 🔞" : ""}
          </p>
          {a.studios?.length > 0 && (
            <p className="text-white/60 text-xs mt-1 truncate">
              Studio: {a.studios.join(", ")}
            </p>
          )}
          {a.genres?.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {a.genres.slice(0, 6).map((g) => (
                <span
                  key={g}
                  className="text-[10px] bg-white/10 text-white/70 px-1.5 py-0.5 rounded"
                >
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {a.bannerImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={a.bannerImage}
          alt=""
          className="w-full h-20 rounded object-cover"
        />
      )}

      <div className="text-xs font-karla">
        <p className="text-white/70 font-semibold mb-1">
          Fanarts ({f.total})
        </p>
        {f.total === 0 && (
          <p className="text-white/40">
            No fanart cached yet — wait for the next refresh-fanarts cron.
          </p>
        )}
        {Object.keys(f.counts).length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {Object.entries(f.counts).map(([type, n]) => (
              <span
                key={type}
                className="bg-white/10 text-white/70 px-1.5 py-0.5 rounded"
              >
                {type}: {n}
              </span>
            ))}
          </div>
        )}
        {f.samples?.length > 0 && (
          <div className="grid grid-cols-6 gap-1">
            {f.samples.map((s, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={s.url}
                alt={s.type}
                title={s.type}
                className="aspect-square object-cover rounded ring-1 ring-white/10"
              />
            ))}
          </div>
        )}
      </div>

      {a.relations?.length > 0 && (
        <div className="text-xs font-karla">
          <p className="text-white/70 font-semibold mb-1">Relations</p>
          <ul className="space-y-0.5 text-white/60">
            {a.relations.map((r, i) => (
              <li key={i} className="truncate">
                <span className="text-action">{r.type}</span> · {r.title}{" "}
                {r.format && <span className="text-white/40">({r.format})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Bulk refresh card ───────────────────────────────────────────────────
function BulkRefreshCard({ onSuccess }) {
  const [limit, setLimit] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const handleClick = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/v2/admin/bulk-refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit }),
      });
      const data = await r.json();
      if (r.ok) {
        setResult(data);
        toast.success(`${data.refreshed} refreshed, ${data.failed} failed`);
        onSuccess?.();
      } else {
        toast.error(data.error || "Bulk refresh failed");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Bulk refresh (stale anime)">
      <p className="text-xs text-white/50 font-karla mb-3 leading-relaxed">
        Re-fetches the N least-recently-checked anime whose Turso cache has
        expired (TTL based on status: 1h for releasing, 30d for finished).
        Same logic as the daily cron, but on-demand — useful when you
        want fresh scores/episodes right now.
      </p>
      <div className="flex flex-col gap-3">
        <Field label={`Batch size (1-50): ${limit}`}>
          <input
            type="range"
            min={1}
            max={50}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="w-full accent-as-accent"
          />
        </Field>
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className="px-4 py-2 rounded-md bg-action text-white font-semibold hover:bg-action/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Refreshing…" : `Refresh ${limit} stale row(s)`}
        </button>
        {result && (
          <div className="text-sm text-white/70 font-karla">
            ✓ {result.refreshed} ok · ✘ {result.failed} failed
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Banned IPs card ─────────────────────────────────────────────────────
function BannedIpsCard() {
  const [bans, setBans] = useState([]);
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");

  const fetchBans = async () => {
    try {
      const r = await fetch("/api/v2/admin/banned-ips");
      if (r.ok) {
        const data = await r.json();
        setBans(data.bans || []);
      }
    } catch {}
  };

  useEffect(() => { fetchBans(); }, []);

  const handleBan = async (e) => {
    e.preventDefault();
    if (!ip) return;
    const r = await fetch("/api/v2/admin/banned-ips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: ip.trim(), reason: reason.trim() }),
    });
    if (r.ok) {
      toast.success(`Banned ${ip}`);
      setIp(""); setReason("");
      fetchBans();
    } else toast.error("Ban failed");
  };

  const handleUnban = async (target) => {
    const r = await fetch("/api/v2/admin/banned-ips", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: target }),
    });
    if (r.ok) {
      toast.success(`Unbanned ${target}`);
      fetchBans();
    } else toast.error("Unban failed");
  };

  return (
    <Card title={`Banned IPs (${bans.length})`}>
      <form onSubmit={handleBan} className="flex flex-col gap-2 mb-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.0.2.42"
            className="flex-1 px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent font-mono text-sm"
          />
          <button
            type="submit"
            disabled={!ip}
            className="px-3 py-2 rounded-md bg-rose-600/80 text-white text-sm font-semibold hover:bg-rose-600 disabled:opacity-40"
          >
            Ban
          </button>
        </div>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          className="w-full px-3 py-2 rounded-md bg-as-surface text-white ring-1 ring-white/10 outline-none focus:ring-as-accent text-sm"
        />
      </form>
      <div className="max-h-48 overflow-y-auto space-y-1">
        {bans.length === 0 && (
          <p className="text-sm text-white/40 font-karla">No bans yet.</p>
        )}
        {bans.map((b) => (
          <div
            key={b.ip}
            className="flex items-center justify-between bg-primary/40 rounded px-3 py-1.5 font-karla text-sm"
          >
            <div className="flex flex-col">
              <span className="font-mono">{b.ip}</span>
              {b.reason && <span className="text-white/50 text-xs">{b.reason}</span>}
            </div>
            <button
              type="button"
              onClick={() => handleUnban(b.ip)}
              className="text-rose-400 hover:text-rose-300 text-xs uppercase tracking-wider"
            >
              Unban
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Reports card ────────────────────────────────────────────────────────
function ReportsCard({ report, onResolve }) {
  const [severityFilter, setSeverityFilter] = useState("All");

  const filtered = (report || []).filter((r) =>
    severityFilter === "All" ? true : r.severity === severityFilter,
  );
  // Order: Critical → High → Medium → Low (after the user filter passes).
  const severityRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  filtered.sort(
    (a, b) =>
      (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99),
  );

  const handleResolved = async (id) => {
    try {
      const r = await fetch("/api/v2/admin/bug-report", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: id }),
      });
      const data = await r.json();
      if (r.status === 200) {
        toast.success(data.message);
        onResolve?.();
      } else toast.error("Failed");
    } catch {
      toast.error("Failed");
    }
  };

  // Flip a report's pending state. Same backing endpoint the dedicated
  // /admin/reports page uses — caller refreshes the list via onResolve()
  // (which is really "something changed, reload") so the badge updates.
  const handleTogglePending = async (id, nextPending) => {
    try {
      const r = await fetch("/api/v2/admin/bug-report", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: id, pending: nextPending }),
      });
      const data = await r.json();
      if (r.status === 200) {
        toast.success(data.message);
        onResolve?.();
      } else toast.error("Failed");
    } catch {
      toast.error("Failed");
    }
  };

  return (
    <Card
      title="Recent bug reports"
      pill={
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="bg-as-surface text-white/85 ring-1 ring-white/10 rounded px-2 py-1 text-xs font-karla outline-none focus:ring-as-accent"
        >
          {["All", "Critical", "High", "Medium", "Low"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      }
    >
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="text-sm text-white/40 font-karla">No reports.</p>
        )}
        {filtered.map((i, idx) => {
          const isPending = !!i.pending_at;
          return (
          <div
            key={idx}
            className={`bg-primary/40 rounded px-3 py-2 font-karla text-sm ${
              isPending ? "ring-1 ring-amber-500/30 opacity-80" : ""
            }`}
          >
            <div className="flex justify-between items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {isPending && (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold bg-amber-500/20 text-amber-300 shrink-0">
                      Pending
                    </span>
                  )}
                  <Link
                    href={i.url || "#"}
                    className="block text-white font-semibold hover:text-action break-words"
                  >
                    {i.title || "(untitled)"}
                  </Link>
                </div>
                {i.desc && (
                  <p className="text-xs text-white/70 mt-0.5 break-words whitespace-pre-wrap">
                    {i.desc}
                  </p>
                )}
                {(i.reporter || i.reporter_ip) && (
                  <p className="text-[10px] text-white/40 mt-0.5">
                    {i.reporter || "anon"}
                    {i.reporter_ip ? ` · ${i.reporter_ip}` : ""}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <SeverityDot severity={i.severity} />
                <button
                  type="button"
                  onClick={() => handleTogglePending(i?.id, !isPending)}
                  title={
                    isPending
                      ? "Un-pending (back to Open)"
                      : "Mark pending (fix shipped, awaiting verification)"
                  }
                  className={`transition-colors ${
                    isPending
                      ? "text-amber-300 hover:text-amber-200"
                      : "text-white/40 hover:text-amber-300"
                  }`}
                >
                  ⏳
                </button>
                <button
                  type="button"
                  onClick={() => handleResolved(i?.id)}
                  title="Mark resolved"
                  className="text-white/40 hover:text-emerald-400 transition-colors"
                >
                  ✓
                </button>
              </div>
            </div>
            {Array.isArray(i.images) && i.images.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {i.images.map((src, j) => (
                  <button
                    type="button"
                    key={j}
                    onClick={() => openImageInNewTab(src)}
                    className="block w-14 h-14"
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
        })}
      </div>
    </Card>
  );
}

/**
 * Open a base64 data URL in a new browser tab. Going through `<a href>` is
 * unreliable on large data URLs (Chrome / Opera land you on about:blank).
 * Converting to a Blob URL first makes the new-tab open reliably.
 */
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
    // Don't revoke immediately — give the new tab time to load.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {}
}

function SeverityDot({ severity }) {
  const colors = {
    Low: "bg-emerald-500",
    Medium: "bg-amber-500",
    High: "bg-rose-500",
    Critical: "bg-red-700 animate-pulse",
  };
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[severity] || "bg-white/30"}`} />
  );
}

// ── Reusable Card primitive ─────────────────────────────────────────────
function Card({ title, pill, children }) {
  return (
    <div className="bg-secondary rounded-md p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-outfit font-semibold text-white">{title}</h3>
        {pill}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block mb-1.5 text-xs uppercase tracking-wider text-white/50 font-karla">
        {label}
      </label>
      {children}
    </div>
  );
}
