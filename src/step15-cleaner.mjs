import fs from "node:fs/promises";
import path from "node:path";

import {
  PLATFORM_HEADERS,
  PLATFORM_LEGACY_HEADERS,
  buildFeishuUrlCell,
  extractFeishuCellLink
} from "./daily-records.mjs";
import { formatBatchTitle, formatDate, formatDisplayDate, pad } from "./date-utils.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { loadLogisticPolicyModel } from "./logistic-policy.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";
import { createDouyinAssetBundle } from "./step15-douyin-assets.mjs";
import {
  applyBatchPassQuota,
  calibrateStep15Decision,
  detectHistoricalFilterPriors,
  detectLocalFilterSignals,
  filterWithConfiguredProvider,
  localRejectResult,
  normalizeBriefReason
} from "./step15-filter-provider.mjs";

export const STEP15_FEEDBACK_HEADERS = ["筛选状态", "简短理由", "本地素材目录"];
export const STEP15_LEGACY_FILTERED_HEADERS = PLATFORM_LEGACY_HEADERS.step15;
export const STEP15_FILTERED_HEADERS = PLATFORM_HEADERS.step15;

const STEP15_SHEET_KEY = "step15";
const STEP15_DATE_COLUMN_INDEX = STEP15_FILTERED_HEADERS.indexOf("投稿时间");
const DOUYIN_STATUS_REASON_START_COLUMN = "F";
const DOUYIN_STATUS_REASON_END_COLUMN = "G";
const DOUYIN_ASSET_DIR_COLUMN = "K";

export async function cleanDailyStep15({
  root = process.cwd(),
  targetDate,
  client = null,
  platforms = ["douyin"],
  extractDouyinAsset,
  filterWithProvider = filterWithConfiguredProvider,
  env = process.env,
  fetch = globalThis.fetch,
  log = () => {}
} = {}) {
  if (!targetDate) throw new Error("targetDate is required");
  const writer = client || new FeishuSheetsClient(loadStep15FeishuConfig(env));
  await fs.mkdir(path.join(root, "output"), { recursive: true });

  const summary = {
    ok: false,
    targetDate,
    startedAt: new Date().toISOString(),
    douyin: { total: 0, pass: 0, reject: 0, review: 0 },
    xhs: { kept: 0 },
    bilibili: { kept: 0 }
  };
  const filteredRows = [];
  const details = [];
  const logisticModel = await loadLogisticPolicyModel(env, root);

  for (const platformId of platforms) {
    const rows = await writer.readRows(platformId);
    const sourceRows = sourceRowsForTargetDate(platformId, targetDate, rows, dataStartRowFor(writer, platformId));
    if (platformId === "douyin") {
      log(`抖音待筛选：${sourceRows.length} 条`);
      const result = await processDouyinRows({
        root,
        targetDate,
        sourceRows,
        client: writer,
        extractDouyinAsset,
        filterWithProvider,
        logisticModel,
        env,
        fetch
      });
      filteredRows.push(...result.filteredRows);
      details.push(...result.details);
      summary.douyin = result.summary;
      continue;
    }

    const platformRows = sourceRows.map((sourceRow) => buildFilteredRow({
      sourceRow,
      briefReason: "未筛选，按规则原样保留。"
    }));
    filteredRows.push(...platformRows);
    summary[platformId].kept = platformRows.length;
  }

  await replaceFilteredRowsForTargetDate(writer, targetDate, filteredRows);
  const summaryPath = path.join(root, "output", `step15_clean_${targetDate}.json`);
  summary.ok = true;
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify({ summary, details }, null, 2), "utf8");
  return { ok: true, summary, details, summaryPath };
}

export function loadStep15FeishuConfig(env = process.env) {
  const config = loadFeishuConfig(env);
  config.sheets.step15 = String(env.FEISHU_SHEET_STEP15_FILTERED || config.sheets.step15 || "").trim();
  if (!config.sheets.step15) {
    throw new Error("缺少飞书配置：FEISHU_SHEET_STEP15_FILTERED。请在同一普通表格中创建筛选后输出工作表并填入 sheet_id。");
  }
  return config;
}

export function sourceRowsForTargetDate(platformId, targetDate, rows = [], dataStartRow = 2) {
  const headers = PLATFORM_HEADERS[platformId];
  if (!headers) throw new Error(`不支持的平台：${platformId}`);
  const displayDate = formatDisplayDate(targetDate);
  const sourceRows = [];
  rows.forEach((row, index) => {
    const fields = Object.fromEntries(headers.map((header, headerIndex) => [header, cellText(row[headerIndex])]));
    const rowDate = String(fields["投稿时间"] || "").trim();
    const link = extractFeishuCellLink(row[headers.indexOf("内容链接")]);
    if (!link) return;
    if (!dateMatches(rowDate, displayDate, targetDate)) return;
    sourceRows.push({
      platformId,
      sourceRowNumber: index + dataStartRow,
      fields,
      rawRow: row,
      link
    });
  });
  return sourceRows;
}

