/**
 * Sign in / sign up / forgot password, in one modal with three views.
 *
 * Same shell as SyncDirectionModal (backdrop click closes, `bg-secondary`
 * card) so the site keeps one dialog idiom.
 *
 * Signing up carries the guest's local data along in `snapshot`: a visitor who
 * built a list before creating an account must not lose it at the moment they
 * decide to keep it. Sign-in then pulls whatever the server already had.
 */

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notifications/noticeStore";
import { snapshotAll } from "@/lib/list/cloudSync";
import UsernameField from "./UsernameField";
import PasswordField from "./PasswordField";

type View = "signin" | "signup" | "forgot";

const INPUT =
  "w-full rounded-lg bg-white/5 ring-1 ring-white/10 px-3 py-2.5 text-sm outline-none focus:ring-action/50";

/** AniList "A" mark, same artwork as SyncDirectionModal. */
function AniListIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 41 30" fill="none" aria-hidden>
      <path
        fill="#00A8FF"
        d="M27.825 21.773V2.977c0-1.077-.613-1.672-1.725-1.672h-3.795c-1.111 0-1.725.595-1.725 1.672v8.927c0 .251 2.5 1.418 2.565 1.665 1.904 7.21.414 12.982-1.392 13.251 2.952.142 3.277 1.517 1.078.578.337-3.848 1.65-3.84 5.422-.142.032.032.774 1.539.82 1.539h8.91c1.113 0 1.726-.594 1.726-1.672v-3.677c0-1.078-.614-1.672-1.725-1.672H27.825z"
      />
      <path
        fill="#fff"
        d="M12.07 1.306l-9.966 27.49h7.743l1.687-4.756h8.433l1.649 4.755h7.705l-9.929-27.49H12.07zm1.227 16.642l2.415-7.615 2.645 7.615h-5.06z"
      />
    </svg>
  );
}

export default function AuthModal({
  open,
  onClose,
  initialView = "signin",
}: {
  open: boolean;
  onClose: () => void;
  initialView?: View;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>(initialView);
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [usernameOk, setUsernameOk] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const close = () => {
    if (busy) return;
    onClose();
  };

  async function doSignIn() {
    setBusy(true);
    const res = await signIn("aniscroll", {
      identifier,
      password,
      redirect: false,
    });
    setBusy(false);
    if (res?.error) {
      // NextAuth collapses every authorize() failure into CredentialsSignin;
      // the throttle is the one case worth naming separately.
      notify.error(
        res.error.includes("throttled")
          ? t("auth.errors.throttled")
          : t("auth.errors.badCredentials")
      );
      return;
    }
    notify.success(t("auth.signedIn"));
    onClose();
  }

  async function doSignUp() {
    setBusy(true);
    try {
      const res = await fetch("/api/v2/account/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          username,
          password,
          // Bring the guest's list, progress and settings over.
          snapshot: snapshotAll(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify.error(t(`auth.errors.${data.code || data.error}`, t("auth.errors.generic")));
        return;
      }
      // Sign in straight away so the new account is usable without a second form.
      await signIn("aniscroll", { identifier: email, password, redirect: false });
      notify.success(t("auth.accountCreated"));
      onClose();
    } catch {
      notify.error(t("auth.errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function doForgot() {
    setBusy(true);
    try {
      await fetch("/api/v2/account/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // The endpoint answers 200 whether or not the address exists, and so
      // does this message — it must not reveal who has an account.
      notify.success(t("auth.resetSent"));
      setView("signin");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    view === "signin"
      ? identifier.trim() && password
      : view === "signup"
      ? email.trim() && usernameOk && password.length >= 8
      : email.trim();

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
      onClick={close}
    >
      <div
        className="w-full max-w-md rounded-xl bg-secondary ring-1 ring-white/10 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-1">
          {t(`auth.${view}Title`)}
        </h3>
        <p className="text-white/60 text-sm mb-5">{t(`auth.${view}Body`)}</p>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !canSubmit) return;
            if (view === "signin") void doSignIn();
            else if (view === "signup") void doSignUp();
            else void doForgot();
          }}
        >
          {view === "signin" && (
            <>
              <label className="block">
                <span className="block text-sm text-white/70 mb-1.5">
                  {t("auth.identifierLabel")}
                </span>
                <input
                  className={INPUT}
                  autoFocus
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                />
              </label>
              <PasswordField
                label={t("auth.passwordLabel")}
                value={password}
                onChange={setPassword}
              />
            </>
          )}

          {view === "signup" && (
            <>
              <UsernameField
                value={username}
                onChange={setUsername}
                onValidity={setUsernameOk}
                autoFocus
              />
              <label className="block">
                <span className="block text-sm text-white/70 mb-1.5">
                  {t("auth.emailLabel")}
                </span>
                <input
                  className={INPUT}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <PasswordField
                label={t("auth.passwordLabel")}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                hint={t("auth.passwordHint")}
              />
            </>
          )}

          {view === "forgot" && (
            <label className="block">
              <span className="block text-sm text-white/70 mb-1.5">
                {t("auth.emailLabel")}
              </span>
              <input
                className={INPUT}
                type="email"
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}

          <button
            type="submit"
            disabled={busy || !canSubmit}
            className="mt-1 w-full rounded-lg bg-action px-4 py-2.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {busy ? t("auth.working") : t(`auth.${view}Action`)}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 text-xs text-white/30">
          <span className="h-px flex-1 bg-white/10" />
          {t("auth.or")}
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => signIn("AniListProvider")}
          className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-white/5 ring-1 ring-white/10 px-4 py-2.5 text-sm hover:bg-white/10 disabled:opacity-50"
        >
          <AniListIcon />
          {t("auth.continueWithAniList")}
        </button>

        <div className="mt-5 flex items-center justify-between text-xs text-white/50">
          {view === "signin" ? (
            <>
              <button type="button" onClick={() => setView("forgot")} className="hover:text-white">
                {t("auth.forgotLink")}
              </button>
              <button type="button" onClick={() => setView("signup")} className="hover:text-white">
                {t("auth.toSignup")}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setView("signin")} className="hover:text-white">
              {t("auth.toSignin")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
