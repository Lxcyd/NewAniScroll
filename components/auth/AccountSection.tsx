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
import { signIn, signOut, useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import dynamic from "next/dynamic";
import { notify } from "@/lib/notifications/noticeStore";
import { guestTag, useGuestIdentity } from "@/lib/prefs/guestIdentity";
import { pickAvatar } from "@/lib/auth/avatar";
import DangerConfirmModal from "@/components/shared/DangerConfirmModal";
import EmailCodeField from "./EmailCodeField";

const AuthModal = dynamic(() => import("./AuthModal"), { ssr: false });
const UsernameField = dynamic(() => import("./UsernameField"), { ssr: false });
const PasswordField = dynamic(() => import("./PasswordField"), { ssr: false });

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
  const [authOpen, setAuthOpen] = useState(false);

  // Null until the effect has read localStorage — rendering the generated name
  // during SSR would mismatch on hydration.
  if (!identity) return null;

  return (
    <>
      <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
        {/* A guest's name is generated and cannot be changed: a free-text name
            is precisely what would let two visitors be indistinguishable in a
            shared room. */}
        <div className="flex items-center gap-3.5">
          <span className="flex-none grid place-items-center w-12 h-12 rounded-full bg-white/10 ring-1 ring-white/10 text-white/50 font-semibold">
            ?
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold truncate">{t("auth.guestWord")}</span>
              <span className="text-white/40 text-xs font-mono">
                #{guestTag(identity)}
              </span>
            </div>
            <div className="text-white/50 text-xs mt-0.5">{t("auth.guestDesc")}</div>
          </div>
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

function AccountPanel({
  user,
  onChanged,
}: {
  user: any;
  /** Ask the parent to re-read the account from the database. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { update } = useSession();
  /* The server allows 3 verification mails an hour; this stops the button
     from being mashed into that limit by accident. */
  const [verifyCooldown, setVerifyCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(user.username || "");
  const [nameOk, setNameOk] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  /* Deletion asks for the password inline. It used to go through
     window.prompt(), which shows the password in clear text in a dialog the
     browser doesn't treat as a credential field. */
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  /* Codes mailed by /api/v2/account/challenge. Only accounts with an address
     are challenged — an AniList-only one has no mailbox to prove. */
  const [passwordCode, setPasswordCode] = useState("");
  const [deleteCode, setDeleteCode] = useState("");

  /* "AniList only" = never went through signup, so no e-mail and no password.
     The e-mail is the discriminator, NOT the pseudo: an AniList account now
     gets its AniList name as a pseudo, so `!username` would be wrong. */
  const anilistOnly = !user.email;

  /* The AniScroll pseudo, not session.user.name — that one becomes the AniList
     handle once linked, and this panel is about the account. */
  const displayName = user.username || user.name || "";
  /* The account's own picture first, AniList's as the fallback — one rule,
     one place: lib/auth/avatar.ts. */
  const avatarUrl = pickAvatar(user);

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
    onChanged();
    setRenaming(false);
    notify.success(t("auth.renamed"));
  };

  const changePassword = async () => {
    const data = await call("/api/v2/account/me", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, password, code: passwordCode }),
    });
    if (!data) return;
    setChangingPassword(false);
    setCurrentPassword("");
    setPassword("");
    setPasswordCode("");
    notify.success(t("auth.passwordChanged"));
  };

  useEffect(() => {
    if (verifyCooldown <= 0) return;
    const id = setTimeout(() => setVerifyCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [verifyCooldown]);

  const resendVerification = async () => {
    const data = await call("/api/v2/account/verify-email", { method: "POST" });
    if (!data) return;
    // The route answers `already` when the address got verified elsewhere in
    // the meantime — re-read rather than promise a mail that wasn't sent.
    if (data.already) {
      onChanged();
      return;
    }
    setVerifyCooldown(60);
    notify.success(t("auth.verifySent"));
  };

  const unlinkAniList = async () => {
    const data = await call("/api/v2/account/link-anilist", { method: "DELETE" });
    if (!data) return;
    await update?.();
    onChanged();
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
    const data = await call("/api/v2/account/me", {
      method: "DELETE",
      body: JSON.stringify({ currentPassword: deletePassword, code: deleteCode }),
    });
    if (!data) return;
    // Sign out through NextAuth so the cookie goes with the account.
    await signOut({ redirect: false });
    notify.success(t("auth.deleted"));
  };

  return (
    <>
      <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4 mb-4 flex items-center gap-3.5">
        {/* Plain <img>, not next/image: the URL comes from AniList and an
            unconfigured host throws at render — that is what emptied the
            mobile bar once. An account with no AniList link has no picture
            at all, hence the initial. */}
        <span className="flex-none grid place-items-center w-12 h-12 rounded-full bg-white/10 ring-1 ring-white/10 overflow-hidden text-white/60 font-semibold">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            (displayName || "?").charAt(0).toUpperCase()
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold truncate">{displayName}</span>
            <span className="text-white/40 text-xs font-mono">#{user.tag}</span>
          </div>
          <div className="text-white/50 text-xs mt-0.5">
            {anilistOnly ? t("auth.anilistOnlyDesc") : t("auth.accountDesc")}
          </div>
        </div>
        {/* Signing out belongs to the identity card, not to the list of
            account operations below: it acts on this browser, not on the
            account. Nothing is lost — the data stays on the account. */}
        <button
          type="button"
          disabled={busy}
          className={BTN}
          onClick={() => signOut({ redirect: false })}
        >
          {t("nav.signOut")}
        </button>
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
          {/* Gone entirely once the address is verified — there is nothing
              left to resend. */}
          {user.email && !user.emailVerified && (
            <button
              type="button"
              className={BTN}
              disabled={busy || verifyCooldown > 0}
              onClick={resendVerification}
            >
              {verifyCooldown > 0 ? `${verifyCooldown}s` : t("auth.resend")}
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
              <PasswordField
                value={currentPassword}
                onChange={setCurrentPassword}
                placeholder={t("auth.currentPassword")}
              />
            )}
            <PasswordField
              value={password}
              onChange={setPassword}
              placeholder={t("auth.newPassword")}
              autoComplete="new-password"
            />
            {/* Proof of the mailbox, on top of the session. */}
            {user.email && (
              <EmailCodeField
                action="password"
                value={passwordCode}
                onChange={setPasswordCode}
              />
            )}
            <button
              type="button"
              disabled={
                busy ||
                password.length < 8 ||
                (!!user.email && passwordCode.length !== 6)
              }
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
            /* Straight to the OAuth round-trip: the account stays the one
               signed in, AniList is attached to it. */
            <button
              type="button"
              className={BTN}
              onClick={() => signIn("AniListProvider")}
            >
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
            onClick={() => setDeleting(true)}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-red-500/15 ring-1 ring-red-500/30 text-sm text-red-300 hover:bg-red-500/25 disabled:opacity-50"
          >
            {t("auth.delete")}
          </button>
        </Row>
      </div>

      {/* Deleting asks for the password in a real credential field — it used
          to go through window.prompt() — and confirms with the same
          hold-to-confirm gesture as every other destructive action. */}
      <DangerConfirmModal
        open={deleting}
        title={t("auth.deleteTitle")}
        body={t("auth.deleteConfirm")}
        confirmLabel={t("auth.delete")}
        onConfirm={remove}
        confirmDisabled={!!user.email && deleteCode.length !== 6}
        onCancel={() => {
          setDeleting(false);
          setDeletePassword("");
          setDeleteCode("");
        }}
        busy={busy}
      >
        <div className="flex flex-col gap-3">
          {!anilistOnly && (
            <PasswordField
              value={deletePassword}
              onChange={setDeletePassword}
              placeholder={t("auth.currentPassword")}
              autoFocus
            />
          )}
          {user.email && (
            <EmailCodeField
              action="delete"
              value={deleteCode}
              onChange={setDeleteCode}
            />
          )}
        </div>
      </DangerConfirmModal>

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
  const sessionUser = (session as any)?.user;

  /* The JWT is a cache, refreshed only on an explicit update() — so a mail
     verified in another tab (or from a phone) leaves `emailVerified: false`
     in this session's token, and the panel claimed the address was still
     unverified. This section reads the database instead: it is the one place
     that must show the account's real state. `refresh` re-reads after an
     action changed something. */
  const [fresh, setFresh] = useState<any>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!sessionUser?.uid) {
      setFresh(null);
      return;
    }
    let cancelled = false;
    fetch("/api/v2/account/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.user) setFresh(data.user);
      })
      .catch(() => {
        /* the session's own claims remain as the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionUser?.uid, refresh]);

  const user = fresh
    ? { ...sessionUser, ...fresh, emailVerified: fresh.emailVerifiedAt != null }
    : sessionUser;

  /* The verification link lands here with ?verify=ok|invalid (it is clicked
     from a mail client, so the outcome has to travel in the URL).

     It used to be announced with a toast, which is the wrong instrument: the
     link is very often opened on another device — a phone, from the mailbox —
     where nobody is signed in and the page has nothing else to say. A toast
     that has already faded, or was missed while the page loaded, leaves the
     visitor with no idea whether it worked. The outcome stays on screen. */
  const [verified, setVerified] = useState<"ok" | "invalid" | null>(null);

  useEffect(() => {
    const verify = router.query.verify;
    if (verify !== "ok" && verify !== "invalid") return;
    setVerified(verify);
    if (verify === "ok") {
      void update?.();
      setRefresh((n) => n + 1);
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

      {verified && (
        <div
          className={`mb-4 rounded-xl px-4 py-3 text-sm ring-1 ${
            verified === "ok"
              ? "bg-green-500/10 ring-green-500/30 text-green-200"
              : "bg-red-500/10 ring-red-500/30 text-red-200"
          }`}
        >
          <div className="font-medium">
            {t(verified === "ok" ? "auth.verifyOk" : "auth.verifyInvalid")}
          </div>
          {/* Confirmed from a device that isn't signed in — say what to do
              next, rather than leaving a stranger's settings page open. */}
          {verified === "ok" && !user?.uid && (
            <div className="mt-1 text-white/60 text-xs">
              {t("auth.verifySignedOut")}
            </div>
          )}
        </div>
      )}

      {user?.uid ? (
        <AccountPanel user={user} onChanged={() => setRefresh((n) => n + 1)} />
      ) : (
        <GuestPanel />
      )}
    </section>
  );
}
