import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  buildXhsExploreUrl,
  canonicalizeContentLink,
  extractBilibiliBv,
  extractDouyinItem,
  extractLinkValue,
  extractXhsNoteId,
  isDouyinShortLink,
  resolveDouyinShortLinkViaRedirect
} from "./link-utils.mjs";
import { extractDouyinTitleFromShareText } from "./douyin-detail-text.mjs";
import { FeishuSheetsClient, loadFeishuConfig, writeDailyPlatformRecords } from "./feishu-sheets.mjs";
import { normalizeAccountLabel, PLATFORM_HEADERS } from "./daily-records.mjs";

const DEFAULT_EXCEL_PATH = "/Users/tjk/Downloads/原生内容投稿 (1).xlsx";
const DEFAULT_PLATFORMS = ["douyin", "xhs", "bilibili"];
const TARGET_YEAR = "2026";

const SHEET_MAPPINGS = [
  {
    sheetName: "抖音渠道",
    platformId: "douyin",
    dateColumn: "B",
    linkColumn: "C",
    accountColumn: "D",
    contentTypeColumn: "E"
  },
  {
    sheetName: "小红书渠道",
    platformId: "xhs",
    dateColumn: "B",
    linkColumn: "C",
    idColumn: "D",
    accountColumn: "E",
    contentTypeColumn: "F"
  },
  {
    sheetName: "B站渠道",
    platformId: "bilibili",
    dateColumn: "B",
    linkColumn: "C",
    idColumn: "D",
    accountColumn: "E",
    titleColumn: "F",
    tagsColumn: "G"
  }
];

export async function runExcelHistoryImport({
  filePath = DEFAULT_EXCEL_PATH,
  platforms = DEFAULT_PLATFORMS,
  apply = false,
  style = false,
  client = new FeishuSheetsClient(loadFeishuConfig()),
  outputDir = path.resolve("output"),
  resolveDouyinShortLink = resolveDouyinShortLinkViaRedirect
} = {}) {
  const selectedPlatforms = normalizePlatforms(platforms);
  const recordsByPlatform = await parseExcelHistoryWorkbook(filePath, { platforms: selectedPlatforms });
  const existingRecordsByPlatform = await readExistingHistoryRecords(client, selectedPlatforms);
  const classification = classifyExcelHistoryRecords({ recordsByPlatform, existingRecordsByPlatform });
  await resolveDouyinSafeRecordLinks(classification, resolveDouyinShortLink, existingRecordsByPlatform.douyin || []);

  let writeResult = null;
  if (apply) {
    const writer = style ? client : dataOnlyClient(client);
    writeResult = await writeSafeRecords({ classification, client: writer, platforms: selectedPlatforms });
  }

  const report = buildReport({
    filePath,
    mode: apply ? "apply" : "dry-run",
    style,
    classification,
    writeResult
  });
  const reportPath = await writeReport(report, outputDir);

  return {
    reportPath,
    report
  };
}

export async function resolveDouyinSafeRecordLinks(classification, resolveDouyinShortLink = resolveDouyinShortLinkViaRedirect, existingRecords = []) {
  const platform = classification?.platforms?.douyin;
  if (!platform?.safeRecords?.length) return classification;

  const existingByKey = groupBy(existingRecords.filter((record) => record.key), (record) => record.key);
  const existingMaterialDates = new Set(existingRecords.map((record) => record.date).filter(Boolean));
  const existingDouyinTitleAccountKeys = new Set(
    existingRecords
      .filter((record) => record.date && record.titleKey)
      .map((record) => douyinTitleAccountKey(record))
  );
  const resolvedRecords = [];
  for (const record of platform.safeRecords) {
    const currentLink = String(record.link || "").trim();
    let candidate = record;
    const resolvedLink = await resolveDouyinShortLink(currentLink);
    if (resolvedLink && extractDouyinItem(resolvedLink)) {
      candidate = {
        ...record,
        link: resolvedLink,
        key: resolvedLink,
        resolvedFrom: currentLink
      };
    } else if (isDouyinShortLink(currentLink)) {
      platform.needsReview.push(withReason(record, "unresolved_douyin_short_link"));
      continue;
    }

    const existingMatches = existingByKey.get(candidate.key) || [];
    if (existingMatches.length > 0) {
      const existingDates = uniqueSorted(existingMatches.map((existing) => existing.date).filter(Boolean));
      if (existingDates.includes(candidate.date)) {
        platform.skippedExisting.push({
          ...candidate,
          existingRows: existingMatches,
          existingDates,
          reason: "same_key_same_date"
        });
      } else {
        platform.dateConflicts.push({
          ...candidate,
          existingRows: existingMatches,
          existingDates,
          reason: "same_key_different_date"
        });
      }
      continue;
    }

    if (existingMaterialDates.has(candidate.date)
      && candidate.titleKey
      && existingDouyinTitleAccountKeys.has(douyinTitleAccountKey(candidate))) {
      platform.skippedExisting.push({
        ...candidate,
        existingRows: existingRecords.filter((existing) => douyinTitleAccountKey(existing) === douyinTitleAccountKey(candidate)),
        existingDates: [candidate.date],
        reason: "same_date_same_title_account"
      });
      continue;
    }

    resolvedRecords.push(candidate);
  }

  platform.safeRecords = resolvedRecords;
  return classification;
}

