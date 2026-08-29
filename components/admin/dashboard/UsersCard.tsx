/**
 * Users tab of the admin panel — replaces the "Users coming soon" placeholder.
 *
 * Read-mostly: search, paginate, and the four actions the plan calls for
 * (disable / re-enable, force an e-mail verification, rename). Passwords are
 * not shown because the API never sends them.
 */

import { useCallback, useEffect, useState } from "react";

type AdminUser = {
  id: string;
  tag: string;
  username: string | null;
  email: string | null;
  emailVerifiedAt: number | null;
  anilistId: number | null;
  anilistName: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  createdAt: number;
  lastSeenAt: number;
  dataBytes: number;
};

const PAGE = 50;

function date(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function size(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function UsersCard() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v2/admin/users?q=${encodeURIComponent(q)}&limit=${PAGE}&offset=${offset}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      setUsers(data.users || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      // The most likely cause is TURSO_USERS_URL missing on this environment;
      // saying so beats an empty table that looks like "no users yet".
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [q, offset]);

  useEffect(() => {
    // Debounced so typing in the search box doesn't fire a query per keystroke.
    const id = setTimeout(load, 300);
    return () => clearTimeout(id);
  }, [load]);

  const act = async (id: string, action: string, username?: string) => {
    const res = await fetch("/api/v2/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, username }),
    });
    if (res.ok) void load();
  };

  return (
    <div className="px-6 py-8">
      <div className="bg-secondary rounded-md p-5">
        <div className="flex items-center justify-between mb-4 gap-4">
          <h3 className="font-outfit font-semibold text-white">
            Users{" "}
            <span className="text-white/40 text-sm font-normal">({total})</span>
          </h3>
          <input
            value={q}
            onChange={(e) => {
              setOffset(0);
              setQ(e.target.value);
            }}
            placeholder="tag, pseudo, e-mail, AniList…"
            className="w-72 rounded-md bg-white/5 ring-1 ring-white/10 px-3 py-2 text-sm outline-none focus:ring-action/50"
          />
        </div>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-white/40 text-xs uppercase tracking-wider">
              <tr className="text-left">
                <th className="py-2 pr-4">Tag</th>
                <th className="py-2 pr-4">Pseudo</th>
                <th className="py-2 pr-4">E-mail</th>
                <th className="py-2 pr-4">AniList</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4">Last seen</th>
                <th className="py-2 pr-4">Data</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {users.map((u) => (
                <tr key={u.id} className={u.status === "disabled" ? "opacity-50" : ""}>
                  <td className="py-2 pr-4 font-mono text-xs text-white/60">#{u.tag}</td>
                  <td className="py-2 pr-4">{u.username || "—"}</td>
                  <td className="py-2 pr-4">
                    {u.email ? (
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full ${
                            u.emailVerifiedAt ? "bg-green-400" : "bg-amber-400"
                          }`}
                          title={u.emailVerifiedAt ? "verified" : "not verified"}
                        />
                        {u.email}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 pr-4 text-white/60">{u.anilistName || "—"}</td>
                  <td className="py-2 pr-4 text-white/60">{u.role}</td>
                  <td className="py-2 pr-4 text-white/60">{date(u.createdAt)}</td>
                  <td className="py-2 pr-4 text-white/60">{date(u.lastSeenAt)}</td>
                  <td className="py-2 pr-4 text-white/60">{size(u.dataBytes)}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {u.email && !u.emailVerifiedAt && (
                      <button
                        type="button"
                        onClick={() => act(u.id, "verifyEmail")}
                        className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 mr-1"
                      >
                        Verify
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const name = window.prompt("New username", u.username || "");
                        if (name) void act(u.id, "rename", name);
                      }}
                      className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 mr-1"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        act(u.id, u.status === "disabled" ? "enable" : "disable")
                      }
                      className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20"
                    >
                      {u.status === "disabled" ? "Enable" : "Disable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {loading && <p className="text-white/40 text-sm mt-3">Loading…</p>}
        {!loading && !users.length && !error && (
          <p className="text-white/40 text-sm mt-3">No user matches.</p>
        )}

        {total > PAGE && (
          <div className="flex items-center justify-between mt-4 text-sm text-white/60">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
              className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40"
            >
              Previous
            </button>
            <span>
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <button
              type="button"
              disabled={offset + PAGE >= total}
              onClick={() => setOffset(offset + PAGE)}
              className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
