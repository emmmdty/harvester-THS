import fs from "node:fs/promises";
import path from "node:path";

import { extractBilibiliTags } from "./bilibili-detail-text.mjs";
import { dateFromBilibiliEpoch } from "./bilibili-published-date.mjs";
import { classifyTags } from "./tag-rules.mjs";
import { extractBilibiliBv } from "./link-utils.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";

export const BILIBILI_HISTORY_SHEET_KEY = "bilibiliHistory";
export const BILIBILI_HISTORY_SHEET_TITLE = "B站历史台账";
export const BILIBILI_HISTORY_HEADERS = [
  "账号名称",
  "账号主页",
  "发布时间",
  "作品类型",
  "作品ID",
  "作品链接",
  "标题",
  "tag词",
  "内容类型",
  "内容类型标签审核",
  "采集状态",
  "采集时间",
  "失败原因",
  "来源"
];

export const BILIBILI_HISTORY_COLUMN_WIDTHS = [120, 220, 110, 80, 150, 560, 420, 360, 120, 120, 100, 160, 260, 100];

const HEADER_STYLE = {
  backColor: "#DEE0E3",
  font: { bold: true },
  hAlign: 1,
  vAlign: 1
};

const SPACE_CARD_SPM = "333.1387.upload.video_card.click";

export function buildBilibiliHistoryVideoUrl(value) {
  const bvid = extractBilibiliBv(value) || String(value || "").trim();
  if (!bvid) return "";
  return `https://www.bilibili.com/video/${bvid}/?spm_id_from=${SPACE_CARD_SPM}`;
}

export function extractBilibiliHistoryItemsFromArcSearch(payload, {
  accountName = "",
  accountHomeUrl = "",
  collectedAt = ""
} = {}) {
  const list = Array.isArray(payload?.data?.list?.vlist) ? payload.data.list.vlist : [];
  const seen = new Set();
  const items = [];
  for (const video of list) {
    const item = bilibiliHistoryItemFromArcSearchVideo(video, { accountName, accountHomeUrl, collectedAt });
    if (!item || seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    items.push(item);
  }
  return {
    totalCount: Number(payload?.data?.page?.count || 0),
    pageNumber: Number(payload?.data?.page?.pn || 0),
    pageSize: Number(payload?.data?.page?.ps || 0),
    items
  };
}

export function bilibiliHistoryItemFromArcSearchVideo(video = {}, {
  accountName = "",
  accountHomeUrl = "",
  collectedAt = ""
} = {}) {
  const itemId = String(video.bvid || video.bv_id || extractBilibiliBv(video.arcurl || video.uri || video.url || "") || "").trim();
  if (!itemId) return null;
  const title = spreadsheetSafeText(video.title || "");
  const tags = normalizeBilibiliHistoryTags(extractBilibiliTags({
    videoData: video,
    title
  }));
  const contentType = classifyTags(tags, { platformId: "bilibili" });
  const publishedAt = dateFromBilibiliEpoch(video.created || video.pubdate || video.ctime);
  return {
    accountName,
    accountHomeUrl,
    publishedAt,
    itemType: "视频",
    itemId,
    itemUrl: buildBilibiliHistoryVideoUrl(itemId),
    title,
    tags,
    contentType,
    contentTypeReview: contentType && contentType !== "无" ? "通过" : "需审核",
    collectStatus: title && publishedAt ? "已采集" : "待补全",
    collectedAt,
    failureReason: "",
    source: "space-wbi-arc-search"
  };
}

export function mergeBilibiliHistoryLedgerItems(existingItems = [], incomingItems = []) {
  const merged = new Map();
  for (const item of existingItems || []) {
    const key = historyItemKey(item);
    if (key) merged.set(key, { ...item });
  }
  for (const item of incomingItems || []) {
    const key = historyItemKey(item);
    if (!key) continue;
    const previous = merged.get(key) || {};
    merged.set(key, mergeHistoryItem(previous, item));
  }
  return [...merged.values()];
}

export async function readBilibiliHistoryLedger(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    if (!text.trim()) return [];
    if (filePath.endsWith(".jsonl")) {
      return text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.items || [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeBilibiliHistoryLedger(filePath, items) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = (items || []).map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, content ? `${content}\n` : "", "utf8");
}

export function mapBilibiliHistoryItemToSheetRow(item = {}) {
  const fields = {
    "账号名称": item.accountName || "",
    "账号主页": item.accountHomeUrl || "",
    "发布时间": item.publishedAt || "",
    "作品类型": item.itemType || "",
    "作品ID": item.itemId || "",
    "作品链接": item.itemUrl || "",
    "标题": spreadsheetSafeText(item.title || ""),
    "tag词": spreadsheetSafeText(item.tags || ""),
    "内容类型": item.contentType || "",
    "内容类型标签审核": item.contentTypeReview || "",
    "采集状态": item.collectStatus || "",
    "采集时间": item.collectedAt || "",
    "失败原因": spreadsheetSafeText(item.failureReason || ""),
    "来源": item.source || ""
  };
  return BILIBILI_HISTORY_HEADERS.map((header) => fields[header] || "");
}

export function historyItemsToCsv(items = []) {
  return [
    BILIBILI_HISTORY_HEADERS.map(csvEscape).join(","),
    ...sortBilibiliHistoryItems(items).map((item) => mapBilibiliHistoryItemToSheetRow(item).map(csvEscape).join(","))
  ].join("\n");
}

export async function writeBilibiliHistoryOutputs({ items = [], outputDir = "output", generatedAt = new Date().toISOString() } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `bilibili_history_${safeTimestamp}.json`);
  const csvPath = path.join(outputDir, `bilibili_history_${safeTimestamp}.csv`);
  const sortedItems = sortBilibiliHistoryItems(items);
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt, total: sortedItems.length, items: sortedItems }, null, 2), "utf8");
  await fs.writeFile(csvPath, historyItemsToCsv(sortedItems), "utf8");
  return { jsonPath, csvPath };
}

