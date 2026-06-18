import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { readPlatformItems as defaultReadPlatformItems, writePlatformJsonToFeishu as defaultWritePlatformJsonToFeishu } from "./feishu-writer.mjs";
import { dailySummaryPath, getPlatformConfig, resolvePlatformPaths } from "./platform-config.mjs";
import { classifyPlatformItems as defaultClassifyPlatformItems } from "./daily/classify-platform.mjs";
import { cachePlatformMaterials as defaultCachePlatformMaterials } from "./materials/cache.mjs";
import { shouldBlockFeishuWriteback } from "./materials/failure-gate.mjs";
import { emitProgress } from "./progress-events.mjs";

const NODE_BIN = process.execPath;
const CHILD_OUTPUT_SNIPPET_LIMIT = 8000;

export async function collectDaily({
  root = process.cwd(),
  targetDate,
  sinceDate = targetDate,
  untilDate = targetDate || sinceDate,
  platforms,
  skipFeishu = false,
  crawlMode = "conservative",
  strictMaterialGate = strictMaterialGateFromEnv(process.env),
  createClient = () => new FeishuSheetsClient(loadFeishuConfig()),
  runPlatformCrawler = defaultRunPlatformCrawler,
  readPlatformItems = defaultReadPlatformItems,
  cachePlatformMaterials = defaultCachePlatformMaterials,
  classifyPlatformItems = defaultClassifyPlatformItems,
  writePlatformJsonToFeishu = defaultWritePlatformJsonToFeishu,
  openRiskLoginWindow = defaultOpenRiskLoginWindow,
  log = console.log,
  onProgress = null
}) {
  sinceDate = sinceDate || targetDate;
  untilDate = untilDate || sinceDate;
  await fs.mkdir(path.join(root, "output"), { recursive: true });
  const summary = {
    ok: false,
    targetDate: sinceDate,
    sinceDate,
    untilDate,
    startedAt: new Date().toISOString(),
    skipFeishu,
    platforms: {}
  };

  const rangeText = sinceDate === untilDate ? sinceDate : `${sinceDate} 至 ${untilDate}`;
  log(`每日采集目标日期：${rangeText}`);
  log(`采集平台：${platforms.map((id) => getPlatformConfig(id).label).join("、")}`);
  log(`采集模式：${crawlMode === "legacy" ? "兼容旧模式" : "保守提速"}`);
  if (skipFeishu) log("已启用 --skip-feishu，本次只采集并生成本地输出。");

  let client = null;
  for (let platformIndex = 0; platformIndex < platforms.length; platformIndex += 1) {
    const platformId = platforms[platformIndex];
    const config = getPlatformConfig(platformId);
    let failureProgress = {
      stage: "crawl",
      completed: platformIndex,
      total: platforms.length,
      action: `${config.label}作品采集失败`
    };
    log(`\n==> 开始 ${config.label}`);
    try {
      emitProgress({
        onProgress,
        log,
        logProgress: shouldLogProgress(process.env),
        platformId,
        stage: "crawl",
        phase: "start",
        completed: platformIndex,
        total: platforms.length,
        action: `${config.label}作品采集中`
      });
      await runPlatformCrawler(platformId, sinceDate, untilDate, crawlMode, { root });
      emitProgress({
        onProgress,
        log,
        logProgress: shouldLogProgress(process.env),
        platformId,
        stage: "crawl",
        phase: "done",
        completed: platformIndex + 1,
        total: platforms.length,
        action: `${config.label}作品采集完成`
      });
      const platformSummary = await processCollectedPlatformItems({
        platformId,
        sinceDate,
        untilDate,
        root,
        skipFeishu,
        strictMaterialGate,
        createClient: () => {
          client = client || createClient();
          return client;
        },
        readPlatformItems,
        cachePlatformMaterials,
        classifyPlatformItems,
        writePlatformJsonToFeishu,
        log,
        onProgress,
        setFailureProgress: (next) => {
          failureProgress = next;
        }
      });
      summary.platforms[platformId] = platformSummary;
    } catch (error) {
      const message = error.message || String(error);
      emitProgress({
        onProgress,
        log,
        logProgress: shouldLogProgress(process.env),
        platformId,
        stage: failureProgress.stage,
        phase: "failed",
        completed: failureProgress.completed,
        total: failureProgress.total,
        action: failureProgress.action
      });
      const platformSummary = {
        status: "failed",
        collected: 0,
        feishu: null,
        error: message
      };
      if (isPlatformRiskStop(platformId, message)) {
        platformSummary.status = "risk_stopped";
        platformSummary.action = "login_window_open_failed";
        const loginResult = await openRiskLoginWindow({ platformId, root, reason: message, log }).catch((loginError) => ({
          ok: false,
          error: loginError.message || String(loginError)
        }));
        if (loginResult?.ok) {
          platformSummary.action = "login_window_opened";
        } else {
          platformSummary.loginWindowError = loginResult?.error || "登录窗口启动失败";
        }
        log(`${config.label} 触发登录/安全验证，已停止后台采集${platformSummary.action === "login_window_opened" ? "并打开登录窗口" : ""}：${message}`);
        const partialSummary = await processRiskStoppedPartialItems({
          platformId,
          sinceDate,
          untilDate,
          root,
          skipFeishu,
          strictMaterialGate,
          riskSummary: platformSummary,
          createClient: () => {
            client = client || createClient();
            return client;
          },
          readPlatformItems,
          cachePlatformMaterials,
          classifyPlatformItems,
          writePlatformJsonToFeishu,
          log,
          onProgress
        });
        if (partialSummary) {
          summary.platforms[platformId] = partialSummary;
          continue;
        }
      } else {
        log(`${config.label} 失败：${message}`);
      }
      summary.platforms[platformId] = platformSummary;
    }
  }

  const failedPlatforms = platforms.filter((platformId) => isFailedPlatformStatus(summary.platforms[platformId]?.status));
  summary.ok = failedPlatforms.length === 0;
  if (failedPlatforms.length > 0) {
    summary.partialFailureReason = failedPlatforms.some((platformId) => hasRiskStopStatus(summary.platforms[platformId]))
      ? "部分平台触发登录或安全验证，已停止对应平台后台采集并打开登录窗口。"
      : failedPlatforms.some((platformId) => String(summary.platforms[platformId]?.status || "").startsWith("asset_blocked"))
      ? "部分平台素材获取失败达到阈值，已停止对应平台飞书回填并优先保留素材获取证据。"
      : "部分平台采集失败，成功平台已按日期写入飞书。";
    log(`\n每日采集存在失败平台：${failedPlatforms.map((id) => getPlatformConfig(id).label).join("、")}。成功平台已继续写入。`);
  }
  summary.finishedAt = new Date().toISOString();
  await writeSummary(summary, root);
  log(`\n每日采集汇总：${dailySummaryPath(sinceDate, root, untilDate)}`);
  return { ok: summary.ok, summary };
}

