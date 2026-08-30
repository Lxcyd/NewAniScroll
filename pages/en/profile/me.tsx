import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect } from "react";
import { useSession } from "next-auth/react";

import { Navbar } from "@/components/shared/NavBar";
import { profileHref } from "@/lib/profile/href";

/**
 * Kept as a redirect, not deleted: this URL was minted in links and may sit in
 * someone's history.
 *
 * A signed-out visitor's own page is /en/my-list — same shell, same plate, same
 * stats as a real profile, but named for what it is, since a list held in one
 * browser is not a profile anyone could visit. Someone signed in has a real,
 * shareable profile and is sent to it.
 */
export default function MyOwnProfile() {
  const router = useRouter();
  const { data: session, status }: { data: any; status: string } = useSession();

  useEffect(() => {
    if (status === "loading") return;
    router.replace(session?.user ? profileHref(session.user) : "/en/my-list");
  }, [session, status, router]);

  return (
    <>
      <Head>
        <meta name="robots" content="noindex" />
      </Head>
      <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />
    </>
  );
}