export async function parseExcelHistoryWorkbook(filePath, { platforms = DEFAULT_PLATFORMS } = {}) {
  const selected = new Set(normalizePlatforms(platforms));
  const archive = new XlsxArchive(await fs.readFile(filePath));
  const sharedStrings = parseSharedStrings(archive.text("xl/sharedStrings.xml", ""));
  const workbookSheets = parseWorkbookSheets(archive.text("xl/workbook.xml"));
  const workbookRelationships = parseRelationships(archive.text("xl/_rels/workbook.xml.rels"));
  const recordsByPlatform = Object.fromEntries(DEFAULT_PLATFORMS.map((platformId) => [platformId, []]));

  for (const mapping of SHEET_MAPPINGS) {
    if (!selected.has(mapping.platformId)) continue;
    const sheet = workbookSheets.find((candidate) => candidate.name === mapping.sheetName);
    if (!sheet) continue;
    const target = resolveWorkbookTarget(workbookRelationships.get(sheet.relationshipId));
    if (!target) continue;

    const sheetRelationships = parseRelationships(
      archive.text(`${path.posix.dirname(target)}/_rels/${path.posix.basename(target)}.rels`, "")
    );
    const parsedRows = parseWorksheetRows(archive.text(target), sharedStrings, sheetRelationships);
    for (const row of parsedRows) {
      const record = rowToHistoryRecord(row, mapping);
      if (record) recordsByPlatform[mapping.platformId].push(record);
    }
  }

  return recordsByPlatform;
}

export function classifyExcelHistoryRecords({
  recordsByPlatform = {},
  existingRecordsByPlatform = {},
  targetYear = TARGET_YEAR
} = {}) {
  const platforms = {};
  for (const platformId of DEFAULT_PLATFORMS) {
    const sourceRecords = recordsByPlatform[platformId] || [];
    const existingRecords = existingRecordsByPlatform[platformId] || [];
    platforms[platformId] = classifyPlatformRecords(platformId, sourceRecords, existingRecords, targetYear);
  }
  return { platforms };
}

export function historyRecordToPlatformItem(record) {
  const platformId = record.platformId;
  if (platformId === "xhs") {
    const noteId = record.id || extractXhsNoteId(record.link) || record.key;
    return {
      link: record.link || buildXhsExploreUrl(noteId),
      id: noteId,
      noteId,
      accountName: record.accountName,
      contentType: record.contentType,
      contentTypeReview: record.contentType ? "通过" : "",
      tags: record.tags || "",
      publishedAt: record.date
    };
  }

  if (platformId === "bilibili") {
    const bvid = record.id || extractBilibiliBv(record.link) || record.key;
    return {
      link: bvid ? `https://www.bilibili.com/video/${bvid}/` : record.link,
      id: bvid,
      bvid,
      accountName: record.accountName || "投资号",
      title: record.title || "",
      tags: record.tags || "",
      publishedAt: record.date
    };
  }

  return {
    link: record.link,
    accountName: record.accountName,
    contentType: record.contentType,
    contentTypeReview: record.contentType ? "通过" : "",
    title: record.title || "",
    tags: record.tags || "",
    publishedAt: record.date
  };
}

