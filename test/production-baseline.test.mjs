import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { planRuntimeCleanup } from "../src/runtime-cleanup.mjs";
import { runProductionCheck } from "../src/prod-checker.mjs";
import {
  nextScheduledTargetDate,
  recordSchedulerRun,
  readSchedulerRunHistory,
  summarizeDailyRunForScheduler
} from "../src/scheduler-run-history.mjs";

test("production check reports missing runtime prerequisites without shared password checks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-prod-check-"));
  await fs.writeFile(path.join(root, ".env"), "FEISHU_APP_ID=app\n", "utf8");
  const result = await runProductionCheck({
    root,
    env: {
      HOST: "0.0.0.0",
      PORT: "0",
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_SPREADSHEET_TOKEN: "sheet",
      FEISHU_SHEET_DOUYIN: "douyin",
      FEISHU_SHEET_XHS: "xhs",
      FEISHU_SHEET_BILIBILI: "bilibili"
    },
    checkPort: async () => ({ ok: true, message: "可用" })
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.some((check) => check.id === "lan_password"), false);
  assert.equal(result.checks.find((check) => check.id === "profiles").status, "fail");
  assert.match(result.summary, /检查未通过/);
});

test("production check passes when env, Feishu config, profiles, scheduler, and port are ready", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-prod-ready-"));
  await fs.writeFile(path.join(root, ".env"), "FEISHU_APP_ID=app\n", "utf8");
  await fs.mkdir(path.join(root, ".xhs-profile"));
  await fs.mkdir(path.join(root, ".douyin-profile"));
  await fs.mkdir(path.join(root, ".bilibili-profile"));
  await fs.mkdir(path.join(root, ".runtime"));
  await fs.writeFile(path.join(root, ".runtime", "scheduler.json"), JSON.stringify({ enabled: true, time: "11:30" }), "utf8");
  const result = await runProductionCheck({
    root,
    env: {
      HOST: "0.0.0.0",
      PORT: "0",
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_SPREADSHEET_TOKEN: "sheet",
      FEISHU_SHEET_DOUYIN: "douyin",
      FEISHU_SHEET_XHS: "xhs",
      FEISHU_SHEET_BILIBILI: "bilibili"
    },
    checkPort: async () => ({ ok: true, message: "可用" })
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.every((check) => check.status !== "fail"), true);
});

test("runtime cleanup dry run includes generated artifacts and excludes browser profiles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-cleanup-"));
  await fs.mkdir(path.join(root, "output", "feishu-backups"), { recursive: true });
  await fs.writeFile(path.join(root, "output", "feishu-backups", "backup.json"), "backup", "utf8");
  await fs.writeFile(path.join(root, "output", "step15-policy-eval-2026-05-26.json"), "{}", "utf8");
  await fs.mkdir(path.join(root, "output", "step15-assets", "2026-05-20"), { recursive: true });
  await fs.writeFile(path.join(root, "output", "step15-assets", "2026-05-20", "manifest.json"), "{}", "utf8");
  await fs.mkdir(path.join(root, ".runtime", "detail-cache", "xhs"), { recursive: true });
  await fs.writeFile(path.join(root, ".runtime", "detail-cache", "xhs", "item.json"), "{}", "utf8");
  await fs.mkdir(path.join(root, ".xhs-profile"), { recursive: true });
  await fs.writeFile(path.join(root, ".xhs-profile", "Cookies"), "keep", "utf8");

  const plan = await planRuntimeCleanup({ root });

  assert.equal(plan.apply, false);
  assert.equal(plan.candidates.some((candidate) => candidate.relativePath === "output/feishu-backups"), true);
  assert.equal(plan.candidates.some((candidate) => candidate.relativePath === "output/step15-assets"), true);
  assert.equal(plan.candidates.some((candidate) => candidate.relativePath === ".runtime/detail-cache"), true);
  assert.equal(plan.candidates.some((candidate) => candidate.relativePath.includes(".xhs-profile")), false);
  assert.equal(plan.totalBytes > 0, true);
});

