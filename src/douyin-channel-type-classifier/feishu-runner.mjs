import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import { classifyDouyinChannelType, classifyDouyinChannelTypesBatch } from "./classifier.mjs";
import {
  classifyDouyinChannelTypeWithMiniMax,
  MINIMAX_PROMPT_VERSION
} from "./multimodal.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "../feishu-sheets.mjs";
import { extractLinkValue } from "../link-utils.mjs";
import { createDouyinChannelTypeAssetBundle } from "./assets.mjs";

export const DOUYIN_CHANNEL_TYPE_OUTPUT_DIR = ".runtime/douyin-channel-type-classifier";
export const DOUYIN_CHANNEL_TYPE_HEADERS = ["一级类型", "二级类型"];
export const DOUYIN_CHANNEL_TYPE_AUDIT_HEADERS = [
  "AI分类置信度",
  "AI分类依据",
  "AI复核状态",
  "AI素材状态",
  "AI模型版本",
  "AI分类时间"
];
export const DOUYIN_CHANNEL_TYPE_OUTPUT_HEADERS = [
  ...DOUYIN_CHANNEL_TYPE_HEADERS,
  ...DOUYIN_CHANNEL_TYPE_AUDIT_HEADERS
];
const DEFAULT_READ_COLUMNS = 30;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_ASSET_CONCURRENCY = 2;
const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_CACHE_DIR = path.join(DOUYIN_CHANNEL_TYPE_OUTPUT_DIR, "cache");

export async function ensureDouyinChannelTypeHeaders({ client, readColumnCount = DEFAULT_READ_COLUMNS } = {}) {
  const rows = await client.readSheetRows("douyin", readColumnCount);
  const headerInfo = detectHeader(rows);
  const header = trimTrailingEmptyHeaders(headerInfo.header);
  const missingHeaders = DOUYIN_CHANNEL_TYPE_OUTPUT_HEADERS.filter((name) => !header.includes(name));
  if (missingHeaders.length > 0) {
    const startColumn = header.length + 1;
    const endColumn = header.length + missingHeaders.length;
    const sheetId = client.sheetId("douyin");
    await client.writeRows(
      "douyin",
      `${sheetId}!${columnName(startColumn)}${headerInfo.headerRowNumber}:${columnName(endColumn)}${headerInfo.headerRowNumber}`,
      [missingHeaders]
    );
    header.push(...missingHeaders);
  }

  return {
    ...headerInfo,
    header,
    ...typeColumnInfo(header),
    addedHeaders: missingHeaders
  };
}

