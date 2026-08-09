#!/usr/bin/env node
/**
 * Download SmilingWolf/wd-swinv2-tagger-v3 (ONNX) and its tag CSV.
 *
 * Why SwinV2 over EVA02-Large?
 *   • EVA02-Large: 1.26 GB, mAP 0.8709
 *   • SwinV2:      467 MB,  mAP 0.8633   ← we use this
 *   • Same input shape (448x448), same tag list, ~3× smaller, ~2× faster on CPU.
 *   The 0.8% accuracy drop is invisible vs the ~800 MB disk savings on a
 *   storage-constrained machine. The user explicitly asked us to keep the
 *   PC light.
 *
 * Files we need:
 *   • model.onnx           — the network
 *   • selected_tags.csv    — tag id → name + category mapping
 */
import { writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";

const MODEL_URL = "https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/resolve/main/model.onnx";
const TAGS_URL  = "https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/resolve/main/selected_tags.csv";

const MODEL_PATH = "./.cache/models/wd-swinv2-v3.onnx";
const TAGS_PATH  = "./.cache/models/wd-swinv2-v3-tags.csv";

async function downloadStreaming(url, outPath, label) {
  if (existsSync(outPath)) {
    const s = await stat(outPath);
    console.log(`✓ ${label} already at ${outPath} (${(s.size / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }
  console.log(`→ Downloading ${label}: ${url}`);
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get("content-length")) || 0;
  const chunks = [];
  let received = 0;
  let lastLog = Date.now();
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (Date.now() - lastLog > 1000 && total > 1024 * 1024) {
      const pct = total ? `${((received / total) * 100).toFixed(0)}%` : "?";
      process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB (${pct})`);
      lastLog = Date.now();
    }
  }
  if (total > 1024 * 1024) process.stdout.write("\n");
  await writeFile(outPath, Buffer.concat(chunks));
  console.log(`✓ Saved ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${outPath}`);
}

await mkdir("./.cache/models", { recursive: true });
await downloadStreaming(MODEL_URL, MODEL_PATH, "WD14 SwinV2 model");
await downloadStreaming(TAGS_URL,  TAGS_PATH,  "Tag CSV");
