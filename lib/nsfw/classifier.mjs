/**
 * NSFW image classifier using AdamCodd/vit-base-nsfw-detector via onnxruntime.
 *
 * The model is a ViT-base fine-tuned on ~6k images. It returns 2 logits we
 * interpret as `safe` and `nsfw` probabilities (after softmax).
 *
 * Inference path:
 *   1. fetch image bytes
 *   2. sharp → resize 224×224, ensure 3 RGB channels
 *   3. normalize per ImageNet stats (mean=0.5, std=0.5 for ViT)
 *   4. tensor [1, 3, 224, 224]
 *   5. session.run → softmax → { safe, nsfw }
 *
 * The session is loaded once and reused across calls. Disposing is the
 * caller's responsibility (server stays up, scripts exit on their own).
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { readFile } from "fs/promises";

const MODEL_PATH = "./.cache/models/nsfw-vit-fp32.onnx";

// Matches preprocessor_config.json from the AdamCodd repo:
//   image_mean=[0.5,0.5,0.5], image_std=[0.5,0.5,0.5], size=384x384, RGB.
// Note: 384 (not 224) — that's why the model was throwing an Add broadcast
// error before. The patch grid for 384 is 24×24 = 576 patches + 1 cls = 577.
const IMG_SIZE = 384;
const MEAN = [0.5, 0.5, 0.5];
const STD = [0.5, 0.5, 0.5];

// Class index mapping. From config.json: {"0": "safe", "1": "nsfw"}
const LABELS = ["safe", "nsfw"];

let session = null;
let loadingPromise = null;

export async function loadModel() {
  if (session) return session;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const buf = await readFile(MODEL_PATH);
    session = await ort.InferenceSession.create(buf, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    return session;
  })();
  return loadingPromise;
}

/** Decode + normalize one image into a Float32Array of shape [1, 3, 224, 224]. */
async function imageToTensor(imageBuffer) {
  // sharp gives raw RGB bytes [h, w, 3]. We resize to 224x224 first.
  const { data, info } = await sharp(imageBuffer)
    .resize(IMG_SIZE, IMG_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { channels } = info;
  if (channels !== 3) {
    throw new Error(`expected 3 channels after sharp, got ${channels}`);
  }

  // Repack from [h*w*3] (interleaved) into [3*h*w] (channels-first) which is
  // what ViT expects, normalizing each channel against ImageNet mean/std.
  const numPixels = IMG_SIZE * IMG_SIZE;
  const tensor = new Float32Array(3 * numPixels);
  for (let i = 0; i < numPixels; i++) {
    const r = data[i * 3]     / 255;
    const g = data[i * 3 + 1] / 255;
    const b = data[i * 3 + 2] / 255;
    tensor[i]              = (r - MEAN[0]) / STD[0];
    tensor[numPixels + i]   = (g - MEAN[1]) / STD[1];
    tensor[numPixels * 2 + i] = (b - MEAN[2]) / STD[2];
  }

  return new ort.Tensor("float32", tensor, [1, 3, IMG_SIZE, IMG_SIZE]);
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Classify one image (bytes). Returns { safe, nsfw } probabilities in [0..1].
 * Throws on invalid image bytes — caller decides whether to swallow.
 */
export async function classifyImageBytes(imageBuffer) {
  const sess = await loadModel();
  const tensor = await imageToTensor(imageBuffer);

  // The session expects { pixel_values: tensor } and outputs { logits }.
  const inputName = sess.inputNames[0];
  const result = await sess.run({ [inputName]: tensor });
  const outputName = sess.outputNames[0];
  const logits = Array.from(result[outputName].data);
  const probs = softmax(logits);

  return { safe: probs[0], nsfw: probs[1] };
}

/** Convenience: download an image URL and classify it. */
export async function classifyImageUrl(url, fetchOpts = {}) {
  const res = await fetch(url, fetchOpts);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return classifyImageBytes(buf);
}
