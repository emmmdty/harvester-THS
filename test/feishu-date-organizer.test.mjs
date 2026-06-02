import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPublishedDateResolver,
  rowsToRewrite,
  organizePlatformRows,
  rowRangesFromMaterialRows
} from "../src/feishu-date-organizer.mjs";
import { buildFeishuUrlCell } from "../src/daily-records.mjs";
import { XHS_DETAIL_CACHE_VERSION } from "../src/xhs-published-date.mjs";

test("organizePlatformRows moves material rows to their resolved publish date blocks", () => {
  const rows = [
    ["", "0524 投稿视频", "", "", "", "", "", ""],
    ["1", "05 24", buildFeishuUrlCell("https://www.xiaohongshu.com/discovery/item/a"), "a", "投资号", "图文", "通过", "#tag"],
    ["", "0523 投稿视频", "", "", "", "", "", ""],
    ["1", "05 23", buildFeishuUrlCell("https://www.xiaohongshu.com/discovery/item/b"), "b", "投资号", "图文", "通过", "#tag"]
  ];

  const result = organizePlatformRows({
    platformId: "xhs",
    rows,
    dataStartRow: 3,
    resolvePublishedAt: ({ fields }) => fields["笔记ID"] === "a" ? "2026-05-23" : ""
  });

  assert.equal(result.moves.length, 1);
  assert.deepEqual(result.dateBlocks.map((block) => [block.date, block.materialCount]), [
    ["2026-05-23", 2]
  ]);
  assert.deepEqual(result.rows.map((row) => [row[0], row[1], row[3] || ""]), [
    ["", "0523 投稿视频", ""],
    ["1", "05 23", "a"],
    ["2", "05 23", "b"]
  ]);
});

test("organizePlatformRows removes separator-only date blocks after 5.30 cleanup", () => {
  const rows = [
    ["", "0530 投稿视频", "", "", "", "", "", ""],
    ["", "0529 投稿视频", "", "", "", "", "", ""],
    ["1", "05 29", buildFeishuUrlCell("https://www.xiaohongshu.com/discovery/item/6a198e0c0000000036000f68"), "6a198e0c0000000036000f68", "投资号", "图文", "通过", "#tag"]
  ];

  const result = organizePlatformRows({
    platformId: "xhs",
    rows,
    dataStartRow: 3,
    resolvePublishedAt: () => ""
  });

  assert.deepEqual(result.dateBlocks.map((block) => [block.date, block.materialCount]), [
    ["2026-05-29", 1]
  ]);
  assert.deepEqual(result.rows.map((row) => [row[0], row[1], row[3] || ""]), [
    ["", "0529 投稿视频", ""],
    ["1", "05 29", "6a198e0c0000000036000f68"]
  ]);
});

test("organizePlatformRows writes full-year labels for non-current-year date blocks", () => {
  const rows = [
    ["", "0524 投稿视频", "", "", "", "", ""],
    ["1", "05 24", buildFeishuUrlCell("https://www.bilibili.com/video/BV1hhGd6kEVj/"), "BV1hhGd6kEVj", "投资号", "标题", "#tag"]
  ];

  const result = organizePlatformRows({
    platformId: "bilibili",
    rows,
    dataStartRow: 3,
    resolvePublishedAt: () => "2025-06-11"
  });

  assert.deepEqual(result.rows.map((row) => [row[0], row[1], row[3] || ""]), [
    ["", "2025-06-11 投稿视频", ""],
    ["1", "2025-06-11", "BV1hhGd6kEVj"]
  ]);
});

test("rowRangesFromMaterialRows groups material rows between separator rows", () => {
  const ranges = rowRangesFromMaterialRows([
    ["", "0524 投稿视频"],
    ["", "0523 投稿视频"],
    ["1", "05 23"],
    ["2", "05 23"],
    ["", "0522 投稿视频"],
    ["1", "05 22"]
  ], 3);

  assert.deepEqual(ranges, [
    { startRow: 5, endRow: 6 },
    { startRow: 8, endRow: 8 }
  ]);
});

test("rowsToRewrite pads only through the previous occupied data area", () => {
  const rows = rowsToRewrite({
    existingRows: [
      ["", "0524 投稿视频"],
      ["1", "05 24"],
      ["", ""],
      ["", ""]
    ],
    organizedRows: [
      ["", "0524 投稿视频"],
      ["", "0523 投稿视频"],
      ["1", "05 23"]
    ],
    columnCount: 2
  });

  assert.deepEqual(rows, [
    ["", "0524 投稿视频"],
    ["", "0523 投稿视频"],
    ["1", "05 23"]
  ]);
});

