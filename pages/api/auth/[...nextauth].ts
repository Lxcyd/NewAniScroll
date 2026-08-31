import type { NextApiRequest, NextApiResponse } from "next";
import NextAuth, { NextAuthOptions } from "next-auth";
import { getToken } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import {
  attachAniList,
  backfillUsername,
  createAnilistAccount,
  findByAnilistId,
  findByIdentifier,
  findById,
  getAnilistSession,
  markEmailVerified,
  setAnilistSession,
  touchLastSeen,
  type UserRecord,
} from "@/lib/auth/users";
import { pickAvatar } from "@/lib/auth/avatar";
import { verifyPassword } from "@/lib/auth/password";
import { checkThrottle, resetThrottle } from "@/lib/auth/throttle";
import { consumeToken, pruneTokens } from "@/lib/auth/tokens";
import { getUsersClient } from "@/lib/db/turso-users";

/**
 * Two ways in, one identity.
 *
 *   AniListProvider  — the historical OAuth path, untouched in its userinfo
 *                      request (it still creates the custom list on first
 *                      login). What changed is what happens AFTER: we now
 *                      resolve, create or LINK a row in the users database.
 *   aniscroll        — e-mail/pseudo + password, scrypt-verified.
 *
 * The AniScroll account takes precedence: when a session already carries a
 * `uid`, an AniList sign-in links to it instead of creating a second account,
 * and refuses if that AniList id already belongs to someone else.
 *
 * Session shape is explicit (see the jwt callback). `session.user.name`,
 * `.token`, `.id`/`.sub`, `.image` and `.list` keep their AniList semantics —
 * utils/request, lib/list/syncEngine, lib/anilist/favouritesCache,
 * lib/auth/isAdmin, lib/watch2gether/auth and the admin routes all depend on
 * them.
 */

const VIEWER_QUERY = `
  query {
    Viewer {
      id
      name
      avatar { large medium }
      bannerImage
      mediaListOptions { animeList { customLists } }
    }
  }
`;

/**
 * Who is signing in, according to AniList.
 *
 * This used to be one `fetch(...).then(res => res.json())`. When AniList is
 * down it does not answer JSON — it answers a Cloudflare HTML page — so the
 * parse threw `Unexpected token '<'`, NextAuth reported OAUTH_CALLBACK_ERROR,
 * and the visitor was bounced back to where they came from with no explanation
 * and their previous session still in place. An outage at AniList must read as
 * an outage at AniList.
 *
 * One retry, because these blips last seconds; then a named error the sign-in
 * can show.
 */
async function viewerOf(accessToken: string): Promise<any> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700));
    try {
      const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: VIEWER_QUERY }),
      });
      const body = await res.text();
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        continue;
      }
      let json: any;
      try {
        json = JSON.parse(body);
      } catch {
        // An HTML error page, i.e. AniList is not serving GraphQL right now.
        last = `non-JSON (${body.slice(0, 40).replace(/\s+/g, " ")})`;
        continue;
      }
      if (json?.data?.Viewer?.id) return json.data;
      last = json?.errors?.[0]?.message || "no Viewer";
    } catch (err: any) {
      last = err?.message || "network";
    }
  }
  console.error("[nextauth] AniList viewer unavailable:", last);
  throw new Error("anilist-unavailable");
}

