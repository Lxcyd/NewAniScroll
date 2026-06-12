/**
 * Repro: the "Vu récemment" page renders empty while the home carousel shows
 * the same history. Seeds localStorage `artplayer_settings` with rows shaped
 * exactly like what pages/en/anime/watch/[...info].js writes, then opens
 * /en/anime/recently-watched and counts the rendered cards. Also captures
 * every console error / pageerror so a render crash can't hide silently.
 *
 * Usage: node scripts/repro-recently-watched.mjs   (dev server on :3000)
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";

// One full row (what the episode-list effect writes) + one minimal row (what
// the mount effect writes when the episode fetch fails: image null, no nextId).
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
    nextId: "one-piece-episode-2",
    nextNumber: 2,
    dub: false,
    createdAt: new Date().toISOString(),
  },
  146065: {
    watchId: "146065",
    aniId: 146065,
    aniTitle: "Kusuriya no Hitorigoto",
    title: "Episode 3",
    image: null,
    cover: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx146065.jpg",
    episode: 3,
    provider: "animesama",
    dub: false,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  },
};

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));

// Seed storage before any app code runs.
await page.addInitScript(
  ({ history }) => {
    localStorage.setItem("artplayer_settings", JSON.stringify(history));
    localStorage.setItem("aniscroll.lang", "fr"); // French session like the user
  },
  { history: HISTORY },
);

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

// ── 1. The recently-watched page itself ────────────────────────────────
await page.goto(`${BASE}/en/anime/recently-watched`, {
  waitUntil: "domcontentloaded",
  timeout: 90_000,
});
// Give the fetch effect time to settle (profile call + localStorage read).
await page.waitForTimeout(4000);

const result = await page.evaluate(() => {
  const links = Array.from(
    document.querySelectorAll('a[href*="/anime/watch/"]'),
  );
  return {
    cardLinks: links.length,
    hrefs: links.slice(0, 6).map((a) => a.getAttribute("href")),
    bodyHasOnePiece: /one\s*piece/i.test(document.body.innerText),
    bodyText: document.body.innerText.slice(0, 400),
  };
});

check(
  "page affiche des cartes (liens /anime/watch/)",
  result.cardLinks >= 2,
  `trouvé ${result.cardLinks}`,
);
check("ONE PIECE visible dans la page", result.bodyHasOnePiece);
if (result.cardLinks < 2) {
  console.log("  body sample:", JSON.stringify(result.bodyText));
}
console.log("  hrefs:", result.hrefs);

// ── 2. Same page reached the way the user does: home → carousel header ──
await page.goto(`${BASE}/en`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(4000);
const homeCarousel = await page.evaluate(() => {
  const el = document.getElementById("recentlyWatched");
  return {
    exists: !!el,
    cards: el ? el.querySelectorAll('a[href*="/anime/watch/"]').length : 0,
  };
});
check(
  "carrousel accueil rend les mêmes données",
  homeCarousel.exists && homeCarousel.cards >= 2,
  `cards=${homeCarousel.cards}`,
);

if (consoleErrors.length) {
  console.log("\nConsole errors capturés:");
  for (const e of consoleErrors.slice(0, 12)) console.log("  •", e);
}

await browser.close();
console.log(failures === 0 ? "\n=== TOUT PASSE ===" : `\n=== ${failures} ÉCHEC(S) ===`);
process.exit(failures === 0 ? 0 : 1);
