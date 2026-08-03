import type { NextApiRequest, NextApiResponse } from "next";
import { readFile } from "fs/promises";
import path from "path";

/**
 * Serves the SHORT release-popup changelog (separate from the full changelog
 * that the navbar button shows). One file per language, under changelog/:
 *   changelog/popup.fr.md  /  changelog/popup.en.md
 *
 * Format — first line is the version (the popup's auto-display trigger), then a
 * `---` separator, then the body (paragraphs separated by blank lines, **bold**
 * supported):
 *
 *   v0.0.3
 *   ---
 *   ✨ Something new...
 *
 *   🔧 A fix...
 *
 * Short max-age so a returning visitor picks up a new release quickly (the popup
 * also no-stores on the client side by appending a cache-buster).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const lang = String(req.query.lang || "en").toLowerCase() === "fr" ? "fr" : "en";
  try {
    const filePath = path.join(process.cwd(), "changelog", `popup.${lang}.md`);
    const content = await readFile(filePath, "utf-8");
    // This file only changes on a deploy, but the endpoint is hit on every page
    // load (twice — one per language), so the cache is what keeps it from being
    // a per-visit function invocation. A new release surfacing a little late is
    // invisible: the popup is dismissed per release signature, so a visitor who
    // misses the first window still gets it on the next page.
    //
    // The old 300s pair was measured at a 7.5% CDN hit rate — at ~7 requests an
    // hour, most arrivals fall outside a 5-minute window, so the edge copy has
    // almost always expired and the function runs again. Both TTLs are widened
    // to match how often the content ACTUALLY changes (once per deploy):
    // an hour at the edge caps the delay for a fresh release, a day of
    // stale-while-revalidate absorbs the quiet hours, and an hour in the browser
    // means a visitor clicking through several pages fetches this once.
    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    );
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(content);
  } catch (e: any) {
    res.status(404).json({ error: "Popup changelog not found", detail: e?.message });
  }
}
