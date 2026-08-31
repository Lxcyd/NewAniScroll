import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { signIn } from "next-auth/react";
import { useTranslation } from "react-i18next";

import { Navbar } from "@/components/shared/NavBar";

/**
 * The only page NextAuth is allowed to send anyone to.
 *
 * It replaces BOTH of the built-in ones. The default sign-in page lists every
 * provider that exists — password, e-mail-confirmation token, AniList — and it
 * surfaces on any failed `signIn()`, so clicking "link my AniList account"
 * could land on a form asking for an AniScroll password. AniScroll has its own
 * sign-in UI (components/auth/AuthModal.tsx); the hosted one only ever appeared
 * by accident, and when it did it offered the wrong things.
 *
 * So: one route, one action — AniList — plus the reason, when there is one.
 * The default error page is replaced for the same reason it existed at all: an
 * AniList outage used to bounce the visitor back with nothing but `?error=` in
 * a URL nobody reads.
 *
 * The precise cause is logged server-side; NextAuth's own codes are coarse
 * (`Callback`, `OAuthCallback`, `OAuthAccountNotLinked`…) and none of them are
 * worth showing raw.
 */
const KNOWN: Record<string, string> = {
  "anilist-already-linked": "auth.errors.anilist-already-linked",
  "anilist-unavailable": "auth.errors.anilist-unavailable",
  AccessDenied: "auth.errors.generic",
  /* `Callback` est le code que NextAuth pose sur TOUT echec survenu apres le
     retour d'AniList, et il ecrase le notre : une erreur levee dans le callback
     `jwt` (« ce compte AniList est deja lie ailleurs ») ressort ici sous le meme
     mot qu'un echange de jeton en echec. Mesure du 31/08/2026 sur les logs de
     dev : les deux causes sont arrivees dans la meme minute.
     Tant que les deux partagent un code, le message nomme les deux et dit quoi
     faire — c'est plus honnete que d'affirmer « AniList ne repond pas » quand la
     moitie du temps AniList a parfaitement repondu.
     `CredentialsSignin` reste dehors : il vient du formulaire mot de passe, pas
     d'ici. */
  Callback: "auth.errors.callbackBody",
  OAuthCallback: "auth.errors.callbackBody",
  OAuthSignin: "auth.errors.anilist-unavailable",
};

export default function AniListSignIn() {
  const { t } = useTranslation();
  const router = useRouter();
  const code = String(router.query.error || "");
  const callbackUrl = String(router.query.callbackUrl || "/en/settings");
  const reason = code ? KNOWN[code] || "auth.errors.signInFailedBody" : null;

  return (
    <>
      <Head>
        <title>
          {(code ? t("auth.errors.signInFailed") : t("nav.signInWithAniList")) +
            " • AniScroll"}
        </title>
        <meta name="robots" content="noindex" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>
      <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />

      <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
        {reason ? (
          <>
            <h1 className="mb-3 font-outfit text-2xl font-bold">
              {t("auth.errors.signInFailed")}
            </h1>
            <p className="mb-8 max-w-md text-sm text-white/60">{t(reason)}</p>
          </>
        ) : (
          <h1 className="mb-8 font-outfit text-2xl font-bold">
            {t("nav.signInWithAniList")}
          </h1>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => signIn("AniListProvider", { callbackUrl })}
            className="rounded-lg bg-[#02a9ff] px-5 py-2.5 text-sm font-bold text-white transition-transform hover:scale-105"
          >
            {t("nav.signInWithAniList")}
          </button>
          <Link
            href="/en/settings"
            className="rounded-lg px-4 py-2 text-sm ring-1 ring-white/15 hover:bg-white/5"
          >
            {t("auth.errors.backToSettings")}
          </Link>
        </div>
      </div>
    </>
  );
}