export async function buildDouyinChannelTypePreview({
  rows = [],
  overwrite = false,
  limit = 0,
  concurrency = DEFAULT_CONCURRENCY,
  batchSize = DEFAULT_BATCH_SIZE,
  assetConcurrency = DEFAULT_ASSET_CONCURRENCY,
  provider = "deepseek",
  mediaMode = "text-only",
  noClassify = false,
  cacheDir = "",
  generatedAt = new Date().toISOString(),
  root = process.cwd(),
  classify = classifyDouyinChannelType,
  classifyBatch = null,
  prepareAsset = prepareDouyinChannelTypeAsset,
  onProgress = null
} = {}) {
  const headerInfo = detectHeaderWithTypeColumns(rows);
  const rowsToClassify = [];
  const summary = {
    materialRows: 0,
    classifiedRows: 0,
    failedRows: 0,
    deepseekRequests: 0,
    reusedDuplicateRows: 0,
    skippedSeparatorRows: 0,
    skippedEmptyRows: 0,
    skippedExistingRows: 0,
    limitedRows: 0,
    cacheHits: 0,
    cacheWrites: 0,
    assetPreparedRows: 0,
    assetFailedRows: 0,
    assetReadyRows: 0,
    minimaxRequests: 0,
    noClassify,
    mediaMode,
    provider
  };

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (rowNumber <= headerInfo.headerRowNumber) return;
    const fields = rowToFields(headerInfo.header, row);
    if (isSeparatorRow(fields, row)) {
      summary.skippedSeparatorRows += 1;
      return;
    }

    const title = cellText(fields["标题"]);
    const tags = cellText(fields["tag词"]);
    const primaryType = cellText(fields["一级类型"]);
    const secondaryType = cellText(fields["二级类型"]);
    const itemId = cellText(fields["作品ID"]);
    const link = cellText(fields["内容链接"]);
    const sourceRow = {
      rowNumber,
      fields,
      title,
      tags,
      account: cellText(fields["账号"]),
      contentType: cellText(fields["内容类型"]),
      itemType: cellText(fields["作品类型"]),
      itemId,
      link
    };
    summary.materialRows += 1;
    if (!title && !tags) {
      summary.skippedEmptyRows += 1;
      return;
    }

    if (!overwrite && (primaryType || secondaryType)) {
      summary.skippedExistingRows += 1;
      return;
    }
    if (limit > 0 && rowsToClassify.length >= limit) {
      summary.limitedRows += 1;
      return;
    }
    rowsToClassify.push({
      rowNumber,
      title,
      tags,
      itemId,
      link,
      sourceRow,
      cacheKey: classificationCacheKey({ sourceRow, provider, mediaMode })
    });
  });

  let completed = 0;
  const uniqueItems = uniqueClassificationItems(rowsToClassify);
  summary.uniqueClassificationRows = uniqueItems.length;
  summary.reusedDuplicateRows = rowsToClassify.length - uniqueItems.length;
  const resultByKey = new Map();
  const diskCache = cacheDir && !noClassify ? await createClassificationDiskCache(cacheDir) : null;
  const canReadCacheBeforeAsset = !(provider === "minimax" && mediaMode !== "text-only");
  const pendingItems = [];
  for (const item of uniqueItems) {
    const cached = diskCache && canReadCacheBeforeAsset ? await diskCache.read(item.cacheKey) : null;
    if (cached) {
      resultByKey.set(item.cacheKey, normalizeClassificationResult(cached));
      summary.cacheHits += 1;
    } else {
      pendingItems.push(item);
    }
  }

  if (classifyBatch && provider === "deepseek" && mediaMode === "text-only" && pendingItems.length) {
    const batches = chunkItems(pendingItems, batchSize);
    summary.deepseekRequests = batches.length;
    await mapWithConcurrency(batches, concurrency, async (batch) => {
      const results = await classifyBatch({
        items: batch.map((item) => ({
          id: item.id,
          title: item.title,
          tags: item.tags
        }))
      });
      batch.forEach((item, index) => {
        const normalized = normalizeClassificationResult(results[index]);
        resultByKey.set(item.cacheKey, normalized);
      });
      if (diskCache) {
        const written = await Promise.all(batch.map(async (item, index) => {
          const normalized = normalizeClassificationResult(results[index]);
          if (!normalized.ok) return 0;
          await diskCache.write(item.cacheKey, normalized);
          return 1;
        }));
        summary.cacheWrites += written.reduce((sum, value) => sum + value, 0);
      }
      completed += batch.length;
      reportClassificationProgress({ onProgress, completed, total: pendingItems.length, item: batch.at(-1), provider });
    });
  } else if (pendingItems.length) {
    const assetByKey = new Map();
    if (provider === "minimax" && mediaMode !== "text-only") {
      await mapWithConcurrency(pendingItems, assetConcurrency, async (item) => {
        const asset = await prepareAsset({
          sourceRow: item.sourceRow,
          mediaMode,
          root,
          generatedAt
        });
        assetByKey.set(item.cacheKey, asset);
        if (hasVisualAsset(asset)) {
          summary.assetPreparedRows += 1;
          summary.assetReadyRows += 1;
        } else {
          summary.assetFailedRows += 1;
        }
      });
    }

    if (noClassify) {
      for (const item of pendingItems) {
        const assetBundle = assetByKey.get(item.cacheKey) || textOnlyAssetBundle(item.sourceRow);
        resultByKey.set(item.cacheKey, notClassifiedResult({ assetBundle, generatedAt, provider }));
      }
    }

    const classificationItems = noClassify ? [] : pendingItems.filter((item) => {
      const assetBundle = assetByKey.get(item.cacheKey);
      if (provider === "minimax" && mediaMode !== "text-only" && !hasVisualAsset(assetBundle)) {
        resultByKey.set(item.cacheKey, noVisualAssetResult({ assetBundle, generatedAt }));
        return false;
      }
      if (provider === "minimax" && mediaMode !== "text-only") {
        item.resultCacheKey = classificationCacheKey({
          sourceRow: item.sourceRow,
          provider,
          mediaMode,
          assetSignature: assetSignatureForCache(assetBundle)
        });
      }
      return true;
    });
    if (diskCache && provider === "minimax" && mediaMode !== "text-only") {
      const missedItems = [];
      for (const item of classificationItems) {
        const cached = await diskCache.read(item.resultCacheKey);
        if (cached) {
          resultByKey.set(item.cacheKey, normalizeClassificationResult(cached));
          summary.cacheHits += 1;
        } else {
          missedItems.push(item);
        }
      }
      classificationItems.splice(0, classificationItems.length, ...missedItems);
    }
    if (provider === "deepseek") summary.deepseekRequests = classificationItems.length;
    else summary.minimaxRequests = classificationItems.length;

    await mapWithConcurrency(classificationItems, concurrency, async (item) => {
      const assetBundle = assetByKey.get(item.cacheKey) || textOnlyAssetBundle(item.sourceRow);
      const result = await classify({
        title: item.title,
        tags: item.tags,
        sourceRow: item.sourceRow,
        assetBundle,
        mediaMode
      });
      const normalized = normalizeClassificationResult(result, { generatedAt, assetBundle, mediaMode, provider });
      resultByKey.set(item.cacheKey, normalized);
      if (diskCache && normalized.ok) {
        await diskCache.write(item.resultCacheKey || item.cacheKey, normalized);
        summary.cacheWrites += 1;
      }
      completed += 1;
      reportClassificationProgress({ onProgress, completed, total: classificationItems.length, item, provider });
    });
  }
  const classified = rowsToClassify.map((item) => {
    const result = resultByKey.get(item.cacheKey) || {
      primaryType: "",
      secondaryType: "",
      confidence: 0,
      reason: "未获取到分类结果",
      ok: false
    };
    const update = {
      rowNumber: item.rowNumber,
      primaryType: result.primaryType,
      secondaryType: result.secondaryType,
      confidence: result.confidence,
      reason: result.reason,
      evidence: result.evidence || [],
      assetSignals: result.assetSignals || [],
      reviewStatus: result.reviewStatus || reviewStatusForResult(result),
      assetStatus: result.assetStatus || "文本分类",
      model: result.model || result.source || "",
      classifiedAt: result.classifiedAt || generatedAt,
      ok: result.ok
    };
    if (update.reviewStatus === "未分类") {
      // no-classify dry-runs measure asset readiness without changing classification counters.
    } else if (update.ok) summary.classifiedRows += 1;
    else summary.failedRows += 1;
    return update;
  });

  return {
    headerInfo,
    updates: classified,
    summary
  };
}

