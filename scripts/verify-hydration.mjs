/**
 * Hydration regression check. Loads the home page and an anime info page,
 * captures EVERY console error + pageerror, and asserts none mention React
 * hydration (the #418/#423/#425 family, or the dev-mode "hydration"/"did not
 * match" text). Run against the dev server (non-minified messages).
 *
 * Also flips the fanart-proxy-exhausted session flag on a second load to make
 * sure the post-mount src swap still doesn't reintroduce a mismatch.
 *
 * Usage: node scripts/verify-hydration.mjs   (dev server on :3000)
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const HYDRATION_RE =
  /hydrat|did not match|#418|#423|#425|Minified React error #4(18|23|25)/i;

const browser = await chromium.launch();
let failures = 0;

async function load(label, path, { flagExhausted = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + (e.message || e)));

  if (flagExhausted) {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("fanart-proxy-exhausted", "1");
      } catch {}
    });
  }

  await page.goto(`${BASE}${path}`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  // Let hydration + post-mount effects (the fanart swap) run.
  await page.waitForTimeout(4500);

  const hydrationErrors = errors.filter((e) => HYDRATION_RE.test(e));
  const ok = hydrationErrors.length === 0;
  console.log(
    `${ok ? "✓" : "✗"} ${label}${flagExhausted ? " (proxy exhausted)" : ""}`,
  );
  if (!ok) {
    failures++;
    for (const e of hydrationErrors.slice(0, 6)) console.log("    •", e);
  }
  // Surface any OTHER console errors for visibility (don't fail on them).
  const others = errors.filter((e) => !HYDRATION_RE.test(e));
  if (others.length) {
    console.log(`    (${others.length} autres erreurs console non-hydratation)`);
  }
  await page.close();
}

await load("Accueil — hydratation", "/en");
await load("Accueil — hydratation", "/en", { flagExhausted: true });
await load("Info page — hydratation", "/en/anime/112151/dr-stone");
await load("Info page — hydratation", "/en/anime/112151/dr-stone", {
  flagExhausted: true,
});

await browser.close();
console.log(
  failures === 0
    ? "\n=== AUCUNE ERREUR D'HYDRATATION ==="
    : `\n=== ${failures} PAGE(S) AVEC ERREUR D'HYDRATATION ===`,
);
process.exit(failures === 0 ? 0 : 1);
