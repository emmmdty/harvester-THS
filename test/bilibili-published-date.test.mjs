import test from "node:test";
import assert from "node:assert/strict";

import {
  dateFromBilibiliEpoch,
  extractBilibiliPublishedAtFromText,
  resolveBilibiliPublishedAt
} from "../src/bilibili-published-date.mjs";

test("Bilibili published date prefers API epoch over text fallback", () => {
  const pubdate = Date.parse("2026-05-24T12:00:00+08:00") / 1000;

  assert.equal(
    resolveBilibiliPublishedAt({
      pubdate,
      text: "发布时间：2026-05-22\n5月22日涨停复盘"
    }),
    "2026-05-24"
  );
});

test("Bilibili text fallback ignores business dates without publish labels", () => {
  assert.equal(
    extractBilibiliPublishedAtFromText("5月22日涨停复盘！\n评论 100"),
    ""
  );
});

test("Bilibili text fallback parses explicit publish labels", () => {
  assert.equal(
    extractBilibiliPublishedAtFromText("简介\n发布时间：2026-05-22 18:00\n评论 100"),
    "2026-05-22"
  );
});

test("Bilibili epoch formatter returns Shanghai calendar dates", () => {
  const pubdate = Date.parse("2026-05-22T23:30:00+08:00") / 1000;

  assert.equal(dateFromBilibiliEpoch(pubdate), "2026-05-22");
});
