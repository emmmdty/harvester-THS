import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeTopnJobs,
  runCacheTopnCli
} from "../src/cache-topn-materials.mjs";

test("package scripts expose TopN material cache command", async () => {
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["materials:cache-topn"], "node src/cache-topn-materials.mjs");
});

test("normalizeTopnJobs supports arrays, items objects, JSONL, and platform aliases", () => {
  const fromObject = normalizeTopnJobs({
    items: [
      {
        job_id: "douyin-1",
        platform: "抖音",
        content_id: "aweme-1",
        content_url: "https://www.douyin.com/video/1",
        title: "抖音素材",
        account: "官方号",
        period_start: "2026-06-01",
        period_end: "2026-06-07",
        metrics: { spend: 120 }
      },
      {
        job_id: "xhs-1",
        channel: "小红书",
        content_url: "https://www.xiaohongshu.com/explore/1"
      },
      {
        job_id: "skip-1",
        platform: "wechat",
        content_url: "https://example.com/1"
      }
    ]
  });
  assert.deepEqual(fromObject.map((job) => [job.job_id, job.platform, job.skipped]), [
    ["douyin-1", "douyin", false],
    ["xhs-1", "xhs", false],
    ["skip-1", "wechat", true]
  ]);
  assert.deepEqual(fromObject[0].item, {
    id: "aweme-1",
    link: "https://www.douyin.com/video/1",
    title: "抖音素材",
    author: "官方号",
    publishedAt: "2026-06-07",
    metrics: { spend: 120 }
  });

  const fromJsonl = normalizeTopnJobs([
    JSON.stringify({ job_id: "bili-1", platform: "B站", content_url: "https://www.bilibili.com/video/BV1" }),
    "",
    JSON.stringify({ job_id: "douyin-2", platform: "douyin", content_url: "https://www.douyin.com/video/2" })
  ].join("\n"));
  assert.deepEqual(fromJsonl.map((job) => job.platform), ["bilibili", "douyin"]);

  const fromSingleLineJsonl = normalizeTopnJobs(
    `${JSON.stringify({ job_id: "bili-single", platform: "B站", content_id: "BV1single" })}\n`
  );
  assert.deepEqual(fromSingleLineJsonl.map((job) => [job.job_id, job.platform]), [["bili-single", "bilibili"]]);
});

test("runCacheTopnCli reads TopN jobs, groups by platform, and writes normalized manifest", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "topn-cache-cli-"));
  const inputPath = path.join(tmpDir, "jobs.jsonl");
  const outPath = path.join(tmpDir, "manifest.json");
  await fs.writeFile(inputPath, [
    JSON.stringify({
      job_id: "douyin-ok",
      platform: "抖音",
      content_id: "aweme-ok",
      content_url: "https://www.douyin.com/video/ok",
      period_end: "2026-06-09"
    }),
    JSON.stringify({
      job_id: "bili-fail",
      platform: "bilibili",
      content_id: "BVfail",
      content_url: "https://www.bilibili.com/video/BVfail"
    }),
    JSON.stringify({
      job_id: "unknown-skip",
      platform: "视频号",
      content_url: "https://example.com/skip"
    })
  ].join("\n"));

  const calls = [];
  const result = await runCacheTopnCli({
    argv: ["--input", inputPath, "--out", outPath, "--root", tmpDir, "--target-date", "2026-06-10"],
    cachePlatformMaterials: async (options) => {
      calls.push({
        platformId: options.platformId,
        root: options.root,
        targetDate: options.targetDate,
        items: options.items
      });
      if (options.platformId === "douyin") {
        return {
          manifests: [{
            ok: true,
            itemDir: path.join(tmpDir, "output/2026-06-09/douyin/aweme-ok"),
            imagePaths: ["cover.jpg"],
            framePaths: ["frame-001.jpg"],
            videoPath: "video.mp4",
            metadata: { source: "fake" },
            assets: [{ type: "image", path: "asset-cover.jpg" }]
          }]
        };
      }
      return {
        manifests: [{
          ok: false,
          assetDir: path.join(tmpDir, "output/2026-06-10/bilibili/BVfail"),
          error: "登录态失效：请重新登录 B站"
        }]
      };
    }
  });

  assert.deepEqual(calls.map((call) => call.platformId), ["douyin", "bilibili"]);
  assert.equal(calls[0].root, tmpDir);
  assert.equal(calls[0].targetDate, "2026-06-10");
  assert.deepEqual(calls[0].items, [{
    id: "aweme-ok",
    link: "https://www.douyin.com/video/ok",
    title: "",
    author: "",
    publishedAt: "2026-06-09",
    metrics: {}
  }]);

  const written = JSON.parse(await fs.readFile(outPath, "utf8"));
  assert.deepEqual(result, written);
  assert.deepEqual(written.items.map((item) => [item.job_id, item.status, item.platform]), [
    ["douyin-ok", "succeeded", "douyin"],
    ["bili-fail", "failed", "bilibili"],
    ["unknown-skip", "failed", "视频号"]
  ]);
  assert.equal(written.items[0].asset_dir, path.join(tmpDir, "output/2026-06-09/douyin/aweme-ok"));
  assert.equal(written.items[0].cover_path, "cover.jpg");
  assert.equal(written.items[0].video_path, "video.mp4");
  assert.deepEqual(written.items[0].screenshots, ["cover.jpg", "asset-cover.jpg"]);
  assert.deepEqual(written.items[0].frames, ["frame-001.jpg"]);
  assert.deepEqual(written.items[0].metadata, { source: "fake" });
  assert.equal(written.items[1].error_message, "登录态失效：请重新登录 B站");
  assert.equal(written.items[2].error_message, "Unsupported platform: 视频号");
});
