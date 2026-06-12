import fs from "node:fs/promises";
import path from "node:path";

import { classifyTags } from "./tag-rules.mjs";
import { extractDouyinApiDetail } from "./douyin-detail-text.mjs";
import { douyinProfileIdsMatch } from "./douyin-profile-guard.mjs";
import { normalizeDouyinContentLink } from "./link-utils.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";

export const DOUYIN_HISTORY_SHEET_KEY = "douyinHistory";
export const DOUYIN_HISTORY_SHEET_TITLE = "抖音历史台账";
export const DOUYIN_HISTORY_HEADERS = [
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

export const DOUYIN_HISTORY_COLUMN_WIDTHS = [120, 220, 110, 80, 150, 560, 420, 360, 120, 120, 100, 160, 260, 100];

const HEADER_STYLE = {
  backColor: "#DEE0E3",
  font: { bold: true },
  hAlign: 1,
  vAlign: 1
};

export function extractHistoryItemsFromPostResponse(response, {
  accountName = "",
  accountHomeUrl = "",
  collectedAt = ""
} = {}) {
  const list = Array.isArray(response?.aweme_list) ? response.aweme_list : [];
  return list
    .map((item) => historyItemFromAweme(item, { accountName, accountHomeUrl, collectedAt }))
    .filter((item) => item.itemId && item.itemUrl);
}

export function extractPostPageInfo(response = {}) {
  const hasMoreValue = response.has_more ?? response.hasMore;
  const maxCursorValue = response.max_cursor ?? response.maxCursor ?? response.cursor ?? "";
  const expectedValue = response.aweme_count ?? response.awemeCount ?? response.total ?? response.total_count ?? response.totalCount;
  const expectedNumber = Number(expectedValue);
  const itemCount = Array.isArray(response.aweme_list) ? response.aweme_list.length : 0;
  return {
    hasMore: hasMoreValue === true || hasMoreValue === 1 || hasMoreValue === "1",
    maxCursor: maxCursorValue === undefined || maxCursorValue === null ? "" : String(maxCursorValue),
    expected: Number.isFinite(expectedNumber) && expectedNumber > 0 ? expectedNumber : null,
    itemCount
  };
}

export function buildPostApiCursorUrl(baseUrl, { cursor = "", count = null } = {}) {
  const url = new URL(baseUrl, "https://www.douyin.com");
  const cursorValue = String(cursor ?? "").trim();
  if (cursorValue) {
    url.searchParams.set("max_cursor", cursorValue);
    url.searchParams.set("cursor", cursorValue);
  }
  if (count !== null && count !== undefined && count !== "") {
    url.searchParams.set("count", String(Math.max(1, Number(count) || 0)));
  }
  for (const key of ["a_bogus", "A-Bogus", "x_bogus", "X-Bogus"]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

export function cursorPaginationStopReason({
  pageInfo = {},
  pages = 0,
  maxPages = 0,
  emptyPages = 0,
  emptyPagesLimit = 0,
  collected = 0,
  itemLimit = 0
} = {}) {
  if (itemLimit > 0 && collected >= itemLimit) return "item-limit";
  if (maxPages > 0 && pages >= maxPages) return "max-pages";
  if (emptyPagesLimit > 0 && emptyPages >= emptyPagesLimit) return "empty-pages";
  if (pageInfo.hasMore === false) return "has-more-false";
  if (pageInfo.hasMore && !pageInfo.maxCursor) return "missing-cursor";
  return "";
}

export function createHistoryAccountAudit({ account = {}, expected = null } = {}) {
  return {
    accountName: account.name || "",
    accountHomeUrl: account.url || "",
    expected: Number.isFinite(Number(expected)) ? Number(expected) : null,
    collected: 0,
    pages: 0,
    emptyPages: 0,
    hasMoreStopped: false,
    stopReason: "",
    failureReason: "",
    source: "",
    lastCursor: ""
  };
}

export function updateHistoryAccountAudit(audit, {
  source = "",
  pageInfo = {},
  added = 0,
  collected = null,
  stopReason = ""
} = {}) {
  if (!audit) return audit;
  audit.pages += 1;
  if (Number(added) <= 0) audit.emptyPages += 1;
  if (Number.isFinite(Number(pageInfo.expected)) && Number(pageInfo.expected) > 0) {
    audit.expected = Number(pageInfo.expected);
  }
  if (collected !== null && collected !== undefined) {
    audit.collected = Number(collected) || 0;
  }
  if (source) audit.source = appendSource(audit.source, source);
  audit.lastCursor = pageInfo.maxCursor || audit.lastCursor || "";
  if (stopReason) {
    audit.stopReason = stopReason;
    audit.hasMoreStopped = stopReason === "has-more-false";
  }
  return audit;
}

export function historyItemFromAweme(item, { accountName = "", accountHomeUrl = "", collectedAt = "" } = {}) {
  const itemId = String(item?.aweme_id || item?.awemeId || "").trim();
  if (!itemId) return null;
  const apiDetail = extractDouyinApiDetail(item, { itemId });
  const itemType = inferHistoryItemType(item);
  const itemUrl = normalizeDouyinContentLink(`https://www.douyin.com/${itemType === "图文" ? "note" : "video"}/${itemId}`);
  const contentType = classifyTags(apiDetail.tags || "", { platformId: "douyin" });
  const record = {
    accountName,
    actualAuthorName: apiDetail.authorName || "",
    accountHomeUrl,
    authorProfileUrl: apiDetail.authorProfileUrl || "",
    publishedAt: apiDetail.publishedAt ? formatDate(apiDetail.publishedAt) : "",
    itemType,
    itemId,
    itemUrl,
    title: apiDetail.title || "",
    tags: apiDetail.tags || "",
    contentType,
    contentTypeReview: contentType && contentType !== "无" ? "通过" : "需审核",
    collectStatus: apiDetail.title && apiDetail.tags && apiDetail.publishedAt ? "已采集" : "待补全",
    failureReason: "",
    source: "aweme-post"
  };
  if (collectedAt) record.collectedAt = collectedAt;
  return record;
}

export function filterHistoryItemsForAccount(items = [], account = {}, { requireAuthor = true } = {}) {
  const accepted = [];
  const excluded = [];
  for (const item of items || []) {
    const authorProfileUrl = item.authorProfileUrl || "";
    if (!authorProfileUrl) {
      if (requireAuthor) {
        excluded.push(excludedHistoryItem(item, account, "作者主页缺失"));
      } else {
        accepted.push({ ...item, accountName: account.name || item.accountName || "", accountHomeUrl: account.url || item.accountHomeUrl || "" });
      }
      continue;
    }
    if (!douyinProfileIdsMatch(account.url, authorProfileUrl)) {
      excluded.push(excludedHistoryItem(item, account, "作者主页不匹配"));
      continue;
    }
    accepted.push({
      ...item,
      accountName: account.name || item.accountName || "",
      accountHomeUrl: account.url || item.accountHomeUrl || ""
    });
  }
  return { accepted, excluded };
}

export function mergeHistoryLedgerItems(existingItems = [], incomingItems = []) {
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

export async function readHistoryLedger(filePath) {
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

export async function writeHistoryLedger(filePath, items) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = (items || []).map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, content ? `${content}\n` : "", "utf8");
}

export function mapHistoryItemToSheetRow(item = {}) {
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
  return DOUYIN_HISTORY_HEADERS.map((header) => fields[header] || "");
}

export function historyItemsToCsv(items = []) {
  return [
    DOUYIN_HISTORY_HEADERS.map(csvEscape).join(","),
    ...(items || []).map((item) => mapHistoryItemToSheetRow(item).map(csvEscape).join(","))
  ].join("\n");
}

export async function writeHistoryOutputs({ items = [], outputDir = "output", generatedAt = new Date().toISOString() } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `douyin_history_${safeTimestamp}.json`);
  const csvPath = path.join(outputDir, `douyin_history_${safeTimestamp}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt, total: items.length, items }, null, 2), "utf8");
  await fs.writeFile(csvPath, historyItemsToCsv(items), "utf8");
  return { jsonPath, csvPath };
}

export async function writeExcludedHistoryOutputs({ items = [], outputDir = "output", generatedAt = new Date().toISOString() } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `douyin_history_excluded_${safeTimestamp}.json`);
  const csvPath = path.join(outputDir, `douyin_history_excluded_${safeTimestamp}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt, total: items.length, items }, null, 2), "utf8");
  await fs.writeFile(csvPath, excludedHistoryItemsToCsv(items), "utf8");
  return { jsonPath, csvPath };
}

