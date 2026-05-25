import fs from "node:fs/promises";
import path from "node:path";

import "dotenv/config";
import { extractFeishuCellLink, PLATFORM_HEADERS } from "./daily-records.mjs";
import { formatBatchTitle, formatDate, formatDisplayDate, parseDateStringParts } from "./date-utils.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { canonicalizeContentLink, extractBilibiliBv, extractXhsNoteId } from "./link-utils.mjs";

const PLATFORM_IDS = ["douyin", "xhs", "bilibili"];

export async function organizeExistingFeishuDates({
  root = process.cwd(),
  platforms = PLATFORM_IDS,
  apply = false,
  client = null,
  env = process.env,
  log = console.log
} = {}) {
  const config = loadFeishuConfig(env);
  if (env.FEISHU_SHEET_STEP15_FILTERED) {
    config.sheets.step15 = String(env.FEISHU_SHEET_STEP15_FILTERED).trim();
  }
  const writer = client || new FeishuSheetsClient(config);
  const resolver = await buildPublishedDateResolver({ root });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(root, "output", "feishu-backups", timestamp);
  await fs.mkdir(backupDir, { recursive: true });

  const summary = {
    ok: false,
    apply,
    backupDir,
    startedAt: new Date().toISOString(),
    platforms: {}
  };

  for (const platformId of platforms) {
    const rows = await writer.readRows(platformId);
    const dataStartRow = typeof writer.dataStartRow === "function" ? writer.dataStartRow(platformId) : 2;
    await fs.writeFile(path.join(backupDir, `${platformId}.json`), JSON.stringify(rows, null, 2), "utf8");
    const result = organizePlatformRows({
      platformId,
      rows,
      dataStartRow,
      resolvePublishedAt: resolver
    });

    summary.platforms[platformId] = {
      dataStartRow,
      rowsBefore: rows.length,
      rowsAfter: result.rows.length,
      moves: result.moves,
      dateBlocks: result.dateBlocks
    };

    log(`${platformId} 日期整理：移动 ${result.moves.length} 条，日期块 ${result.dateBlocks.map((block) => `${block.date}:${block.materialCount}`).join("、")}`);
    if (!apply) continue;

    await writeOrganizedPlatformRows({
      client: writer,
      platformId,
      existingRows: rows,
      organizedRows: result.rows,
      dataStartRow
    });
    if (typeof writer.clearMaterialRowHighlights === "function") {
      await writer.clearMaterialRowHighlights(platformId, rowRangesFromMaterialRows(result.rows, dataStartRow));
    }
    if (typeof writer.highlightSeparatorRows === "function") {
      await writer.highlightSeparatorRows(platformId, result.separatorRowNumbers);
    }
    if (typeof writer.configurePlatformDropdowns === "function") {
      await writer.configurePlatformDropdowns(platformId);
    }
  }

  summary.ok = true;
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(backupDir, "organize-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

export function organizePlatformRows({
  platformId,
  rows,
  dataStartRow = 2,
  resolvePublishedAt = () => ""
}) {
  const headers = PLATFORM_HEADERS[platformId];
  if (!headers) throw new Error(`不支持的平台：${platformId}`);

  const dateIndex = headers.indexOf("投稿时间");
  const sequenceIndex = headers.indexOf("编号");
  const dates = new Set();
  const separatorRowsByDate = new Map();
  const materialRowsByDate = new Map();
  const moves = [];

  rows.forEach((row, index) => {
    if (!rowHasValue(row)) return;

    const separatorDate = separatorDateFromRow(row, dateIndex);
    if (separatorDate) {
      dates.add(separatorDate);
      if (!separatorRowsByDate.has(separatorDate)) {
        separatorRowsByDate.set(separatorDate, normalizeRowWidth(row, headers.length));
      }
      return;
    }

    const fields = rowFields(headers, row);
    const currentDate = normalizeSheetDate(fields["投稿时间"]);
    const resolvedDate = normalizeSheetDate(resolvePublishedAt({
      platformId,
      row,
      rowNumber: index + dataStartRow,
      fields
    })) || currentDate;
    if (!resolvedDate) return;

    dates.add(resolvedDate);
    const normalizedRow = normalizeRowWidth(row, headers.length);
    normalizedRow[dateIndex] = formatDisplayDate(resolvedDate);
    if (!materialRowsByDate.has(resolvedDate)) materialRowsByDate.set(resolvedDate, []);
    materialRowsByDate.get(resolvedDate).push({
      row: normalizedRow,
      originalRowNumber: index + dataStartRow,
      originalDate: currentDate,
      resolvedDate
    });
    if (currentDate && currentDate !== resolvedDate) {
      moves.push({
        rowNumber: index + dataStartRow,
        from: currentDate,
        to: resolvedDate,
        id: materialId(platformId, fields)
      });
    }
  });

  const sortedDates = [...dates].sort((left, right) => right.localeCompare(left));
  const organizedRows = [];
  const separatorRowNumbers = [];
  const dateBlocks = [];

  for (const date of sortedDates) {
    const separatorRowNumber = dataStartRow + organizedRows.length;
    separatorRowNumbers.push(separatorRowNumber);
    organizedRows.push(separatorRowsByDate.get(date) || separatorRow(platformId, date));
    const materials = materialRowsByDate.get(date) || [];
    let sequence = 1;
    for (const item of materials) {
      if (sequenceIndex >= 0) item.row[sequenceIndex] = String(sequence++);
      organizedRows.push(item.row);
    }
    dateBlocks.push({
      date,
      startRow: separatorRowNumber,
      materialCount: materials.length
    });
  }

  return {
    rows: organizedRows,
    moves,
    dateBlocks,
    separatorRowNumbers
  };
}

export function rowRangesFromMaterialRows(rows, dataStartRow = 2) {
  const ranges = [];
  let currentRange = null;
  rows.forEach((row, index) => {
    const rowNumber = index + dataStartRow;
    const isSeparator = separatorDateFromRow(row, 1);
    const isMaterial = rowHasValue(row) && !isSeparator;
    if (isMaterial) {
      if (currentRange && currentRange.endRow + 1 === rowNumber) {
        currentRange.endRow = rowNumber;
      } else {
        currentRange = { startRow: rowNumber, endRow: rowNumber };
        ranges.push(currentRange);
      }
    } else {
      currentRange = null;
    }
  });
  return ranges;
}

export function rowsToRewrite({ existingRows, organizedRows, columnCount }) {
  const occupiedLength = lastOccupiedDataLength(existingRows);
  const rewriteLength = Math.max(occupiedLength, organizedRows.length);
  const blankRow = Array.from({ length: columnCount }, () => "");
  return [
    ...organizedRows.map((row) => normalizeRowWidth(row, columnCount)),
    ...Array.from({ length: Math.max(0, rewriteLength - organizedRows.length) }, () => blankRow)
  ];
}

async function writeOrganizedPlatformRows({ client, platformId, existingRows, organizedRows, dataStartRow }) {
  const columnCount = PLATFORM_HEADERS[platformId].length;
  const rows = rowsToRewrite({ existingRows, organizedRows, columnCount });
  if (rows.length === 0) return;
  const sheetId = client.sheetId(platformId);
  const range = `${sheetId}!A${dataStartRow}:${columnName(columnCount)}${dataStartRow + rows.length - 1}`;
  await client.writeRows(platformId, range, rows);
}

export async function buildPublishedDateResolver({ root = process.cwd() } = {}) {
  const detailCaches = {
    douyin: await readDetailCache(path.join(root, ".runtime", "detail-cache", "douyin")),
    xhs: await readDetailCache(path.join(root, ".runtime", "detail-cache", "xhs"))
  };
  const localJson = await readLocalJsonPublishedDates(root);

  return ({ platformId, fields }) => {
    if (platformId === "xhs") {
      const id = String(fields["笔记ID"] || extractXhsNoteId(extractFeishuCellLink(fields["内容链接"]))).trim();
      return detailCaches.xhs.get(id)?.publishedAt || localJson.xhsById.get(id) || localJson.xhsByLink.get(canonicalizeContentLink(platformId, extractFeishuCellLink(fields["内容链接"]))) || "";
    }
    if (platformId === "douyin") {
      const link = extractFeishuCellLink(fields["内容链接"]);
      const itemId = extractDouyinItemId(link);
      return detailCaches.douyin.get(itemId)?.publishedAt || localJson.douyinByLink.get(canonicalizeContentLink(platformId, link)) || "";
    }
    if (platformId === "bilibili") {
      const bvid = String(fields["短链id"] || extractBilibiliBv(extractFeishuCellLink(fields["内容链接"]))).trim();
      return localJson.bilibiliById.get(bvid) || localJson.bilibiliByLink.get(canonicalizeContentLink(platformId, extractFeishuCellLink(fields["内容链接"]))) || "";
    }
    return "";
  };
}

async function readDetailCache(dir) {
  const cache = new Map();
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.replace(/\.json$/u, "");
    const parsed = JSON.parse(await fs.readFile(path.join(dir, entry.name), "utf8"));
    if (parsed.publishedAt) cache.set(id, { publishedAt: parsed.publishedAt });
  }
  return cache;
}

async function readLocalJsonPublishedDates(root) {
  const result = {
    douyinByLink: new Map(),
    xhsById: new Map(),
    xhsByLink: new Map(),
    bilibiliById: new Map(),
    bilibiliByLink: new Map()
  };
  const outputDir = path.join(root, "output");
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(outputDir, entry.name);
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!Array.isArray(parsed.items)) continue;
    for (const item of parsed.items) {
      const platformId = item.platform;
      const publishedAt = normalizeSheetDate(item.publishedAt);
      if (!publishedAt) continue;
      const link = item.link || item.noteUrl || item.itemUrl || item.videoUrl || "";
      if (platformId === "douyin") {
        result.douyinByLink.set(canonicalizeContentLink(platformId, link), publishedAt);
      } else if (platformId === "xhs") {
        if (item.id) result.xhsById.set(String(item.id), publishedAt);
        result.xhsByLink.set(canonicalizeContentLink(platformId, link), publishedAt);
      } else if (platformId === "bilibili") {
        if (item.id) result.bilibiliById.set(String(item.id), publishedAt);
        result.bilibiliByLink.set(canonicalizeContentLink(platformId, link), publishedAt);
      }
    }
  }
  return result;
}

