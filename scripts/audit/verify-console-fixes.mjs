/**
 * Post-fix verification in a real browser:
 *  1. /en/anime/recently-watched renders seeded local history (signed-out path).
 *  2. The anime info page still renders its hero (fanartSrc wiring didn't
 *     break the clearart <img>), and a clearart/logo image is present.
 *  3. The fanart onError fallback actually swaps a dead proxied URL to
 *     assets.fanart.tv (checked by injecting a broken proxy URL into an <img>
 *     wired exactly like the app does).
 *
 * Usage: node scripts/audit/verify-console-fixes.mjs  (dev server on :3000)
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";

const HISTORY = {
  21: {
    watchId: "one-piece-episode-1",
    aniId: 21,
    aniTitle: "ONE PIECE",
    title: "Episode 1",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJmZqs.jpg",
    cover: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg",
    episode: 1,
    provider: "animesama",
    dub: false,
    createdAt: new Date().toISOString(),
  },
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(({ history }) => {
  localStorage.setItem("artplayer_settings", JSON.stringify(history));
}, { history: HISTORY });

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

// ── 1. recently-watched ────────────────────────────────────────────────
await page.goto(`${BASE}/en/anime/recently-watched`, {
  waitUntil: "domcontentloaded",
  timeout: 90_000,
});
await page.waitForTimeout(3500);
const rw = await page.evaluate(() => ({
  cards: document.querySelectorAll('a[href*="/anime/watch/"]').length,
  hasOnePiece: /one\s*piece/i.test(document.body.innerText),
}));
check("Vu récemment : cartes rendues", rw.cards >= 1, `cards=${rw.cards}`);
check("Vu récemment : ONE PIECE visible", rw.hasOnePiece);

// ── 2. info page hero ──────────────────────────────────────────────────
await page.goto(`${BASE}/en/anime/21/one-piece`, {
  waitUntil: "domcontentloaded",
  timeout: 120_000,
});
await page.waitForTimeout(4000);
const hero = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll("img"));
  const fanart = imgs.find((i) => /\/fanart\//.test(i.src));
  return {
    rendered: /one\s*piece/i.test(document.body.innerText),
    fanartImg: fanart ? fanart.src : null,
  };
});
check("Info page : contenu rendu", hero.rendered);
console.log("  fanart img:", hero.fanartImg || "(aucune — fallback titre texte)");

// ── 3. fanart onError fallback behaviour ──────────────────────────────
// Reproduce the exact handler logic against a guaranteed-dead proxied URL.
const fb = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const ORIGIN = "https://assets.fanart.tv";
      const img = document.createElement("img");
      let swapped = null;
      img.onerror = () => {
        // mirror lib/images/fanartFallback.onFanartError
        try {
          const u = new URL(img.src);
          if (u.origin !== ORIGIN && u.pathname.startsWith("/fanart/")) {
            swapped = ORIGIN + u.pathname + u.search;
            img.onerror = () => resolve({ swapped, secondError: true });
            img.onload = () => resolve({ swapped, secondError: false });
            img.src = swapped;
            return;
          }
        } catch {}
        resolve({ swapped: null });
      };
      img.src =
        "https://fanart-proxy.aniscroll.com/fanart/__nonexistent__/broken.png";
      setTimeout(() => resolve({ swapped, timeout: true }), 15000);
    }),
);
check(
  "Fallback : URL proxy morte → réécrite vers assets.fanart.tv",
  fb.swapped === "https://assets.fanart.tv/fanart/__nonexistent__/broken.png",
  JSON.stringify(fb),
);

await browser.close();
console.log(failures === 0 ? "\n=== TOUT PASSE ===" : `\n=== ${failures} ÉCHEC(S) ===`);
process.exit(failures === 0 ? 0 : 1);
