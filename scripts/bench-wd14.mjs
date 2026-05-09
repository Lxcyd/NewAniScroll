#!/usr/bin/env node
/**
 * Bench: how long does ONE WD14 inference actually take on this CPU?
 * The earlier estimate of 1-2s/image was wrong — the 13-min/200-URLs run
 * implies ~10s/inference, which is 5× slower than expected.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { readFile } from "fs/promises";

const MODEL_PATH = "./.cache/models/wd-swinv2-v3.onnx";
const IMG_SIZE = 448;

console.log("→ Loading model…");
const t0 = Date.now();
const buf = await readFile(MODEL_PATH);
const session = await ort.InferenceSession.create(buf, {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
});
console.log(`  ✓ loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  input: ${session.inputNames[0]}`);
console.log(`  output: ${session.outputNames[0]}`);

// Warm up + bench with 5 random images downloaded fresh
const TEST_URLS = [
  "https://assets.fanart.tv/fanart/akame-ga-kill-5fb9ee1bc3607.png",
  "https://assets.fanart.tv/fanart/death-note-52ef42c02c464.jpg",
  "https://assets.fanart.tv/fanart/jujutsu-kaisen-61024e377c5bb.jpg",
];

async function preprocess(buf) {
  const { data } = await sharp(buf)
    .resize(IMG_SIZE, IMG_SIZE, { fit: "contain", background: { r: 255, g: 255, b: 255 } })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const np = IMG_SIZE * IMG_SIZE;
  const out = new Float32Array(np * 3);
  for (let i = 0; i < np; i++) {
    out[i * 3]     = data[i * 3 + 2];
    out[i * 3 + 1] = data[i * 3 + 1];
    out[i * 3 + 2] = data[i * 3];
  }
  return new ort.Tensor("float32", out, [1, IMG_SIZE, IMG_SIZE, 3]);
}

console.log("\n→ Pre-fetching test images…");
const tensors = [];
for (const url of TEST_URLS) {
  const res = await fetch(url);
  const b = Buffer.from(await res.arrayBuffer());
  tensors.push(await preprocess(b));
}
console.log(`  ✓ ${tensors.length} tensors ready`);

console.log("\n→ Warm-up run (1 inference, ignore timing)");
const tw = Date.now();
await session.run({ [session.inputNames[0]]: tensors[0] });
console.log(`  warm-up: ${Date.now() - tw}ms`);

console.log("\n→ Bench: 5 inferences");
const times = [];
for (let i = 0; i < 5; i++) {
  const t = Date.now();
  await session.run({ [session.inputNames[0]]: tensors[i % tensors.length] });
  times.push(Date.now() - t);
}
const avg = times.reduce((a, b) => a + b, 0) / times.length;
console.log(`  times: ${times.join(", ")}ms`);
console.log(`  avg: ${avg.toFixed(0)}ms per inference`);
console.log(`  → with 4 sessions parallel: theoretical ${(4 / (avg / 1000)).toFixed(2)} inf/s`);
console.log(`  → 46k URLs / 4 sessions: ${Math.round(46000 * avg / 4 / 1000 / 60)} min`);
