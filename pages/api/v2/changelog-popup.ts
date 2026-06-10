import type { NextApiRequest, NextApiResponse } from "next";
import { readFile } from "fs/promises";
import path from "path";

/**
 * Serves the SHORT release-popup changelog (separate from the full CHANGELOG.md
 * that the navbar button shows). One file per language:
 *   CHANGELOG_POPUP.fr.md  /  CHANGELOG_POPUP.en.md
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
  const file = `CHANGELOG_POPUP.${lang}.md`;
  try {
    const filePath = path.join(process.cwd(), file);
    const content = await readFile(filePath, "utf-8");
    // Short cache so a new release shows up fast for returning users; the client
    // also cache-busts the request. SWR keeps it cheap.
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(content);
  } catch (e: any) {
    res.status(404).json({ error: "Popup changelog not found", detail: e?.message });
  }
}