export async function upsertBilibiliHistorySheet({
  client,
  sheetId = "",
  items = [],
  batchSize = 100
} = {}) {
  if (!client) throw new Error("缺少飞书 client。");
  const createdSheetId = await ensureBilibiliHistorySheet(client, sheetId);
  const rows = await client.readSheetRows(BILIBILI_HISTORY_SHEET_KEY, BILIBILI_HISTORY_HEADERS.length);
  const hasHeader = headerMatches(rows[0]);
  const existingRows = hasHeader ? rows.slice(1) : rows;
  const existingByKey = new Map();
  existingRows.forEach((row, index) => {
    const key = sheetRowKey(row);
    if (key) {
      existingByKey.set(key, {
        row,
        rowNumber: (hasHeader ? 2 : 1) + index
      });
    }
  });

  const existingKeys = new Set(existingByKey.keys());
  const rowsToAppend = [];
  let updated = 0;
  for (const item of items || []) {
    const key = historyItemKey(item);
    if (!key) continue;
    if (existingKeys.has(key)) {
      const existing = existingByKey.get(key);
      const mergedRow = mergeSheetRow(existing.row, mapBilibiliHistoryItemToSheetRow(item));
      if (!sheetRowsEqual(existing.row, mergedRow)) {
        const range = `${client.sheetId(BILIBILI_HISTORY_SHEET_KEY)}!A${existing.rowNumber}:${columnName(BILIBILI_HISTORY_HEADERS.length)}${existing.rowNumber}`;
        await client.writeRows(BILIBILI_HISTORY_SHEET_KEY, range, [mergedRow]);
        updated += 1;
      }
      continue;
    }
    existingKeys.add(key);
    rowsToAppend.push(mapBilibiliHistoryItemToSheetRow(item));
  }
  for (const batch of chunks(rowsToAppend, batchSize)) {
    await client.appendRowsToSheet(BILIBILI_HISTORY_SHEET_KEY, batch, BILIBILI_HISTORY_HEADERS.length);
  }
  return {
    createdSheetId,
    total: items.length,
    created: rowsToAppend.length,
    updated,
    skipped: items.length - rowsToAppend.length - updated
  };
}