async function processDouyinRows({
  root,
  targetDate,
  sourceRows,
  client,
  extractDouyinAsset,
  filterWithProvider,
  logisticModel = null,
  env,
  fetch
}) {
  const filteredRows = [];
  const feedback = [];
  const details = [];
  const summary = { total: sourceRows.length, pass: 0, reject: 0, review: 0 };
  const decisions = [];

  for (const sourceRow of sourceRows) {
    const assetBundle = await createDouyinAssetBundle({
      root,
      targetDate,
      sourceRow,
      extractDouyinAsset,
      fetch,
      env
    });
    const localRisks = [
      ...detectLocalFilterSignals(assetBundle.sourceText),
      ...detectHistoricalFilterPriors(sourceRow)
    ];
    const localRejects = localRisks.filter((risk) => risk.action === "reject");
    let filterResult;
    let decisionSource = "provider";
    if (localRejects.length > 0) {
      filterResult = localRejectResult(localRejects);
      decisionSource = "local-reject";
    } else if (!assetBundle.ok) {
      filterResult = {
        status: "review",
        ruleIds: [],
        briefReason: "素材抽取失败，需人工复核。",
        evidence: [assetBundle.error].filter(Boolean)
      };
      decisionSource = "asset-error";
    } else {
      try {
        filterResult = await filterWithProvider({
          sourceRow,
          assetBundle,
          localRisks,
          env,
          fetch
        });
      } catch (error) {
        filterResult = {
          status: "review",
          ruleIds: [],
          briefReason: "模型筛选失败，需人工复核。",
          evidence: [error.message || String(error)]
        };
        decisionSource = "provider-error";
      }
    }

    const normalized = normalizeFilterResult(filterResult);
    decisions.push({
      sourceRow,
      assetBundle,
      localRisks,
      decisionSource,
      result: normalized
    });
  }

  const quotaDecisions = applyBatchPassQuota(decisions, env);
  for (const decision of quotaDecisions) {
    const { sourceRow, assetBundle } = decision;
    const calibrated = calibrateStep15Decision(decision, { logisticModel });
    const normalized = normalizeFilterResult(calibrated.result);
    summary[normalized.status] += 1;
    const feedbackRow = feedbackRowForResult(normalized, assetBundle.assetDir);
    feedback.push({ sourceRowNumber: sourceRow.sourceRowNumber, row: feedbackRow });
    if (normalized.status === "pass") {
      filteredRows.push(buildFilteredRow({
        sourceRow,
        briefReason: normalized.briefReason
      }));
    }
    details.push({
      sourceRowNumber: sourceRow.sourceRowNumber,
      link: sourceRow.link,
      assetDir: assetBundle.assetDir,
      result: normalized,
      preliminaryResult: decision.preliminaryResult,
      calibratedResult: normalized,
      calibration: calibrated.calibration,
      localRisks: decision.localRisks,
      quota: decision.quota
    });
  }

  await writeDouyinFeedback(client, feedback);
  return { filteredRows, feedback, details, summary };
}

async function writeDouyinFeedback(client, feedbackRows) {
  const sheetId = client.sheetId("douyin");
  const headerRow = headerRowFor(client, "douyin");
  await client.writeRows("douyin", `${sheetId}!${DOUYIN_STATUS_REASON_START_COLUMN}${headerRow}:${DOUYIN_STATUS_REASON_END_COLUMN}${headerRow}`, [["筛选状态", "简短理由"]]);
  await client.writeRows("douyin", `${sheetId}!${DOUYIN_ASSET_DIR_COLUMN}${headerRow}:${DOUYIN_ASSET_DIR_COLUMN}${headerRow}`, [["本地素材目录"]]);
  for (const feedback of feedbackRows) {
    await client.writeRows(
      "douyin",
      `${sheetId}!${DOUYIN_STATUS_REASON_START_COLUMN}${feedback.sourceRowNumber}:${DOUYIN_STATUS_REASON_END_COLUMN}${feedback.sourceRowNumber}`,
      [feedback.row.slice(0, 2)]
    );
    await client.writeRows(
      "douyin",
      `${sheetId}!${DOUYIN_ASSET_DIR_COLUMN}${feedback.sourceRowNumber}:${DOUYIN_ASSET_DIR_COLUMN}${feedback.sourceRowNumber}`,
      [[feedback.row[2] || ""]]
    );
  }
}

