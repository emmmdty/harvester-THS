import test from "node:test";
import assert from "node:assert/strict";
import {
  XHS_DETAIL_CACHE_VERSION,
  createXhsDetailRiskGuard,
  parseXhsDetailPublishedAt,
  resolveXhsPublishedAt,
  resolveXhsStatePublishedAt,
  restoreXhsDetailFromCache
} from "../src/xhs-published-date.mjs";

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

test("XHS publish date resolution uses the note ID before detail or state dates", () => {
  const detailPublishedAt = new Date(2026, 4, 30);
  const statePublishedAt = new Date(2026, 4, 30);

  assert.equal(
    localDateKey(resolveXhsPublishedAt({
      noteId: "6a198e0c0000000036000f68",
      detailPublishedAt,
      statePublishedAt
    })),
    "2026-05-29"
  );
});

test("XHS publish date resolution does not fall back to detail or state dates", () => {
  const detailPublishedAt = new Date(2026, 4, 19);
  const statePublishedAt = new Date(2026, 4, 20);

  assert.equal(
    resolveXhsPublishedAt({ detailPublishedAt, statePublishedAt }),
    null
  );
});

test("XHS blocked details do not fall back to state publish dates", () => {
  const statePublishedAt = new Date(2026, 4, 24);

  assert.equal(
    resolveXhsPublishedAt({ detailPublishedAt: null, statePublishedAt, detailBlocked: true }),
    null
  );
});

test("XHS detail risk guard stops after consecutive blocked details", () => {
  const guard = createXhsDetailRiskGuard({ stopAfter: 2 });

  assert.deepEqual(guard.record({ blocked: true }), {
    consecutiveBlocked: 1,
    shouldStop: false
  });
  assert.deepEqual(guard.record({ publishedAt: new Date(2026, 4, 24) }), {
    consecutiveBlocked: 0,
    shouldStop: false
  });
  assert.deepEqual(guard.record({ blocked: true }), {
    consecutiveBlocked: 1,
    shouldStop: false
  });
  assert.deepEqual(guard.record({ blocked: true }), {
    consecutiveBlocked: 2,
    shouldStop: true
  });
});

test("XHS publish date resolution returns null when no publish date is available", () => {
  assert.equal(
    resolveXhsPublishedAt({ detailPublishedAt: null, statePublishedAt: null }),
    null
  );
});

test("XHS detail publish date ignores edited dates and uses explicit publish text", () => {
  const result = parseXhsDetailPublishedAt({
    dateTexts: ["编辑于 05-24 上海", "发布于 05-22 浙江"],
    bodyText: "5月22日涨停复盘！\n编辑于 05-24 上海",
    referenceDateString: "2026-05-24"
  });

  assert.equal(localDateKey(result.publishedAt), "2026-05-22");
  assert.equal(result.source, "detail-date");
});

test("XHS state publish date ignores lastUpdateTime and prefers publish fields", () => {
  const result = resolveXhsStatePublishedAt({
    publishTime: "2026-05-22",
    lastUpdateTime: "2026-05-24"
  }, {
    referenceDateString: "2026-05-24"
  });

  assert.equal(localDateKey(result.publishedAt), "2026-05-22");
  assert.equal(result.source, "state:publishTime");

  assert.equal(
    resolveXhsStatePublishedAt({ lastUpdateTime: "2026-05-24" }, { referenceDateString: "2026-05-24" }).publishedAt,
    null
  );
});

test("XHS detail cache restore requires the current cache version", () => {
  assert.equal(restoreXhsDetailFromCache({
    tags: "#tag",
    publishedAt: "2026-05-24",
    noteUrl: "https://www.xiaohongshu.com/explore/old"
  }), null);

  const restoredFromDetailDate = restoreXhsDetailFromCache({
    cacheVersion: XHS_DETAIL_CACHE_VERSION,
    tags: "#tag",
    publishedAt: "2026-05-22",
    publishedAtSource: "detail-date",
    noteUrl: "https://www.xiaohongshu.com/explore/current"
  });

  assert.equal(restoredFromDetailDate.publishedAt, null);
  assert.equal(restoredFromDetailDate.publishedAtSource, "");

  const restored = restoreXhsDetailFromCache({
    cacheVersion: XHS_DETAIL_CACHE_VERSION,
    tags: "#tag",
    publishedAt: "2026-05-22",
    publishedAtSource: "note-id",
    noteUrl: "https://www.xiaohongshu.com/explore/current"
  });

  assert.equal(localDateKey(restored.publishedAt), "2026-05-22");
  assert.equal(restored.publishedAtSource, "note-id");
});