export function sortBilibiliHistoryItems(items = []) {
  return (items || [])
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftDate = String(left.item?.publishedAt || "");
      const rightDate = String(right.item?.publishedAt || "");
      if (leftDate && rightDate && leftDate !== rightDate) return rightDate.localeCompare(leftDate);
      if (leftDate && !rightDate) return -1;
      if (!leftDate && rightDate) return 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export async function replaceBilibiliHistorySheet({
  client,
  sheetId = "",
  items = []
} = {}) {
  if (!client) throw new Error("缺少飞书 client。");
  await ensureBilibiliHistorySheet(client, sheetId);
  const sortedItems = sortBilibiliHistoryItems(items);
  const rows = [
    BILIBILI_HISTORY_HEADERS,
    ...sortedItems.map((item) => mapBilibiliHistoryItemToSheetRow(item))
  ];
  if (typeof client.replaceSheetRows !== "function") {
    throw new Error("当前飞书 client 不支持重写 Sheet。");
  }
  await client.replaceSheetRows(BILIBILI_HISTORY_SHEET_KEY, rows, BILIBILI_HISTORY_HEADERS.length);
  await initializeBilibiliHistorySheet(client);
  return {
    total: sortedItems.length,
    created: sortedItems.length,
    updated: 0,
    skipped: 0
  };
}

async function ensureBilibiliHistorySheet(client, sheetId = "") {
  const configuredSheetId = String(sheetId || client.config?.sheets?.[BILIBILI_HISTORY_SHEET_KEY] || "").trim();
  if (client.config?.sheets && configuredSheetId) {
    client.config.sheets[BILIBILI_HISTORY_SHEET_KEY] = configuredSheetId;
  }

  let resolvedSheetId = configuredSheetId;
  const sheets = typeof client.listSheets === "function" ? await client.listSheets() : [];
  const existing = sheets
    .map((sheet) => sheet.properties || sheet)
    .find((sheet) => (
      [sheet.sheet_id, sheet.sheetId, sheet.id].includes(resolvedSheetId)
      || sheet.title === BILIBILI_HISTORY_SHEET_TITLE
    ));
  if (existing) {
    resolvedSheetId = existing.sheet_id || existing.sheetId || existing.id || resolvedSheetId;
  }
  if (!resolvedSheetId) {
    const created = await client.createSheet(BILIBILI_HISTORY_SHEET_TITLE);
    resolvedSheetId = created?.sheetId || created?.sheet_id || created?.id || "";
  }
  if (!resolvedSheetId) throw new Error("创建或定位B站历史台账 Sheet 失败。");
  if (client.config?.sheets) client.config.sheets[BILIBILI_HISTORY_SHEET_KEY] = resolvedSheetId;
  await initializeBilibiliHistorySheet(client);
  return configuredSheetId ? "" : resolvedSheetId;
}

async function initializeBilibiliHistorySheet(client) {
  const sheetId = client.sheetId(BILIBILI_HISTORY_SHEET_KEY);
  const columnEnd = columnName(BILIBILI_HISTORY_HEADERS.length);
  await client.writeRows(
    BILIBILI_HISTORY_SHEET_KEY,
    `${sheetId}!A1:${columnEnd}1`,
    [BILIBILI_HISTORY_HEADERS]
  );
  if (typeof client.freezeRows === "function") {
    await client.freezeRows(BILIBILI_HISTORY_SHEET_KEY, 1).catch(() => {});
  }
  if (typeof client.setRangeStyle === "function") {
    await client.setRangeStyle(`${sheetId}!A1:${columnEnd}1`, HEADER_STYLE).catch(() => {});
  }
  if (typeof client.setColumnWidths === "function") {
    await client.setColumnWidths(BILIBILI_HISTORY_SHEET_KEY, BILIBILI_HISTORY_COLUMN_WIDTHS).catch(() => {});
  }
}

function normalizeBilibiliHistoryTags(value = "") {
  const tags = String(value || "")
    .split(/[\s,，#]+/u)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.startsWith("#") ? tag : `#${tag}`);
  return [...new Set(tags)].join(" ");
}

function mergeHistoryItem(previous = {}, incoming = {}) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (!merged[key]) merged[key] = value;
    if (["collectStatus", "collectedAt", "failureReason", "source"].includes(key)) merged[key] = value;
  }
  return merged;
}

function historyItemKey(item = {}) {
  return String(item.itemId || extractBilibiliBv(item.itemUrl || "") || item.itemUrl || "").trim();
}

function sheetRowKey(row = []) {
  const itemId = cellText(row[BILIBILI_HISTORY_HEADERS.indexOf("作品ID")]);
  const itemUrl = cellText(row[BILIBILI_HISTORY_HEADERS.indexOf("作品链接")]);
  return itemId || extractBilibiliBv(itemUrl) || itemUrl;
}

function mergeSheetRow(existingRow = [], incomingRow = []) {
  return BILIBILI_HISTORY_HEADERS.map((header, index) => {
    const existing = cellText(existingRow[index]);
    const incoming = cellText(incomingRow[index]);
    if (header === "失败原因") return incoming;
    if (!incoming) return existing;
    if (!existing) return incoming;
    if (["采集状态", "采集时间", "失败原因", "来源"].includes(header)) return incoming;
    return existing;
  });
}

function sheetRowsEqual(left = [], right = []) {
  return BILIBILI_HISTORY_HEADERS.every((_, index) => cellText(left[index]) === cellText(right[index]));
}

function headerMatches(row = []) {
  return BILIBILI_HISTORY_HEADERS.every((header, index) => cellText(row[index]) === header);
}

function cellText(value) {
  if (Array.isArray(value)) return value.map((entry) => cellText(entry)).find(Boolean) || "";
  if (value && typeof value === "object") return String(value.text || value.link || value.url || "");
  return String(value || "");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function chunks(values, size) {
  const chunkSize = Math.max(1, Number(size) || 100);
  const result = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    result.push(values.slice(index, index + chunkSize));
  }
  return result;
}

function columnName(index) {
  let n = index;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}
