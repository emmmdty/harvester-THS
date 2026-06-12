import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../src/classify-douyin-channel-types.mjs";

test("classify Douyin channel type CLI parses write, overwrite, media, provider, limit, concurrency, and output dir", () => {
  assert.deepEqual(parseArgs([
    "--write",
    "--overwrite",
    "--provider",
    "minimax",
    "--media-mode=sampled-media",
    "--limit",
    "20",
    "--concurrency=2",
    "--asset-concurrency",
    "3",
    "--no-classify",
    "--ab-compare",
    "--output-dir",
    ".runtime/custom"
  ]), {
    write: true,
    overwrite: true,
    provider: "minimax",
    mediaMode: "sampled-media",
    limit: 20,
    concurrency: 2,
    assetConcurrency: 3,
    noClassify: true,
    abCompare: true,
    outputDir: ".runtime/custom"
  });
});
