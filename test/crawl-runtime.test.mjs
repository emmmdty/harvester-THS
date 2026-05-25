import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function loadRuntime() {
  return import("../src/crawl-runtime.mjs");
}

test("crawl mode defaults to conservative and preserves explicit legacy mode", async () => {
  const { resolveCrawlMode, isConservativeMode } = await loadRuntime();

  assert.equal(resolveCrawlMode({}, {}), "conservative");
  assert.equal(resolveCrawlMode({ mode: "legacy" }, {}), "legacy");
  assert.equal(resolveCrawlMode({}, { CRAWL_MODE: "legacy" }), "legacy");
  assert.equal(isConservativeMode("conservative"), true);
  assert.equal(isConservativeMode("legacy"), false);
});

test("date prefilter only skips details with reliable out-of-range dates", async () => {
  const { shouldInspectDetailByPublishedAt } = await loadRuntime();
  const range = { since: "2026-05-19", until: "2026-05-20" };

  assert.deepEqual(shouldInspectDetailByPublishedAt({ publishedAt: "", ...range }), {
    inspect: true,
    reason: "unknown-date"
  });
  assert.deepEqual(shouldInspectDetailByPublishedAt({ publishedAt: "2026-05-18", ...range }), {
    inspect: false,
    reason: "before-since"
  });
  assert.deepEqual(shouldInspectDetailByPublishedAt({ publishedAt: "2026-05-19", ...range }), {
    inspect: true,
    reason: "in-range"
  });
  assert.deepEqual(shouldInspectDetailByPublishedAt({ publishedAt: "2026-05-21", ...range }), {
    inspect: false,
    reason: "after-until"
  });
});

test("publish date range checks compare calendar dates instead of Date timestamps", async () => {
  const { isPublishedAtInDateRange } = await loadRuntime();
  const range = {
    since: new Date(2026, 4, 20, 0, 0, 0),
    until: new Date(2026, 4, 22, 0, 0, 0)
  };

  assert.equal(
    isPublishedAtInDateRange({
      publishedAt: new Date(2026, 4, 22, 23, 59, 59),
      ...range
    }),
    true
  );
  assert.equal(
    isPublishedAtInDateRange({
      publishedAt: new Date(2026, 4, 23, 0, 0, 0),
      ...range
    }),
    false
  );
});

test("detail cache honors disabled and refresh modes and survives corrupt files", async () => {
  const { DetailCache } = await loadRuntime();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-cache-"));

  const cache = new DetailCache({ root, platformId: "xhs", enabled: true, refresh: false });
  assert.equal(await cache.get("note-1"), null);
  await cache.set("note-1", { publishedAt: "2026-05-19", tags: "#tag" });
  assert.deepEqual(await cache.get("note-1"), { publishedAt: "2026-05-19", tags: "#tag" });

  const disabled = new DetailCache({ root, platformId: "xhs", enabled: false, refresh: false });
  assert.equal(await disabled.get("note-1"), null);
  await disabled.set("note-2", { publishedAt: "2026-05-20" });
  assert.equal(await cache.get("note-2"), null);

  const refresh = new DetailCache({ root, platformId: "xhs", enabled: true, refresh: true });
  assert.equal(await refresh.get("note-1"), null);

  await fs.writeFile(path.join(root, ".runtime", "detail-cache", "xhs", "broken.json"), "{", "utf8");
  assert.equal(await cache.get("broken"), null);
});

test("audit helper records skipped, checked, cache hit, unknown date, and stop reason", async () => {
  const { createCrawlAudit } = await loadRuntime();

  const audit = createCrawlAudit("xhs");
  const accountAudit = audit.account("同花顺投资");
  accountAudit.recordChecked();
  accountAudit.recordHit();
  accountAudit.recordSkipped("before-since");
  accountAudit.recordSkipped("after-until");
  accountAudit.recordUnknownDate();
  accountAudit.recordCacheHit();
  accountAudit.stop("old-boundary");

  assert.deepEqual(audit.toJSON(), {
    platform: "xhs",
    totals: {
      accounts: 1,
      checked: 1,
      hits: 1,
      skippedBeforeSince: 1,
      skippedAfterUntil: 1,
      unknownDate: 1,
      cacheHits: 1
    },
    accounts: [
      {
        accountName: "同花顺投资",
        checked: 1,
        hits: 1,
        skippedBeforeSince: 1,
        skippedAfterUntil: 1,
        unknownDate: 1,
        cacheHits: 1,
        stopReason: "old-boundary"
      }
    ]
  });
});

test("resource blocker aborts heavy assets only in conservative mode", async () => {
  const { shouldBlockResource } = await loadRuntime();

  assert.equal(shouldBlockResource({ mode: "conservative", resourceType: "image" }), true);
  assert.equal(shouldBlockResource({ mode: "conservative", resourceType: "media" }), true);
  assert.equal(shouldBlockResource({ mode: "conservative", resourceType: "font" }), true);
  assert.equal(shouldBlockResource({ mode: "conservative", resourceType: "script" }), false);
  assert.equal(shouldBlockResource({ mode: "legacy", resourceType: "image" }), false);
});

test("Douyin share copy is opt-in in conservative mode and preserved in legacy mode", async () => {
  const { shouldCopyDouyinShare } = await loadRuntime();

  assert.equal(shouldCopyDouyinShare({ mode: "conservative", env: {} }), false);
  assert.equal(shouldCopyDouyinShare({ mode: "conservative", env: { DOUYIN_COPY_SHARE: "1" } }), true);
  assert.equal(shouldCopyDouyinShare({ mode: "legacy", env: {} }), true);
});
