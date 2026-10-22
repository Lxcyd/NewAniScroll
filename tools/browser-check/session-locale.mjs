/**
 * Une session NextAuth pour le site LOCAL, le temps d'une capture.
 *
 *   node tools/browser-check/session-locale.mjs [admin]
 *
 * Imprime « next-auth.session-token=<jeton> », a passer a mobile-audit.mjs par
 * la variable COOKIE. Le jeton est chiffre avec le NEXTAUTH_SECRET du .env, que
 * le script lit sans jamais l'afficher. `admin` : role admin et nom
 * ADMIN_USERNAME, ce qu'exigent les pages /admin (isAdminSession et
 * fanarts-review).
 *
 * POUR LOCALHOST SEULEMENT : le cookie est pose sur l'hote teste, et ne vaut
 * que la ou ce meme secret dechiffre. Aucune ligne n'est ecrite en base — la
 * session de ce site vit dans le jeton (callbacks jwt/session de
 * pages/api/auth/[...nextauth].ts), seule `update()` relit le compte.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { encode } = require("next-auth/jwt");

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
    }),
);
const secret = process.env.NEXTAUTH_SECRET || env.NEXTAUTH_SECRET;
if (!secret) {
  console.error("NEXTAUTH_SECRET absent du .env");
  process.exit(1);
}
const admin = process.argv[2] === "admin";
const name = admin ? process.env.ADMIN_USERNAME || env.ADMIN_USERNAME || "admin" : "Testeur";
const token = await encode({
  secret,
  token: {
    name,
    username: name,
    uid: "local-capture",
    id: "local-capture",
    sub: "local-capture",
    /* /admin renvoie la session telle quelle depuis getServerSideProps : un
       champ `undefined` n'y est pas serialisable. */
    token: null,
    list: null,
    image: null,
    tag: "0000",
    role: admin ? "admin" : "user",
  },
  maxAge: 60 * 60,
});
process.stdout.write(`next-auth.session-token=${token}`);
