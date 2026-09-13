/**
 * System tab — what this deployment is, what it can reach, and who is admin.
 *
 * Variables are shown as present / absent, never by value. See the note at the
 * top of pages/api/v2/admin/system.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";

type Sys = {
  deployment: Record<string, string | null>;
  services: { name: string; ok: boolean; ms: number; detail: string | null }[];
  admins: {
    byRole: { username: string | null; tag: string; email: string | null }[];
    byNameList: string[];
    you: { name: string | null; role: string | null };
  };
  env: { group: string; vars: { key: string; set: boolean }[] }[];
  wallhaven: Record<string, number> | null;
};

const btn = "text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 transition-colors";

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-secondary rounded-md p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-outfit font-semibold text-white">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm py-1.5 border-b border-white/5 last:border-0">
      <span className="text-white/50">{label}</span>
      <span className="text-white text-right break-all">{value ?? "—"}</span>
    </div>
  );
}

export default function SystemCard() {
  const [s, setS] = useState<Sys | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v2/admin/system");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setS(data);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = (
    <button type="button" onClick={() => void load()} className={`${btn} flex items-center gap-1.5`}>
      <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Retester
    </button>
  );

  const env = s?.env ?? [];
  const missing = env.flatMap((g) => g.vars.filter((v) => !v.set).map((v) => v.key));

  /* The trap of 13/09/2026: an admin by role whose name is not in the list, or
     a name in the list that matches no account. Said out loud rather than left
     to be inferred from two columns. */
  const listNames = new Set((s?.admins.byNameList ?? []).map((n) => n.toLowerCase()));
  const unmatchedNames = [...listNames].filter(
    (n) => !(s?.admins.byRole ?? []).some((a) => (a.username || "").toLowerCase() === n),
  );

  return (
    <div className="px-6 py-8 space-y-5">
      {error && <p className="text-rose-300 text-sm">Erreur : {error}</p>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Déploiement" right={refresh}>
          {s && (
            <div>
              <Line label="Environnement" value={s.deployment.env} />
              <Line label="Branche" value={s.deployment.branch} />
              <Line label="Commit" value={s.deployment.commit && (
                <span><span className="font-mono">{s.deployment.commit}</span>
                  {s.deployment.commitMessage && <span className="text-white/50"> — {s.deployment.commitMessage}</span>}</span>
              )} />
              <Line label="URL" value={s.deployment.url} />
              <Line label="Région" value={s.deployment.region} />
              <Line label="Node" value={s.deployment.node} />
            </div>
          )}
        </Card>

        <Card title="Services">
          <div className="space-y-1.5">
            {(s?.services ?? []).map((x) => (
              <div key={x.name} className="flex items-center gap-3 text-sm">
                <span className={`w-2 h-2 rounded-full shrink-0 ${x.ok ? "bg-emerald-400" : "bg-rose-400"}`} />
                <span className="text-white w-36 shrink-0">{x.name}</span>
                <span className="tabular-nums text-white/40 w-14 shrink-0">{x.ms} ms</span>
                <span className={`truncate ${x.ok ? "text-white/60" : "text-rose-300"}`} title={x.detail ?? ""}>{x.detail}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Administrateurs">
          {s && (
            <div className="space-y-3 text-sm">
              <p className="text-white/60">
                Tu es connecté en tant que <span className="text-white">{s.admins.you.name}</span>, rôle{" "}
                <span className="text-action">{s.admins.you.role}</span>.
              </p>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-white/40 mb-1">Par rôle en base</p>
                {s.admins.byRole.length ? s.admins.byRole.map((a) => (
                  <Line key={a.tag} label={`${a.username || "—"}#${a.tag}`} value={a.email} />
                )) : <p className="text-white/40">Aucun.</p>}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-white/40 mb-1">Par nom (NEXT_PUBLIC_ADMIN_USERNAMES)</p>
                <p className="text-white/80">{s.admins.byNameList.join(", ") || "—"}</p>
                {unmatchedNames.length > 0 && (
                  <p className="text-amber-300 text-xs mt-1">
                    Aucun compte admin ne s'appelle {unmatchedNames.join(", ")} : ce nom ne donne l'accès qu'à une session AniList portant exactement ce pseudo.
                  </p>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card title="Wallhaven">
          {s?.wallhaven ? (
            <div>
              <Line label="Images en base" value={s.wallhaven.images?.toLocaleString("fr-FR")} />
              <Line label="Animes couverts" value={s.wallhaven.animes?.toLocaleString("fr-FR")} />
              <Line label="Images taguées" value={s.wallhaven.taguees?.toLocaleString("fr-FR")} />
              <Line label="Hors-sujet écartées" value={s.wallhaven.horsSujet?.toLocaleString("fr-FR")} />
            </div>
          ) : <p className="text-sm text-white/40">Table absente sur cette base.</p>}
        </Card>
      </div>

      <Card
        title="Variables d'environnement"
        right={<span className={`text-xs ${missing.length ? "text-amber-300" : "text-emerald-300"}`}>
          {missing.length ? `${missing.length} absente(s)` : "toutes présentes"}
        </span>}
      >
        <p className="text-xs text-white/40 mb-3">Présence seulement — aucune valeur n'est jamais envoyée au navigateur.</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {env.map((g) => (
            <div key={g.group}>
              <p className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5">{g.group}</p>
              <ul className="space-y-1">
                {g.vars.map((v) => (
                  <li key={v.key} className="flex items-center gap-2 text-xs font-mono">
                    <span className={`w-1.5 h-1.5 rounded-full ${v.set ? "bg-emerald-400" : "bg-rose-400"}`} />
                    <span className={v.set ? "text-white/70" : "text-rose-300"}>{v.key}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
