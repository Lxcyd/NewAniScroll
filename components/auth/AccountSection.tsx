/**
 * The "Account" section of the settings page.
 *
 * Kept out of pages/en/settings.tsx (already 1500 lines) and mounted there as
 * a single <AccountSection />. It covers the whole identity surface:
 *
 *   - signed out          → the guest name, renameable, and a way in;
 *   - AniScroll account   → pseudo + tag, e-mail and its verification state,
 *                           password, AniList link, export, deletion;
 *   - AniList-only        → the same, minus what needs an e-mail, plus the
 *                           invitation to create a full account on top.
 */

import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import dynamic from "next/dynamic";
import { notify } from "@/lib/notifications/noticeStore";
import {
  guestDisplayName,
  setGuestName,
  useGuestIdentity,
} from "@/lib/prefs/guestIdentity";
import { validateUsername } from "@/lib/auth/username";

const AuthModal = dynamic(() => import("./AuthModal"), { ssr: false });
const UsernameField = dynamic(() => import("./UsernameField"), { ssr: false });

const INPUT =
  "w-full rounded-lg bg-white/5 ring-1 ring-white/10 px-3 py-2.5 text-sm outline-none focus:ring-action/50";
const BTN =
  "shrink-0 px-3 py-1.5 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm hover:bg-white/15 disabled:opacity-50";

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="py-4 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="text-white/50 text-xs mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-2">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Signed out                                                          */
/* ------------------------------------------------------------------ */

