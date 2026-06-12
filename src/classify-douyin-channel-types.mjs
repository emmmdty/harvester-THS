import "dotenv/config";
import path from "node:path";

import {
  runDouyinChannelTypeABComparison,
  runDouyinChannelTypeClassification
} from "./douyin-channel-type-classifier/feishu-runner.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.abCompare) {
    const result = await runDouyinChannelTypeABComparison({
      overwrite: options.overwrite,
      limit: options.limit,
      concurrency: options.concurrency,
      assetConcurrency: options.assetConcurrency,
      outputDir: options.outputDir || undefined,
      log: console.log
    });
    console.log("抖音渠道 text-only / sampled-media A/B 对比完成。");
    console.log(`对比行数：${result.summary.totalRows}`);
    console.log(`分类冲突行数：${result.summary.conflictRows}`);
    console.log(`text-only 通过行数：${result.summary.textPassedRows}`);
    console.log(`sampled-media 通过行数：${result.summary.mediaPassedRows}`);
    console.log(`sampled-media 素材可用行数：${result.summary.mediaAssetReadyRows}`);
    console.log(`text-only MiniMax 请求：${result.summary.textMiniMaxRequests}`);
    console.log(`sampled-media MiniMax 请求：${result.summary.mediaMiniMaxRequests}`);
    if (result.outputPaths?.jsonPath) console.log(`对比 JSON：${result.outputPaths.jsonPath}`);
    if (result.outputPaths?.csvPath) console.log(`对比 CSV：${result.outputPaths.csvPath}`);
    console.log("A/B 对比始终为 dry-run，不写回飞书。");
    return;
  }
  const result = await runDouyinChannelTypeClassification({
    write: options.write,
    overwrite: options.overwrite,
    limit: options.limit,
    concurrency: options.concurrency,
    assetConcurrency: options.assetConcurrency,
    provider: options.provider,
    mediaMode: options.mediaMode,
    noClassify: options.noClassify,
    outputDir: options.outputDir || undefined,
    log: console.log
  });
  const summary = result.audit.summary;
  console.log(`抖音渠道分级分类${options.write ? "写入" : "预览"}完成。`);
  console.log(`素材行：${summary.materialRows}`);
  console.log(`本次分类：${summary.classifiedRows}`);
  console.log(`分类失败：${summary.failedRows}`);
  console.log(`分类 provider：${summary.provider}`);
  console.log(`素材模式：${summary.mediaMode}`);
  console.log(`DeepSeek 实际请求：${summary.deepseekRequests}`);
  console.log(`MiniMax 实际请求：${summary.minimaxRequests || 0}`);
  console.log(`重复复用行数：${summary.reusedDuplicateRows}`);
  console.log(`缓存命中：${summary.cacheHits || 0}`);
  console.log(`缓存写入：${summary.cacheWrites || 0}`);
  console.log(`素材准备成功：${summary.assetPreparedRows || 0}`);
  console.log(`素材可用于多模态：${summary.assetReadyRows || 0}`);
  console.log(`素材准备失败：${summary.assetFailedRows || 0}`);
  console.log(`跳过已有分类：${summary.skippedExistingRows}`);
  console.log(`跳过空内容：${summary.skippedEmptyRows}`);
  console.log(`跳过分隔行：${summary.skippedSeparatorRows}`);
  console.log(`受 limit 限制未处理：${summary.limitedRows}`);
  console.log(`写入行数：${result.writtenRows}`);
  if (result.outputPaths?.jsonPath) console.log(`审计 JSON：${result.outputPaths.jsonPath}`);
  if (result.outputPaths?.csvPath) console.log(`预览 CSV：${result.outputPaths.csvPath}`);
  if (!options.write) console.log("当前为 dry-run；加 --write 才会写回飞书。");
}

export function parseArgs(args = []) {
  const options = {
    write: false,
    overwrite: false,
    limit: 0,
    concurrency: 30,
    assetConcurrency: 2,
    provider: "deepseek",
    mediaMode: "text-only",
    noClassify: false,
    abCompare: false,
    outputDir: ""
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    if (arg === "--no-classify") {
      options.noClassify = true;
      continue;
    }
    if (arg === "--ab-compare") {
      options.abCompare = true;
      continue;
    }
    if (arg === "--provider") {
      options.provider = normalizeProvider(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      options.provider = normalizeProvider(arg.slice("--provider=".length));
      continue;
    }
    if (arg === "--media-mode") {
      options.mediaMode = normalizeMediaMode(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--media-mode=")) {
      options.mediaMode = normalizeMediaMode(arg.slice("--media-mode=".length));
      continue;
    }
    if (arg === "--limit") {
      options.limit = positiveInteger(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      options.limit = positiveInteger(arg.slice("--limit=".length));
      continue;
    }
    if (arg === "--concurrency") {
      options.concurrency = Math.max(1, positiveInteger(args[index + 1]) || 30);
      index += 1;
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      options.concurrency = Math.max(1, positiveInteger(arg.slice("--concurrency=".length)) || 30);
      continue;
    }
    if (arg === "--asset-concurrency") {
      options.assetConcurrency = Math.max(1, positiveInteger(args[index + 1]) || 2);
      index += 1;
      continue;
    }
    if (arg.startsWith("--asset-concurrency=")) {
      options.assetConcurrency = Math.max(1, positiveInteger(arg.slice("--asset-concurrency=".length)) || 2);
      continue;
    }
    if (arg === "--output-dir") {
      options.outputDir = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    }
  }
  return options;
}

function positiveInteger(value) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider === "minimax" ? "minimax" : "deepseek";
}

function normalizeMediaMode(value) {
  const mode = String(value || "").trim();
  return ["text-only", "sampled-media", "full-media", "auto"].includes(mode) ? mode : "text-only";
}

if (process.argv[1] && import.meta.url === new URL(path.resolve(process.argv[1]), "file:").href) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
