#!/usr/bin/env node
/**
 * Compare: 1 session with N intra-op threads vs N sessions with 1 thread each.
 * On Windows, multi-session scaling is broken — let's see if intra-op threads
 * actually help.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import * as ort from "onnxruntime-node";
import { readFile } from "fs/promises";

const MODEL_PATH = "./.cache/models/wd-swinv2-v3.onnx";
const IMG_SIZE = 448;

const buf = await readFile(MODEL_PATH);
const arr = new Float32Array(IMG_SIZE * IMG_SIZE * 3);
for (let i = 0; i < arr.length; i++) arr[i] = Math.random() * 255;
const tensor = new ort.Tensor("float32", arr, [1, IMG_SIZE, IMG_SIZE, 3]);

for (const threads of [1, 2, 4, 8]) {
  const session = await ort.InferenceSession.create(buf, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  });
  // warm-up
  await session.run({ [session.inputNames[0]]: tensor });

  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    await session.run({ [session.inputNames[0]]: tensor });
  }
  const dt = Date.now() - t0;
  const per = dt / 5;
  console.log(`intraOpNumThreads=${threads}: ${per.toFixed(0)}ms/inf, ${(1000 / per).toFixed(2)} inf/s`);
}