export async function readExistingHistoryRecords(client, platforms = DEFAULT_PLATFORMS) {
  const recordsByPlatform = {};
  for (const platformId of normalizePlatforms(platforms)) {
    const rows = await client.readRows(platformId);
    const dataStartRow = typeof client.dataStartRow === "function" ? client.dataStartRow(platformId) : 2;
    recordsByPlatform[platformId] = rows
      .map((row, index) => existingRowToRecord(platformId, row, index + dataStartRow))
      .filter(Boolean);
  }
  return recordsByPlatform;
}

async function writeSafeRecords({ classification, client, platforms }) {
  const result = {
    platforms: {},
    warnings: []
  };

  for (const platformId of normalizePlatforms(platforms)) {
    const safeRecords = classification.platforms[platformId]?.safeRecords || [];
    const recordsByDate = groupBy(safeRecords, (record) => record.date);
    const platformResult = {
      submittedMaterials: safeRecords.length,
      feishuCreated: 0,
      feishuSkipped: 0,
      byDate: []
    };

    if (typeof client.configurePlatformDropdowns === "function") {
      try {
        await client.configurePlatformDropdowns(platformId);
      } catch (error) {
        result.warnings.push(`${platformId} 下拉选项配置失败，继续写入：${error.message || String(error)}`);
      }
    }

    for (const date of [...recordsByDate.keys()].sort()) {
      const items = recordsByDate.get(date).map(historyRecordToPlatformItem);
      const writeResult = await writeDailyPlatformRecords({
        platformId,
        targetDate: date,
        items,
        client
      });
      platformResult.feishuCreated += writeResult.created;
      platformResult.feishuSkipped += writeResult.skipped;
      platformResult.byDate.push({
        date,
        submittedMaterials: items.length,
        ...writeResult
      });
    }

    if (safeRecords.length > 0 && typeof client.configurePlatformDropdowns === "function") {
      try {
        await client.configurePlatformDropdowns(platformId);
      } catch (error) {
        result.warnings.push(`${platformId} 写入后下拉选项配置失败：${error.message || String(error)}`);
      }
    }

    result.platforms[platformId] = platformResult;
  }

  return result;
}

function classifyPlatformRecords(platformId, sourceRecords, existingRecords, targetYear) {
  const existingByKey = groupBy(existingRecords.filter((record) => record.key), (record) => record.key);
  const existingMaterialDates = new Set(existingRecords.map((record) => record.date).filter(Boolean));
  const existingDouyinTitleAccountKeys = new Set(
    platformId === "douyin"
      ? existingRecords
        .filter((record) => record.date && record.titleKey)
        .map((record) => douyinTitleAccountKey(record))
      : []
  );
  const bucketsByKey = new Map();
  const invalid = [];
  const outOfScope = [];

  for (const record of sourceRecords) {
    if (!record.date || !record.key) {
      invalid.push(withReason(record, !record.key ? "missing_key" : "missing_date"));
      continue;
    }
    if (!record.date.startsWith(`${targetYear}-`)) {
      outOfScope.push(withReason(record, "out_of_scope_year"));
      continue;
    }
    const bucket = bucketsByKey.get(record.key) || [];
    bucket.push(record);
    bucketsByKey.set(record.key, bucket);
  }

  const safeRecords = [];
  const skippedExisting = [];
  const dateConflicts = [];
  const excelAmbiguous = [];
  const excelDuplicateRows = [];
  const needsReview = [];

  for (const [key, bucket] of bucketsByKey) {
    const dates = uniqueSorted(bucket.map((record) => record.date));
    const sortedBucket = bucket.sort((left, right) => (
      left.date.localeCompare(right.date)
      || left.rowNumber - right.rowNumber
    ));
    const [candidate, ...duplicates] = sortedBucket;
    const duplicateReason = dates.length > 1
      ? "excel_duplicate_key_later_date"
      : "excel_duplicate_key_same_date";
    excelDuplicateRows.push(...duplicates.map((record) => withReason(record, duplicateReason)));

    const existingMatches = existingByKey.get(key) || [];
    if (existingMatches.length > 0) {
      const existingDates = uniqueSorted(existingMatches.map((record) => record.date).filter(Boolean));
      if (existingDates.includes(candidate.date)) {
        skippedExisting.push({
          ...candidate,
          existingRows: existingMatches,
          existingDates,
          reason: "same_key_same_date"
        });
      } else {
        dateConflicts.push({
          ...candidate,
          existingRows: existingMatches,
          existingDates,
          reason: "same_key_different_date"
        });
      }
      continue;
    }

    if (platformId === "douyin" && existingMaterialDates.has(candidate.date)) {
      if (candidate.titleKey && existingDouyinTitleAccountKeys.has(douyinTitleAccountKey(candidate))) {
        skippedExisting.push({
          ...candidate,
          existingRows: existingRecords.filter((record) => douyinTitleAccountKey(record) === douyinTitleAccountKey(candidate)),
          existingDates: [candidate.date],
          reason: "same_date_same_title_account"
        });
        continue;
      }
    }

    safeRecords.push(candidate);
  }

  return {
    sourceRows: sourceRecords.length,
    validRows: sourceRecords.length - invalid.length - outOfScope.length,
    uniqueKeys: bucketsByKey.size,
    safeRecords,
    skippedExisting,
    dateConflicts,
    excelAmbiguous,
    excelDuplicateRows,
    outOfScope,
    invalid,
    needsReview
  };
}

