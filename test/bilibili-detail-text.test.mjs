import test from "node:test";
import assert from "node:assert/strict";

import {
  extractBilibiliTags,
  extractBilibiliTitle
} from "../src/bilibili-detail-text.mjs";

test("extractBilibiliTitle prefers video metadata and removes Bilibili suffixes", () => {
  assert.equal(
    extractBilibiliTitle({
      videoData: { title: "如何看懂今天的市场机会" },
      documentTitle: "无关标题_哔哩哔哩_bilibili"
    }),
    "如何看懂今天的市场机会"
  );

  assert.equal(
    extractBilibiliTitle({
      videoData: {},
      documentTitle: "如何看懂今天的市场机会 - bilibili"
    }),
    "如何看懂今天的市场机会"
  );
});

test("extractBilibiliTags normalizes metadata tags and removes duplicates", () => {
  const tags = extractBilibiliTags({
    videoData: {
      tag: [
        { tag_name: "财经" },
        { tagName: "投资理财" },
        "财经"
      ]
    },
    initialTags: [{ tag_name: "同花顺" }],
    metaKeywords: "财经,股票,哔哩哔哩,bilibili"
  });

  assert.equal(tags, "#财经 #投资理财 #同花顺 #股票");
});

test("extractBilibiliTags removes the video title and generic site tags", () => {
  const tags = extractBilibiliTags({
    title: "高中1万入市开始炒股：现在资金体量七位数！",
    videoData: {
      tag: []
    },
    metaKeywords: "谁是理财王,财经,股市,投资,股票,高中1万入市开始炒股：现在资金体量七位数！,知识,B站"
  });

  assert.equal(tags, "#谁是理财王 #财经 #股市 #投资 #股票 #知识");
});
