import test from "node:test";
import assert from "node:assert/strict";

import {
  rowsToRewrite,
  organizePlatformRows,
  rowRangesFromMaterialRows
} from "../src/feishu-date-organizer.mjs";
import { buildFeishuUrlCell } from "../src/daily-records.mjs";

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
    ["2026-05-24", 0],
    ["2026-05-23", 2]
  ]);
  assert.deepEqual(result.rows.map((row) => [row[0], row[1], row[3] || ""]), [
    ["", "0524 投稿视频", ""],
    ["", "0523 投稿视频", ""],
    ["1", "05 23", "a"],
    ["2", "05 23", "b"]
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