async function processCollectedPlatformItems({
  platformId,
  sinceDate,
  untilDate,
  root,
  skipFeishu,
  strictMaterialGate,
  createClient,
  readPlatformItems,
  cachePlatformMaterials,
  classifyPlatformItems,
  writePlatformJsonToFeishu,
  log,
  onProgress,
  setFailureProgress = () => {},
  providedItems = null
}) {
  const config = getPlatformConfig(platformId);
  const items = Array.isArray(providedItems)
    ? providedItems
    : await readPlatformItems(platformId, sinceDate, root, untilDate);
  setFailureProgress({
    stage: "material",
    completed: 0,
    total: items.length,
    action: `${config.label}素材处理失败`
  });
  const materialResult = await cachePlatformMaterials({
    platformId,
    items,
    targetDate: sinceDate,
    sinceDate,
    untilDate,
    root,
    log,
    onProgress
  });
  const gate = materialResult.gate || shouldBlockFeishuWriteback(materialResult.stats || {});
  const platformSummary = {
    status: "collected",
    collected: items.length,
    materials: materialResult.stats || null,
    feishu: null
  };
  if (gate.blocked && strictMaterialGate) {
    platformSummary.status = "asset_blocked";
    platformSummary.error = gate.reason;
    platformSummary.materialGate = gate;
    log(`${config.label} 素材严格阻断：${gate.reason}`);
    return platformSummary;
  }
  if (gate.blocked) {
    platformSummary.status = "asset_warning";
    platformSummary.materialGate = gate;
    log(`${config.label} 素材失败但已写基础数据：${gate.reason}`);
  }
  setFailureProgress({
    stage: "classify",
    completed: 0,
    total: items.length,
    action: `${config.label}内容识别失败`
  });
  const classifiedItems = await classifyPlatformItems({
    platformId,
    items,
    materialResult,
    log,
    onProgress
  });
  if (!skipFeishu) {
    setFailureProgress({
      stage: "feishu",
      completed: 0,
      total: classifiedItems.length,
      action: `${config.label}飞书写入失败`
    });
    emitProgress({
      onProgress,
      log,
      logProgress: shouldLogProgress(process.env),
      platformId,
      stage: "feishu",
      phase: "start",
      completed: 0,
      total: classifiedItems.length,
      action: `${config.label}飞书写入中`
    });
    const client = createClient();
    const result = await writePlatformJsonToFeishu({
      platformId,
      targetDate: sinceDate,
      sinceDate,
      untilDate,
      root,
      client,
      items: classifiedItems
    });
    platformSummary.status = gate.blocked ? "written_with_asset_failures" : "written";
    platformSummary.feishu = result.feishu;
    log(`${config.label} 飞书写入：新增 ${result.feishu.created || 0}，更新 ${result.feishu.updated || 0}，跳过 ${result.feishu.skipped || 0}`);
    emitProgress({
      onProgress,
      log,
      logProgress: shouldLogProgress(process.env),
      platformId,
      stage: "feishu",
      phase: "done",
      completed: classifiedItems.length,
      total: classifiedItems.length,
      action: `${config.label}飞书写入完成`
    });
  } else {
    platformSummary.status = "classified";
  }
  return platformSummary;
}

