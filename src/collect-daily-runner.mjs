import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { readPlatformItems as defaultReadPlatformItems, writePlatformJsonToFeishu as defaultWritePlatformJsonToFeishu } from "./feishu-writer.mjs";
import { dailySummaryPath, getPlatformConfig, resolvePlatformPaths } from "./platform-config.mjs";
import { classifyPlatformItems as defaultClassifyPlatformItems } from "./daily/classify-platform.mjs";
import { cachePlatformMaterials as defaultCachePlatformMaterials } from "./materials/cache.mjs";
import { shouldBlockFeishuWriteback } from "./materials/failure-gate.mjs";

const NODE_BIN = process.execPath;

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
  log = console.log
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
  for (const platformId of platforms) {
    const config = getPlatformConfig(platformId);
    log(`\n==> 开始 ${config.label}`);
    try {
      await runPlatformCrawler(platformId, sinceDate, untilDate, crawlMode, { root });
      const items = await readPlatformItems(platformId, sinceDate, root, untilDate);
      const materialResult = await cachePlatformMaterials({
        platformId,
        items,
        targetDate: sinceDate,
        sinceDate,
        untilDate,
        root,
        log
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
        summary.platforms[platformId] = platformSummary;
        log(`${config.label} 素材严格阻断：${gate.reason}`);
        continue;
      }
      if (gate.blocked) {
        platformSummary.status = "asset_warning";
        platformSummary.materialGate = gate;
        log(`${config.label} 素材失败但已写基础数据：${gate.reason}`);
      }
      const classifiedItems = await classifyPlatformItems({
        platformId,
        items,
        materialResult,
        log
      });
      if (!skipFeishu) {
        client = client || createClient();
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
        log(`${config.label} 飞书写入：新增 ${result.feishu.created}，更新 ${result.feishu.updated || 0}，跳过 ${result.feishu.skipped}`);
      } else {
        platformSummary.status = "classified";
      }
      summary.platforms[platformId] = platformSummary;
    } catch (error) {
      summary.platforms[platformId] = {
        status: "failed",
        collected: 0,
        feishu: null,
        error: error.message || String(error)
      };
      log(`${config.label} 失败：${error.message || String(error)}`);
    }
  }

  const failedPlatforms = platforms.filter((platformId) => ["failed", "asset_blocked"].includes(summary.platforms[platformId]?.status));
  summary.ok = failedPlatforms.length === 0;
  if (failedPlatforms.length > 0) {
    summary.partialFailureReason = failedPlatforms.some((platformId) => summary.platforms[platformId]?.status === "asset_blocked")
      ? "部分平台素材获取失败达到阈值，已停止对应平台飞书回填并优先保留素材获取证据。"
      : "部分平台采集失败，成功平台已按日期写入飞书。";
    log(`\n每日采集存在失败平台：${failedPlatforms.map((id) => getPlatformConfig(id).label).join("、")}。成功平台已继续写入。`);
  }
  summary.finishedAt = new Date().toISOString();
  await writeSummary(summary, root);
  log(`\n每日采集汇总：${dailySummaryPath(sinceDate, root, untilDate)}`);
  return { ok: summary.ok, summary };
}

function strictMaterialGateFromEnv(env = process.env) {
  return /^(1|true|yes|on)$/iu.test(String(env.STRICT_MATERIAL_GATE || env.MATERIAL_STRICT_GATE || "").trim());
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

    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args[0]} 退出码：${code}`));
    });
  });
}