export async function buildDouyinChannelTypeABComparison({
  rows = [],
  overwrite = false,
  limit = 0,
  concurrency = DEFAULT_CONCURRENCY,
  assetConcurrency = DEFAULT_ASSET_CONCURRENCY,
  root = process.cwd(),
  generatedAt = new Date().toISOString(),
  cacheDir = "",
  textClassify = classifyDouyinChannelTypeWithMiniMax,
  mediaClassify = classifyDouyinChannelTypeWithMiniMax,
  prepareAsset = prepareDouyinChannelTypeAsset,
  onProgress = null
} = {}) {
  const textPreview = await buildDouyinChannelTypePreview({
    rows,
    overwrite,
    limit,
    concurrency,
    provider: "minimax",
    mediaMode: "text-only",
    cacheDir,
    generatedAt,
    root,
    classify: textClassify,
    onProgress
  });
  const mediaPreview = await buildDouyinChannelTypePreview({
    rows,
    overwrite,
    limit,
    concurrency,
    assetConcurrency,
    provider: "minimax",
    mediaMode: "sampled-media",
    cacheDir,
    generatedAt,
    root,
    classify: mediaClassify,
    prepareAsset,
    onProgress
  });
  const sourceByRowNumber = sourceRowsByNumber(rows);
  const textByRowNumber = new Map(textPreview.updates.map((update) => [update.rowNumber, update]));
  const mediaByRowNumber = new Map(mediaPreview.updates.map((update) => [update.rowNumber, update]));
  const rowNumbers = [...new Set([
    ...textPreview.updates.map((update) => update.rowNumber),
    ...mediaPreview.updates.map((update) => update.rowNumber)
  ])].sort((left, right) => left - right);
  const comparisons = rowNumbers.map((rowNumber) => {
    const source = sourceByRowNumber.get(rowNumber) || {};
    const text = textByRowNumber.get(rowNumber) || {};
    const media = mediaByRowNumber.get(rowNumber) || {};
    const conflict = Boolean(
      text.primaryType || text.secondaryType || media.primaryType || media.secondaryType
    ) && (text.primaryType !== media.primaryType || text.secondaryType !== media.secondaryType);
    return {
      rowNumber,
      title: source.title || "",
      tags: source.tags || "",
      itemType: source.itemType || "",
      contentType: source.contentType || "",
      textPrimaryType: text.primaryType || "",
      textSecondaryType: text.secondaryType || "",
      textConfidence: text.confidence || 0,
      textReviewStatus: text.reviewStatus || "",
      textReason: text.reason || "",
      mediaPrimaryType: media.primaryType || "",
      mediaSecondaryType: media.secondaryType || "",
      mediaConfidence: media.confidence || 0,
      mediaReviewStatus: media.reviewStatus || "",
      mediaReason: media.reason || "",
      assetStatus: media.assetStatus || "",
      conflict
    };
  });
  return {
    generatedAt,
    textPreview,
    mediaPreview,
    comparisons,
    summary: {
      totalRows: comparisons.length,
      conflictRows: comparisons.filter((row) => row.conflict).length,
      textPassedRows: textPreview.updates.filter((update) => update.reviewStatus === "通过").length,
      mediaPassedRows: mediaPreview.updates.filter((update) => update.reviewStatus === "通过").length,
      mediaAssetReadyRows: mediaPreview.summary.assetReadyRows || 0,
      textMiniMaxRequests: textPreview.summary.minimaxRequests || 0,
      mediaMiniMaxRequests: mediaPreview.summary.minimaxRequests || 0
    }
  };
}

