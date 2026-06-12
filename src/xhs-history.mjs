import fs from "node:fs/promises";
import path from "node:path";

import { publishedDateFromXhsNoteId } from "./content-identity.mjs";
import { normalizeAccountLabel } from "./daily-records.mjs";
import { extractLinkValue, extractXhsNoteId } from "./link-utils.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";

export const XHS_HISTORY_SHEET_KEY = "xhsHistory";
export const XHS_HISTORY_SHEET_TITLE = "小红书历史台账";
export const XHS_HISTORY_HEADERS = [
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

export const XHS_HISTORY_COLUMN_WIDTHS = [120, 220, 110, 80, 180, 560, 420, 360, 120, 120, 100, 160, 260, 100];

const HEADER_STYLE = {
  backColor: "#DEE0E3",
  font: { bold: true },
  hAlign: 1,
  vAlign: 1
};

const XHS_LEGACY_SEED_HEADERS = ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "内容类型标签审核", "tag词"];
const XHS_CURRENT_SEED_HEADERS = ["编号", "投稿时间", "内容链接", "笔记ID", "标题", "账号", "内容类型", "内容类型标签审核", "tag词"];
const XHS_LEGACY_CHANNEL_SEED_HEADERS = ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "标题", "内容类型标签审核", "tag词"];
const XHS_CHANNEL_SEED_HEADERS = ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "标题", "tag词", "一级类型", "二级类型", "内容类型标签审核", "AI内容判断备注"];

export function extractXhsHistoryItemsFromSeedRows(rows = [], {
  collectedAt = "",
  accountHomeUrlsByLabel = new Map(),
  accountNamesByLabel = new Map()
} = {}) {
  const headerInfo = findSeedHeader(rows);
  if (!headerInfo) return [];

  const items = [];
  for (const row of rows.slice(headerInfo.index + 1)) {
    const item = seedRowToXhsHistoryItem(row, headerInfo.headers, {
      collectedAt,
      accountHomeUrlsByLabel,
      accountNamesByLabel
    });
    if (item) items.push(item);
  }
  return mergeXhsHistoryLedgerItems([], items);
}

export function seedRowToXhsHistoryItem(row = [], headers = XHS_LEGACY_SEED_HEADERS, {
  collectedAt = "",
  accountHomeUrlsByLabel = new Map(),
  accountNamesByLabel = new Map()
} = {}) {
  const fields = Object.fromEntries(headers.map((header, index) => [header, cellText(row[index])]));
  const rawLink = extractLinkValue(row[headers.indexOf("内容链接")]);
  const itemId = fields["笔记ID"] || extractXhsNoteId(rawLink);
  const itemUrl = canonicalXhsItemUrl(itemId || rawLink);
  if (!itemId && !itemUrl) return null;

  const label = normalizeAccountLabel("xhs", fields["账号"]);
  const accountName = accountNamesByLabel.get(label) || fields["账号"] || label;
  const publishedAt = publishedDateFromXhsNoteId(itemId) || parseSeedDisplayDate(fields["投稿时间"]) || "";
  const tags = fields["tag词"] || "";
  const title = fields["标题"] || "";
  const contentType = fields["内容类型"] || "";
  const contentTypeReview = normalizeContentTypeReview(fields["内容类型标签审核"], contentType);
  const completeness = historySeedCompleteness({ title, tags, contentType });

  return {
    accountName,
    accountHomeUrl: accountHomeUrlsByLabel.get(label) || "",
    publishedAt,
    itemType: "图文",
    itemId,
    itemUrl,
    title,
    tags,
    contentType,
    contentTypeReview,
    collectStatus: completeness.complete ? "已采集" : "待补全",
    collectedAt,
    failureReason: completeness.failureReason,
    source: "feishu-seed"
  };
}

