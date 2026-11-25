// Mobile 4G lente (meme profil que perf-measure) : tout ce qui part AVANT l'image
// principale, dans l'ordre, avec poids, priorite et initiateur (25/11/2026, docs/PERF-PLAN.md).
//   PLAYWRIGHT_CORE=<...>/playwright-core/index.mjs node tools/browser-check/avant-lcp.mjs <url>
import { pathToFileURL } from "node:url";
const url = process.argv[2];
const PW = process.env.PLAYWRIGHT_CORE; // chemin de playwright-core/index.mjs (installe hors du depot)
if (!PW) { console.error("PLAYWRIGHT_CORE=<chemin vers playwright-core/index.mjs> requis"); process.exit(2); }
const { chromium } = await import(pathToFileURL(PW).href);
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "fr-FR",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
const req = new Map();
let t0 = 0;
cdp.on("Network.requestWillBeSent", (e) => {
  if (!t0) t0 = e.timestamp;
  const ini = e.initiator?.stack?.callFrames?.[0]?.url || e.initiator?.url || e.initiator?.type || "";
  req.set(e.requestId, { url: e.request.url, t: Math.round((e.timestamp - t0) * 1000), type: e.type, ini: ini.split("/").pop().slice(0, 40), prio: e.request.initialPriority });
});
cdp.on("Network.loadingFinished", (e) => { const r = req.get(e.requestId); if (r) { r.octets = e.encodedDataLength; r.fin = Math.round((e.timestamp - t0) * 1000); } });
await page.addInitScript(() => { window.__lcp = null; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = { t: Math.round(e.startTime), url: (e.url || "").split("/").pop().slice(0, 50), el: e.element?.tagName }; }).observe({ type: "largest-contentful-paint", buffered: true }); });
await page.goto(url, { waitUntil: "load", timeout: 120000 }).catch((e) => console.log("goto", e.message));
const tLoad = await page.evaluate(() => Math.round(performance.getEntriesByType("navigation")[0]?.loadEventStart || 0));
await page.waitForTimeout(4000);
const lcp = await page.evaluate(() => window.__lcp);
console.log(`LCP ${JSON.stringify(lcp)} | load a ${tLoad} ms`);
const liste = [...req.values()].filter((r) => r.octets).sort((a, b) => a.t - b.t);
const ko = (n) => Math.round(n / 1024);
let cumul = 0;
for (const r of liste) {
  if (lcp && r.t > lcp.t) break;
  cumul += r.octets;
  if (r.octets > 8 * 1024) console.log(`  ${String(r.t).padStart(6)} -> ${String(r.fin).padStart(6)} ms ${String(ko(r.octets)).padStart(5)} Ko  ${r.type.padEnd(10)} ${(r.prio || "").padEnd(8)} ${r.url.replace(/^https:\/\/dev\.aniscroll\.com/, "").slice(0, 85)}  <- ${r.ini}`);
}
console.log(`  avant le LCP : ${ko(cumul)} Ko ; apres : ${ko(liste.reduce((s, r) => s + r.octets, 0) - cumul)} Ko`);
await b.close();
