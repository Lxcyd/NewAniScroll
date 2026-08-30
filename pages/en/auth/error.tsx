import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";

import { Navbar } from "@/components/shared/NavBar";

/**
 * Where a failed sign-in lands.
 *
 * Without it, NextAuth bounced an OAuth failure back with nothing but
 * `?error=Callback` in a URL nobody reads: an AniList outage looked like the
 * button had simply done nothing, and the visitor was left on their previous
 * session wondering what had happened to their account.
 *
 * The reasons NextAuth can send here are coarse (`Callback`, `OAuthCallback`,
 * `AccessDenied`…) — the precise one is logged server-side. What matters on
 * screen is the honest part: it failed, it failed on AniList's side, and
 * nothing was changed here.
 */
const KNOWN: Record<string, string> = {
  "anilist-already-linked": "auth.errors.anilist-already-linked",
  "anilist-unavailable": "auth.errors.anilist-unavailable",
  AccessDenied: "auth.errors.generic",
};

export default function AuthError() {
  const { t } = useTranslation();
  const router = useRouter();
  const code = String(router.query.error || "");
  const detail = KNOWN[code] ? t(KNOWN[code]) : t("auth.errors.signInFailedBody");

  return (
    <>
      <Head>
        <title>{t("auth.errors.signInFailed")} • AniScroll</title>
        <meta name="robots" content="noindex" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>
      <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />

      <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <h1 className="mb-3 font-outfit text-2xl font-bold">
          {t("auth.errors.signInFailed")}
        </h1>
        <p className="mb-8 max-w-md text-sm text-white/60">{detail}</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/en/settings"
            className="rounded-lg bg-action px-4 py-2 text-sm font-bold text-white"
          >
            {t("auth.errors.backToSettings")}
          </Link>
          <Link
            href="/en"
            className="rounded-lg px-4 py-2 text-sm ring-1 ring-white/15 hover:bg-white/5"
          >
            AniScroll
          </Link>
        </div>
      </div>
    </>
  );
}