export function mapXhsHistoryItemToSheetRow(item = {}) {
  const fields = {
    "账号名称": item.accountName || "",
    "账号主页": item.accountHomeUrl || "",
    "发布时间": item.publishedAt || "",
    "作品类型": item.itemType || "",
    "作品ID": item.itemId || extractXhsNoteId(item.itemUrl || ""),
    "作品链接": canonicalXhsItemUrl(item.itemUrl || item.itemId || ""),
    "标题": spreadsheetSafeText(item.title || ""),
    "tag词": spreadsheetSafeText(item.tags || ""),
    "内容类型": item.contentType || "",
    "内容类型标签审核": item.contentTypeReview || "",
    "采集状态": item.collectStatus || "",
    "采集时间": item.collectedAt || "",
    "失败原因": spreadsheetSafeText(item.failureReason || ""),
    "来源": item.source || ""
  };
  return XHS_HISTORY_HEADERS.map((header) => fields[header] || "");
}

export function createPendingXhsHistoryItem({
  link = {},
  account = {},
  collectedAt = "",
  failureReason = "待补全",
  source = "profile-state"
} = {}) {
  const itemId = link.id || extractXhsNoteId(link.exportUrl || link.detailUrl || "");
  const itemUrl = canonicalXhsItemUrl(link.exportUrl || link.detailUrl || itemId || "");
  return {
    accountName: account.name || "",
    accountHomeUrl: account.url || "",
    publishedAt: publishedDateFromXhsNoteId(itemId) || "",
    itemType: "图文",
    itemId,
    itemUrl,
    title: link.title || "",
    tags: "",
    contentType: "",
    contentTypeReview: "",
    collectStatus: "待补全",
    collectedAt,
    failureReason,
    source
  };
}

export function mergeXhsHistoryLedgerItems(existingItems = [], incomingItems = []) {
  const merged = new Map();
  for (const item of existingItems || []) {
    const normalized = normalizeHistoryItemStatus(item);
    const key = historyItemKey(normalized);
    if (key) merged.set(key, normalized);
  }
  for (const item of incomingItems || []) {
    const normalized = normalizeHistoryItemStatus(item);
    const key = historyItemKey(normalized);
    if (!key) continue;
    if (!merged.has(key)) {
      merged.set(key, normalized);
      continue;
    }
    merged.set(key, mergeHistoryItem(merged.get(key), normalized));
  }
  return [...merged.values()];
}

export async function readXhsHistoryLedger(filePath) {
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

export async function writeXhsHistoryLedger(filePath, items) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = (items || []).map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, content ? `${content}\n` : "", "utf8");
}

export function historyItemsToCsv(items = []) {
  return [
    XHS_HISTORY_HEADERS.map(csvEscape).join(","),
    ...sortXhsHistoryItems(items).map((item) => mapXhsHistoryItemToSheetRow(item).map(csvEscape).join(","))
  ].join("\n");
}

export async function writeXhsHistoryOutputs({ items = [], outputDir = "output", generatedAt = new Date().toISOString(), audit = [] } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `xhs_history_${safeTimestamp}.json`);
  const csvPath = path.join(outputDir, `xhs_history_${safeTimestamp}.csv`);
  const sortedItems = sortXhsHistoryItems(items);
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt, total: sortedItems.length, audit, items: sortedItems }, null, 2), "utf8");
  await fs.writeFile(csvPath, historyItemsToCsv(sortedItems), "utf8");
  return { jsonPath, csvPath };
}

export async function upsertXhsHistorySheet({
  client,
  sheetId = "",
  items = [],
  batchSize = 100
} = {}) {
  if (!client) throw new Error("缺少飞书 client。");
  const createdSheetId = await ensureXhsHistorySheet(client, sheetId);
  const rows = await client.readSheetRows(XHS_HISTORY_SHEET_KEY, XHS_HISTORY_HEADERS.length);
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
      const mergedRow = mergeSheetRow(existing.row, mapXhsHistoryItemToSheetRow(item));
      if (!sheetRowsEqual(existing.row, mergedRow)) {
        const range = `${client.sheetId(XHS_HISTORY_SHEET_KEY)}!A${existing.rowNumber}:${columnName(XHS_HISTORY_HEADERS.length)}${existing.rowNumber}`;
        await client.writeRows(XHS_HISTORY_SHEET_KEY, range, [mergedRow]);
        updated += 1;
      }
      continue;
    }
    existingKeys.add(key);
    rowsToAppend.push(mapXhsHistoryItemToSheetRow(item));
  }

  for (const batch of chunks(rowsToAppend, batchSize)) {
    await client.appendRowsToSheet(XHS_HISTORY_SHEET_KEY, batch, XHS_HISTORY_HEADERS.length);
  }
  return {
    createdSheetId,
    total: items.length,
    created: rowsToAppend.length,
    updated,
    skipped: items.length - rowsToAppend.length - updated
  };
}