async function replaceFilteredRowsForTargetDate(client, targetDate, newRows) {
  const existing = typeof client.readSheetRows === "function"
    ? await client.readSheetRows(STEP15_SHEET_KEY, STEP15_FILTERED_HEADERS.length)
    : [];
  const existingBody = existingRowsWithoutHeader(existing, client, STEP15_SHEET_KEY)
    .filter((row) => row.some((cell) => cellText(cell).trim()))
    .filter((row) => !rowMatchesTargetDate(row, targetDate));
  const rows = buildRowsWithDateSeparators([...existingBody, ...newRows]);
  await writeFilteredRows(client, rows);
}

export async function rebuildStep15FilteredSeparators({ client = null, env = process.env } = {}) {
  const writer = client || new FeishuSheetsClient(loadStep15FeishuConfig(env));
  const existing = typeof writer.readSheetRows === "function"
    ? await writer.readSheetRows(STEP15_SHEET_KEY, STEP15_FILTERED_HEADERS.length)
    : [];
  const existingBody = existingRowsWithoutHeader(existing, writer, STEP15_SHEET_KEY)
    .filter((row) => row.some((cell) => cellText(cell).trim()))
    .filter((row) => !isFilteredSeparatorRow(row));
  const rows = buildRowsWithDateSeparators(existingBody);
  await writeFilteredRows(writer, rows);
  return {
    totalRows: rows.length,
    separatorRows: rows.filter(isFilteredSeparatorRow).length,
    materialRows: rows.filter((row) => row.some((cell) => cellText(cell).trim()) && !isFilteredSeparatorRow(row)).length
  };
}

async function writeFilteredRows(client, rows) {
  if (typeof client.replaceSheetDataRows === "function") {
    await writeFilteredHeader(client);
    await client.replaceSheetDataRows(STEP15_SHEET_KEY, rows, STEP15_FILTERED_HEADERS.length);
    await applyFilteredRowStyles(client, rows, dataStartRowFor(client, STEP15_SHEET_KEY));
    return;
  }
  const legacyRows = [
    STEP15_FILTERED_HEADERS,
    ...rows
  ];
  if (typeof client.replaceSheetRows === "function") {
    await client.replaceSheetRows(STEP15_SHEET_KEY, legacyRows, STEP15_FILTERED_HEADERS.length);
    await applyFilteredRowStyles(client, rows, dataStartRowFor(client, STEP15_SHEET_KEY));
    return;
  }
  const sheetId = client.sheetId(STEP15_SHEET_KEY);
  await client.writeRows(
    STEP15_SHEET_KEY,
    `${sheetId}!A1:J${legacyRows.length}`,
    legacyRows
  );
  await applyFilteredRowStyles(client, rows, 2);
}

async function writeFilteredHeader(client) {
  if (typeof client.writeRows !== "function" || typeof client.sheetId !== "function") return;
  const sheetId = client.sheetId(STEP15_SHEET_KEY);
  const headerRow = headerRowFor(client, STEP15_SHEET_KEY);
  await client.writeRows(STEP15_SHEET_KEY, `${sheetId}!A${headerRow}:J${headerRow}`, [STEP15_FILTERED_HEADERS]);
}

function buildFilteredRow({ sourceRow, briefReason }) {
  const fields = sourceRow.fields;
  return [
    fields["编号"] || "",
    fields["投稿时间"] || "",
    buildFeishuUrlCell(sourceRow.link),
    spreadsheetSafeText(fields["账号"] || ""),
    spreadsheetSafeText(fields["内容类型"] || ""),
    spreadsheetSafeText(normalizeBriefReason(briefReason)),
    "",
    "",
    "",
    ""
  ];
}

function feedbackRowForResult(result, assetDir) {
  const statusLabel = result.status === "pass"
    ? "通过"
    : result.status === "reject"
      ? "不投放"
      : "需人工复核";
  return [
    statusLabel,
    spreadsheetSafeText(normalizeBriefReason(result.briefReason)),
    spreadsheetSafeText(assetDir || "")
  ];
}

function normalizeFilterResult(result = {}) {
  const status = ["pass", "reject", "review"].includes(result.status) ? result.status : "review";
  return {
    status,
    ruleIds: Array.isArray(result.ruleIds) ? result.ruleIds.filter(Boolean) : [],
    briefReason: normalizeBriefReason(result.briefReason, status === "pass" ? "未发现不投放风险。" : "需要人工复核。"),
    evidence: Array.isArray(result.evidence) ? result.evidence : []
  };
}

function existingRowsWithoutHeader(rows, client = null, sheetKey = STEP15_SHEET_KEY) {
  if (!rows.length) return [];
  const dataStartRow = dataStartRowFor(client, sheetKey);
  if (dataStartRow > 2 && rows.length >= dataStartRow) {
    return rows.slice(dataStartRow - 1);
  }
  const first = rows[0] || [];
  const hasHeader = rowMatchesAny(first, [STEP15_FILTERED_HEADERS, ...STEP15_LEGACY_FILTERED_HEADERS]);
  return hasHeader ? rows.slice(1) : rows;
}

