/**
 * Users tab of the admin panel.
 *
 * Three levels, in the order an admin actually works:
 *   1. the headline numbers — how many, how active, what needs attention;
 *   2. the table — every account, filterable and sortable, one line each;
 *   3. the drawer — one account in full: what it stores, how it signs in, what
 *      was done to it, and every action that can be taken on it.
 *
 * Passwords and AniList tokens never reach this file: the API strips them.
 * Destructive actions confirm first, and deleting an account requires typing
 * its tag back — the one action here with no undo.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

type AuthMethod = "password" | "anilist" | "both" | "none";

type AdminUser = {
  id: string;
  tag: string;
  username: string | null;
  email: string | null;
  emailVerifiedAt: number | null;
  anilistId: number | null;
  anilistName: string | null;
  avatarUrl: string | null;
  anilistAvatarUrl: string | null;
  profileBanner: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  createdAt: number;
  lastSeenAt: number;
  dataBytes: number;
  authMethod: AuthMethod;
  listCount: number;
};

type Stats = Record<string, number>;

type Detail = {
  user: AdminUser;
  authMethod: AuthMethod;
  hasAnilistToken: boolean;
  data: { kind: string; bytes: number; rev: number; updatedAt: number; summary: any }[];
  tokens: { kind: string; live: number; total: number }[];
  audit: { actor: string; action: string; detail: string | null; createdAt: number }[];
};

const PAGE = 50;

/* ── formatting ──────────────────────────────────────────────────────────── */

function date(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("fr-FR", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function ago(ms: number | null): string {
  if (!ms) return "jamais";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 30 * 86400) return `il y a ${Math.floor(s / 86400)} j`;
  if (s < 365 * 86400) return `il y a ${Math.floor(s / (30 * 86400))} mois`;
  return `il y a ${Math.floor(s / (365 * 86400))} an(s)`;
}

function size(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

const nf = (n: number | undefined) => (n ?? 0).toLocaleString("fr-FR");

const AUTH_LABEL: Record<AuthMethod, string> = {
  both: "Mot de passe + AniList",
  password: "Mot de passe",
  anilist: "AniList seul",
  none: "Aucune",
};

const KIND_LABEL: Record<string, string> = {
  list: "Liste",
  progress: "Progression",
  favourites: "Favoris",
  prefs: "Préférences",
  player: "Lecteur",
  recent: "Récents",
};

const STATUS_LABEL: Record<string, string> = {
  CURRENT: "En cours",
  PLANNING: "Prévu",
  COMPLETED: "Terminé",
  PAUSED: "En pause",
  DROPPED: "Abandonné",
  REPEATING: "Revisionnage",
};

function avatarOf(u: AdminUser): string | null {
  return u.avatarUrl || u.anilistAvatarUrl || null;
}

function nameOf(u: AdminUser): string {
  return u.username || u.anilistName || `Invité#${u.tag}`;
}

function profileHref(u: AdminUser): string {
  return `/en/profile/${encodeURIComponent(u.username || "user")}-${u.tag}`;
}

/* ── small pieces ────────────────────────────────────────────────────────── */

function Avatar({ u, size: px = 32 }: { u: AdminUser; size?: number }) {
  const src = avatarOf(u);
  const initial = nameOf(u).slice(0, 1).toUpperCase();
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      style={{ width: px, height: px }}
      className="rounded-full object-cover bg-white/10 shrink-0"
    />
  ) : (
    <span
      style={{ width: px, height: px }}
      className="rounded-full bg-white/10 grid place-items-center text-white/60 text-xs font-semibold shrink-0"
    >
      {initial}
    </span>
  );
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "accent" }) {
  const tones = {
    neutral: "bg-white/5 text-white/60 ring-white/10",
    good: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
    warn: "bg-amber-400/10 text-amber-300 ring-amber-400/20",
    bad: "bg-rose-400/10 text-rose-300 ring-rose-400/20",
    accent: "bg-action/10 text-action ring-action/30",
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] ring-1 whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Stat({ label, value, tone = "text-white", hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-md bg-white/[0.03] ring-1 ring-white/5 px-3 py-2.5" title={hint}>
      <p className="text-[11px] uppercase tracking-wider text-white/40">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function Select({ id, value, onChange, options }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md bg-white/5 ring-1 ring-white/10 px-2 py-2 text-sm outline-none focus:ring-action/50"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v} className="bg-secondary">
          {l}
        </option>
      ))}
    </select>
  );
}

