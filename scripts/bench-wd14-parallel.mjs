#!/usr/bin/env node
/**
 * Test how parallel ONNX sessions actually scale on this CPU.
 * The single-session bench gives 2.5s/inference. We need to know the
 * effective rate with N sessions running concurrently.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { readFile } from "fs/promises";

const MODEL_PATH = "./.cache/models/wd-swinv2-v3.onnx";
const IMG_SIZE = 448;

const buf = await readFile(MODEL_PATH);
const sharedTensor = (() => {
  // Build a synthetic random tensor — we don't care about the result
  const arr = new Float32Array(IMG_SIZE * IMG_SIZE * 3);
  for (let i = 0; i < arr.length; i++) arr[i] = Math.random() * 255;
  return new ort.Tensor("float32", arr, [1, IMG_SIZE, IMG_SIZE, 3]);
})();

for (const N of [2, 4, 6, 8]) {
  console.log(`\n→ Testing N=${N} sessions, 8 inferences total`);
  const sessions = [];
  for (let i = 0; i < N; i++) {
    sessions.push(await ort.InferenceSession.create(buf, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    }));
  }
  // Warm-up
  await Promise.all(sessions.map((s) => s.run({ [s.inputNames[0]]: sharedTensor })));

  const t0 = Date.now();
  const total = 8;
  const queue = Array.from({ length: total }, (_, i) => i);
  async function worker(idx) {
    while (queue.length > 0) {
      queue.shift();
      await sessions[idx].run({ [sessions[idx].inputNames[0]]: sharedTensor });
    }
  }
  await Promise.all(sessions.map((_, i) => worker(i)));
  const dt = Date.now() - t0;
  console.log(`  ${total} inferences in ${dt}ms = ${(total / (dt / 1000)).toFixed(2)} inf/s`);

  // Free sessions to reclaim memory before next round
  for (const s of sessions) await s.release?.();
}