function douyinTitleAccountKey(record) {
  return [
    record.date || "",
    record.titleKey || "",
    normalizeAccountLabel("douyin", record.accountName || "")
  ].join("\t");
}

function rowToHistoryRecord(row, mapping) {
  if (isHeaderOrInstructionRow(row)) return null;

  const rawDate = cellValue(row.cells, mapping.dateColumn);
  const rawText = cellValue(row.cells, mapping.linkColumn);
  const link = normalizeHttpLink(hyperlinkValue(row.links, mapping.linkColumn), rawText);
  const date = parseExcelHistoryDate(rawDate);
  const id = mapping.idColumn ? cellValue(row.cells, mapping.idColumn) : "";
  const accountName = mapping.accountColumn ? cellValue(row.cells, mapping.accountColumn) : "";
  const contentType = mapping.contentTypeColumn ? cellValue(row.cells, mapping.contentTypeColumn) : "";
  const explicitTitle = mapping.titleColumn ? cellValue(row.cells, mapping.titleColumn) : "";
  const explicitTags = mapping.tagsColumn ? cellValue(row.cells, mapping.tagsColumn) : "";
  const key = materialKeyFromExcelRecord(mapping.platformId, { link, id });

  if (isLikelySectionRow(row, rawDate, rawText, link, key)) return null;
  if (!date && !key && !rawText) return null;

  const title = explicitTitle || (mapping.platformId === "douyin" ? extractDouyinTitle(rawText) : "");
  return {
    platformId: mapping.platformId,
    sheetName: mapping.sheetName,
    rowNumber: row.rowNumber,
    date,
    rawDate,
    link: linkForPlatform(mapping.platformId, link, id),
    id: idForPlatform(mapping.platformId, link, id),
    key,
    accountName,
    contentType,
    title,
    titleKey: normalizeTitleKey(title || rawText),
    tags: explicitTags || extractTags(rawText),
    rawText
  };
}

function existingRowToRecord(platformId, row, rowNumber) {
  if (!Array.isArray(row) || !row.some((value) => cellText(value).trim())) return null;
  const fields = Object.fromEntries(PLATFORM_HEADERS[platformId].map((header, index) => [header, row[index]]));
  const date = parseFeishuDisplayDate(fields["投稿时间"]);
  if (!date) return null;
  const link = canonicalizeContentLink(platformId, extractLinkValue(fields["内容链接"]));
  const id = cellText(fields["笔记ID"] || fields["短链id"] || "");
  const key = materialKeyFromExistingRecord(platformId, { link, id });
  if (!key) return null;
  return {
    platformId,
    rowNumber,
    date,
    link,
    id,
    key,
    accountName: cellText(fields["账号"] || ""),
    contentType: cellText(fields["内容类型"] || ""),
    titleKey: normalizeTitleKey(cellText(fields["标题"] || ""))
  };
}

