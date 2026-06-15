import fs from "node:fs/promises";
import path from "node:path";
import { dailySummaryPath } from "./platform-config.mjs";

const DEFAULT_MAX_ENTRIES = 20;
const HISTORY_PATH = path.join(".runtime", "scheduler-runs.json");
const BACKFILL_STATUS_SET = new Set(["skipped", "failed"]);
const CLEAR_BACKFILL_STATUS_SET = new Set(["finished"]);
const PLATFORM_LABELS = {
  douyin: "抖音",
  xhs: "小红书",
  bilibili: "B站"
};

export async function readSchedulerRunHistory({ root = process.cwd() } = {}) {
  const filePath = path.join(root, HISTORY_PATH);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    const pendingBackfillDates = normalizePendingBackfillDates(parsed.pendingBackfillDates || parsed.pendingDates || []);
    return {
      latest: parsed.latest || runs.at(-1) || null,
      runs,
      pendingBackfillDates
    };
  } catch {
    return { latest: null, runs: [], pendingBackfillDates: [] };
  }
}

export async function recordSchedulerRun({
  root = process.cwd(),
  event,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => new Date()
} = {}) {
  if (!event || typeof event !== "object") throw new Error("scheduler run event is required");
  const history = await readSchedulerRunHistory({ root });
  const normalized = normalizeSchedulerRunEvent(event, now);
  const runs = [...history.runs, normalized].slice(-Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES));
  const pendingBackfillDates = updatePendingBackfillDates(history.pendingBackfillDates, normalized);
  const payload = {
    latest: normalized,
    runs,
    pendingBackfillDates
  };
  const filePath = path.join(root, HISTORY_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function nextScheduledTargetDate(history, fallbackTargetDate) {
  const pendingBackfillDates = normalizePendingBackfillDates(history?.pendingBackfillDates || []);
  if (pendingBackfillDates.length > 0) {
    return {
      targetDate: pendingBackfillDates[0],
      isBackfill: true,
      pendingBackfillDates
    };
  }
  return {
    targetDate: String(fallbackTargetDate || ""),
    isBackfill: false,
    pendingBackfillDates
  };
}

export async function summarizeDailyRunForScheduler({
  root = process.cwd(),
  targetDate,
  sinceDate = targetDate,
  untilDate = targetDate,
  exitCode = null
} = {}) {
  const summaryPath = dailySummaryPath(sinceDate || targetDate, root, untilDate || sinceDate || targetDate);
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      summaryPath,
      missing: true,
      reason: Number(exitCode) === 0
        ? `未找到每日采集汇总：${summaryPath}`
        : `采集进程退出码 ${exitCode}`,
      platforms: {}
    };
  }

  const platforms = normalizeSchedulerPlatforms(parsed.platforms || {});
  const failedLabels = Object.entries(platforms)
    .filter(([, platform]) => isFailedPlatformStatus(platform.status))
    .map(([platformId]) => PLATFORM_LABELS[platformId] || platformId);
  const ok = Boolean(parsed.ok) && Number(exitCode) === 0;
  const reason = !ok
    ? (failedLabels.length > 0
        ? `每日汇总存在失败平台：${failedLabels.join("、")}。`
        : (Number(exitCode) !== 0 ? `采集进程退出码 ${exitCode}` : String(parsed.partialFailureReason || "每日汇总标记失败。")))
    : "";

  return {
    ok,
    summaryPath,
    missing: false,
    sinceDate: String(parsed.sinceDate || sinceDate || targetDate || ""),
    untilDate: String(parsed.untilDate || untilDate || sinceDate || targetDate || ""),
    partialFailureReason: String(parsed.partialFailureReason || ""),
    reason,
    platforms
  };
}

function normalizeSchedulerRunEvent(event, now) {
  const timestamp = now().toISOString();
  return {
    status: String(event.status || "unknown"),
    targetDate: String(event.targetDate || ""),
    isBackfill: Boolean(event.isBackfill),
    triggeredAt: event.triggeredAt || timestamp,
    finishedAt: event.finishedAt || "",
    exitCode: event.exitCode !== undefined && event.exitCode !== null && Number.isFinite(Number(event.exitCode))
      ? Number(event.exitCode)
      : null,
    reason: String(event.reason || ""),
    dailySummary: event.dailySummary || null,
    recordedAt: timestamp
  };
}

function updatePendingBackfillDates(existingDates, event) {
  const pending = new Set(normalizePendingBackfillDates(existingDates));
  const targetDate = String(event.targetDate || "").trim();
  if (!targetDate) return [...pending].sort();
  if (BACKFILL_STATUS_SET.has(event.status)) pending.add(targetDate);
  if (CLEAR_BACKFILL_STATUS_SET.has(event.status) && Number(event.exitCode || 0) === 0) pending.delete(targetDate);
  return [...pending].sort();
}

function normalizePendingBackfillDates(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/u.test(item)))]
    .sort();
}

function normalizeSchedulerPlatforms(platforms = {}) {
  return Object.fromEntries(Object.entries(platforms).map(([platformId, platform = {}]) => {
    const gate = platform.materialGate || platform.gate || {};
    const stats = platform.materials || {};
    return [platformId, {
      status: String(platform.status || ""),
      collected: Number(platform.collected || 0),
      error: String(platform.error || ""),
      feishu: platform.feishu ? {
        created: Number(platform.feishu.created || 0),
        updated: Number(platform.feishu.updated || 0),
        skipped: Number(platform.feishu.skipped || 0)
      } : null,
      materials: stats || gate.reason ? {
        total: Number(stats.total || gate.total || 0),
        failed: Number(stats.failed || gate.failed || 0),
        consecutiveFailures: Number(stats.consecutiveFailures || gate.consecutiveFailures || 0),
        blocked: Boolean(gate.blocked),
        reason: String(gate.reason || "")
      } : null
    }];
  }));
}

function isFailedPlatformStatus(status = "") {
  return ["failed", "asset_blocked"].includes(String(status));
}
