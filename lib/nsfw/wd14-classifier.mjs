/**
 * WD14 SwinV2 v3 — anime-native NSFW tagger.
 *
 * Why this model: trained on 5M+ Danbooru/e621 images (= actual anime
 * fanart), so it understands the visual codes (sukumizu, lingerie typed
 * anime, costume tropes…) that photo-trained classifiers miss.
 *
 * Output: ~10 000 boolean tags per image with confidence scores. We turn
 * those into a label using:
 *
 *   1. Native Danbooru rating tags (general | sensitive | questionable |
 *      explicit) — already calibrated by the model.
 *   2. Hard blacklist of explicit body-part tags → forces NSFW regardless
 *      of rating ("explicit override"). The user wants no false negatives.
 *   3. Gender-aware suggestive bucket: bikini / cleavage / lingerie /
 *      bare_chest etc. Apply only when '1girl'/'multiple_girls' is present
 *      with high confidence; for '1boy' alone, bare-chested is SAFE
 *      (Titans, shounen heroes shirtless).
 *   4. Sexual acts override gender: yaoi/sex/oral/anal/cum → always NSFW.
 *
 * Output label is one of: 'safe' | 'suggestive' | 'nsfw'
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { readFile } from "fs/promises";

const MODEL_PATH = "./.cache/models/wd-swinv2-v3.onnx";
const TAGS_CSV_PATH = "./.cache/models/wd-swinv2-v3-tags.csv";

// SwinV2 expects 448×448 BGR (yes, BGR not RGB — historical OpenCV legacy
// in WD14 training). Mean/std are NOT applied — the model normalizes
// internally. Just feed [0..255] BGR.
const IMG_SIZE = 448;

// ─── Tag rule lists ─────────────────────────────────────────────────────
// Hard blacklist — any of these above threshold → NSFW always.
// Covers genitalia, sex acts, explicit body fluids. Sex-specific tags
// like 'yaoi' so male/male doesn't slip through the gender whitelist.
const HARD_BLACKLIST = [
  "nude", "nipples", "pussy", "penis", "anus",
  "cum", "cum_on_body", "cum_on_face",
  "sex", "vaginal", "anal", "oral", "fellatio", "cunnilingus",
  "yaoi", "yuri",
  "rape",
  "bdsm", "bondage",
  "futanari",
  "spread_legs",
  "ejaculation",
  "masturbation",
];
const HARD_BLACKLIST_THRESHOLD = 0.3; // aggressive — user wants no false neg

// Female-presence gated tags. Only flag if a female is plausibly the subject.
const FEMALE_NSFW = [
  "topless", "bottomless", "partially_nude",
  "see_through", "wet_clothes",
];
const FEMALE_NSFW_THRESHOLD = 0.4;

const FEMALE_SUGGESTIVE = [
  "bikini", "swimsuit", "lingerie", "underwear",
  "bra", "panties", "thong",
  "cleavage", "large_breasts",
  "ass_focus", "ass_visible_through_thighs",
  "revealing_clothes", "midriff",
  "underboob", "sideboob", "downblouse", "downpants",
  "skindentation", "thigh_gap",
  "pelvic_curtain", "groin",
];
const FEMALE_SUGGESTIVE_THRESHOLD = 0.4;

// Generic body tags — only flag when very high (>= 0.75) to avoid catching
// every fully-clothed character with a chest in frame.
const FEMALE_GENERIC_BODY = ["breasts", "huge_breasts", "medium_breasts"];
const FEMALE_GENERIC_BODY_THRESHOLD = 0.75;

// Female presence detection — at least one of these has to be high-conf.
const FEMALE_PRESENCE_TAGS = ["1girl", "multiple_girls", "2girls", "female_focus"];
const FEMALE_PRESENCE_THRESHOLD = 0.4;

// Male presence (used for the bare_chest whitelist).
const MALE_PRESENCE_TAGS = ["1boy", "multiple_boys", "2boys", "male_focus"];
const MALE_PRESENCE_THRESHOLD = 0.4;

// Native Danbooru rating tags WD14 was trained on. These are pseudo-tags
// (id 999999X) the model emits as a category. We use them as a coarse
// prior — but the rule-based blacklists above can override them upward
// (never downward).
const RATING_TAGS = ["general", "sensitive", "questionable", "explicit"];

// ─── Model state ────────────────────────────────────────────────────────
let session = null;
let tagNames = null;     // Array indexed like the model output dim
let loadingPromise = null;

async function loadTagCsv() {
  const text = await readFile(TAGS_CSV_PATH, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  // First line is header. WD14 tag CSV columns: tag_id, name, category, count
  // The order of rows IS the model output dimension order.
  const names = [];
  for (let i = 1; i < lines.length; i++) {
    // Tag names sometimes contain commas (rare) but never inside quotes,
    // so a simple split is fine for SwinV2 CSV.
    const parts = lines[i].split(",");
    names.push(parts[1]);
  }
  return names;
}

export async function loadModel() {
  if (session && tagNames) return { session, tagNames };
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const buf = await readFile(MODEL_PATH);
    session = await ort.InferenceSession.create(buf, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    tagNames = await loadTagCsv();
    return { session, tagNames };
  })();
  return loadingPromise;
}

// ─── Image preprocessing ────────────────────────────────────────────────
// SwinV2 expects [N, H, W, C] (channels last) at 448×448 with BGR ordering.
async function preprocess(imageBuffer) {
  // 1. Decode to RGB at 448×448, padded with white (Danbooru convention).
  const { data, info } = await sharp(imageBuffer)
    .resize(IMG_SIZE, IMG_SIZE, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3) throw new Error(`channels=${info.channels}`);

  // 2. RGB → BGR + cast to float32 (no mean/std normalization).
  const np = IMG_SIZE * IMG_SIZE;
  const out = new Float32Array(np * 3);
  for (let i = 0; i < np; i++) {
    out[i * 3]     = data[i * 3 + 2]; // B
    out[i * 3 + 1] = data[i * 3 + 1]; // G
    out[i * 3 + 2] = data[i * 3];     // R
  }
  return new ort.Tensor("float32", out, [1, IMG_SIZE, IMG_SIZE, 3]);
}

// ─── Decision logic ─────────────────────────────────────────────────────
function tagScore(scoresByName, name) {
  return scoresByName.get(name) ?? 0;
}

function anyAbove(scoresByName, names, threshold) {
  for (const n of names) {
    if (tagScore(scoresByName, n) >= threshold) return n;
  }
  return null;
}

/**
 * Turn raw tag scores into a label + reason.
 * Returns:
 *   {
 *     label: 'safe' | 'suggestive' | 'nsfw',
 *     score: number,             // 0..1, our internal "nsfw-ness"
 *     reason: string,            // human-readable rule that fired
 *     topRating: { tag, score }, // which Danbooru rating was strongest
 *     topTags: [{ name, score }] // top-10 tags for debugging
 *   }
 */
