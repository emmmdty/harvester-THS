import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectDaily, riskLoginWindowSpawnOptions } from "../src/collect-daily-runner.mjs";
import { dailySummaryPath, DAILY_PLATFORM_IDS, resolvePlatformPaths } from "../src/platform-config.mjs";

const noOpMaterialCache = async () => ({
  manifests: [],
  stats: { total: 1, failed: 0, consecutiveFailures: 0 }
});
const passThroughClassify = async ({ items }) => items;

test("collect:daily platform paths only point to daily crawler entrypoints", () => {
  const scripts = Object.fromEntries(DAILY_PLATFORM_IDS.map((platformId) => [
    platformId,
    path.basename(resolvePlatformPaths(platformId, "/repo").crawlScriptPath)
  ]));

  assert.deepEqual(scripts, {
    douyin: "crawl-douyin.mjs",
    xhs: "crawl-xhs.mjs",
    bilibili: "crawl-bilibili.mjs"
  });
  assert.equal(Object.values(scripts).some((script) => /history|sync|oneoff/u.test(script)), false);
});

test("collectDaily writes each successful platform before moving to the next one", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-daily-"));
  const calls = [];

  const result = await collectDaily({
    root,
    targetDate: "2026-05-19",
    platforms: ["douyin", "xhs", "bilibili"],
    skipFeishu: false,
    crawlMode: "conservative",
    createClient: () => ({ client: true }),
    runPlatformCrawler: async (platformId) => {
      calls.push(`crawl:${platformId}`);
    },
    readPlatformItems: async (platformId) => {
      calls.push(`read:${platformId}`);
      return [{ link: `${platformId}-link`, publishedAt: "2026-05-19" }];
    },
    cachePlatformMaterials: noOpMaterialCache,
    classifyPlatformItems: passThroughClassify,
    writePlatformJsonToFeishu: async ({ platformId }) => {
      calls.push(`write:${platformId}`);
      return { collected: 1, feishu: { created: 1, skipped: 0 } };
    },
    log: () => {}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "crawl:douyin",
    "read:douyin",
    "write:douyin",
    "crawl:xhs",
    "read:xhs",
    "write:xhs",
    "crawl:bilibili",
    "read:bilibili",
    "write:bilibili"
  ]);
});

test("collectDaily crawls one inclusive date range and writes the successful range by platform", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-daily-"));
  const calls = [];

  const result = await collectDaily({
    root,
    sinceDate: "2026-05-20",
    untilDate: "2026-05-22",
    platforms: ["douyin", "xhs"],
    skipFeishu: false,
    crawlMode: "conservative",
    createClient: () => ({ client: true }),
    runPlatformCrawler: async (platformId, sinceDate, untilDate) => {
      calls.push(`crawl:${platformId}:${sinceDate}->${untilDate}`);
    },
    readPlatformItems: async (platformId, sinceDate, rootDir, untilDate) => {
      calls.push(`read:${platformId}:${sinceDate}->${untilDate}`);
      return [
        { link: `${platformId}-0520`, publishedAt: "2026-05-20" },
        { link: `${platformId}-0521`, publishedAt: "2026-05-21" },
        { link: `${platformId}-0522`, publishedAt: "2026-05-22" }
      ];
    },
    cachePlatformMaterials: noOpMaterialCache,
    classifyPlatformItems: passThroughClassify,
    writePlatformJsonToFeishu: async ({ platformId, sinceDate, untilDate }) => {
      calls.push(`write:${platformId}:${sinceDate}->${untilDate}`);
      return {
        collected: 3,
        feishu: {
          created: 6,
          skipped: 0,
          byDate: [
            { date: "2026-05-20", collected: 1 },
            { date: "2026-05-21", collected: 1 },
            { date: "2026-05-22", collected: 1 }
          ]
        }
      };
    },
    log: () => {}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "crawl:douyin:2026-05-20->2026-05-22",
    "read:douyin:2026-05-20->2026-05-22",
    "write:douyin:2026-05-20->2026-05-22",
    "crawl:xhs:2026-05-20->2026-05-22",
    "read:xhs:2026-05-20->2026-05-22",
    "write:xhs:2026-05-20->2026-05-22"
  ]);

  const summary = JSON.parse(await fs.readFile(dailySummaryPath("2026-05-20", root, "2026-05-22"), "utf8"));
  assert.equal(summary.sinceDate, "2026-05-20");
  assert.equal(summary.untilDate, "2026-05-22");
  assert.deepEqual(summary.platforms.douyin.feishu.byDate.map((entry) => entry.date), [
    "2026-05-20",
    "2026-05-21",
    "2026-05-22"
  ]);
});

test("collectDaily records platform failures but still writes successful platforms", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-daily-"));
  const calls = [];

  const result = await collectDaily({
    root,
    targetDate: "2026-05-19",
    platforms: ["douyin", "xhs", "bilibili"],
    skipFeishu: false,
    crawlMode: "conservative",
    createClient: () => ({ client: true }),
    runPlatformCrawler: async (platformId) => {
      calls.push(`crawl:${platformId}`);
      if (platformId === "xhs") throw new Error("xhs failed");
    },
    readPlatformItems: async (platformId) => {
      calls.push(`read:${platformId}`);
      return [{ link: `${platformId}-link`, publishedAt: "2026-05-19" }];
    },
    cachePlatformMaterials: noOpMaterialCache,
    classifyPlatformItems: passThroughClassify,
    writePlatformJsonToFeishu: async ({ platformId }) => {
      calls.push(`write:${platformId}`);
      return { collected: 1, feishu: { created: 1, skipped: 0 } };
    },
    log: () => {}
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [
    "crawl:douyin",
    "read:douyin",
    "write:douyin",
    "crawl:xhs",
    "crawl:bilibili",
    "read:bilibili",
    "write:bilibili"
  ]);
  assert.equal(result.summary.platforms.xhs.status, "failed");
  assert.match(result.summary.platforms.xhs.error, /xhs failed/);
  assert.equal(result.summary.platforms.douyin.status, "written");
  assert.equal(result.summary.platforms.bilibili.status, "written");

  const summary = JSON.parse(await fs.readFile(dailySummaryPath("2026-05-19", root), "utf8"));
  assert.equal(summary.ok, false);
  assert.equal(summary.partialFailureReason, "部分平台采集失败，成功平台已按日期写入飞书。");
  assert.equal(summary.platforms.douyin.feishu.created, 1);
  assert.equal(summary.platforms.bilibili.feishu.created, 1);
});

