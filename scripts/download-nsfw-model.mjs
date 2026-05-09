#!/usr/bin/env node
/**
 * Download the NSFW classifier model once.
 *
 * We pick FULL FP32 (~345 MB) on purpose: zero accuracy loss, and the user
 * explicitly said "no false negatives" — quantized variants trade ~1% recall
 * for size/speed which is exactly the wrong tradeoff here.
 *
 * Variants on HF for reference:
 *   • Full FP32 (us): 345 MB, 100% acc                    ← we use this
 *   • FP16:           172 MB, 99.9% acc
 *   • INT8:            88 MB, ~99% acc
 *   • BNB4:            52 MB, ~98% acc
 *
 * Cached to .cache/models/ so we don't re-download on every run.
 */
import { writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";

const MODEL_URL =
  "https://huggingface.co/AdamCodd/vit-base-nsfw-detector/resolve/main/onnx/model.onnx";
const MODEL_PATH = "./.cache/models/nsfw-vit-fp32.onnx";

async function main() {
  if (existsSync(MODEL_PATH)) {
    const s = await stat(MODEL_PATH);
    console.log(`✓ Model already at ${MODEL_PATH} (${(s.size / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }

  await mkdir("./.cache/models", { recursive: true });
  console.log(`→ Downloading ${MODEL_URL}`);
  const t0 = Date.now();
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // Stream to disk so we don't hold the whole 88 MB in memory
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let lastLog = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (Date.now() - lastLog > 1000) {
      const pct = total ? `${((received / total) * 100).toFixed(0)}%` : "?";
      process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB (${pct})`);
      lastLog = Date.now();
    }
  }
  process.stdout.write("\n");

  const buf = Buffer.concat(chunks);
  await writeFile(MODEL_PATH, buf);
  console.log(`✓ Saved (${(Date.now() - t0) / 1000}s) → ${MODEL_PATH}`);
}

main().catch((e) => { console.error("✘", e); process.exit(1); });