/** Shrink a users row to the fields the JWT carries. */
function accountClaims(user: UserRecord) {
  return {
    uid: user.id,
    tag: user.tag,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerifiedAt != null,
    role: user.role,
    anilistId: user.anilistId,
    // The resolved picture: the account's own, AniList's when it has none.
    avatarUrl: pickAvatar(user),
  };
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    CredentialsProvider({
      id: "aniscroll",
      name: "AniScroll",
      credentials: {
        identifier: { label: "E-mail or username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const identifier = String(credentials?.identifier || "").trim();
        const password = String(credentials?.password || "");
        if (!identifier || !password) return null;
        if (!getUsersClient()) return null;

        // Throttle on the identifier: an IP key here would be defeated by a
        // botnet, and the account is what we actually need to protect.
        const key = `login:${identifier.toLowerCase()}`;
        const gate = await checkThrottle(key, 10, 15 * 60 * 1000);
        if (!gate.ok) throw new Error("throttled");

        const user = await findByIdentifier(identifier);
        if (!user || user.status === "disabled") return null;
        if (!(await verifyPassword(password, user.passwordHash))) return null;

        await resetThrottle(key);
        void touchLastSeen(user.id);

        /* The AniList half of the account, restored from the row. Without it a
           password sign-in on a linked account produced a session with no
           AniList access token, and the sync panel — which reads exactly that
           — announced "Not connected" under an account the settings showed as
           linked. */
        const anilist = user.anilistId
          ? await getAnilistSession(user.id)
          : { token: null, lists: [] };

        return {
          ...accountClaims(user),
          id: user.anilistId ? String(user.anilistId) : user.id,
          name: user.anilistName || user.username,
          image: pickAvatar(user),
          token: anilist.token ?? undefined,
          list: anilist.lists,
        } as any;
      },
    }),
    /**
     * The link mailed to confirm an address, used as a way in.
     *
     * The link is very often opened somewhere else than where the account was
     * created — the mailbox is on the phone, the signup was on a PC — and that
     * device then has a confirmed account it is not signed into. Clicking the
     * link signs it in.
     *
     * What makes that acceptable rather than a back door: the token is burned
     * here, on a POST made by the browser, and NOT by the GET that opened the
     * link. Mail scanners, link previews and antivirus prefetchers follow the
     * GET; none of them submit this form, so none of them can consume the
     * token or open a session. It stays single-use, 24 h, and the page strips
     * it from the URL before submitting it.
     */
    CredentialsProvider({
      id: "verify",
      name: "E-mail confirmation",
      credentials: { token: { label: "Token", type: "text" } },
      async authorize(credentials) {
        const token = String(credentials?.token || "");
        if (!token || !getUsersClient()) return null;

        const userId = await consumeToken(token, "verify");
        if (!userId) return null;

        await markEmailVerified(userId);
        void pruneTokens();

        const user = await findById(userId);
        if (!user || user.status === "disabled") return null;
        void touchLastSeen(user.id);

        const anilist = user.anilistId
          ? await getAnilistSession(user.id)
          : { token: null, lists: [] };

        return {
          ...accountClaims(user),
          id: user.anilistId ? String(user.anilistId) : user.id,
          name: user.anilistName || user.username,
          image: pickAvatar(user),
          token: anilist.token ?? undefined,
          list: anilist.lists,
        } as any;
      },
    }),
    {
      id: "AniListProvider",
      name: "AniList",
      type: "oauth",
      token: "https://anilist.co/api/v2/oauth/token",
      authorization: {
        url: "https://anilist.co/api/v2/oauth/authorize",
        params: { scope: "", response_type: "code" },
      },
      userinfo: {
        url: process.env.GRAPHQL_ENDPOINT,
        async request(context) {
          const data = await viewerOf(context.tokens.access_token as string);

          const userLists = data.Viewer?.mediaListOptions?.animeList?.customLists;

          /* Creating the custom list is a courtesy, not a condition of signing
             in. It used to run unguarded, so a hiccup on this second call —
             AniList answering HTML, a rate limit — took the whole sign-in down
             with it, when the identity had already been established. */
          if (!userLists?.includes("Watched using Moopa")) {
            try {
              await fetch("https://graphql.anilist.co/", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(context.tokens.access_token && {
                    Authorization: `Bearer ${context.tokens.access_token}`,
                  }),
                },
                body: JSON.stringify({
                  query: `
                  mutation($lists: [String]){
                    UpdateUser(animeListOptions: { customLists: $lists }){
                      id
                    }
                  }
                `,
                  variables: { lists: [...(userLists || []), "Watched using Moopa"] },
                }),
              });
            } catch (err) {
              console.warn("[nextauth] custom list not created:", (err as any)?.message);
            }
          }

          return {
            token: context.tokens.access_token,
            name: data.Viewer.name,
            sub: data.Viewer.id,
            image: data.Viewer.avatar,
            list: data.Viewer?.mediaListOptions?.animeList?.customLists ?? [],
          };
        },
      },
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      /* L'ECHANGE DU CODE CONTRE UN JETON, ET SES 3,5 SECONDES.
         openid-client — la bibliotheque qui fait cet appel pour NextAuth —
         coupe a 3500 ms par defaut. MESURE le 31/08/2026 dans les logs de dev :
         `RPError: outgoing request timed out after 3500ms` sur
         /api/auth/callback/AniListProvider, c'est-a-dire une connexion perdue
         alors qu'AniList avait DEJA accorde le code. Le visiteur, lui, voit
         « AniList refuse ou ne repond pas » et recommence — pour retomber sur
         la meme limite.
         10 s : anilist.co/api/v2/oauth/token repond en general en moins d'une
         seconde, la marge n'est pas un budget mais un filet. Au-dela, mieux
         vaut echouer que laisser la fonction serverless attendre. */
      httpOptions: { timeout: 10000 },
      profile(profile) {
        return {
          token: profile.token,
          id: profile.sub,
          name: profile?.name,
          image: profile.image,
          list: profile?.list,
          version: "1.0.1",
        };
      },
    },
  ],
  session: {
    //Sets the session to use JSON Web Token
    strategy: "jwt",
  },
  /* Neither of NextAuth's hosted pages is wanted here.
     - `signIn`: the default lists every provider that exists, password form and
       e-mail-token field included, and it appears on any failed sign-in — so
       clicking "link my AniList account" could end on a password form. The site
       has its own sign-in UI (components/auth/AuthModal.tsx); this route is
       AniList and nothing else.
     - `error`: the default bounced the visitor back with `?error=` in a URL
       nobody reads, still on their old session, with no way to tell that
       anything had gone wrong. */
  pages: { signIn: "/en/auth/anilist", error: "/en/auth/anilist" },
  callbacks: {
    async jwt({ token, user, account, trigger }) {
      // 1. AniList sign-in — resolve the account row, creating or linking it.
      if (account?.provider === "AniListProvider" && user) {
        const anilistId = Number((user as any).id ?? (user as any).sub);
        const anilistName = (user as any).name ?? null;
        const raw = (user as any).image;
        const avatarUrl =
          typeof raw === "string" ? raw : raw?.large || raw?.medium || null;

        if (getUsersClient() && Number.isFinite(anilistId)) {
          try {
            // An AniScroll session already open → link, don't fork a second
            // account. This is the hierarchy the user asked for. The uid is put
            // back on the token by the wrapper below, because NextAuth builds a
            // blank token on every sign-in.
            const currentUid = (token as any)?.uid as string | undefined;
            let record = currentUid ? await findById(currentUid) : null;

            if (record) {
              record = await attachAniList(record.id, {
                anilistId,
                anilistName,
                avatarUrl,
              });
            } else {
              const existing = await findByAnilistId(anilistId);
              // Signing in again with the same AniList id lands on the very
              // same row — that is what brings the backed-up data back. The
              // name and the picture are re-read every time: they belong to
              // AniList and can have changed there, and a row older than the
              // anilist_avatar_url column has none at all.
              record = existing
                ? await backfillUsername(
                    (await attachAniList(existing.id, {
                      anilistId,
                      anilistName,
                      avatarUrl,
                    })) ?? existing
                  )
                : await createAnilistAccount({ anilistId, anilistName, avatarUrl });
            }

            if (record) {
              if (record.status === "disabled") throw new Error("account-disabled");
              void touchLastSeen(record.id);
              /* Keep the credential on the account, not only in this cookie:
                 the next password sign-in has to find it there. */
              await setAnilistSession(record.id, {
                token: (user as any).token,
                lists: (user as any).list,
              });
              Object.assign(token, accountClaims(record));
            }
          } catch (err) {
            // A refused link must not silently produce a half-identity: fail
            // the sign-in so NextAuth redirects with a readable error.
            if (String((err as any)?.message) === "anilist-already-linked") {
              throw new Error("anilist-already-linked");
            }
            console.error("[nextauth] AniList account resolution", err);
          }
        }

        // AniList-specific claims, kept under their historical names.
        (token as any).token = (user as any).token;
        (token as any).list = (user as any).list;
        (token as any).image = (user as any).image;
        (token as any).id = (user as any).id;
        (token as any).sub = String((user as any).id ?? token.sub ?? "");
        (token as any).anilistName = anilistName;
      }

      // 2. Credentials sign-in — authorize() already returned the claims.
      //    Same for the confirmation link, which is a credentials provider too.
      if ((account?.provider === "aniscroll" || account?.provider === "verify") && user) {
        Object.assign(token, user);
      }

      // 3. Explicit refresh from the client (useSession().update()) — the only
      //    time we hit the database on an existing session. _app.tsx disables
      //    periodic refetching for Vercel cost, so the JWT is the cache.
      if (trigger === "update" && (token as any)?.uid) {
        const record = await findById(String((token as any).uid));
        if (record) {
          Object.assign(token, accountClaims(record));
          (token as any).anilistName = record.anilistName;
          // Unlinked since the token was minted: drop the AniList half, or the
          // access token would keep the site syncing to an account the user
          // just detached.
          if (!record.anilistId) {
            (token as any).token = undefined;
            (token as any).list = undefined;
            (token as any).image = null;
            (token as any).id = record.id;
            (token as any).sub = record.id;
          } else if (!(token as any).token) {
            // Linked, but this session was opened with a password before the
            // link existed — take the credential from the account.
            const anilist = await getAnilistSession(record.id);
            if (anilist.token) {
              (token as any).token = anilist.token;
              (token as any).list = anilist.lists;
              (token as any).id = String(record.anilistId);
              (token as any).sub = String(record.anilistId);
            }
          }
        }
      }

      // Display name: the AniList name when linked, else the AniScroll pseudo.
      (token as any).name =
        (token as any).anilistName || (token as any).username || token.name || null;

      return token;
    },
    async session({ session, token }) {
      const t = token as any;
      session.user = {
        // AniScroll account
        uid: t.uid,
        tag: t.tag,
        username: t.username ?? null,
        email: t.email ?? null,
        emailVerified: !!t.emailVerified,
        role: t.role ?? "user",
        // AniList — same names and meanings as before this file grew accounts
        anilistId: t.anilistId ?? null,
        avatarUrl: t.avatarUrl ?? null,
        id: t.id,
        sub: t.sub,
        token: t.token,
        list: t.list,
        image: t.image,
        name: t.name ?? null,
      } as any;
      return session;
    },
  },
};

