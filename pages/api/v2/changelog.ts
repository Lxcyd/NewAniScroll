import type { NextApiRequest, NextApiResponse } from "next";
import { readFile } from "fs/promises";
import path from "path";

/**
 * Returns the FULL changelog markdown for the navbar button. One hand-written
 * file per language under changelog/:
 *   changelog/full.fr.md  /  changelog/full.en.md
 *
 * (The short release-popup uses changelog/popup.<lang>.md via
 * /api/v2/changelog-popup. The full text is no longer auto-translated — both
 * languages are maintained directly.)
 *
 * Cached 1h at the edge — the changelog changes rarely.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const lang = String(req.query.lang || "en").toLowerCase() === "fr" ? "fr" : "en";
  try {
    const filePath = path.join(process.cwd(), "changelog", `full.${lang}.md`);
    const content = await readFile(filePath, "utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(content);
  } catch (e: any) {
    res.status(404).json({ error: "Changelog not found", detail: e?.message });
  }
}