export async function runDouyinChannelTypeABComparison({
  client = null,
  overwrite = false,
  limit = 0,
  concurrency = DEFAULT_CONCURRENCY,
  assetConcurrency = DEFAULT_ASSET_CONCURRENCY,
  root = process.cwd(),
  outputDir = DOUYIN_CHANNEL_TYPE_OUTPUT_DIR,
  generatedAt = new Date().toISOString(),
  cacheDir = DEFAULT_CACHE_DIR,
  writeAudit = true,
  textClassify = classifyDouyinChannelTypeWithMiniMax,
  mediaClassify = classifyDouyinChannelTypeWithMiniMax,
  prepareAsset = prepareDouyinChannelTypeAsset,
  log = null
} = {}) {
  const writer = client || new FeishuSheetsClient(loadFeishuConfig());
  const rows = await writer.readSheetRows("douyin", DEFAULT_READ_COLUMNS);
  const comparison = await buildDouyinChannelTypeABComparison({
    rows,
    overwrite,
    limit,
    concurrency,
    assetConcurrency,
    root,
    generatedAt,
    cacheDir,
    textClassify,
    mediaClassify,
    prepareAsset,
    onProgress: buildProgressLogger(log)
  });
  const outputPaths = writeAudit
    ? await writeABComparisonFiles({ outputDir, generatedAt, comparison })
    : {};
  return { ...comparison, outputPaths };
}

export async function runDouyinChannelTypeClassification({
  client = null,
  write = false,
  overwrite = false,
  limit = 0,
  concurrency = DEFAULT_CONCURRENCY,
  batchSize = DEFAULT_BATCH_SIZE,
  assetConcurrency = DEFAULT_ASSET_CONCURRENCY,
  provider = "deepseek",
  mediaMode = "text-only",
  noClassify = false,
  cacheDir = DEFAULT_CACHE_DIR,
  root = process.cwd(),
  outputDir = DOUYIN_CHANNEL_TYPE_OUTPUT_DIR,
  writeAudit = true,
  generatedAt = new Date().toISOString(),
  classify = null,
  classifyBatch = null,
  prepareAsset = prepareDouyinChannelTypeAsset,
  log = null
} = {}) {
  const writer = client || new FeishuSheetsClient(loadFeishuConfig());
  const normalizedProvider = normalizeProvider(provider);
  const normalizedMediaMode = normalizeMediaMode(mediaMode);
  const classifier = classify || (normalizedProvider === "minimax" ? classifyDouyinChannelTypeWithMiniMax : classifyDouyinChannelType);
  if (write) {
    await ensureDouyinChannelTypeHeaders({ client: writer });
  }
  const rows = await writer.readSheetRows("douyin", DEFAULT_READ_COLUMNS);
  const preview = await buildDouyinChannelTypePreview({
    rows,
    overwrite,
    limit,
    concurrency,
    batchSize,
    assetConcurrency,
    provider: normalizedProvider,
    mediaMode: normalizedMediaMode,
    noClassify,
    cacheDir,
    root,
    generatedAt,
    classify: classifier,
    classifyBatch: classifyBatch || (classifier === classifyDouyinChannelType ? classifyDouyinChannelTypesBatch : null),
    prepareAsset,
    onProgress: buildProgressLogger(log)
  });

  let writtenRows = 0;
  if (write) {
    writtenRows = await applyDouyinChannelTypeUpdates({
      client: writer,
      headerInfo: preview.headerInfo,
      updates: preview.updates.filter((update) => update.ok)
    });
  }

  const audit = buildAudit({
    preview,
    write,
    overwrite,
    limit,
    concurrency,
    batchSize,
    assetConcurrency,
    provider: normalizedProvider,
    mediaMode: normalizedMediaMode,
    noClassify,
    generatedAt,
    writtenRows
  });
  const outputPaths = writeAudit
    ? await writeAuditFiles({ outputDir, generatedAt, audit, preview })
    : {};

  return {
    ...preview,
    audit,
    outputPaths,
    written: write,
    writtenRows
  };
}

