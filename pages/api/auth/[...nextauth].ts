import NextAuth, { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import {
  attachAniList,
  backfillUsername,
  createAnilistAccount,
  findByAnilistId,
  findByIdentifier,
  findById,
  touchLastSeen,
  type UserRecord,
} from "@/lib/auth/users";
import { verifyPassword } from "@/lib/auth/password";
import { checkThrottle, resetThrottle } from "@/lib/auth/throttle";
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

        return {
          ...accountClaims(user),
          id: user.anilistId ? String(user.anilistId) : user.id,
          name: user.anilistName || user.username,
          image: user.avatarUrl || null,
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
          // console.log(context.tokens.access_token);
          const { data } = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // ...(context.tokens.access_token && {
              Authorization: `Bearer ${context.tokens.access_token}`,
              // }),
            },
            body: JSON.stringify({
              query: `
              query {
                Viewer {
                  id
                  name
                  avatar {
                    large
                    medium
                  }
                  bannerImage
                  mediaListOptions {
                    animeList {
                      customLists
                    }
                  }
                }
              }
            `,
            }),
          }).then((res) => res.json());

          const userLists = data.Viewer?.mediaListOptions.animeList.customLists;

          let custLists = userLists || [];

          if (!userLists?.includes("Watched using Moopa")) {
            custLists.push("Watched using Moopa");
            const fetchGraphQL = async (
              query: string,
              variables: { lists: any }
            ) => {
              const response = await fetch("https://graphql.anilist.co/", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(context.tokens.access_token && {
                    Authorization: `Bearer ${context.tokens.access_token}`,
                  }),
                },
                body: JSON.stringify({ query, variables }),
              });
              return response.json();
            };

            const customLists = async (lists: any) => {
              const setList = `
                  mutation($lists: [String]){
                    UpdateUser(animeListOptions: { customLists: $lists }){
                      id
                    }
                  }
                `;
              const data = await fetchGraphQL(setList, { lists });
              return data;
            };

            await customLists(custLists);
          }

          return {
            token: context.tokens.access_token,
            name: data.Viewer.name,
            sub: data.Viewer.id,
            image: data.Viewer.avatar,
            list: data.Viewer?.mediaListOptions.animeList.customLists,
          };
        },
      },
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
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
            // account. This is the hierarchy the user asked for.
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
              // same row — that is what brings the backed-up data back.
              record = existing
                ? await backfillUsername(existing)
                : await createAnilistAccount({ anilistId, anilistName, avatarUrl });
            }

            if (record) {
              if (record.status === "disabled") throw new Error("account-disabled");
              void touchLastSeen(record.id);
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
      if (account?.provider === "aniscroll" && user) {
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

export default NextAuth(authOptions);