const btn = "text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 transition-colors";
const btnDanger = "text-xs px-2.5 py-1.5 rounded bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 disabled:opacity-40 transition-colors";

/* ── the tab ─────────────────────────────────────────────────────────────── */

export default function UsersCard() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [auth, setAuth] = useState("");
  const [verified, setVerified] = useState("");
  const [sort, setSort] = useState("lastSeen");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({
        q, role, status, auth, verified, sort, dir,
        limit: String(PAGE), offset: String(offset),
      });
      const res = await fetch(`/api/v2/admin/users?${p}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUsers(data.users || []);
      setTotal(data.total || 0);
      setStats(data.stats || null);
      setMe(data.me || null);
    } catch (err: any) {
      // Most likely TURSO_USERS_URL missing on this deployment; saying so beats
      // an empty table that reads as "no users yet".
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [q, role, status, auth, verified, sort, dir, offset]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    setOffset(0);
    set(v);
  };

  const purgeOrphans = async () => {
    if (!window.confirm(`Supprimer ${stats?.orphanRows} ligne(s) de données appartenant à des comptes supprimés ?`)) return;
    const res = await fetch("/api/v2/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "purgeOrphans" }),
    });
    const data = await res.json();
    setNotice(res.ok ? `${data.removed} ligne(s) orpheline(s) supprimée(s).` : data.error);
    void load();
  };

  const s = stats || {};

  return (
    <div className="px-6 py-8 space-y-5">
      {/* 1. headline numbers */}
      <div className="bg-secondary rounded-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-outfit font-semibold text-white">Comptes</h3>
          <button type="button" onClick={() => void load()} className={`${btn} flex items-center gap-1.5`}>
            <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Actualiser
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Stat label="Total" value={nf(s.total)} tone="text-action" />
          <Stat label="Actifs 24 h" value={nf(s.active24h)} tone="text-sky-300" hint="Dernière visite dans les 24 dernières heures" />
          <Stat label="Actifs 7 j" value={nf(s.active7d)} tone="text-sky-300" />
          <Stat label="Actifs 30 j" value={nf(s.active30d)} tone="text-sky-300" />
          <Stat label="Nouveaux 7 j" value={nf(s.new7d)} tone="text-emerald-300" />
          <Stat label="Nouveaux 30 j" value={nf(s.new30d)} tone="text-emerald-300" />
          <Stat label="Liés AniList" value={nf(s.anilistLinked)} />
          <Stat label="Mot de passe" value={nf(s.withPassword)} />
          <Stat label="E-mail non vérifié" value={nf(s.unverified)} tone={s.unverified ? "text-amber-300" : "text-white"} />
          <Stat label="Admins" value={nf(s.admins)} tone="text-action" />
          <Stat label="Désactivés" value={nf(s.disabled)} tone={s.disabled ? "text-rose-300" : "text-white"} />
          <Stat label="Données stockées" value={size(s.dataBytes || 0)} hint="Somme des charges synchronisées (user_data)" />
        </div>
        {(s.orphanRows > 0 || s.liveTokens > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            {s.orphanRows > 0 && (
              <span className="flex items-center gap-2 text-amber-300">
                {s.orphanRows} ligne(s) de données appartiennent à des comptes supprimés.
                <button type="button" onClick={purgeOrphans} className={btn}>Purger</button>
              </span>
            )}
            {s.liveTokens > 0 && (
              <span className="text-white/50">{s.liveTokens} lien(s) e-mail en attente.</span>
            )}
          </div>
        )}
        {notice && <p className="mt-3 text-sm text-emerald-300">{notice}</p>}
      </div>

      {/* 2. table */}
      <div className="bg-secondary rounded-md p-5">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input
            id="users-search"
            value={q}
            onChange={(e) => resetPage(setQ)(e.target.value)}
            placeholder="Pseudo, e-mail, tag, AniList, id…"
            className="flex-1 min-w-[14rem] rounded-md bg-white/5 ring-1 ring-white/10 px-3 py-2 text-sm outline-none focus:ring-action/50"
          />
          <Select id="users-role" value={role} onChange={resetPage(setRole)}
            options={[["", "Tous rôles"], ["admin", "Admins"], ["user", "Utilisateurs"]]} />
          <Select id="users-status" value={status} onChange={resetPage(setStatus)}
            options={[["", "Tous statuts"], ["active", "Actifs"], ["disabled", "Désactivés"]]} />
          <Select id="users-auth" value={auth} onChange={resetPage(setAuth)}
            options={[["", "Toute connexion"], ["both", "Mot de passe + AniList"], ["password", "Mot de passe"], ["anilist", "AniList seul"], ["none", "Aucune"]]} />
          <Select id="users-verified" value={verified} onChange={resetPage(setVerified)}
            options={[["", "Tout e-mail"], ["yes", "Vérifié"], ["no", "Non vérifié"]]} />
          <Select id="users-sort" value={sort} onChange={resetPage(setSort)}
            options={[["lastSeen", "Dernière visite"], ["created", "Inscription"], ["data", "Données"], ["name", "Nom"]]} />
          <button
            type="button"
            onClick={() => resetPage(setDir)(dir === "desc" ? "asc" : "desc")}
            className={btn}
            title="Inverser l'ordre"
          >
            {dir === "desc" ? "↓ décroissant" : "↑ croissant"}
          </button>
        </div>

        {error && <p className="text-rose-300 text-sm mb-3">Erreur : {error}</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-white/40 text-[11px] uppercase tracking-wider">
              <tr className="text-left">
                <th className="py-2 pr-4">Compte</th>
                <th className="py-2 pr-4">E-mail</th>
                <th className="py-2 pr-4">Connexion</th>
                <th className="py-2 pr-4">AniList</th>
                <th className="py-2 pr-4 text-right">Liste</th>
                <th className="py-2 pr-4">Rôle</th>
                <th className="py-2 pr-4">Inscrit</th>
                <th className="py-2 pr-4">Vu</th>
                <th className="py-2 text-right">Données</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {users.map((u) => (
                <tr
                  key={u.id}
                  onClick={() => setOpenId(u.id)}
                  className={`cursor-pointer hover:bg-white/[0.03] ${u.status === "disabled" ? "opacity-50" : ""} ${openId === u.id ? "bg-white/[0.05]" : ""}`}
                >
                  <td className="py-2 pr-4">
                    <span className="flex items-center gap-2.5">
                      <Avatar u={u} />
                      <span className="flex flex-col leading-tight">
                        <span className="text-white flex items-center gap-1.5">
                          {nameOf(u)}
                          {u.id === me && <Badge tone="accent">toi</Badge>}
                          {u.status === "disabled" && <Badge tone="bad">désactivé</Badge>}
                        </span>
                        <span className="font-mono text-[11px] text-white/40">#{u.tag}</span>
                      </span>
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    {u.email ? (
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full ${u.emailVerifiedAt ? "bg-emerald-400" : "bg-amber-400"}`}
                          title={u.emailVerifiedAt ? "vérifié" : "non vérifié"}
                        />
                        {u.email}
                      </span>
                    ) : <span className="text-white/30">—</span>}
                  </td>
                  <td className="py-2 pr-4"><Badge>{AUTH_LABEL[u.authMethod]}</Badge></td>
                  <td className="py-2 pr-4 text-white/60">{u.anilistName || "—"}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-white/70">{u.listCount ? nf(u.listCount) : "—"}</td>
                  <td className="py-2 pr-4">{u.role === "admin" ? <Badge tone="accent">admin</Badge> : <span className="text-white/40">user</span>}</td>
                  <td className="py-2 pr-4 text-white/60 whitespace-nowrap" title={date(u.createdAt)}>{ago(u.createdAt)}</td>
                  <td className="py-2 pr-4 text-white/60 whitespace-nowrap" title={date(u.lastSeenAt)}>{ago(u.lastSeenAt)}</td>
                  <td className="py-2 text-right tabular-nums text-white/60">{size(u.dataBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {loading && !users.length && <p className="text-white/40 text-sm mt-3">Chargement…</p>}
        {!loading && !users.length && !error && <p className="text-white/40 text-sm mt-3">Aucun compte ne correspond.</p>}

        <div className="flex items-center justify-between mt-4 text-sm text-white/60">
          <span>{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} sur ${nf(total)}` : ""}</span>
          {total > PAGE && (
            <span className="flex gap-2">
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className={btn}>Précédent</button>
              <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} className={btn}>Suivant</button>
            </span>
          )}
        </div>
      </div>

      {openId && (
        <UserDrawer
          id={openId}
          me={me}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

/* ── 3. the drawer ───────────────────────────────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] uppercase tracking-wider text-white/40">{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm py-1 border-b border-white/5 last:border-0">
      <span className="text-white/50 shrink-0">{label}</span>
      <span className="text-white text-right break-all">{children}</span>
    </div>
  );
}

function UserDrawer({ id, me, onClose, onChanged }: {
  id: string;
  me: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/v2/admin/users?id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (res.ok) setD(data);
    else setMsg({ ok: false, text: data.error || "Chargement impossible" });
  }, [id]);

  useEffect(() => {
    setD(null);
    setMsg(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (action: string, extra: Record<string, unknown> = {}, done?: string) => {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch("/api/v2/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMsg({ ok: true, text: done || "Fait." });
      onChanged();
      if (data.deleted) onClose();
      else await load();
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  };

  const u = d?.user;
  const self = id === me;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Fermer" onClick={onClose} className="absolute inset-0 bg-black/50" />
      <aside className="relative w-full max-w-xl h-full bg-secondary ring-1 ring-white/10 overflow-y-auto">
        <div className="sticky top-0 bg-secondary/95 backdrop-blur px-5 py-4 border-b border-white/5 flex items-center gap-3">
          {u && <Avatar u={u as AdminUser} size={44} />}
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold truncate">{u ? nameOf(u as AdminUser) : "…"}</p>
            {u && (
              <p className="flex flex-wrap items-center gap-1.5 mt-0.5">
                <span className="font-mono text-[11px] text-white/40">#{u.tag}</span>
                {u.role === "admin" && <Badge tone="accent">admin</Badge>}
                <Badge tone={u.status === "disabled" ? "bad" : "good"}>{u.status === "disabled" ? "désactivé" : "actif"}</Badge>
                {self && <Badge tone="accent">toi</Badge>}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-white/10" aria-label="Fermer">
            <XMarkIcon className="w-5 h-5 text-white/60" />
          </button>
        </div>

        {!d && !msg && <p className="p-5 text-white/40 text-sm">Chargement…</p>}
        {msg && (
          <p className={`mx-5 mt-4 text-sm rounded px-3 py-2 ${msg.ok ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}`}>
            {msg.text}
          </p>
        )}

        {d && u && (
          <div className="p-5 space-y-6">
            <Section title="Identité">
              <div>
                <Row label="Id"><span className="font-mono text-xs">{u.id}</span></Row>
                <Row label="Pseudo">{u.username || "—"}</Row>
                <Row label="E-mail">
                  {u.email ? (
                    <span className="flex items-center justify-end gap-2">
                      {u.email}
                      <Badge tone={u.emailVerifiedAt ? "good" : "warn"}>{u.emailVerifiedAt ? "vérifié" : "non vérifié"}</Badge>
                    </span>
                  ) : "—"}
                </Row>
                {u.emailVerifiedAt && <Row label="Vérifié le">{date(u.emailVerifiedAt)}</Row>}
                <Row label="Connexion">{AUTH_LABEL[d.authMethod]}</Row>
                <Row label="AniList">
                  {u.anilistId ? (
                    <a href={`https://anilist.co/user/${u.anilistName || u.anilistId}`} target="_blank" rel="noreferrer"
                      className="text-action hover:underline inline-flex items-center gap-1">
                      {u.anilistName || u.anilistId} <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                    </a>
                  ) : "non lié"}
                </Row>
                {u.anilistId && <Row label="Jeton AniList">{d.hasAnilistToken ? "présent (synchro active)" : "absent"}</Row>}
                <Row label="Avatar">{u.avatarUrl ? "AniScroll" : u.anilistAvatarUrl ? "AniList" : "aucun"}</Row>
                <Row label="Bannière de profil">{u.profileBanner ? "épinglée" : "par défaut"}</Row>
              </div>
            </Section>

            <Section title="Activité">
              <div>
                <Row label="Inscrit">{date(u.createdAt)} · {ago(u.createdAt)}</Row>
                <Row label="Dernière visite">{date(u.lastSeenAt)} · {ago(u.lastSeenAt)}</Row>
              </div>
            </Section>

            <Section title={`Données synchronisées (${size(d.data.reduce((s, k) => s + k.bytes, 0))})`}>
              {!d.data.length && <p className="text-sm text-white/40">Aucune donnée synchronisée.</p>}
              <div className="space-y-2">
                {d.data.map((k) => (
                  <div key={k.kind} className="rounded-md bg-white/[0.03] ring-1 ring-white/5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-white text-sm font-medium">{KIND_LABEL[k.kind] || k.kind}</span>
                      <span className="flex items-center gap-2 text-xs text-white/40">
                        {size(k.bytes)} · rév. {k.rev} · {ago(k.updatedAt)}
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() =>
                            window.confirm(`Vider « ${KIND_LABEL[k.kind] || k.kind} » pour ce compte ? Irréversible.`) &&
                            act("clearData", { kind: k.kind }, `« ${KIND_LABEL[k.kind] || k.kind} » vidé.`)
                          }
                          className="text-rose-300/70 hover:text-rose-300"
                        >
                          vider
                        </button>
                      </span>
                    </div>
                    <KindSummary kind={k.kind} s={k.summary} />
                  </div>
                ))}
              </div>
            </Section>

            {d.tokens.length > 0 && (
              <Section title="Liens e-mail">
                <div>
                  {d.tokens.map((t) => (
                    <Row key={t.kind} label={t.kind}>{t.live} en attente · {t.total} au total</Row>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Actions">
              <div className="flex flex-wrap gap-2">
                <a href={profileHref(u as AdminUser)} target="_blank" rel="noreferrer" className={`${btn} inline-flex items-center gap-1`}>
                  Voir le profil <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                </a>
                {u.email && !u.emailVerifiedAt && (
                  <button type="button" disabled={!!busy} className={btn}
                    onClick={() => act("verifyEmail", {}, "E-mail marqué vérifié.")}>
                    Marquer l'e-mail vérifié
                  </button>
                )}
                <button type="button" disabled={!!busy} className={btn}
                  onClick={() => {
                    const name = window.prompt("Nouveau pseudo", u.username || "");
                    if (name && name !== u.username) void act("rename", { username: name }, `Renommé en ${name}.`);
                  }}>
                  Renommer
                </button>
                {u.role === "admin" ? (
                  <button type="button" disabled={!!busy || self} className={btn}
                    title={self ? "Impossible sur ton propre compte" : undefined}
                    onClick={() => window.confirm("Retirer le rôle admin ?") && act("demote", {}, "Rôle admin retiré — effectif à sa prochaine connexion.")}>
                    Retirer admin
                  </button>
                ) : (
                  <button type="button" disabled={!!busy} className={btn}
                    onClick={() => window.confirm(`Donner le rôle admin à ${nameOf(u as AdminUser)} ?`) && act("promote", {}, "Promu admin — effectif à sa prochaine connexion.")}>
                    Promouvoir admin
                  </button>
                )}
                {d.tokens.some((t) => t.live > 0) && (
                  <button type="button" disabled={!!busy} className={btn}
                    onClick={() => act("revokeTokens", {}, "Liens e-mail révoqués.")}>
                    Révoquer les liens e-mail
                  </button>
                )}
                {u.anilistId && (
                  <button type="button" disabled={!!busy} className={btn}
                    onClick={() => window.confirm("Délier le compte AniList ? La synchro s'arrêtera.") && act("detachAnilist", {}, "AniList délié.")}>
                    Délier AniList
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
                <button type="button" disabled={!!busy || (self && u.status !== "disabled")} className={btnDanger}
                  title={self ? "Impossible sur ton propre compte" : undefined}
                  onClick={() =>
                    u.status === "disabled"
                      ? act("enable", {}, "Compte réactivé.")
                      : window.confirm("Désactiver ce compte ? La personne ne pourra plus se connecter.") && act("disable", {}, "Compte désactivé.")
                  }>
                  {u.status === "disabled" ? "Réactiver" : "Désactiver"}
                </button>
                {d.data.length > 0 && (
                  <button type="button" disabled={!!busy} className={btnDanger}
                    onClick={() => window.confirm("Vider TOUTES les données synchronisées de ce compte ? Irréversible.") && act("clearData", {}, "Toutes les données vidées.")}>
                    Vider toutes les données
                  </button>
                )}
                <button type="button" disabled={!!busy || self} className={btnDanger}
                  title={self ? "Impossible sur ton propre compte" : undefined}
                  onClick={() => {
                    const typed = window.prompt(`Suppression DÉFINITIVE du compte et de ses données.\nTape le tag « ${u.tag} » pour confirmer :`);
                    if (typed != null) void act("delete", { confirm: typed.trim() }, "Compte supprimé.");
                  }}>
                  Supprimer le compte
                </button>
              </div>
              <p className="text-[11px] text-white/35">
                La désactivation est immédiate : les routes de compte relisent la base à chaque appel, et la connexion est refusée. Un changement de rôle, lui, n'agit qu'à la prochaine connexion — le rôle voyage dans la session signée.
              </p>
            </Section>

            <Section title={`Historique admin (${d.audit.length})`}>
              {!d.audit.length && <p className="text-sm text-white/40">Aucune action enregistrée sur ce compte.</p>}
              <ol className="space-y-1.5">
                {d.audit.map((a, i) => (
                  <li key={i} className="text-sm flex gap-3">
                    <span className="text-white/40 whitespace-nowrap tabular-nums text-xs pt-0.5">{date(a.createdAt)}</span>
                    <span className="text-white/80">
                      <span className="text-action">{a.actor}</span> · {a.action}
                      {a.detail && <span className="text-white/40"> — {a.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
          </div>
        )}
      </aside>
    </div>
  );
}

function KindSummary({ kind, s }: { kind: string; s: any }) {
  if (!s) return null;
  if (kind === "list") {
    return (
      <div className="mt-2 space-y-1.5">
        <p className="text-xs text-white/60">
          {nf(s.entries)} anime · {nf(s.scored)} notés · {nf(s.episodes)} épisodes vus
        </p>
        <div className="flex flex-wrap gap-1">
          {Object.entries<number>(s.byStatus || {})
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <Badge key={k}>{STATUS_LABEL[k] || k} · {nf(n)}</Badge>
            ))}
        </div>
      </div>
    );
  }
  if (kind === "progress") {
    return (
      <p className="mt-2 text-xs text-white/60">
        {nf(s.episodes)} épisode(s) en cours · ~{s.hoursWatched} h · dernier visionnage {ago(s.lastWatchedAt)}
      </p>
    );
  }
  if (kind === "favourites") return <p className="mt-2 text-xs text-white/60">{nf(s.count)} favori(s)</p>;
  if (Array.isArray(s.keys) && s.keys.length) {
    return (
      <p className="mt-2 text-[11px] font-mono text-white/40 break-all">
        {s.keys.map((k: string) => k.replace(/^aniscroll:/, "")).join(" · ")}
      </p>
    );
  }
  return null;
}