test("scheduler run history records latest starts, skips, and exits without touching output data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-scheduler-runs-"));
  await recordSchedulerRun({
    root,
    event: {
      status: "started",
      targetDate: "2026-05-27",
      triggeredAt: "2026-05-28T03:30:00.000Z"
    },
    maxEntries: 2
  });
  await recordSchedulerRun({
    root,
    event: {
      status: "skipped",
      targetDate: "2026-05-27",
      reason: "当前有任务正在运行",
      triggeredAt: "2026-05-28T03:31:00.000Z"
    },
    maxEntries: 2
  });
  await recordSchedulerRun({
    root,
    event: {
      status: "finished",
      targetDate: "2026-05-27",
      exitCode: 0,
      finishedAt: "2026-05-28T03:32:00.000Z"
    },
    maxEntries: 2
  });

  const history = await readSchedulerRunHistory({ root });

  assert.equal(history.runs.length, 2);
  assert.equal(history.latest.status, "finished");
  assert.equal(history.runs[0].status, "skipped");
  assert.equal(history.runs[0].reason, "当前有任务正在运行");
  assert.equal(history.runs[1].exitCode, 0);
});

test("scheduler run history tracks pending backfill dates and chooses the oldest one first", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-scheduler-pending-"));
  await recordSchedulerRun({
    root,
    event: {
      status: "skipped",
      targetDate: "2026-05-27",
      reason: "当前有任务正在运行",
      triggeredAt: "2026-05-28T03:30:00.000Z"
    }
  });
  await recordSchedulerRun({
    root,
    event: {
      status: "failed",
      targetDate: "2026-05-26",
      reason: "采集进程退出码 1",
      triggeredAt: "2026-05-27T03:30:00.000Z"
    }
  });

  let history = await readSchedulerRunHistory({ root });
  assert.deepEqual(history.pendingBackfillDates, ["2026-05-26", "2026-05-27"]);
  assert.deepEqual(nextScheduledTargetDate(history, "2026-05-29"), {
    targetDate: "2026-05-26",
    isBackfill: true,
    pendingBackfillDates: ["2026-05-26", "2026-05-27"]
  });

  await recordSchedulerRun({
    root,
    event: {
      status: "finished",
      targetDate: "2026-05-26",
      exitCode: 0,
      triggeredAt: "2026-05-29T03:30:00.000Z",
      finishedAt: "2026-05-29T03:32:00.000Z"
    }
  });

  history = await readSchedulerRunHistory({ root });
  assert.deepEqual(history.pendingBackfillDates, ["2026-05-27"]);
});

test("scheduler summary readback records platform outcomes and queues failed summaries for backfill", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-scheduler-summary-"));
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  await fs.writeFile(path.join(root, "output", "daily_collect_2026-05-27.json"), JSON.stringify({
    ok: false,
    sinceDate: "2026-05-27",
    untilDate: "2026-05-27",
    platforms: {
      douyin: {
        status: "written_with_asset_failures",
        collected: 10,
        materials: { total: 10, failed: 3, consecutiveFailures: 3 },
        materialGate: { blocked: true, reason: "素材获取失败率达到阈值：3/10，优先处理素材获取。" },
        feishu: { created: 8, updated: 2, skipped: 0 }
      },
      xhs: {
        status: "failed",
        error: "登录失效",
        collected: 0,
        feishu: null
      }
    }
  }), "utf8");

  const summary = await summarizeDailyRunForScheduler({
    root,
    targetDate: "2026-05-27",
    exitCode: 0
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.reason, "每日汇总存在失败平台：小红书。");
  assert.equal(summary.platforms.douyin.status, "written_with_asset_failures");
  assert.deepEqual(summary.platforms.douyin.materials, {
    total: 10,
    failed: 3,
    consecutiveFailures: 3,
    blocked: true,
    reason: "素材获取失败率达到阈值：3/10，优先处理素材获取。"
  });
  assert.deepEqual(summary.platforms.douyin.feishu, { created: 8, updated: 2, skipped: 0 });

  await recordSchedulerRun({
    root,
    event: {
      status: summary.ok ? "finished" : "failed",
      targetDate: "2026-05-27",
      exitCode: 0,
      reason: summary.reason,
      dailySummary: summary
    }
  });
  const history = await readSchedulerRunHistory({ root });
  assert.deepEqual(history.pendingBackfillDates, ["2026-05-27"]);
  assert.equal(history.latest.dailySummary.platforms.xhs.error, "登录失效");
});