test("collectDaily stops XHS on risk errors and opens the visible login window hook", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-daily-xhs-risk-"));
  const calls = [];

  const result = await collectDaily({
    root,
    targetDate: "2026-05-19",
    platforms: ["xhs"],
    skipFeishu: true,
    crawlMode: "conservative",
    runPlatformCrawler: async (platformId) => {
      calls.push(`crawl:${platformId}`);
      throw new Error("小红书登录状态已失效：website-login/captcha 安全验证");
    },
    readPlatformItems: async (platformId) => {
      calls.push(`read:${platformId}`);
      return [];
    },
    cachePlatformMaterials: async ({ platformId }) => {
      calls.push(`materials:${platformId}`);
      return noOpMaterialCache();
    },
    classifyPlatformItems: passThroughClassify,
    writePlatformJsonToFeishu: async ({ platformId }) => {
      calls.push(`write:${platformId}`);
      return { collected: 0, feishu: { created: 0, skipped: 0 } };
    },
    openRiskLoginWindow: async ({ platformId, reason }) => {
      calls.push(`login:${platformId}:${/安全验证/u.test(reason)}`);
      return { ok: true };
    },
    log: () => {}
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["crawl:xhs", "login:xhs:true"]);
  assert.equal(result.summary.platforms.xhs.status, "risk_stopped");
  assert.equal(result.summary.platforms.xhs.action, "login_window_opened");
});

test("collectDaily detects XHS risk text propagated from child process output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-daily-xhs-child-risk-"));
  const calls = [];

  const result = await collectDaily({
    root,
    targetDate: "2026-05-19",
    platforms: ["xhs"],
    skipFeishu: true,
    crawlMode: "conservative",
    runPlatformCrawler: async () => {
      throw new Error("src/crawl-xhs.mjs 退出码：1\n小红书登录状态已失效，请先在面板点击“打开登录”重新登录。");
    },
    readPlatformItems: async () => [],
    cachePlatformMaterials: noOpMaterialCache,
    classifyPlatformItems: passThroughClassify,
    openRiskLoginWindow: async ({ platformId }) => {
      calls.push(`login:${platformId}`);
      return { ok: true };
    },
    log: () => {}
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["login:xhs"]);
  assert.equal(result.summary.platforms.xhs.status, "risk_stopped");
});

test("collectDaily writes partial XHS items collected before a later account risk stop", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-daily-xhs-partial-risk-"));
  const calls = [];

  const result = await collectDaily({
    root,
    targetDate: "2026-05-19",
    platforms: ["xhs"],
    skipFeishu: false,
    crawlMode: "conservative",
    createClient: () => ({ client: true }),
    runPlatformCrawler: async () => {
      calls.push("crawl:xhs");
      throw new Error("src/crawl-xhs.mjs 退出码：1\n页面疑似触发安全验证或访问限制（账号：同花顺理财）");
    },
    readPlatformItems: async (platformId) => {
      calls.push(`read:${platformId}`);
      return [
        { link: "xhs-before-risk-1", publishedAt: "2026-05-19" },
        { link: "xhs-before-risk-2", publishedAt: "2026-05-19" },
        { link: "xhs-before-risk-3", publishedAt: "2026-05-19" }
      ];
    },
    cachePlatformMaterials: async ({ platformId, items }) => {
      calls.push(`materials:${platformId}:${items.length}`);
      return { manifests: [], stats: { total: items.length, failed: 0, consecutiveFailures: 0 } };
    },
    classifyPlatformItems: async ({ platformId, items }) => {
      calls.push(`classify:${platformId}:${items.length}`);
      return items;
    },
    writePlatformJsonToFeishu: async ({ platformId, items }) => {
      calls.push(`write:${platformId}:${items.length}`);
      return { collected: items.length, feishu: { total: items.length, created: 3, updated: 0, skipped: 0 } };
    },
    openRiskLoginWindow: async ({ platformId }) => {
      calls.push(`login:${platformId}`);
      return { ok: true };
    },
    log: () => {}
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [
    "crawl:xhs",
    "login:xhs",
    "read:xhs",
    "materials:xhs:3",
    "classify:xhs:3",
    "write:xhs:3"
  ]);
  assert.equal(result.summary.platforms.xhs.status, "written_with_risk_stop");
  assert.equal(result.summary.platforms.xhs.collected, 3);
  assert.equal(result.summary.platforms.xhs.action, "login_window_opened");
  assert.equal(result.summary.platforms.xhs.feishu.created, 3);
});

test("risk login window is detached without keeping collection stdio open", () => {
  assert.deepEqual(riskLoginWindowSpawnOptions("/tmp/harvester"), {
    cwd: "/tmp/harvester",
    detached: true,
    stdio: "ignore"
  });
});
