import type { NextApiRequest, NextApiResponse } from "next";
import { readFile } from "fs/promises";
import path from "path";

/**
 * Returns the raw markdown contents of /CHANGELOG.md so the client-side
 * modal can render it without bundling the file (which would also bloat
 * the JS payload of every page load).
 *
 * Cached for 1h at the edge so we don't hit disk on every navbar mount.
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    const filePath = path.join(process.cwd(), "CHANGELOG.md");
    const content = await readFile(filePath, "utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(content);
  } catch (e: any) {
    res.status(404).json({ error: "Changelog not found", detail: e?.message });
  }
}
