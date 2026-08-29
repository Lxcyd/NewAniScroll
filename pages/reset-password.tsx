/**
 * Landing page for the reset link mailed by lib/auth/mail.ts.
 *
 * Lives at the root rather than under /en so the URL in the e-mail stays
 * short and language-independent — the page reads the visitor's own language
 * from i18n like everything else.
 */

import Head from "next/head";
import { useRouter } from "next/router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import { notify } from "@/lib/notifications/noticeStore";
import PasswordField from "@/components/auth/PasswordField";

export default function ResetPassword() {
  const { t } = useTranslation();
  const router = useRouter();
  const token = typeof router.query.token === "string" ? router.query.token : "";

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || password.length < 8) return;
    setBusy(true);
    try {
      const res = await fetch("/api/v2/account/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify.error(t(`auth.errors.${data.code || data.error}`, t("auth.errors.generic")));
        return;
      }
      setDone(true);
      notify.success(t("auth.passwordChanged"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head>
        <title>{t("auth.forgotTitle")} — AniScroll</title>
        {/* A password page has no business in a search index. */}
        <meta name="robots" content="noindex" />
      </Head>
      <Navbar />
      <div className="min-h-screen grid place-items-center px-4 py-28">
        <div className="w-full max-w-md rounded-xl bg-secondary ring-1 ring-white/10 p-6">
          <h1 className="text-lg font-semibold mb-1">{t("auth.forgotTitle")}</h1>

          {done ? (
            <>
              <p className="text-white/60 text-sm mb-5">{t("auth.passwordChanged")}</p>
              <button
                type="button"
                onClick={() => router.push("/")}
                className="w-full rounded-lg bg-action px-4 py-2.5 text-sm font-medium text-white hover:brightness-110"
              >
                {t("auth.signinAction")}
              </button>
            </>
          ) : (
            <form onSubmit={submit}>
              <p className="text-white/60 text-sm mb-5">{t("auth.passwordHint")}</p>
              <PasswordField
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                autoFocus
                placeholder={t("auth.newPassword")}
              />
              <button
                type="submit"
                disabled={busy || !token || password.length < 8}
                className="mt-4 w-full rounded-lg bg-action px-4 py-2.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {busy ? t("auth.working") : t("auth.save")}
              </button>
            </form>
          )}
        </div>
      </div>
      <Footer />
    </>
  );
}