export async function writeHistoryRunAudit({
  audit = [],
  outputDir = "output",
  generatedAt = new Date().toISOString(),
  summary = {}
} = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `douyin_history_run_audit_${safeTimestamp}.json`);
  const csvPath = path.join(outputDir, `douyin_history_run_audit_${safeTimestamp}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt, summary, accounts: audit }, null, 2), "utf8");
  await fs.writeFile(csvPath, historyRunAuditToCsv(audit), "utf8");
  return { jsonPath, csvPath };
}

export async function upsertHistorySheet({
  client,
  sheetId = "",
  items = [],
  batchSize = 100
} = {}) {
  if (!client) throw new Error("缺少飞书 client。");
  const createdSheetId = await ensureHistorySheet(client, sheetId);
  const rows = await client.readSheetRows(DOUYIN_HISTORY_SHEET_KEY, DOUYIN_HISTORY_HEADERS.length);
  const hasHeader = headerMatches(rows[0]);
  const existingRows = hasHeader ? rows.slice(1) : rows;
  const existingByKey = new Map();
  existingRows.forEach((row, index) => {
    const key = sheetRowKey(row);
    if (key) existingByKey.set(key, {
      row,
      rowNumber: (hasHeader ? 2 : 1) + index
    });
  });
  const existingKeys = new Set(existingByKey.keys());
  const rowsToAppend = [];
  let updated = 0;
  for (const item of items || []) {
    const key = historyItemKey(item);
    if (!key) continue;
    if (existingKeys.has(key)) {
      const existing = existingByKey.get(key);
      const mergedRow = mergeSheetRow(existing.row, mapHistoryItemToSheetRow(item));
      if (!sheetRowsEqual(existing.row, mergedRow)) {
        const range = `${client.sheetId(DOUYIN_HISTORY_SHEET_KEY)}!A${existing.rowNumber}:${columnName(DOUYIN_HISTORY_HEADERS.length)}${existing.rowNumber}`;
        await client.writeRows(DOUYIN_HISTORY_SHEET_KEY, range, [mergedRow]);
        updated += 1;
      }
      continue;
    }
    existingKeys.add(key);
    rowsToAppend.push(mapHistoryItemToSheetRow(item));
  }
  for (const batch of chunks(rowsToAppend, batchSize)) {
    await client.appendRowsToSheet(DOUYIN_HISTORY_SHEET_KEY, batch, DOUYIN_HISTORY_HEADERS.length);
  }
  return {
    createdSheetId,
    total: items.length,
    created: rowsToAppend.length,
    updated,
    skipped: items.length - rowsToAppend.length - updated
  };
}

export async function replaceHistorySheet({
  client,
  sheetId = "",
  items = []
} = {}) {
  if (!client) throw new Error("缺少飞书 client。");
  await ensureHistorySheet(client, sheetId);
  const rows = [
    DOUYIN_HISTORY_HEADERS,
    ...(items || []).map((item) => mapHistoryItemToSheetRow(item))
  ];
  if (typeof client.replaceSheetRows !== "function") {
    throw new Error("当前飞书 client 不支持重写 Sheet。");
  }
  await client.replaceSheetRows(DOUYIN_HISTORY_SHEET_KEY, rows, DOUYIN_HISTORY_HEADERS.length);
  await initializeHistorySheet(client);
  return {
    total: items.length,
    created: items.length,
    updated: 0,
    skipped: 0
  };
}

async function ensureHistorySheet(client, sheetId = "") {
  const configuredSheetId = String(sheetId || client.config?.sheets?.[DOUYIN_HISTORY_SHEET_KEY] || "").trim();
  if (client.config?.sheets && configuredSheetId) {
    client.config.sheets[DOUYIN_HISTORY_SHEET_KEY] = configuredSheetId;
  }

  let resolvedSheetId = configuredSheetId;
  let createdSheetId = "";
  const sheets = typeof client.listSheets === "function" ? await client.listSheets() : [];
  const existing = sheets
    .map((sheet) => sheet.properties || sheet)
    .find((sheet) => (
      [sheet.sheet_id, sheet.sheetId, sheet.id].includes(resolvedSheetId)
      || sheet.title === DOUYIN_HISTORY_SHEET_TITLE
    ));
  if (existing) {
    resolvedSheetId = existing.sheet_id || existing.sheetId || existing.id || resolvedSheetId;
  }
  if (!resolvedSheetId) {
    const created = await client.createSheet(DOUYIN_HISTORY_SHEET_TITLE);
    resolvedSheetId = created?.sheetId || created?.sheet_id || created?.id || "";
    createdSheetId = resolvedSheetId;
  }
  if (!resolvedSheetId) throw new Error("创建或定位抖音历史台账 Sheet 失败。");
  if (client.config?.sheets) client.config.sheets[DOUYIN_HISTORY_SHEET_KEY] = resolvedSheetId;
  await initializeHistorySheet(client);
  return createdSheetId;
}

async function initializeHistorySheet(client) {
  const sheetId = client.sheetId(DOUYIN_HISTORY_SHEET_KEY);
  const columnEnd = columnName(DOUYIN_HISTORY_HEADERS.length);
  await client.writeRows(
    DOUYIN_HISTORY_SHEET_KEY,
    `${sheetId}!A1:${columnEnd}1`,
    [DOUYIN_HISTORY_HEADERS]
  );
  if (typeof client.freezeRows === "function") {
    await client.freezeRows(DOUYIN_HISTORY_SHEET_KEY, 1).catch(() => {});
  }
  if (typeof client.setRangeStyle === "function") {
    await client.setRangeStyle(`${sheetId}!A1:${columnEnd}1`, HEADER_STYLE).catch(() => {});
  }
  if (typeof client.setColumnWidths === "function") {
    await client.setColumnWidths(DOUYIN_HISTORY_SHEET_KEY, DOUYIN_HISTORY_COLUMN_WIDTHS).catch(() => {});
  }
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

function excludedHistoryItem(item = {}, account = {}, reason = "") {
  return {
    ...item,
    expectedAccountName: account.name || "",
    expectedAccountHomeUrl: account.url || "",
    exclusionReason: reason,
    source: appendSource(item.source, "excluded")
  };
}

function appendSource(current, next) {
  const values = String(current || "")
    .split(/[+,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (next && !values.includes(next)) values.push(next);
  return values.join("+");
}

function historyItemKey(item = {}) {
  return String(item.itemId || item.itemUrl || "").trim();
}

function sheetRowKey(row = []) {
  const itemId = cellText(row[DOUYIN_HISTORY_HEADERS.indexOf("作品ID")]);
  const itemUrl = cellText(row[DOUYIN_HISTORY_HEADERS.indexOf("作品链接")]);
  return itemId || itemUrl;
}

function mergeSheetRow(existingRow = [], incomingRow = []) {
  return DOUYIN_HISTORY_HEADERS.map((header, index) => {
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
  return DOUYIN_HISTORY_HEADERS.every((_, index) => cellText(left[index]) === cellText(right[index]));
}

function headerMatches(row = []) {
  return DOUYIN_HISTORY_HEADERS.every((header, index) => cellText(row[index]) === header);
}

function inferHistoryItemType(item = {}) {
  const awemeType = Number(item.aweme_type ?? item.awemeType);
  if (awemeType === 68 || Array.isArray(item.images) || Array.isArray(item.image_infos) || item.image_post_info) return "图文";
  return "视频";
}

function formatDate(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(value);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function excludedHistoryItemsToCsv(items = []) {
  const headers = [
    "排除原因",
    "期望账号",
    "期望主页",
    "实际作者",
    "实际作者主页",
    "作品ID",
    "作品链接",
    "标题",
    "tag词",
    "来源"
  ];
  return [
    headers.map(csvEscape).join(","),
    ...(items || []).map((item) => [
      item.exclusionReason || "",
      item.expectedAccountName || "",
      item.expectedAccountHomeUrl || "",
      item.actualAuthorName || item.accountName || "",
      item.authorProfileUrl || "",
      item.itemId || "",
      item.itemUrl || "",
      item.title || "",
      item.tags || "",
      item.source || ""
    ].map(csvEscape).join(","))
  ].join("\n");
}

function historyRunAuditToCsv(items = []) {
  const headers = [
    "账号名称",
    "账号主页",
    "预期数量",
    "采集数量",
    "页数",
    "空页数",
    "正常结束",
    "停止原因",
    "失败原因",
    "来源",
    "最后游标"
  ];
  return [
    headers.map(csvEscape).join(","),
    ...(items || []).map((item) => [
      item.accountName || "",
      item.accountHomeUrl || "",
      item.expected ?? "",
      item.collected ?? "",
      item.pages ?? "",
      item.emptyPages ?? "",
      item.hasMoreStopped ? "是" : "否",
      item.stopReason || "",
      item.failureReason || "",
      item.source || "",
      item.lastCursor || ""
    ].map(csvEscape).join(","))
  ].join("\n");
}

function cellText(value) {
  if (Array.isArray(value)) return value.map((entry) => cellText(entry)).find(Boolean) || "";
  if (value && typeof value === "object") return String(value.text || value.link || value.url || "");
  return String(value || "");
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