/**
 * Linking AniList must not swap the account under the visitor.
 *
 * NextAuth does not hand the jwt callback the token it already had: on every
 * sign-in it builds a fresh one from the provider profile (name, email,
 * picture, sub) and calls the callback with that. So the `uid` of an open
 * AniScroll session was invisible there, and an AniList sign-in looked like a
 * first login — it found or created a second account and took over the
 * session, instead of attaching AniList to the account already signed in.
 *
 * The session cookie is still on the request during the OAuth callback (it is
 * SameSite=Lax, and the return from anilist.co is a top-level navigation), so
 * we read it ourselves and seed the token with the uid before the real
 * callback runs. Everything else stays as it was: the account row is the
 * authority, and `attachAniList` still refuses an AniList id owned by someone
 * else.
 */
function optionsForRequest(req: NextApiRequest): NextAuthOptions {
  const base = authOptions.callbacks!.jwt!;
  return {
    ...authOptions,
    callbacks: {
      ...authOptions.callbacks,
      async jwt(params) {
        if (params.account?.provider === "AniListProvider" && !(params.token as any)?.uid) {
          try {
            const previous = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
            const uid = (previous as any)?.uid;
            if (uid) (params.token as any).uid = uid;
          } catch (err) {
            // Unreadable cookie → treat it as no session, the sign-in still
            // works, it just cannot link.
            console.error("[nextauth] previous session", err);
          }
        }
        return base(params);
      },
    },
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return NextAuth(req, res, optionsForRequest(req));
}