function buildRowsWithDateSeparators(rows) {
  const grouped = new Map();
  const undatedRows = [];
  for (const row of rows) {
    if (!row.some((cell) => cellText(cell).trim()) || isFilteredSeparatorRow(row)) continue;
    const rowDate = normalizedDateFromCell(row[STEP15_DATE_COLUMN_INDEX]);
    if (!rowDate) {
      undatedRows.push(normalizeRowWidth(row));
      continue;
    }
    if (!grouped.has(rowDate)) grouped.set(rowDate, []);
    grouped.get(rowDate).push(normalizeRowWidth(row));
  }

  return [
    ...[...grouped.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .flatMap(([date, dateRows]) => [filteredSeparatorRow(date), ...dateRows]),
    ...undatedRows
  ];
}

function filteredSeparatorRow(date) {
  const row = Array.from({ length: STEP15_FILTERED_HEADERS.length }, () => "");
  row[STEP15_DATE_COLUMN_INDEX] = formatBatchTitle(date);
  return row;
}

function isFilteredSeparatorRow(row) {
  return /^(\d{2})(\d{2})\s+投稿视频$/u.test(cellText(row?.[STEP15_DATE_COLUMN_INDEX]).trim());
}

function rowMatchesTargetDate(row, targetDate) {
  return normalizedDateFromCell(row?.[STEP15_DATE_COLUMN_INDEX]) === targetDate;
}

function normalizedDateFromCell(value) {
  const text = cellText(value).trim();
  const full = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u);
  if (full) return `${full[1]}-${pad(full[2])}-${pad(full[3])}`;
  const display = text.match(/^(\d{1,2})\s+(\d{1,2})$/u);
  if (display) return `${currentYear()}-${pad(display[1])}-${pad(display[2])}`;
  const batch = text.match(/^(\d{2})(\d{2})\s+投稿视频$/u);
  if (batch) return `${currentYear()}-${batch[1]}-${batch[2]}`;
  return "";
}

function currentYear() {
  return formatDate(new Date()).slice(0, 4);
}

function normalizeRowWidth(row = []) {
  return Array.from({ length: STEP15_FILTERED_HEADERS.length }, (_, index) => row[index] || "");
}

async function applyFilteredRowStyles(client, rows, dataStartRow) {
  const separatorRowNumbers = [];
  const materialRowNumbers = [];
  rows.forEach((row, index) => {
    const rowNumber = dataStartRow + index;
    if (isFilteredSeparatorRow(row)) {
      separatorRowNumbers.push(rowNumber);
    } else if (row.some((cell) => cellText(cell).trim())) {
      materialRowNumbers.push(rowNumber);
    }
  });

  if (typeof client.clearMaterialRowHighlights === "function" && materialRowNumbers.length > 0) {
    await client.clearMaterialRowHighlights(STEP15_SHEET_KEY, rowRangesFromRowNumbers(materialRowNumbers));
  }
  if (typeof client.highlightSeparatorRows === "function" && separatorRowNumbers.length > 0) {
    await client.highlightSeparatorRows(STEP15_SHEET_KEY, separatorRowNumbers);
  }
}

function rowRangesFromRowNumbers(rowNumbers) {
  const sortedRows = [...new Set(rowNumbers)]
    .map((rowNumber) => Number(rowNumber))
    .filter((rowNumber) => Number.isInteger(rowNumber) && rowNumber > 0)
    .sort((left, right) => left - right);
  const ranges = [];
  for (const rowNumber of sortedRows) {
    const previous = ranges.at(-1);
    if (previous && previous.endRow + 1 === rowNumber) {
      previous.endRow = rowNumber;
    } else {
      ranges.push({ startRow: rowNumber, endRow: rowNumber });
    }
  }
  return ranges;
}

function dateMatches(value, displayDate, targetDate) {
  const text = cellText(value).trim();
  return text === displayDate || text === targetDate;
}

function cellText(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cellText(entry)).find(Boolean) || "";
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((entry) => cellText(entry)).filter(Boolean).join("、");
    return String(value.text || value.link || value.url || "");
  }
  return String(value || "");
}

function rowMatchesAny(row = [], headerCandidates = []) {
  return headerCandidates.some((headers) => headers.every((header, index) => cellText(row[index]) === header));
}

function headerRowFor(client, sheetKey) {
  return typeof client?.headerRow === "function" ? client.headerRow(sheetKey) : 1;
}

function dataStartRowFor(client, sheetKey) {
  return typeof client?.dataStartRow === "function" ? client.dataStartRow(sheetKey) : 2;
}
