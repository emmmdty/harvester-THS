import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { planRuntimeCleanup } from "../src/runtime-cleanup.mjs";
import { runProductionCheck } from "../src/prod-checker.mjs";
import { recordSchedulerRun, readSchedulerRunHistory } from "../src/scheduler-run-history.mjs";

test("production check keeps LAN password optional but reports missing runtime prerequisites", async () => {
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
  assert.equal(result.checks.find((check) => check.id === "lan_password").status, "ok");
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

test("server records scheduled all-channel run starts, skips, and exits", async () => {
  const server = await fs.readFile(path.join(process.cwd(), "src", "server.mjs"), "utf8");

  assert.match(server, /import \{ recordSchedulerRun \} from "\.\/scheduler-run-history\.mjs"/);
  assert.match(server, /await recordSchedulerEvent\(\{ status: "skipped", targetDate, reason, triggeredAt \}\)/);
  assert.match(server, /await recordSchedulerEvent\(\{ status: "started", targetDate, triggeredAt \}\)/);
  assert.match(server, /status: "finished"/);
  assert.match(server, /exitCode: code/);
});

test("package exposes production check and cleanup dry-run scripts", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"));

  assert.equal(pkg.scripts["prod:check"], "node src/prod-check.mjs");
  assert.equal(pkg.scripts["cleanup:dry-run"], "node src/cleanup-runtime.mjs");
});