export async function replaceXhsHistorySheet({
  client,
  sheetId = "",
  items = []
} = {}) {
  if (!client) throw new Error("缺少飞书 client。");
  await ensureXhsHistorySheet(client, sheetId);
  const sortedItems = sortXhsHistoryItems(items);
  const rows = [
    XHS_HISTORY_HEADERS,
    ...sortedItems.map((item) => mapXhsHistoryItemToSheetRow(item))
  ];
  if (typeof client.replaceSheetRows !== "function") {
    throw new Error("当前飞书 client 不支持重写 Sheet。");
  }
  await client.replaceSheetRows(XHS_HISTORY_SHEET_KEY, rows, XHS_HISTORY_HEADERS.length);
  await initializeXhsHistorySheet(client);
  return {
    total: sortedItems.length,
    created: sortedItems.length,
    updated: 0,
    skipped: 0
  };
}

export function sortXhsHistoryItems(items = []) {
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

export function canonicalXhsItemUrl(value = "") {
  const text = extractLinkValue(value).trim();
  const noteId = extractXhsNoteId(text) || (/^[0-9a-f]{8,}$/iu.test(text) ? text : "");
  return noteId ? `https://www.xiaohongshu.com/discovery/item/${noteId}` : text;
}

function ensureXhsHistorySheet(client, sheetId = "") {
  return ensureXhsHistorySheetAsync(client, sheetId);
}

async function ensureXhsHistorySheetAsync(client, sheetId = "") {
  const configuredSheetId = String(sheetId || client.config?.sheets?.[XHS_HISTORY_SHEET_KEY] || "").trim();
  if (client.config?.sheets && configuredSheetId) {
    client.config.sheets[XHS_HISTORY_SHEET_KEY] = configuredSheetId;
  }

  let resolvedSheetId = configuredSheetId;
  let createdSheetId = "";
  const sheets = typeof client.listSheets === "function" ? await client.listSheets() : [];
  const existing = sheets
    .map((sheet) => sheet.properties || sheet)
    .find((sheet) => (
      [sheet.sheet_id, sheet.sheetId, sheet.id].includes(resolvedSheetId)
      || sheet.title === XHS_HISTORY_SHEET_TITLE
    ));
  if (existing) {
    resolvedSheetId = existing.sheet_id || existing.sheetId || existing.id || resolvedSheetId;
  }
  if (!resolvedSheetId) {
    const created = await client.createSheet(XHS_HISTORY_SHEET_TITLE);
    resolvedSheetId = created?.sheetId || created?.sheet_id || created?.id || "";
    createdSheetId = resolvedSheetId;
  }
  if (!resolvedSheetId) throw new Error("创建或定位小红书历史台账 Sheet 失败。");
  if (client.config?.sheets) client.config.sheets[XHS_HISTORY_SHEET_KEY] = resolvedSheetId;
  await initializeXhsHistorySheet(client);
  return createdSheetId;
}

async function initializeXhsHistorySheet(client) {
  const sheetId = client.sheetId(XHS_HISTORY_SHEET_KEY);
  const columnEnd = columnName(XHS_HISTORY_HEADERS.length);
  await client.writeRows(
    XHS_HISTORY_SHEET_KEY,
    `${sheetId}!A1:${columnEnd}1`,
    [XHS_HISTORY_HEADERS]
  );
  if (typeof client.freezeRows === "function") {
    await client.freezeRows(XHS_HISTORY_SHEET_KEY, 1).catch(() => {});
  }
  if (typeof client.setRangeStyle === "function") {
    await client.setRangeStyle(`${sheetId}!A1:${columnEnd}1`, HEADER_STYLE).catch(() => {});
  }
  if (typeof client.setColumnWidths === "function") {
    await client.setColumnWidths(XHS_HISTORY_SHEET_KEY, XHS_HISTORY_COLUMN_WIDTHS).catch(() => {});
  }
}

function findSeedHeader(rows = []) {
  for (let index = 0; index < rows.length; index += 1) {
    const values = (rows[index] || []).map(cellText);
    if (headerStartsWith(values, XHS_CHANNEL_SEED_HEADERS)) {
      return { index, headers: XHS_CHANNEL_SEED_HEADERS };
    }
    if (headerStartsWith(values, XHS_LEGACY_CHANNEL_SEED_HEADERS)) {
      return { index, headers: XHS_LEGACY_CHANNEL_SEED_HEADERS };
    }
    if (headerStartsWith(values, XHS_CURRENT_SEED_HEADERS)) {
      return { index, headers: XHS_CURRENT_SEED_HEADERS };
    }
    if (headerStartsWith(values, XHS_LEGACY_SEED_HEADERS)) {
      return { index, headers: XHS_LEGACY_SEED_HEADERS };
    }
  }
  return null;
}

function headerStartsWith(values = [], headers = []) {
  return headers.every((header, index) => values[index] === header);
}

function mergeHistoryItem(previous = {}, incoming = {}) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "collectStatus" && isCollectedStatus(previous.collectStatus) && !isCollectedStatus(value)) continue;
    if (["failureReason", "source"].includes(key) && isCollectedStatus(previous.collectStatus) && !isCollectedStatus(incoming.collectStatus)) continue;
    if (!merged[key]) merged[key] = value;
    if (["collectStatus", "collectedAt", "failureReason", "source"].includes(key)) merged[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(incoming, "failureReason") && incoming.failureReason === "") {
    merged.failureReason = "";
  }
  return merged;
}