async function processRiskStoppedPartialItems({
  platformId,
  sinceDate,
  untilDate,
  root,
  skipFeishu,
  strictMaterialGate,
  riskSummary,
  createClient,
  readPlatformItems,
  cachePlatformMaterials,
  classifyPlatformItems,
  writePlatformJsonToFeishu,
  log,
  onProgress
}) {
  if (skipFeishu) return null;

  let items = [];
  try {
    items = await readPlatformItems(platformId, sinceDate, root, untilDate);
  } catch (error) {
    log(`${getPlatformConfig(platformId).label} 风控前未找到可回填的部分采集结果：${error.message || String(error)}`);
    return null;
  }
  if (!Array.isArray(items) || items.length === 0) return null;

  try {
    const partialSummary = await processCollectedPlatformItems({
      platformId,
      sinceDate,
      untilDate,
      root,
      skipFeishu,
      strictMaterialGate,
      createClient,
      readPlatformItems,
      cachePlatformMaterials,
      classifyPlatformItems,
      writePlatformJsonToFeishu,
      log,
      onProgress,
      providedItems: items
    });
    partialSummary.status = statusWithRiskStop(partialSummary.status);
    partialSummary.riskStopped = true;
    partialSummary.riskError = riskSummary.error;
    partialSummary.action = riskSummary.action;
    if (riskSummary.loginWindowError) partialSummary.loginWindowError = riskSummary.loginWindowError;
    log(`${getPlatformConfig(platformId).label} 已处理风控前采集到的 ${items.length} 条部分结果。`);
    return partialSummary;
  } catch (error) {
    log(`${getPlatformConfig(platformId).label} 风控前部分结果处理失败：${error.message || String(error)}`);
    return null;
  }
}

