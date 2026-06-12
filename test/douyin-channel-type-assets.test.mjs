import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createDouyinChannelTypeAssetBundle,
  downloadExtractedMedia,
  extractDouyinAssetFromAwemeDetail
} from "../src/douyin-channel-type-classifier/assets.mjs";

test("asset parser reads video URLs from detail payload and note images from aweme_list", () => {
  const video = extractDouyinAssetFromAwemeDetail({
    aweme_detail: {
      aweme_id: "video-1",
      desc: "视频标题",
      video: {
        play_addr: { url_list: ["https://v.example/play.mp4"] },
        download_addr: { url_list: ["https://v.example/download.mp4"] },
        bit_rate: [
          { play_addr: { url_list: ["https://v.example/bitrate.mp4"] } }
        ]
      }
    }
  }, { itemId: "video-1" });

  assert.equal(video.awemeId, "video-1");
  assert.equal(video.mediaType, "video");
  assert.deepEqual(video.videoUrls, [
    "https://v.example/play.mp4",
    "https://v.example/download.mp4",
    "https://v.example/bitrate.mp4"
  ]);

  const note = extractDouyinAssetFromAwemeDetail({
    aweme_list: [
      { aweme_id: "other", images: [{ url_list: ["https://p.example/other.webp"] }] },
      {
        aweme_id: "note-1",
        desc: "图文标题",
        images: [
          {
            url_list: ["https://p.example/1.webp"],
            download_url_list: ["https://p.example/1-water.webp"]
          }
        ],
        image_infos: [
          { url_list: ["https://p.example/2.webp"] }
        ]
      }
    ]
  }, { itemId: "note-1" });

  assert.equal(note.awemeId, "note-1");
  assert.equal(note.mediaType, "image");
  assert.deepEqual(note.imageUrls, [
    "https://p.example/1.webp",
    "https://p.example/1-water.webp",
    "https://p.example/2.webp"
  ]);
});

test("media downloader sends Douyin headers, tries candidates, and records failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-media-download-"));
  const calls = [];

  const result = await downloadExtractedMedia({
    assetDir: root,
    extracted: {
      videoUrls: ["https://v.example/forbidden.mp4", "https://v.example/video.mp4"],
      imageUrls: ["https://p.example/image.webp"]
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, headers: options.headers || {} });
      if (url.includes("forbidden")) {
        return response({ ok: false, status: 403, text: "forbidden" });
      }
      return response({
        ok: true,
        status: 200,
        headers: { "content-type": url.includes("image") ? "image/webp" : "video/mp4" },
        bytes: Buffer.from(url.includes("image") ? "image" : "video")
      });
    }
  });

  assert.equal(calls[0].headers.Referer, "https://www.douyin.com/");
  assert.match(calls[0].headers["User-Agent"], /Mozilla/u);
  assert.equal(result.videoPath, path.join(root, "video.mp4"));
  assert.equal(result.imagePaths.length, 1);
  assert.equal(result.downloadAttempts[0].status, 403);
  assert.equal(result.downloadAttempts[1].ok, true);
  assert.equal(result.downloadAttempts[2].kind, "image");
});

test("asset bundle uses page screenshots as media fallback instead of text fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-screenshot-fallback-"));
  const screenshotPath = path.join(root, "fallback.jpg");
  await fs.writeFile(screenshotPath, "jpg");

  const bundle = await createDouyinChannelTypeAssetBundle({
    assetBaseDir: root,
    targetDate: "2026-06-10",
    sourceRow: {
      link: "https://www.douyin.com/video/7645161964024450358",
      fields: { "标题": "要按规则炒股赚钱", "tag词": "#同顺财商" }
    },
    extractDouyinAsset: async () => ({
      awemeId: "7645161964024450358",
      mediaType: "video",
      title: "要按规则炒股赚钱",
      videoUrls: [],
      imageUrls: []
    }),
    captureFallbackScreenshots: async () => [screenshotPath]
  });

  assert.equal(bundle.mediaType, "screenshot");
  assert.deepEqual(bundle.screenshotPaths, [screenshotPath]);
  assert.ok(bundle.imagePaths.includes(screenshotPath));
  assert.equal(bundle.artifactStatus.screenshot, "done");
});

function response({ ok, status, headers = {}, bytes = Buffer.from(""), text = "" }) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || headers[name] || "";
      }
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return text;
    }
  };
}