export async function applyDouyinChannelTypeUpdates({ client, headerInfo, updates = [] } = {}) {
  if (!updates.length) return 0;
  const sheetId = client.sheetId("douyin");
  const primaryColumn = headerInfo.header.indexOf("一级类型") + 1;
  const secondaryColumn = headerInfo.header.indexOf("二级类型") + 1;
  const outputColumns = DOUYIN_CHANNEL_TYPE_OUTPUT_HEADERS.map((header) => headerInfo.header.indexOf(header) + 1);
  const outputEndColumn = outputColumns.at(-1);
  const isContiguous = outputColumns.every((column, index) => column === primaryColumn + index);
  if (primaryColumn <= 0 || secondaryColumn !== primaryColumn + 1 || !isContiguous) {
    throw new Error("一级类型、二级类型和 AI 审计列必须是相邻列，才能安全批量写回。");
  }
  const groups = contiguousGroups(updates);
  for (const group of groups) {
    const startRow = group[0].rowNumber;
    const endRow = group.at(-1).rowNumber;
    await client.writeRows(
      "douyin",
      `${sheetId}!${columnName(primaryColumn)}${startRow}:${columnName(outputEndColumn)}${endRow}`,
      group.map(updateToSheetRow)
    );
  }
  return updates.length;
}

export function detectHeader(rows = []) {
  const headerIndex = rows.findIndex((row) => rowIncludes(row, "标题") && rowIncludes(row, "tag词"));
  if (headerIndex < 0) throw new Error("未找到抖音渠道表头：需要包含 标题 和 tag词。");
  return {
    headerRowNumber: headerIndex + 1,
    header: rows[headerIndex].map(cellText)
  };
}

function detectHeaderWithTypeColumns(rows = []) {
  const headerInfo = detectHeader(rows);
  const header = trimTrailingEmptyHeaders(headerInfo.header);
  for (const name of DOUYIN_CHANNEL_TYPE_OUTPUT_HEADERS) {
    if (!header.includes(name)) header.push(name);
  }
  return {
    ...headerInfo,
    header,
    ...typeColumnInfo(header)
  };
}

function trimTrailingEmptyHeaders(header = []) {
  const trimmed = [...header];
  while (trimmed.length > 0 && !cellText(trimmed.at(-1))) trimmed.pop();
  return trimmed;
}

function typeColumnInfo(header = []) {
  return {
    primaryColumn: header.indexOf("一级类型") + 1,
    secondaryColumn: header.indexOf("二级类型") + 1
  };
}

function rowToFields(headers = [], row = []) {
  const fields = {};
  headers.forEach((header, index) => {
    if (!header || Object.hasOwn(fields, header)) return;
    fields[header] = row[index] ?? "";
  });
  return fields;
}

function sourceRowsByNumber(rows = []) {
  const headerInfo = detectHeaderWithTypeColumns(rows);
  const result = new Map();
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (rowNumber <= headerInfo.headerRowNumber) return;
    const fields = rowToFields(headerInfo.header, row);
    result.set(rowNumber, {
      title: cellText(fields["标题"]),
      tags: cellText(fields["tag词"]),
      itemType: cellText(fields["作品类型"]),
      contentType: cellText(fields["内容类型"])
    });
  });
  return result;
}

function isSeparatorRow(fields, row) {
  const title = cellText(fields["标题"]);
  const tags = cellText(fields["tag词"]);
  const link = cellText(fields["内容链接"] || "");
  const sequence = cellText(fields["编号"] || "");
  const dateText = cellText(fields["投稿时间"] || "");
  const hasTypeOutput = cellText(fields["一级类型"]) || cellText(fields["二级类型"]);
  if (title || tags || link || sequence || hasTypeOutput) return false;
  if (/投稿|20\d{2}年投稿|未识别日期/u.test(dateText)) return true;
  const nonEmpty = row.map(cellText).filter(Boolean);
  return nonEmpty.length === 1 && nonEmpty[0] === dateText;
}