test("scheduler summary readback treats a missing zero-exit summary as failed backfill work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-scheduler-missing-summary-"));

  const summary = await summarizeDailyRunForScheduler({
    root,
    targetDate: "2026-05-27",
    exitCode: 0
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.missing, true);
  assert.match(summary.reason, /未找到每日采集汇总/u);

  await recordSchedulerRun({
    root,
    event: {
      status: summary.ok ? "finished" : "failed",
      targetDate: "2026-05-27",
      exitCode: 0,
      reason: summary.reason,
      dailySummary: summary
    }
  });
  const history = await readSchedulerRunHistory({ root });
  assert.deepEqual(history.pendingBackfillDates, ["2026-05-27"]);
});

test("server records scheduled all-channel run starts, skips, and exits", async () => {
  const server = await fs.readFile(path.join(process.cwd(), "src", "server.mjs"), "utf8");

  assert.match(server, /nextScheduledTargetDate, readSchedulerRunHistory, recordSchedulerRun, summarizeDailyRunForScheduler/u);
  assert.match(server, /const target = nextScheduledTargetDate\(history, scheduledTargetDate\)/u);
  assert.match(server, /定时补采中/u);
  assert.match(server, /await recordSchedulerEvent\(\{ status: "skipped", targetDate, isBackfill: target\.isBackfill, reason, triggeredAt \}\)/u);
  assert.match(server, /await recordSchedulerEvent\(\{ status: "started", targetDate, isBackfill: target\.isBackfill, triggeredAt \}\)/u);
  assert.match(server, /const dailySummary = await summarizeDailyRunForScheduler\(\{ root: ROOT, targetDate, exitCode: code \}\)/u);
  assert.match(server, /status: dailySummary\.ok \? "finished" : "failed"/u);
  assert.match(server, /exitCode: code/);
});

test("package exposes production check and cleanup dry-run scripts", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"));

  assert.equal(pkg.scripts["prod:check"], "node src/prod-check.mjs");
  assert.equal(pkg.scripts["cleanup:dry-run"], "node src/cleanup-runtime.mjs");
});

test("release package includes prompt maintenance docs and still excludes runtime artifacts", async () => {
  const packageScript = await fs.readFile(path.join(process.cwd(), "scripts", "package-release.mjs"), "utf8");
  const readme = await fs.readFile(path.join(process.cwd(), "README.md"), "utf8");

  assert.match(packageScript, /const REQUIRED_DIRS = \[\s*"src",\s*"public",\s*"docs"\s*\]/u);
  assert.match(packageScript, /hasPromptDocs: requiredPromptDocs\.every/u);
  assert.match(packageScript, /包含 Prompt 维护文档/u);
  assert.match(packageScript, /item\.startsWith\("output\/"\)/u);
  assert.match(packageScript, /item\.endsWith\("\/manifest\.json"\)/u);

  assert.match(readme, /Prompt 和分类维护资料随交付包提供/u);
  assert.match(readme, /docs\/xhs-content-type-taxonomy\.md/u);
  assert.match(readme, /docs\/douyin-channel-type-taxonomy\.md/u);
  assert.match(readme, /docs\/bilibili-content-type-taxonomy\.md/u);
});