function statusWithRiskStop(status = "") {
  if (status === "written") return "written_with_risk_stop";
  if (status === "written_with_asset_failures") return "written_with_asset_failures_and_risk_stop";
  if (status === "classified") return "classified_with_risk_stop";
  if (status === "asset_blocked") return "asset_blocked_with_risk_stop";
  return `${status || "risk"}_with_risk_stop`;
}

function isFailedPlatformStatus(status = "") {
  const value = String(status || "");
  return ["failed", "risk_stopped", "asset_blocked"].includes(value)
    || value.startsWith("asset_blocked")
    || value.includes("risk_stop");
}

function hasRiskStopStatus(platformSummary = {}) {
  return Boolean(platformSummary?.riskStopped)
    || String(platformSummary?.status || "") === "risk_stopped"
    || String(platformSummary?.status || "").includes("risk_stop");
}

function strictMaterialGateFromEnv(env = process.env) {
  return /^(1|true|yes|on)$/iu.test(String(env.STRICT_MATERIAL_GATE || env.MATERIAL_STRICT_GATE || "").trim());
}

function shouldLogProgress(env = process.env) {
  return /^(1|true|yes|on)$/iu.test(String(env.HARVESTER_PROGRESS_LOGS || "").trim());
}

export async function defaultRunPlatformCrawler(platformId, sinceDate, untilDate, crawlMode, { root = process.cwd() } = {}) {
  const paths = resolvePlatformPaths(platformId, root);
  await runCommand(NODE_BIN, [
    paths.crawlScriptPath,
    "--since",
    sinceDate,
    "--until",
    untilDate,
    "--mode",
    crawlMode
  ], {
    cwd: root,
    env: {
      ...process.env,
      FORCE_COLOR: "0"
    }
  });
}

export async function defaultOpenRiskLoginWindow({ platformId, root = process.cwd(), log = () => {} } = {}) {
  if (isAutoOpenRiskLoginWindowDisabled(process.env)) {
    log(`${getPlatformConfig(platformId).label}触发登录/安全验证，已停止后台采集。自动打开登录窗口已关闭，请在面板点击“打开登录”处理。`);
    return { ok: false, skipped: true, error: "自动打开登录窗口已关闭。" };
  }
  const paths = resolvePlatformPaths(platformId, root);
  if (!paths.loginScriptPath) return { ok: false, error: "没有可用登录脚本。" };
  const child = spawn(NODE_BIN, [paths.loginScriptPath], {
    ...riskLoginWindowSpawnOptions(root)
  });
  child.unref();
  log(`${getPlatformConfig(platformId).label}登录窗口已打开，请完成验证后关闭窗口。`);
  return { ok: true };
}

export function riskLoginWindowSpawnOptions(root = process.cwd()) {
  return {
    cwd: root,
    detached: true,
    stdio: "ignore"
  };
}

function isAutoOpenRiskLoginWindowDisabled(env = process.env) {
  return /^(0|false|no|off)$/iu.test(String(env.AUTO_OPEN_RISK_LOGIN_WINDOW ?? "").trim());
}

function isPlatformRiskStop(platformId, message = "") {
  if (platformId !== "xhs") return false;
  return /登录状态已失效|安全验证|安全限制|验证码|风控|滑块|IP存在风险|存在风险|访问过于频繁|环境异常|website-login\/(?:error|captcha)|\/login|login\?/iu.test(String(message || ""));
}

async function writeSummary(summary, root) {
  const summaryPath = dailySummaryPath(summary.sinceDate || summary.targetDate, root, summary.untilDate || summary.targetDate);
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = appendOutputSnippet(stdout, text);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = appendOutputSnippet(stderr, text);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").trim();
        const suffix = detail ? `\n${detail.slice(-CHILD_OUTPUT_SNIPPET_LIMIT)}` : "";
        reject(new Error(`${args[0]} 退出码：${code}${suffix}`));
      }
    });
  });
}

function appendOutputSnippet(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > CHILD_OUTPUT_SNIPPET_LIMIT
    ? next.slice(-CHILD_OUTPUT_SNIPPET_LIMIT)
    : next;
}