test("buildPublishedDateResolver does not use XHS cache or local JSON dates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-date-resolver-"));
  await fs.mkdir(path.join(root, ".runtime", "detail-cache", "xhs"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });

  await fs.writeFile(path.join(root, ".runtime", "detail-cache", "xhs", "note-old.json"), JSON.stringify({
    publishedAt: "2026-05-24"
  }), "utf8");
  await fs.writeFile(path.join(root, ".runtime", "detail-cache", "xhs", "note-new.json"), JSON.stringify({
    cacheVersion: XHS_DETAIL_CACHE_VERSION,
    publishedAt: "2026-05-22",
    publishedAtSource: "detail-date"
  }), "utf8");
  await fs.writeFile(path.join(root, "output", "xhs_notes_old.json"), JSON.stringify({
    platform: "xhs",
    items: [
      {
        platform: "xhs",
        id: "note-local-old",
        link: "https://www.xiaohongshu.com/discovery/item/note-local-old",
        publishedAt: "2026-05-24"
      }
    ]
  }), "utf8");
  await fs.writeFile(path.join(root, "output", "xhs_notes_new.json"), JSON.stringify({
    platform: "xhs",
    publishedAtVersion: XHS_DETAIL_CACHE_VERSION,
    items: [
      {
        platform: "xhs",
        id: "note-local-new",
        link: "https://www.xiaohongshu.com/discovery/item/note-local-new",
        publishedAt: "2026-05-22",
        publishedAtSource: "detail-date"
      }
    ]
  }), "utf8");

  const resolvePublishedAt = await buildPublishedDateResolver({ root });

  assert.equal(resolvePublishedAt({
    platformId: "xhs",
    fields: {
      "笔记ID": "note-old",
      "内容链接": buildFeishuUrlCell("https://www.xiaohongshu.com/discovery/item/note-old")
    }
  }), "");
  assert.equal(resolvePublishedAt({
    platformId: "xhs",
    fields: {
      "笔记ID": "note-new",
      "内容链接": buildFeishuUrlCell("https://www.xiaohongshu.com/discovery/item/note-new")
    }
  }), "");
  assert.equal(resolvePublishedAt({
    platformId: "xhs",
    fields: {
      "笔记ID": "note-local-old",
      "内容链接": buildFeishuUrlCell("https://www.xiaohongshu.com/discovery/item/note-local-old")
    }
  }), "");
  assert.equal(resolvePublishedAt({
    platformId: "xhs",
    fields: {
      "笔记ID": "note-local-new",
      "内容链接": buildFeishuUrlCell("https://www.xiaohongshu.com/discovery/item/note-local-new")
    }
  }), "");
});

test("buildPublishedDateResolver derives XHS and Douyin publish dates from deterministic content IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-date-id-resolver-"));
  await fs.mkdir(path.join(root, ".runtime", "detail-cache", "xhs"), { recursive: true });
  await fs.mkdir(path.join(root, ".runtime", "detail-cache", "douyin"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });

  await fs.writeFile(path.join(root, ".runtime", "detail-cache", "xhs", "6a198e0c0000000036000f68.json"), JSON.stringify({
    cacheVersion: XHS_DETAIL_CACHE_VERSION,
    publishedAt: "2026-05-30",
    publishedAtSource: "detail-date"
  }), "utf8");
  await fs.writeFile(path.join(root, ".runtime", "detail-cache", "douyin", "7645299366600674602.json"), JSON.stringify({
    cacheVersion: 3,
    publishedAt: "2026-05-30"
  }), "utf8");

  const resolvePublishedAt = await buildPublishedDateResolver({ root });

  assert.equal(resolvePublishedAt({
    platformId: "xhs",
    fields: {
      "笔记ID": "6a198e0c0000000036000f68",
      "内容链接": buildFeishuUrlCell("https://www.xiaohongshu.com/discovery/item/6a198e0c0000000036000f68")
    }
  }), "2026-05-29");
  assert.equal(resolvePublishedAt({
    platformId: "douyin",
    fields: {
      "内容链接": buildFeishuUrlCell("https://www.douyin.com/note/7645299366600674602")
    }
  }), "2026-05-29");
});