function decide(scoresByName) {
  // 1. Explicit override — anything in the hard blacklist that fires high
  //    means NSFW, no matter what the rating bucket says.
  const blackHit = anyAbove(scoresByName, HARD_BLACKLIST, HARD_BLACKLIST_THRESHOLD);
  if (blackHit) {
    return {
      label: "nsfw",
      score: tagScore(scoresByName, blackHit),
      reason: `hard:${blackHit}`,
    };
  }

  // 2. Native Danbooru rating — find the highest scoring rating tag.
  let topRating = { tag: "general", score: 0 };
  for (const r of RATING_TAGS) {
    const s = tagScore(scoresByName, r);
    if (s > topRating.score) topRating = { tag: r, score: s };
  }

  // 3. Female-gated suggestive/NSFW pass.
  const femalePresent = anyAbove(scoresByName, FEMALE_PRESENCE_TAGS, FEMALE_PRESENCE_THRESHOLD);
  const malePresent = anyAbove(scoresByName, MALE_PRESENCE_TAGS, MALE_PRESENCE_THRESHOLD);

  if (femalePresent) {
    const fNsfw = anyAbove(scoresByName, FEMALE_NSFW, FEMALE_NSFW_THRESHOLD);
    if (fNsfw) {
      return { label: "nsfw", score: tagScore(scoresByName, fNsfw), reason: `female-nsfw:${fNsfw}`, topRating };
    }
    const fSugg = anyAbove(scoresByName, FEMALE_SUGGESTIVE, FEMALE_SUGGESTIVE_THRESHOLD);
    if (fSugg) {
      return { label: "suggestive", score: tagScore(scoresByName, fSugg), reason: `female-sugg:${fSugg}`, topRating };
    }
    // Generic body-tag fallback — only when very high (image is breast-centric)
    const fBody = anyAbove(scoresByName, FEMALE_GENERIC_BODY, FEMALE_GENERIC_BODY_THRESHOLD);
    if (fBody) {
      return { label: "suggestive", score: tagScore(scoresByName, fBody), reason: `female-body:${fBody}`, topRating };
    }
  }

  // 4. Native rating fallback — only the truly explicit tiers. We do NOT
  //    use `rating:sensitive` because in practice WD14 puts every fanart
  //    with a visible human character at sensitive≥0.7 even when there's
  //    zero fanservice (Mikasa with a sword, Light Yagami in a suit, etc.).
  //    The specific tag rules above (cleavage / bikini / lingerie / …)
  //    already capture the actual fanservice cases without that noise.
  if (topRating.tag === "explicit" && topRating.score >= 0.4) {
    return { label: "nsfw", score: topRating.score, reason: "rating:explicit", topRating };
  }
  if (topRating.tag === "questionable" && topRating.score >= 0.4) {
    return { label: "nsfw", score: topRating.score, reason: "rating:questionable", topRating };
  }

  return { label: "safe", score: topRating.score, reason: "default", topRating };
}

// ─── Public API ─────────────────────────────────────────────────────────
export async function classifyImageBytes(imageBuffer, opts = {}) {
  const { session: sess, tagNames: names } = await loadModel();
  const tensor = await preprocess(imageBuffer);
  const inputName = sess.inputNames[0];
  const result = await sess.run({ [inputName]: tensor });
  const probs = result[sess.outputNames[0]].data; // Float32Array of length names.length

  // Build a Map only for tags above a tiny floor — keeps memory low and
  // lookups fast. We need everything down to ~0.1 because the rating tag
  // 'general' often sits between 0.1 and 0.3 even on safe images.
  const scoresByName = new Map();
  for (let i = 0; i < names.length; i++) {
    if (probs[i] >= 0.1) scoresByName.set(names[i], probs[i]);
  }

  const verdict = decide(scoresByName);

  // Optionally include top tags for debugging / review tooling.
  if (opts.includeTopTags) {
    const top = [...scoresByName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, score]) => ({ name, score }));
    verdict.topTags = top;
  }

  return verdict;
}

export async function classifyImageUrl(url, fetchOpts = {}, classifyOpts = {}) {
  const res = await fetch(url, fetchOpts);
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.httpStatus = res.status;
    throw e;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return classifyImageBytes(buf, classifyOpts);
}
