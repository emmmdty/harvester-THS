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

test("crawlers count unknown dates only from authoritative platform date sources", async () => {
  const crawlerFiles = {
    xhs: await fs.readFile(path.join(process.cwd(), "src", "crawl-xhs.mjs"), "utf8"),
    douyin: await fs.readFile(path.join(process.cwd(), "src", "crawl-douyin.mjs"), "utf8"),
    bilibili: await fs.readFile(path.join(process.cwd(), "src", "crawl-bilibili.mjs"), "utf8")
  };

  for (const source of Object.values(crawlerFiles)) {
    assert.doesNotMatch(source, /if \(prefilter\.reason === "unknown-date"\) audit\?\.recordUnknownDate\(\);/);
  }
  assert.match(crawlerFiles.xhs, /publishedDateFromXhsNoteId\(link\.id\)[\s\S]*if \(!idPublishedAtDate\) \{[\s\S]*audit\?\.recordUnknownDate\(\);/);
  assert.match(crawlerFiles.douyin, /publishedDateFromDouyinItemId\(link\.id\)[\s\S]*if \(!idPublishedAtDate\) \{[\s\S]*audit\?\.recordUnknownDate\(\);/);
  assert.match(crawlerFiles.bilibili, /if \(!detail\.publishedAt\) \{[\s\S]*audit\?\.recordUnknownDate\(\);/);
});

test("XHS crawler writes partial output before surfacing account risk stops", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "src", "crawl-xhs.mjs"), "utf8");

  assert.match(source, /let pendingRiskError = null;/);
  assert.match(source, /if \(!isXhsRiskStopError\(error\)\) throw error;/);
  assert.match(source, /pendingRiskError = error;/);
  assert.match(source, /await writeOutputs\(rows,[\s\S]*risk: pendingRiskError \?/);
  assert.match(source, /if \(pendingRiskError\) throw pendingRiskError;/);
});

test("Douyin crawler supports a global detail check limit for verification runs", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "src", "crawl-douyin.mjs"), "utf8");

  assert.match(source, /const MAX_TOTAL_DETAIL_PAGES = Number\(process\.env\.MAX_TOTAL_DETAIL_PAGES \|\| 0\);/);
  assert.match(source, /const totalDetailBudget = createTotalDetailBudget\(MAX_TOTAL_DETAIL_PAGES\);/);
  assert.match(source, /totalDetailBudget,/);
  assert.match(source, /if \(totalDetailBudget\.reached\(\)\) \{/);
  assert.match(source, /totalDetailBudget\.record\(\);/);
});

test("Douyin crawler accepts post-list API responses as detail evidence for note pages", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "src", "crawl-douyin.mjs"), "utf8");

  assert.match(source, /url\.pathname\.includes\("\/aweme\/v1\/web\/aweme\/post\/"\)/);
  assert.match(source, /json\.aweme_list\.some\(\(item\) => String\(item\?\.aweme_id \|\| ""\) === itemId\)/);
  assert.match(source, /extractDouyinApiDetail\(json, \{ itemId \}\)/);
});

test("resource blocker aborts heavy assets only in conservative mode", async () => {
  const { shouldBlockResource } = await loadRuntime();

  assert.equal(shouldBlockResource({ mode: "conservative", resourceType: "image" }), true);
  assert.equal(shouldBlockResource({ mode: "conservative", resourceType: "media" }), true);
  assert.equal(shouldBlockResource({ mode: "conservative", resourceType: "font" }), true);
  assert.equal(shouldBlockResource({ mode: "conservative", resourceType: "script" }), false);
  assert.equal(shouldBlockResource({ mode: "legacy", resourceType: "image" }), false);
});

test("resource blocker temporary disable returns fallback and re-enables on timeout", async () => {
  const { installConservativeResourceBlocker } = await loadRuntime();
  const calls = [];
  const context = {
    async route() {
      calls.push("route");
    },
    async unroute() {
      calls.push("unroute");
    }
  };

  const blocker = await installConservativeResourceBlocker(context, {
    mode: "conservative",
    label: "测试轻量模式"
  });
  const result = await blocker.disableTemporarily(() => new Promise(() => {}), {
    timeoutMs: 10,
    fallback: "timeout-fallback",
    onTimeout() {
      calls.push("timeout");
    }
  });

  assert.equal(result, "timeout-fallback");
  assert.deepEqual(calls, ["route", "unroute", "timeout", "route"]);
});

test("Douyin unblocked list retry is bounded by an explicit timeout", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "src", "crawl-douyin.mjs"), "utf8");

  assert.match(source, /DOUYIN_LIST_UNBLOCKED_RETRY_TIMEOUT_MS/);
  assert.match(source, /disableTemporarily\([\s\S]*timeoutMs: DOUYIN_LIST_UNBLOCKED_RETRY_TIMEOUT_MS/);
  assert.match(source, /抖音列表页关闭轻量模式重试超时/);
});

test("Douyin share copy is opt-in in conservative mode and preserved in legacy mode", async () => {
  const { shouldCopyDouyinShare } = await loadRuntime();

  assert.equal(shouldCopyDouyinShare({ mode: "conservative", env: {} }), false);
  assert.equal(shouldCopyDouyinShare({ mode: "conservative", env: { DOUYIN_COPY_SHARE: "1" } }), true);
  assert.equal(shouldCopyDouyinShare({ mode: "legacy", env: {} }), true);
});