function buildAudit({
  preview,
  write,
  overwrite,
  limit,
  concurrency,
  batchSize,
  assetConcurrency,
  provider,
  mediaMode,
  noClassify,
  generatedAt,
  writtenRows
}) {
  return {
    generatedAt,
    mode: write ? "write" : "dry-run",
    overwrite,
    limit,
    concurrency,
    batchSize,
    assetConcurrency,
    provider,
    mediaMode,
    noClassify,
    writtenRows,
    summary: preview.summary,
    updates: preview.updates
  };
}

function buildProgressLogger(log) {
  if (typeof log !== "function") return null;
  let lastLogged = 0;
  return ({ completed, total, ok, provider = "deepseek" }) => {
    if (completed === total || completed - lastLogged >= 50) {
      lastLogged = completed;
      log(`${provider === "minimax" ? "MiniMax" : "DeepSeek"} 分类进度：${completed}/${total}，最近一批${ok ? "成功" : "失败"}`);
    }
  };
}

async function writeAuditFiles({ outputDir, generatedAt, audit, preview }) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `douyin_channel_type_audit_${safeTimestamp}.json`);
  const csvPath = path.join(outputDir, `douyin_channel_type_preview_${safeTimestamp}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify(audit, null, 2), "utf8");
  await fs.writeFile(csvPath, previewToCsv(preview.updates), "utf8");
  return { jsonPath, csvPath };
}

async function writeABComparisonFiles({ outputDir, generatedAt, comparison }) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `douyin_channel_type_ab_${safeTimestamp}.json`);
  const csvPath = path.join(outputDir, `douyin_channel_type_ab_${safeTimestamp}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify(comparison, null, 2), "utf8");
  await fs.writeFile(csvPath, comparisonToCsv(comparison.comparisons), "utf8");
  return { jsonPath, csvPath };
}

function previewToCsv(updates = []) {
  const rows = [
    [
      "rowNumber",
      "ok",
      "primaryType",
      "secondaryType",
      "confidence",
      "reviewStatus",
      "assetStatus",
      "model",
      "classifiedAt",
      "reason",
      "evidence",
      "assetSignals"
    ],
    ...updates.map((update) => [
      update.rowNumber,
      update.ok ? "true" : "false",
      update.primaryType,
      update.secondaryType,
      update.confidence,
      update.reviewStatus,
      update.assetStatus,
      update.model,
      update.classifiedAt,
      update.reason,
      (update.evidence || []).join("；"),
      (update.assetSignals || []).join("；")
    ])
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function comparisonToCsv(rows = []) {
  const output = [
    [
      "rowNumber",
      "title",
      "tags",
      "itemType",
      "contentType",
      "textPrimaryType",
      "textSecondaryType",
      "textConfidence",
      "textReviewStatus",
      "mediaPrimaryType",
      "mediaSecondaryType",
      "mediaConfidence",
      "mediaReviewStatus",
      "assetStatus",
      "conflict",
      "textReason",
      "mediaReason"
    ],
    ...rows.map((row) => [
      row.rowNumber,
      row.title,
      row.tags,
      row.itemType,
      row.contentType,
      row.textPrimaryType,
      row.textSecondaryType,
      row.textConfidence,
      row.textReviewStatus,
      row.mediaPrimaryType,
      row.mediaSecondaryType,
      row.mediaConfidence,
      row.mediaReviewStatus,
      row.assetStatus,
      row.conflict ? "true" : "false",
      row.textReason,
      row.mediaReason
    ])
  ];
  return output.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function contiguousGroups(updates = []) {
  const sorted = [...updates].sort((left, right) => left.rowNumber - right.rowNumber);
  const groups = [];
  for (const update of sorted) {
    const last = groups.at(-1);
    if (last && last.at(-1).rowNumber + 1 === update.rowNumber) {
      last.push(update);
    } else {
      groups.push([update]);
    }
  }
  return groups;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const width = Math.max(1, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY));
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => worker()));
  return results;
}