function GuestPanel() {
  const { t } = useTranslation();
  const identity = useGuestIdentity();
  const [draft, setDraft] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);

  // Null until the effect has read localStorage — rendering the generated name
  // during SSR would mismatch on hydration.
  if (!identity) return null;

  const shown = guestDisplayName(identity, t("auth.guestWord"));
  const value = draft ?? identity.name ?? "";

  const save = () => {
    const name = value.trim();
    if (name) {
      const code = validateUsername(name);
      if (code) {
        notify.error(t(`auth.username.${code}`, t("auth.errors.generic")));
        return;
      }
    }
    setGuestName(name || null);
    setDraft(null);
    notify.success(t("auth.guestRenamed"));
  };

  return (
    <>
      <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
        <div className="font-semibold">{shown}</div>
        <div className="text-white/50 text-xs mt-0.5">{t("auth.guestDesc")}</div>

        <div className="mt-4 flex gap-2">
          <input
            className={INPUT}
            value={value}
            maxLength={20}
            placeholder={t("auth.guestNamePlaceholder")}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="button" className={BTN} onClick={save}>
            {t("auth.save")}
          </button>
        </div>

        {/* The warning is the point of the whole feature: a guest's data lives
            in this browser only. */}
        <p className="text-amber-300/80 text-xs mt-3">{t("auth.guestWarning")}</p>

        <button
          type="button"
          onClick={() => setAuthOpen(true)}
          className="mt-4 w-full rounded-lg bg-action px-4 py-2.5 text-sm font-medium text-white hover:brightness-110"
        >
          {t("auth.createAccount")}
        </button>
      </div>
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        initialView="signup"
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Signed in                                                           */
/* ------------------------------------------------------------------ */

function AccountPanel({ user }: { user: any }) {
  const { t } = useTranslation();
  const { update } = useSession();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(user.username || "");
  const [nameOk, setNameOk] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [authOpen, setAuthOpen] = useState(false);

  /* An account with no username is AniList-only: it has never been through
     signup, so it has no e-mail and no password either. */
  const anilistOnly = !user.username;

  async function call(url: string, init: RequestInit): Promise<any | null> {
    setBusy(true);
    try {
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify.error(t(`auth.errors.${data.code || data.error}`, t("auth.errors.generic")));
        return null;
      }
      return data;
    } catch {
      notify.error(t("auth.errors.generic"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const rename = async () => {
    const data = await call("/api/v2/account/username", {
      method: "PUT",
      body: JSON.stringify({ username: newName }),
    });
    if (!data) return;
    // Refresh the JWT so the nav picks the new name up without a reload.
    await update?.();
    setRenaming(false);
    notify.success(t("auth.renamed"));
  };

  const changePassword = async () => {
    const data = await call("/api/v2/account/me", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, password }),
    });
    if (!data) return;
    setChangingPassword(false);
    setCurrentPassword("");
    setPassword("");
    notify.success(t("auth.passwordChanged"));
  };

  const resendVerification = async () => {
    const data = await call("/api/v2/account/verify-email", { method: "POST" });
    if (data) notify.success(t("auth.verifySent"));
  };

  const unlinkAniList = async () => {
    const data = await call("/api/v2/account/link-anilist", { method: "DELETE" });
    if (!data) return;
    await update?.();
    notify.success(t("auth.anilistUnlinked"));
  };

  const exportData = async () => {
    const res = await fetch("/api/v2/account/me?export=1");
    if (!res.ok) return notify.error(t("auth.errors.generic"));
    const blob = new Blob([JSON.stringify(await res.json(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aniscroll-${user.tag}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const remove = async () => {
    if (!window.confirm(t("auth.deleteConfirm"))) return;
    const body = user.username
      ? JSON.stringify({ currentPassword: window.prompt(t("auth.passwordLabel")) || "" })
      : "{}";
    const data = await call("/api/v2/account/me", { method: "DELETE", body });
    if (!data) return;
    // Sign out through NextAuth so the cookie goes with the account.
    await signOut({ redirect: false });
    notify.success(t("auth.deleted"));
  };

  return (
    <>
      <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4 mb-4">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold truncate">
            {user.name || user.username}
          </span>
          <span className="text-white/40 text-xs font-mono">#{user.tag}</span>
        </div>
        <div className="text-white/50 text-xs mt-0.5">
          {anilistOnly ? t("auth.anilistOnlyDesc") : t("auth.accountDesc")}
        </div>
      </div>

      <div className="rounded-xl bg-white/5 ring-1 ring-white/10 px-4 divide-y divide-white/5">
        {/* Pseudo */}
        <Row title={t("auth.usernameLabel")} desc={user.username || t("auth.noUsername")}>
          <button type="button" className={BTN} onClick={() => setRenaming((v) => !v)}>
            {t("auth.change")}
          </button>
        </Row>
        {renaming && (
          <div className="py-4 flex flex-col gap-2">
            <UsernameField value={newName} onChange={setNewName} onValidity={setNameOk} />
            <button
              type="button"
              disabled={busy || !nameOk}
              onClick={rename}
              className="self-start px-4 py-2 rounded-lg bg-action text-sm text-white disabled:opacity-50"
            >
              {t("auth.save")}
            </button>
          </div>
        )}

        {/* E-mail + verification */}
        <Row
          title={t("auth.emailLabel")}
          desc={
            user.email
              ? user.emailVerified
                ? `${user.email} — ${t("auth.verified")}`
                : `${user.email} — ${t("auth.unverified")}`
              : t("auth.noEmail")
          }
        >
          {user.email && !user.emailVerified && (
            <button type="button" className={BTN} disabled={busy} onClick={resendVerification}>
              {t("auth.resend")}
            </button>
          )}
        </Row>

        {/* Password */}
        <Row
          title={t("auth.passwordLabel")}
          desc={anilistOnly ? t("auth.noPassword") : undefined}
        >
          <button
            type="button"
            className={BTN}
            onClick={() => setChangingPassword((v) => !v)}
          >
            {t("auth.change")}
          </button>
        </Row>
        {changingPassword && (
          <div className="py-4 flex flex-col gap-2">
            {!anilistOnly && (
              <input
                className={INPUT}
                type="password"
                autoComplete="current-password"
                placeholder={t("auth.currentPassword")}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            )}
            <input
              className={INPUT}
              type="password"
              autoComplete="new-password"
              placeholder={t("auth.newPassword")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || password.length < 8}
              onClick={changePassword}
              className="self-start px-4 py-2 rounded-lg bg-action text-sm text-white disabled:opacity-50"
            >
              {t("auth.save")}
            </button>
          </div>
        )}

        {/* AniList link */}
        <Row
          title="AniList"
          desc={user.anilistId ? t("auth.anilistLinked") : t("auth.anilistNotLinked")}
        >
          {user.anilistId ? (
            <button type="button" className={BTN} disabled={busy} onClick={unlinkAniList}>
              {t("auth.unlink")}
            </button>
          ) : (
            <button type="button" className={BTN} onClick={() => setAuthOpen(true)}>
              {t("auth.link")}
            </button>
          )}
        </Row>

        {/* An AniList-only session can add the AniScroll half on top. */}
        {anilistOnly && (
          <Row title={t("auth.upgradeTitle")} desc={t("auth.upgradeDesc")}>
            <button type="button" className={BTN} onClick={() => setAuthOpen(true)}>
              {t("auth.createAccount")}
            </button>
          </Row>
        )}

        <Row title={t("auth.exportTitle")} desc={t("auth.exportDesc")}>
          <button type="button" className={BTN} onClick={exportData}>
            {t("auth.export")}
          </button>
        </Row>

        <Row title={t("auth.deleteTitle")} desc={t("auth.deleteDesc")}>
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-red-500/15 ring-1 ring-red-500/30 text-sm text-red-300 hover:bg-red-500/25 disabled:opacity-50"
          >
            {t("auth.delete")}
          </button>
        </Row>
      </div>

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        initialView="signup"
      />
    </>
  );
}

export default function AccountSection() {
  const { t } = useTranslation();
  const { data: session, update } = useSession();
  const router = useRouter();
  const user = (session as any)?.user;

  /* The verification link lands here with ?verify=ok|invalid (it is clicked
     from a mail client, so the outcome has to travel in the URL). Report it
     once, refresh the session so the badge flips, and clean the query. */
  useEffect(() => {
    const verify = router.query.verify;
    if (verify !== "ok" && verify !== "invalid") return;
    if (verify === "ok") {
      notify.success(t("auth.verifyOk"));
      void update?.();
    } else {
      notify.error(t("auth.verifyInvalid"));
    }
    const { verify: _drop, ...rest } = router.query;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, {
      shallow: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.query.verify]);

  return (
    <section id="account" className="py-10 scroll-mt-24">
      <h2 className="text-xl font-semibold mb-1">{t("auth.sectionTitle")}</h2>
      <p className="text-white/60 text-sm mb-4">{t("auth.sectionDesc")}</p>
      {user?.uid ? <AccountPanel user={user} /> : <GuestPanel />}
    </section>
  );
}