function rowFields(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
}

function materialId(platformId, fields) {
  if (platformId === "xhs") return cellText(fields["笔记ID"]);
  if (platformId === "bilibili") return cellText(fields["短链id"]);
  return extractDouyinItemId(extractFeishuCellLink(fields["内容链接"]));
}

function normalizeRowWidth(row, width) {
  return Array.from({ length: width }, (_, index) => row[index] ?? "");
}

function lastOccupiedDataLength(rows) {
  for (let index = (rows || []).length - 1; index >= 0; index -= 1) {
    if (rowHasValue(rows[index])) return index + 1;
  }
  return 0;
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

function separatorRow(platformId, date) {
  const row = Array.from({ length: PLATFORM_HEADERS[platformId].length }, () => "");
  row[PLATFORM_HEADERS[platformId].indexOf("投稿时间")] = formatBatchTitle(date);
  return row;
}

function separatorDateFromRow(row, dateIndex) {
  const text = cellText(row[dateIndex]).trim();
  const batch = text.match(/^(\d{2})(\d{2})\s+投稿视频$/u);
  if (!batch) return "";
  return `${currentYear()}-${batch[1]}-${batch[2]}`;
}

function normalizeSheetDate(value) {
  const text = cellText(value).trim();
  if (!text) return "";
  const full = text.match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/u);
  if (full) {
    const date = `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
    parseDateStringParts(date);
    return date;
  }
  const display = text.match(/^(\d{1,2})\s+(\d{1,2})$/u);
  if (display) {
    const date = `${currentYear()}-${display[1].padStart(2, "0")}-${display[2].padStart(2, "0")}`;
    parseDateStringParts(date);
    return date;
  }
  return "";
}

function currentYear() {
  return formatDate(new Date()).slice(0, 4);
}

function extractDouyinItemId(link) {
  const match = String(link || "").match(/(?:video|note)\/(\d+)/u);
  return match?.[1] || "";
}

function rowHasValue(row) {
  return (row || []).some((cell) => cellText(cell).trim());
}

function cellText(value) {
  if (Array.isArray(value)) return value.map((entry) => cellText(entry)).find(Boolean) || "";
  if (value && typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((entry) => cellText(entry)).filter(Boolean).join("、");
    return String(value.text || value.link || value.url || "");
  }
  return String(value || "");
}