function uniqueClassificationItems(rowsToClassify = []) {
  const groups = new Map();
  for (const item of rowsToClassify) {
    if (!groups.has(item.cacheKey)) {
      groups.set(item.cacheKey, {
        id: `item-${groups.size + 1}`,
        cacheKey: item.cacheKey,
        title: item.title,
        tags: item.tags,
        itemId: item.itemId,
        link: item.link,
        sourceRow: item.sourceRow,
        firstRowNumber: item.rowNumber
      });
    }
  }
  return [...groups.values()];
}

function normalizeClassificationResult(result = {}, { generatedAt = "", assetBundle = {}, mediaMode = "text-only", provider = "" } = {}) {
  const confidence = Number(result.confidence || 0);
  return {
    primaryType: result.primaryType || "",
    secondaryType: result.secondaryType || "",
    confidence,
    reason: result.reason || "",
    evidence: normalizeStringArray(result.evidence),
    assetSignals: normalizeStringArray(result.assetSignals),
    reviewStatus: result.reviewStatus || reviewStatusForResult(result),
    assetStatus: result.assetStatus || assetBundle.assetStatus || assetStatusForMode(mediaMode),
    model: result.model || result.source || provider || "",
    classifiedAt: result.classifiedAt || generatedAt,
    ok: result.ok === true
  };
}

function noVisualAssetResult({ assetBundle = {}, generatedAt = "" } = {}) {
  return {
    primaryType: "",
    secondaryType: "",
    confidence: 0,
    reason: "sampled-media 未获取到可分析画面，未调用 MiniMax 多模态。",
    evidence: [],
    assetSignals: [],
    reviewStatus: "需人工复核",
    assetStatus: assetBundle.assetStatus || "素材获取失败需复核",
    model: "",
    classifiedAt: generatedAt,
    ok: false
  };
}

function notClassifiedResult({ assetBundle = {}, generatedAt = "", provider = "" } = {}) {
  return {
    primaryType: "",
    secondaryType: "",
    confidence: 0,
    reason: "仅素材准备，未执行分类。",
    evidence: [],
    assetSignals: [],
    reviewStatus: "未分类",
    assetStatus: assetBundle.assetStatus || "文本分类",
    model: provider,
    classifiedAt: generatedAt,
    ok: false
  };
}

function hasVisualAsset(asset = {}) {
  if (!asset) return false;
  return Boolean(
    (asset.framePaths || []).length
      || (asset.imagePaths || []).length
      || (asset.screenshotPaths || []).length
  );
}

function reportClassificationProgress({ onProgress, completed, total, item, provider }) {
  if (typeof onProgress !== "function") return;
  onProgress({
    completed,
    total,
    rowNumber: item?.firstRowNumber || 0,
    provider,
    ok: true
  });
}

function chunkItems(items = [], size = DEFAULT_BATCH_SIZE) {
  const width = Math.max(1, Math.floor(Number(size) || DEFAULT_BATCH_SIZE));
  const chunks = [];
  for (let index = 0; index < items.length; index += width) {
    chunks.push(items.slice(index, index + width));
  }
  return chunks;
}

function classificationCacheKey({ sourceRow = {}, provider = "deepseek", mediaMode = "text-only", assetSignature = "" } = {}) {
  const identity = sourceRow.itemId || sourceRow.link || [
    sourceRow.title,
    sourceRow.tags
  ].map(normalizeClassificationText).join("|");
  return hashText(JSON.stringify({
    identity: normalizeClassificationText(identity),
    title: normalizeClassificationText(sourceRow.title),
    tags: normalizeClassificationText(sourceRow.tags),
    itemType: normalizeClassificationText(sourceRow.itemType),
    assetSignature,
    provider,
    mediaMode,
    promptVersion: provider === "minimax" ? MINIMAX_PROMPT_VERSION : "deepseek-taxonomy-v1"
  }));
}

function assetSignatureForCache(asset = {}) {
  if (!asset) return "";
  return hashText(JSON.stringify({
    awemeId: asset.awemeId || "",
    mediaType: asset.mediaType || "",
    assetStatus: asset.assetStatus || "",
    videoPath: asset.videoPath || "",
    imagePaths: asset.imagePaths || [],
    framePaths: asset.framePaths || [],
    screenshotPaths: asset.screenshotPaths || [],
    downloadAttempts: (asset.downloadAttempts || []).map((attempt) => ({
      kind: attempt.kind,
      ok: attempt.ok,
      status: attempt.status,
      bytes: attempt.bytes
    }))
  }));
}