function historySeedCompleteness({ title = "", tags = "", contentType = "" } = {}) {
  const missing = [];
  if (!title) missing.push("标题缺失");
  if (!tags) missing.push("tag缺失");
  if (!contentType) missing.push("内容类型缺失");
  return {
    complete: missing.length === 0,
    failureReason: missing.join("；")
  };
}

function normalizeHistoryItemStatus(item = {}) {
  const normalized = { ...item };
  if (!isCollectedStatus(normalized.collectStatus)) return normalized;
  const completeness = historySeedCompleteness(normalized);
  if (completeness.complete) return normalized;
  normalized.collectStatus = "待补全";
  normalized.failureReason = completeness.failureReason;
  return normalized;
}

function isCollectedStatus(value) {
  return String(value || "") === "已采集";
}

function historyItemKey(item = {}) {
  return String(item.itemId || extractXhsNoteId(item.itemUrl || "") || item.itemUrl || "").trim();
}

function sheetRowKey(row = []) {
  const itemId = cellText(row[XHS_HISTORY_HEADERS.indexOf("作品ID")]);
  const itemUrl = cellText(row[XHS_HISTORY_HEADERS.indexOf("作品链接")]);
  return itemId || extractXhsNoteId(itemUrl) || itemUrl;
}

function mergeSheetRow(existingRow = [], incomingRow = []) {
  return XHS_HISTORY_HEADERS.map((header, index) => {
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
  return XHS_HISTORY_HEADERS.every((_, index) => cellText(left[index]) === cellText(right[index]));
}

function headerMatches(row = []) {
  return XHS_HISTORY_HEADERS.every((header, index) => cellText(row[index]) === header);
}

function parseSeedDisplayDate(value = "") {
  const text = String(value || "").trim();
  const full = text.match(/^(20\d{2})[-./\s](\d{1,2})[-./\s](\d{1,2})$/);
  if (full) return validDate(full[1], full[2], full[3]);
  const monthDay = text.match(/^(\d{1,2})\s+(\d{1,2})$/);
  if (monthDay) return validDate(new Date().getFullYear(), monthDay[1], monthDay[2]);
  return "";
}

function validDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizeContentTypeReview(value, contentType) {
  const text = String(value || "").trim();
  if (text === "通过" || text === "需审核") return text;
  return contentType ? "通过" : "";
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
