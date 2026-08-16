/* Browser-level proof for the back/forward fix.
 * Exercises the exact broken path: a FRENCH session where every client nav
 * triggers the I18nProvider locale swap (/en → /fr) + slug decoration, which
 * used to null Next's history state and kill popstate navigation.
 *
 *   node scripts/_navtest.mjs
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const ok = (b, msg) => {
  console.log(`${b ? "✓" : "✗ FAIL"}  ${msg}`);
  if (!b) process.exitCode = 1;
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(45000);

// Force a French session before any page script runs.
await page.addInitScript(() => {
  try { localStorage.setItem("aniscroll.lang", "fr"); } catch {}
});

// 1) Home in French.
await page.goto(`${BASE}/fr`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500); // let hydration + locale sync settle

// 2) SPA-navigate to anime #1 via the Next router (links in the app are /en/*,
//    the I18nProvider then swaps the visible URL to /fr — the critical path).
await page.evaluate(() => window.next.router.push("/en/anime/21/one-piece"));
await page.waitForURL("**/anime/21/**");
await page.waitForTimeout(2500); // slug decoration + locale swap effects

const url1 = page.url();
const state1 = await page.evaluate(() => window.history.state);
ok(url1.includes("/fr/anime/21"), `URL localisée après nav SPA: ${url1}`);
ok(!!state1 && state1.__N === true, `history.state préservé (__N) après locale-swap+slug: ${JSON.stringify(state1 && { __N: state1.__N, as: state1.as })}`);

// 3) SPA-navigate to anime #2.
await page.evaluate(() => window.next.router.push("/en/anime/16498/attack-on-titan"));
await page.waitForURL("**/anime/16498/**");
await page.waitForTimeout(2500);
const state2 = await page.evaluate(() => window.history.state);
ok(!!state2 && state2.__N === true, "history.state préservé sur la 2e page");

// 4) BACK → must actually re-render anime #1 (not just change the URL bar).
await page.goBack();
await page.waitForTimeout(3000);
const backUrl = page.url();
const backHasOnePiece = await page.evaluate(() =>
  /one piece/i.test(document.body.innerText),
);
ok(backUrl.includes("/anime/21"), `BACK: URL → ${backUrl}`);
ok(backHasOnePiece, "BACK: le contenu ONE PIECE est bien re-rendu");

// 5) BACK again → home.
await page.goBack();
await page.waitForTimeout(3000);
const homeUrl = page.url();
const isHome = /\/(fr|en)\/?$/.test(new URL(homeUrl).pathname);
ok(isHome, `BACK×2: retour à l'accueil → ${homeUrl}`);

// 6) FORWARD → anime #1 re-rendered again.
await page.goForward();
await page.waitForTimeout(3000);
const fwdUrl = page.url();
const fwdHasOnePiece = await page.evaluate(() =>
  /one piece/i.test(document.body.innerText),
);
ok(fwdUrl.includes("/anime/21"), `FORWARD: URL → ${fwdUrl}`);
ok(fwdHasOnePiece, "FORWARD: le contenu ONE PIECE est bien re-rendu");

await browser.close();
console.log(process.exitCode ? "\n=== ÉCHEC ===" : "\n=== TOUT PASSE ===");
