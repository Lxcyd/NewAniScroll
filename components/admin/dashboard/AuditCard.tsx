/**
 * Audit log tab. Every admin mutation has been written to `audit_log` since the
 * panel exists; until this tab, nothing read it back.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";

type Entry = {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  createdAt: number;
};

const PAGE = 50;
const btn = "text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 transition-colors";

/* Tones by what the action does, so a destructive one stands out in a long list. */
function tone(action: string): string {
  if (/delete|ban|disable|clear|purge|demote|detach|revoke/.test(action)) return "text-rose-300";
  if (/promote|enable|verify/.test(action)) return "text-emerald-300";
  return "text-sky-300";
}

export default function AuditCard() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [actions, setActions] = useState<{ action: string; n: number }[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ q, action, limit: String(PAGE), offset: String(offset) });
      const res = await fetch(`/api/v2/admin/audit?${p}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEntries(data.entries || []);
      setTotal(data.total || 0);
      setActions(data.actions || []);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [q, action, offset]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  return (
    <div className="px-6 py-8">
      <div className="bg-secondary rounded-md p-5">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <h3 className="font-outfit font-semibold text-white mr-auto">
            Journal d'audit <span className="text-white/40 text-sm font-normal">({total.toLocaleString("fr-FR")})</span>
          </h3>
          <input
            id="audit-search"
            value={q}
            onChange={(e) => { setOffset(0); setQ(e.target.value); }}
            placeholder="Auteur, cible, détail…"
            className="w-64 rounded-md bg-white/5 ring-1 ring-white/10 px-3 py-2 text-sm outline-none focus:ring-action/50"
          />
          <select
            id="audit-action"
            value={action}
            onChange={(e) => { setOffset(0); setAction(e.target.value); }}
            className="rounded-md bg-white/5 ring-1 ring-white/10 px-2 py-2 text-sm outline-none"
          >
            <option value="" className="bg-secondary">Toutes les actions</option>
            {actions.map((a) => (
              <option key={a.action} value={a.action} className="bg-secondary">{a.action} ({a.n})</option>
            ))}
          </select>
          <button type="button" onClick={() => void load()} className={`${btn} flex items-center gap-1.5`}>
            <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Actualiser
          </button>
        </div>

        {error && <p className="text-rose-300 text-sm mb-3">Erreur : {error}</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-white/40 text-[11px] uppercase tracking-wider">
              <tr className="text-left">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Auteur</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Cible</th>
                <th className="py-2">Détail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 pr-4 whitespace-nowrap tabular-nums text-white/50">
                    {new Date(e.createdAt).toLocaleString("fr-FR")}
                  </td>
                  <td className="py-2 pr-4 text-action">{e.actor}</td>
                  <td className={`py-2 pr-4 font-mono text-xs ${tone(e.action)}`}>{e.action}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-white/50 break-all">{e.target || "—"}</td>
                  <td className="py-2 text-white/70 break-all">{e.detail || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && !entries.length && !error && <p className="text-white/40 text-sm mt-3">Aucune entrée.</p>}

        {total > PAGE && (
          <div className="flex items-center justify-between mt-4 text-sm text-white/60">
            <span>{offset + 1}–{Math.min(offset + PAGE, total)} sur {total}</span>
            <span className="flex gap-2">
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className={btn}>Précédent</button>
              <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} className={btn}>Suivant</button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