async function prepareDouyinChannelTypeAsset({
  sourceRow = {},
  mediaMode = "text-only",
  root = process.cwd(),
  generatedAt = new Date().toISOString()
} = {}) {
  if (mediaMode === "text-only") return textOnlyAssetBundle(sourceRow);
  try {
    const manifest = await createDouyinChannelTypeAssetBundle({
      root,
      targetDate: dateSegment(generatedAt),
      sourceRow: {
        sourceRowNumber: sourceRow.rowNumber,
        link: sourceRow.link,
        fields: sourceRow.fields
      },
      assetBaseDir: path.join(root, DOUYIN_CHANNEL_TYPE_OUTPUT_DIR, "assets")
    });
    const hasImages = (manifest.imagePaths || []).length > 0;
    const hasFrames = (manifest.framePaths || []).length > 0;
    const hasScreenshots = (manifest.screenshotPaths || []).length > 0;
    return {
      ...manifest,
      assetStatus: assetStatusFromManifest({ hasImages, hasFrames, hasScreenshots, mediaType: manifest.mediaType }),
      sourceText: manifest.sourceText || sourceTextFromRow(sourceRow),
      asrText: manifest.asrText || "",
      ocrText: manifest.ocrText || ""
    };
  } catch (error) {
    return {
      ...textOnlyAssetBundle(sourceRow),
      assetStatus: "素材获取失败需复核",
      error: error.message || String(error)
    };
  }
}

function textOnlyAssetBundle(sourceRow = {}) {
  return {
    assetStatus: "文本分类",
    sourceText: sourceTextFromRow(sourceRow),
    asrText: "",
    ocrText: "",
    imagePaths: [],
    framePaths: []
  };
}

function sourceTextFromRow(sourceRow = {}) {
  return [
    sourceRow.title,
    sourceRow.tags,
    sourceRow.account,
    sourceRow.contentType,
    sourceRow.itemType
  ].filter(Boolean).join("\n");
}

function assetStatusForMode(mediaMode) {
  return mediaMode === "text-only" ? "文本分类" : "素材获取失败需复核";
}

function assetStatusFromManifest({ hasImages, hasFrames, hasScreenshots, mediaType }) {
  if (hasFrames) return "视频抽帧";
  if (mediaType === "screenshot" || hasScreenshots) return "页面截图兜底";
  if (mediaType === "image" || hasImages) return "图文图片";
  return "素材获取失败需复核";
}

function reviewStatusForResult(result = {}) {
  if (!result.ok) return "需人工复核";
  const confidence = Number(result.confidence || 0);
  if (!Number.isFinite(confidence) || confidence < DEFAULT_MIN_CONFIDENCE) return "需人工复核";
  const reason = String(result.reason || "").trim();
  if (!reason) return "需人工复核";
  return "通过";
}

function updateToSheetRow(update = {}) {
  return [
    update.primaryType || "",
    update.secondaryType || "",
    update.confidence || 0,
    update.reason || "",
    update.reviewStatus || reviewStatusForResult(update),
    update.assetStatus || "",
    update.model || "",
    update.classifiedAt || ""
  ];
}

async function createClassificationDiskCache(cacheDir) {
  await fs.mkdir(cacheDir, { recursive: true });
  return {
    async read(cacheKey) {
      const filePath = cachePath(cacheDir, cacheKey);
      const text = await fs.readFile(filePath, "utf8").catch(() => "");
      if (!text.trim()) return null;
      return JSON.parse(text);
    },
    async write(cacheKey, result) {
      await fs.writeFile(cachePath(cacheDir, cacheKey), JSON.stringify(result, null, 2), "utf8");
    }
  };
}

function cachePath(cacheDir, cacheKey) {
  return path.join(cacheDir, `${hashText(cacheKey)}.json`);
}

function normalizeProvider(value) {
  const provider = String(value || "deepseek").trim().toLowerCase();
  return provider === "minimax" ? "minimax" : "deepseek";
}

function normalizeMediaMode(value) {
  const mode = String(value || "text-only").trim();
  if (mode === "sampled-media" || mode === "full-media" || mode === "auto") return mode;
  return "text-only";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    const text = String(value || "").trim();
    return text ? [text] : [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function dateSegment(value) {
  return String(value || new Date().toISOString()).slice(0, 10) || "unknown";
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeClassificationText(value) {
  return String(value || "").trim().replace(/\s+/gu, " ");
}

function rowIncludes(row, text) {
  return row.map(cellText).includes(text);
}

function cellText(value) {
  return extractLinkValue(value).trim();
}

function columnName(index) {
  let value = index;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}