function parseExcelHistoryDate(value) {
  const text = String(value || "")
    .trim()
    .replace(/[年月日/.-]/g, " ")
    .replace(/\s+/g, " ");
  if (!text || /投稿时间/.test(text) || /投稿视频/.test(text)) return "";

  const fullDate = text.match(/^(20\d{2})\s+(\d{1,2})\s+(\d{1,2})$/);
  if (fullDate) return validDate(fullDate[1], fullDate[2], fullDate[3]);

  const shortYear = text.match(/^(\d{2})\s+(\d{4})$/);
  if (shortYear) return validDate(`20${shortYear[1]}`, shortYear[2].slice(0, 2), shortYear[2].slice(2));

  const monthDay = text.match(/^(\d{1,2})\s+(\d{1,2})$/);
  if (monthDay) return validDate(TARGET_YEAR, monthDay[1], monthDay[2]);

  const compactMonthDay = text.match(/^(\d{4})$/);
  if (compactMonthDay) return validDate(TARGET_YEAR, text.slice(0, 2), text.slice(2));

  return "";
}

function parseFeishuDisplayDate(value) {
  const text = cellText(value).trim();
  if (/^\d{4}\s+投稿视频$/.test(text)) return "";
  const fullDate = text.match(/^(20\d{2})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (fullDate) return validDate(fullDate[1], fullDate[2], fullDate[3]);
  const match = text.match(/^(\d{1,2})\s+(\d{1,2})$/);
  if (!match) return "";
  return validDate(TARGET_YEAR, match[1], match[2]);
}

function validDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function materialKeyFromExcelRecord(platformId, { link, id }) {
  if (platformId === "xhs") return id || extractXhsNoteId(link) || "";
  if (platformId === "bilibili") return extractBilibiliBv(id || link) || id || "";
  return link || "";
}

function materialKeyFromExistingRecord(platformId, { link, id }) {
  if (platformId === "xhs") return id || extractXhsNoteId(link) || link || "";
  if (platformId === "bilibili") return id || extractBilibiliBv(link) || link || "";
  return link || "";
}

function linkForPlatform(platformId, link, id) {
  if (platformId === "bilibili") {
    const bvid = extractBilibiliBv(id || link) || id;
    return bvid ? `https://www.bilibili.com/video/${bvid}/` : link;
  }
  if (platformId === "xhs" && !link) {
    const noteId = id || extractXhsNoteId(link);
    return noteId ? buildXhsExploreUrl(noteId) : "";
  }
  return link;
}

function idForPlatform(platformId, link, id) {
  if (platformId === "xhs") return id || extractXhsNoteId(link);
  if (platformId === "bilibili") return extractBilibiliBv(id || link) || id;
  return id || "";
}

function isHeaderOrInstructionRow(row) {
  const first = cellValue(row.cells, "A");
  const second = cellValue(row.cells, "B");
  return first === "编号"
    || second === "投稿时间"
    || first.startsWith("2026目标")
    || first === "投稿规则";
}

function isLikelySectionRow(row, rawDate, rawText, link, key) {
  return Boolean(rawDate)
    && !cellValue(row.cells, "A")
    && !link
    && !key
    && (!rawText || !/^https?:\/\//i.test(rawText));
}

function normalizeHttpLink(hyperlink, rawText) {
  const link = String(hyperlink || "").trim();
  if (/^https?:\/\//i.test(link)) return link;
  const textLink = firstHttpUrl(rawText);
  return textLink || (/^https?:\/\//i.test(String(rawText || "")) ? String(rawText).trim() : "");
}

function firstHttpUrl(value) {
  const match = String(value || "").match(/https?:\/\/[^\s，。,;；]+/);
  return match?.[0] || "";
}

function extractDouyinTitle(value) {
  return extractDouyinTitleFromShareText(value);
}

function extractTags(value) {
  const tags = [];
  const text = String(value || "");
  const pattern = /#\s*([^#\s]+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    tags.push(`#${match[1]}`);
  }
  return [...new Set(tags)].join(" ");
}

function normalizeTitleKey(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+.*$/s, "")
    .replace(/#[^#]+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 80);
}

function dataOnlyClient(client) {
  const writer = Object.create(client);
  writer.configurePlatformDropdowns = async () => {};
  writer.highlightSeparatorRows = async () => {};
  writer.clearMaterialRowHighlights = async () => {};
  return writer;
}

function buildReport({ filePath, mode, style, classification, writeResult }) {
  const platforms = {};
  for (const [platformId, result] of Object.entries(classification.platforms)) {
    platforms[platformId] = {
      sourceRows: result.sourceRows,
      validRows: result.validRows,
      uniqueKeys: result.uniqueKeys,
      safeToWrite: result.safeRecords.length,
      skippedExisting: result.skippedExisting.length,
      dateConflicts: result.dateConflicts.length,
      excelAmbiguous: result.excelAmbiguous.length,
      excelDuplicateRows: result.excelDuplicateRows.length,
      needsReview: result.needsReview.length,
      outOfScope: result.outOfScope.length,
      invalid: result.invalid.length,
      safeByDate: countBy(result.safeRecords, (record) => record.date),
      skippedByDate: countBy(result.skippedExisting, (record) => record.date),
      conflictByDate: countBy(result.dateConflicts, (record) => record.date),
      needsReviewByDate: countBy(result.needsReview, (record) => record.date),
      samples: {
        safeRecords: sampleRecords(result.safeRecords),
        skippedExisting: sampleRecords(result.skippedExisting),
        dateConflicts: sampleRecords(result.dateConflicts),
        excelAmbiguous: result.excelAmbiguous.slice(0, 10),
        excelDuplicateRows: sampleRecords(result.excelDuplicateRows),
        needsReview: sampleRecords(result.needsReview),
        outOfScope: sampleRecords(result.outOfScope),
        invalid: sampleRecords(result.invalid)
      }
    };
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    mode,
    style: style ? "with-style" : "data-only",
    filePath,
    platforms,
    writeResult
  };
}

async function writeReport(report, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const safeTimestamp = report.generatedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(outputDir, `excel_history_import_${safeTimestamp}_${report.mode}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

function sampleRecords(records, limit = 10) {
  return records.slice(0, limit).map((record) => ({
    sheetName: record.sheetName,
    rowNumber: record.rowNumber,
    date: record.date,
    key: record.key,
    link: record.link,
    id: record.id,
    accountName: record.accountName,
    contentType: record.contentType,
    reason: record.reason,
    existingDates: record.existingDates,
    existingRows: record.existingRows?.map((existing) => ({
      rowNumber: existing.rowNumber,
      date: existing.date,
      key: existing.key
    }))
  }));
}

function countBy(records, keyFn) {
  return Object.fromEntries(
    [...groupBy(records, keyFn).entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, values]) => [key, values.length])
  );
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values || []) {
    const key = keyFn(value);
    const group = groups.get(key) || [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function withReason(record, reason) {
  return { ...record, reason };
}

function normalizePlatforms(platforms) {
  if (typeof platforms === "string") {
    platforms = platforms.split(",");
  }
  const selected = (platforms || DEFAULT_PLATFORMS)
    .map((platform) => String(platform || "").trim())
    .filter(Boolean);
  const unsupported = selected.filter((platform) => !DEFAULT_PLATFORMS.includes(platform));
  if (unsupported.length > 0) {
    throw new Error(`不支持的平台：${unsupported.join(", ")}`);
  }
  return selected.length ? selected : DEFAULT_PLATFORMS;
}

function cellValue(cells, column) {
  return String(cells.get(column) || "").trim();
}

function hyperlinkValue(links, column) {
  return String(links.get(column) || "").trim();
}

function cellText(value) {
  if (Array.isArray(value)) return value.map((entry) => cellText(entry)).find(Boolean) || "";
  if (value && typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((entry) => cellText(entry)).filter(Boolean).join("、");
    return String(value.text || value.link || value.url || "");
  }
  return String(value || "");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textFromXml(match[1]));
}

function parseWorkbookSheets(xml) {
  return [...xml.matchAll(/<sheet\b([^>]*)\/?>/g)].map((match) => {
    const attrs = parseAttributes(match[1]);
    return {
      name: attrs.name || "",
      relationshipId: attrs["r:id"] || attrs.id || ""
    };
  });
}

function parseRelationships(xml) {
  const relationships = new Map();
  if (!xml) return relationships;
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.Id) relationships.set(attrs.Id, attrs.Target || "");
  }
  return relationships;
}

function parseWorksheetRows(xml, sharedStrings, relationships) {
  const hyperlinkTargets = parseHyperlinks(xml, relationships);
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const attrs = parseAttributes(rowMatch[1]);
    const rowNumber = Number(attrs.r || rows.length + 1);
    const cells = new Map();
    const links = new Map();
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttrs = parseAttributes(cellMatch[1]);
      const ref = cellAttrs.r || "";
      const column = columnFromCellRef(ref);
      if (!column) continue;
      const value = parseCellValue(cellMatch[2] || "", cellAttrs, sharedStrings);
      if (value) cells.set(column, value);
      const link = hyperlinkTargets.get(ref);
      if (link) links.set(column, link);
    }
    if (cells.size || links.size) {
      rows.push({ rowNumber, cells, links });
    }
  }
  return rows;
}

function parseHyperlinks(xml, relationships) {
  const links = new Map();
  for (const match of xml.matchAll(/<hyperlink\b([^>]*)\/?>/g)) {
    const attrs = parseAttributes(match[1]);
    const ref = attrs.ref || "";
    const relationshipId = attrs["r:id"] || "";
    const target = relationships.get(relationshipId);
    if (ref && target && /^[A-Z]+\d+$/.test(ref)) links.set(ref, target);
  }
  return links;
}

function parseCellValue(xml, attrs, sharedStrings) {
  if (attrs.t === "s") {
    const index = Number(firstTagText(xml, "v"));
    return Number.isInteger(index) ? sharedStrings[index] || "" : "";
  }
  if (attrs.t === "inlineStr") return textFromXml(xml);
  return firstTagText(xml, "v");
}

function firstTagText(xml, tagName) {
  const match = String(xml || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? decodeXml(match[1]) : "";
}

function textFromXml(xml) {
  return [...String(xml || "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function parseAttributes(input) {
  const attrs = {};
  for (const match of String(input || "").matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function columnFromCellRef(ref) {
  return String(ref || "").replace(/\d+/g, "");
}

function resolveWorkbookTarget(target) {
  const text = String(target || "").replace(/^\/+/, "");
  if (!text) return "";
  return text.startsWith("xl/") ? text : `xl/${text}`;
}

class XlsxArchive {
  constructor(buffer) {
    this.buffer = buffer;
    this.entries = readZipEntries(buffer);
  }

  text(name, fallback = null) {
    const entry = this.entries.get(name);
    if (!entry) {
      if (fallback !== null) return fallback;
      throw new Error(`Excel 文件缺少条目：${name}`);
    }
    return entryData(this.buffer, entry).toString("utf8");
  }
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Excel ZIP 中央目录格式异常。");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    entries.set(name, {
      name,
      method,
      compressedSize,
      localHeaderOffset
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Excel ZIP 文件缺少结束目录记录。");
}

function entryData(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Excel ZIP 本地头异常：${entry.name}`);
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的 Excel ZIP 压缩方式：${entry.method}`);
}

function parseArgs(argv) {
  const options = {
    filePath: DEFAULT_EXCEL_PATH,
    platforms: DEFAULT_PLATFORMS,
    apply: false,
    outputDir: path.resolve("output")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--with-style") {
      options.style = true;
    } else if (arg === "--data-only") {
      options.style = false;
    } else if (arg === "--file") {
      options.filePath = argv[++index];
    } else if (arg.startsWith("--file=")) {
      options.filePath = arg.slice("--file=".length);
    } else if (arg === "--platform" || arg === "--platforms") {
      options.platforms = argv[++index];
    } else if (arg.startsWith("--platform=")) {
      options.platforms = arg.slice("--platform=".length);
    } else if (arg.startsWith("--platforms=")) {
      options.platforms = arg.slice("--platforms=".length);
    } else if (arg === "--output-dir") {
      options.outputDir = path.resolve(argv[++index]);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = path.resolve(arg.slice("--output-dir=".length));
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`用法：node src/excel-history-importer.mjs [--dry-run|--apply] [--file <xlsx>] [--platform douyin,xhs,bilibili] [--with-style|--data-only]\n\n默认只 dry-run，不写飞书；apply 默认 data-only，避免历史补录触发飞书样式限流。`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const { reportPath, report } = await runExcelHistoryImport(options);
  console.log(JSON.stringify({
    ok: true,
    mode: report.mode,
    reportPath,
    platforms: report.platforms,
    writeResult: report.writeResult
  }, null, 2));
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
