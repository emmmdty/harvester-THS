import fs from "node:fs/promises";
import path from "node:path";

import "dotenv/config";
import { dateFromBilibiliEpoch } from "./bilibili-published-date.mjs";
import { extractBilibiliTags } from "./bilibili-detail-text.mjs";
import { publishedDateFromDouyinItemId, publishedDateFromXhsNoteId } from "./content-identity.mjs";
import { buildFeishuUrlCell, extractFeishuCellLink, normalizeAccountLabel, PLATFORM_HEADERS } from "./daily-records.mjs";
import { formatDisplayDate } from "./date-utils.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { organizePlatformRows, rowRangesFromMaterialRows, rowsToRewrite } from "./feishu-date-organizer.mjs";
import {
  buildXhsExploreUrl,
  canonicalizeContentLink,
  extractBilibiliBv,
  extractDouyinItem,
  extractDouyinItemId,
  extractXhsNoteId,
  normalizeBilibiliVideoUrl,
  normalizeDouyinContentLink,
  normalizeXhsContentLink,
  resolveDouyinShortLinkViaRedirect
} from "./link-utils.mjs";
import { isLowConfidenceDouyinTags } from "./douyin-detail-text.mjs";

const PLATFORM_IDS = ["douyin", "xhs", "bilibili"];

export async function repairExistingFeishuContent({
  root = process.cwd(),
  platforms = PLATFORM_IDS,
  apply = false,
  client = null,
  env = process.env,
  log = console.log,
  resolveDouyinShortLink = resolveDouyinShortLinkViaRedirect,
  fetchBilibiliMetadata = fetchBilibiliMetadataFromApi,
  organizeDates = true
} = {}) {
  const config = loadFeishuConfig(env);
  if (env.FEISHU_SHEET_STEP15_FILTERED) {
    config.sheets.step15 = String(env.FEISHU_SHEET_STEP15_FILTERED).trim();
  }
  const writer = client || new FeishuSheetsClient(config);
  const metadataStore = await buildLocalMetadataStore({ root });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(root, "output", "feishu-content-repair", timestamp);
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
    await fs.writeFile(path.join(backupDir, `${platformId}.before.json`), JSON.stringify(rows, null, 2), "utf8");

    const result = await repairPlatformRows({
      platformId,
      rows,
      dataStartRow,
      metadataStore,
      resolveDouyinShortLink,
      fetchBilibiliMetadata,
      organizeDates
    });

    summary.platforms[platformId] = {
      dataStartRow,
      rowsBefore: rows.length,
      rowsAfter: result.rows.length,
      changes: result.changes,
      moves: result.moves,
      dateBlocks: result.dateBlocks,
      unresolved: result.unresolved
    };
    await fs.writeFile(path.join(backupDir, `${platformId}.after.json`), JSON.stringify(result.rows, null, 2), "utf8");

    log(`${platformId} 修复预览：日期移动 ${result.moves.length} 条，URL ${result.changes.url} 条，标题 ${result.changes.title} 条，tag ${result.changes.tags} 条，未解析 ${result.unresolved.length} 条`);
    if (!apply) continue;

    const columnCount = PLATFORM_HEADERS[platformId].length;
    if (organizeDates) {
      const rewriteRows = rowsToRewrite({ existingRows: rows, organizedRows: result.rows, columnCount });
      if (rewriteRows.length > 0) {
        const sheetId = writer.sheetId(platformId);
        const range = `${sheetId}!A${dataStartRow}:${columnName(columnCount)}${dataStartRow + rewriteRows.length - 1}`;
        await writer.writeRows(platformId, range, rewriteRows);
      }
    } else {
      const sheetId = writer.sheetId(platformId);
      for (const patch of changedRowPatches({ existingRows: rows, repairedRows: result.rows, columnCount, dataStartRow })) {
        await writer.writeRows(platformId, `${sheetId}!A${patch.startRow}:${columnName(columnCount)}${patch.endRow}`, patch.rows);
      }
    }
    if (organizeDates && typeof writer.clearMaterialRowHighlights === "function") {
      await writer.clearMaterialRowHighlights(platformId, rowRangesFromMaterialRows(result.rows, dataStartRow));
    }
    if (organizeDates && typeof writer.highlightSeparatorRows === "function") {
      await writer.highlightSeparatorRows(platformId, result.separatorRowNumbers);
    }
    if (typeof writer.configurePlatformDropdowns === "function") {
      await writer.configurePlatformDropdowns(platformId);
    }
  }

  summary.ok = true;
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(backupDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

export async function repairPlatformRows({
  platformId,
  rows,
  dataStartRow = 2,
  metadataStore = emptyMetadataStore(),
  resolveDouyinShortLink = async () => "",
  fetchBilibiliMetadata = async () => null,
  organizeDates = true
} = {}) {
  const headers = PLATFORM_HEADERS[platformId];
  if (!headers) throw new Error(`不支持的平台：${platformId}`);

  const normalizedRows = [];
  const changes = { date: 0, url: 0, title: 0, tags: 0 };
  const unresolved = [];

  for (let index = 0; index < (rows || []).length; index += 1) {
    const row = normalizeRowWidth(rows[index], headers.length);
    if (!rowHasValue(row) || isSeparatorRow(platformId, row)) {
      normalizedRows.push(row);
      continue;
    }

    const rowNumber = index + dataStartRow;
    const fields = rowFields(headers, row);
    const repair = await resolveRowRepair({
      platformId,
      fields,
      metadataStore,
      resolveDouyinShortLink,
      fetchBilibiliMetadata
    });
    const nextRow = [...row];

    applyUrlChange({ platformId, fields, row: nextRow, url: repair.link, changes });
    applyTitleAndTagsChange({ platformId, fields, row: nextRow, title: repair.title, tags: repair.tags, changes });

    if (repair.unresolved.length > 0) {
      unresolved.push({ rowNumber, id: repair.id, issues: repair.unresolved });
    }
    normalizedRows.push(nextRow);
  }

  const organized = organizeDates
    ? organizePlatformRows({
      platformId,
      rows: normalizedRows,
      dataStartRow,
      resolvePublishedAt: ({ fields }) => resolvePublishedAtForFields(platformId, fields, metadataStore)
    })
    : {
      rows: normalizedRows,
      moves: [],
      dateBlocks: [],
      separatorRowNumbers: []
    };
  changes.date = organized.moves.length;

  return {
    rows: organized.rows,
    moves: organized.moves,
    dateBlocks: organized.dateBlocks,
    separatorRowNumbers: organized.separatorRowNumbers,
    changes,
    unresolved
  };
}

export async function buildLocalMetadataStore({ root = process.cwd() } = {}) {
  const store = emptyMetadataStore();
  await readOutputJsonMetadata(root, store);
  await readDetailCacheMetadata(root, store);
  await readRepairSnapshotMetadata(root, store);
  rebuildFingerprintIndex(store);
  return store;
}

function emptyMetadataStore() {
  return {
    douyinById: new Map(),
    douyinByLink: new Map(),
    douyinByFingerprint: new Map(),
    xhsById: new Map(),
    xhsByLink: new Map(),
    bilibiliById: new Map(),
    bilibiliByLink: new Map()
  };
}

async function resolveRowRepair({
  platformId,
  fields,
  metadataStore,
  resolveDouyinShortLink,
  fetchBilibiliMetadata
}) {
  if (platformId === "xhs") {
    return resolveXhsRowRepair(fields, metadataStore);
  }
  if (platformId === "douyin") {
    return await resolveDouyinRowRepair(fields, metadataStore, resolveDouyinShortLink);
  }
  return await resolveBilibiliRowRepair(fields, metadataStore, fetchBilibiliMetadata);
}

function resolveXhsRowRepair(fields, metadataStore) {
  const currentLink = extractFeishuCellLink(fields["内容链接"]);
  const id = cellText(fields["笔记ID"]).trim() || extractXhsNoteId(currentLink);
  const metadata = metadataStore.xhsById.get(id) || metadataStore.xhsByLink.get(canonicalizeContentLink("xhs", currentLink)) || {};
  const link = normalizeXhsLinkForRepair(currentLink, id, metadata.link);
  const tags = shouldRepairTags("xhs", fields["tag词"]) ? metadata.tags || "" : "";
  const unresolved = [];
  if (!id) unresolved.push("missing-id");
  if (shouldRepairTags("xhs", fields["tag词"]) && !tags) unresolved.push("missing-tags");
  return {
    id,
    publishedAt: publishedDateFromXhsNoteId(id),
    link,
    tags,
    title: "",
    unresolved
  };
}

async function resolveDouyinRowRepair(fields, metadataStore, resolveDouyinShortLink) {
  const currentLink = extractFeishuCellLink(fields["内容链接"]);
  let item = extractDouyinItem(currentLink);
  let link = item ? normalizeDouyinContentLink(currentLink) : "";
  let metadata = item ? metadataStore.douyinById.get(item.id) : null;
  if (!metadata && item) metadata = metadataStore.douyinByLink.get(link);
  if (!metadata && !item) {
    metadata = metadataStore.douyinByFingerprint.get(rowFingerprint("douyin", fields)) || null;
    if (metadata?.link) {
      item = extractDouyinItem(metadata.link);
      link = normalizeDouyinContentLink(metadata.link);
    }
  }
  if (!item && currentLink) {
    const resolvedLink = await resolveDouyinShortLink(currentLink);
    if (resolvedLink) {
      item = extractDouyinItem(resolvedLink);
      link = normalizeDouyinContentLink(resolvedLink);
      metadata = metadata || metadataStore.douyinById.get(item?.id || "") || metadataStore.douyinByLink.get(link);
    }
  }

  const id = item?.id || "";
  const currentTitle = cellText(fields["标题"]);
  const currentTags = cellText(fields["tag词"]);
  const title = !currentTitle ? metadata?.title || "" : "";
  const tags = shouldRepairTags("douyin", currentTags) ? metadata?.tags || "" : "";
  const unresolved = [];
  if (!id) unresolved.push("missing-id");
  if (!link && currentLink) unresolved.push("unresolved-url");
  if (!currentTitle && !title) unresolved.push("missing-title");
  if (shouldRepairTags("douyin", currentTags) && !tags) unresolved.push("missing-tags");

  return {
    id,
    publishedAt: publishedDateFromDouyinItemId(id),
    link,
    title,
    tags,
    unresolved
  };
}

async function resolveBilibiliRowRepair(fields, metadataStore, fetchBilibiliMetadata) {
  const currentLink = extractFeishuCellLink(fields["内容链接"]);
  const bvid = cellText(fields["短链id"]).trim() || extractBilibiliBv(currentLink);
  let metadata = metadataStore.bilibiliById.get(bvid) || metadataStore.bilibiliByLink.get(canonicalizeContentLink("bilibili", currentLink)) || null;
  const currentTitle = cellText(fields["标题"]);
  const currentTags = cellText(fields["tag词"]);
  if (bvid && (!metadata || !metadata.title || !metadata.tags || shouldRepairTags("bilibili", currentTags))) {
    const live = await fetchBilibiliMetadata(bvid);
    if (live) {
      metadata = mergeMetadata(metadata || {}, live);
      addMetadata(metadataStore, "bilibili", metadata);
    }
  }
  const cleanCurrentTags = shouldRepairTags("bilibili", currentTags) && currentTags
    ? cleanBilibiliFormattedTags(currentTags, currentTitle || metadata?.title || "")
    : "";
  const tags = cleanCurrentTags || (shouldRepairTags("bilibili", currentTags) ? metadata?.tags || "" : "");
  const title = !currentTitle ? metadata?.title || "" : "";
  const unresolved = [];
  if (!bvid) unresolved.push("missing-id");
  if (!currentTitle && !title) unresolved.push("missing-title");
  if (shouldRepairTags("bilibili", currentTags) && !tags) unresolved.push("missing-tags");
  return {
    id: bvid,
    publishedAt: metadata?.publishedAt || "",
    link: bvid ? normalizeBilibiliVideoUrl(bvid) : "",
    title,
    tags,
    unresolved
  };
}

function applyUrlChange({ platformId, fields, row, url, changes }) {
  if (!url) return;
  const index = PLATFORM_HEADERS[platformId].indexOf("内容链接");
  const current = extractFeishuCellLink(fields["内容链接"]);
  const currentText = feishuUrlText(fields["内容链接"]);
  if (current !== url || currentText !== url) {
    row[index] = buildFeishuUrlCell(url);
    changes.url += 1;
  }
}

function applyTitleAndTagsChange({ platformId, fields, row, title, tags, changes }) {
  const titleIndex = PLATFORM_HEADERS[platformId].indexOf("标题");
  if (titleIndex >= 0 && title && cellText(fields["标题"]) !== title) {
    row[titleIndex] = title;
    changes.title += 1;
  }
  const tagsIndex = PLATFORM_HEADERS[platformId].indexOf("tag词");
  if (tagsIndex >= 0 && tags && cellText(fields["tag词"]) !== tags) {
    row[tagsIndex] = tags;
    changes.tags += 1;
  }
}

function resolvePublishedAtForFields(platformId, fields, metadataStore) {
  if (platformId === "xhs") {
    const id = cellText(fields["笔记ID"]).trim() || extractXhsNoteId(extractFeishuCellLink(fields["内容链接"]));
    return publishedDateFromXhsNoteId(id);
  }
  if (platformId === "douyin") {
    return publishedDateFromDouyinItemId(extractDouyinItemId(extractFeishuCellLink(fields["内容链接"])));
  }
  const bvid = cellText(fields["短链id"]).trim() || extractBilibiliBv(extractFeishuCellLink(fields["内容链接"]));
  return metadataStore.bilibiliById.get(bvid)?.publishedAt || "";
}

async function readOutputJsonMetadata(root, store) {
  const outputDir = path.join(root, "output");
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const parsed = JSON.parse(await fs.readFile(path.join(outputDir, entry.name), "utf8"));
    if (!Array.isArray(parsed.items)) continue;
    for (const item of parsed.items) {
      const platformId = item.platform || parsed.platform;
      const link = item.link || item.noteUrl || item.itemUrl || item.videoUrl || "";
      if (!PLATFORM_HEADERS[platformId]) continue;
      addMetadata(store, platformId, metadataFromItem(platformId, {
        id: item.id || item.noteId || item.bvid || "",
        link,
        accountName: item.accountName || item.account || "",
        title: item.title || "",
        tags: item.tags || "",
        publishedAt: item.publishedAt || ""
      }));
    }
  }
}

async function readDetailCacheMetadata(root, store) {
  await readCacheDir(path.join(root, ".runtime", "detail-cache", "xhs"), async (id, parsed) => {
    addMetadata(store, "xhs", metadataFromItem("xhs", {
      id,
      link: parsed.noteUrl || buildXhsExploreUrl(id),
      tags: parsed.tags || "",
      publishedAt: publishedDateFromXhsNoteId(id)
    }));
  });
  await readCacheDir(path.join(root, ".runtime", "detail-cache", "douyin"), async (id, parsed) => {
    addMetadata(store, "douyin", metadataFromItem("douyin", {
      id,
      link: parsed.itemUrl || normalizeDouyinContentLink(id),
      accountName: parsed.authorName || "",
      title: parsed.title || "",
      tags: parsed.tags || "",
      publishedAt: publishedDateFromDouyinItemId(id)
    }));
  });
  await readCacheDir(path.join(root, ".runtime", "detail-cache", "bilibili"), async (id, parsed) => {
    addMetadata(store, "bilibili", metadataFromItem("bilibili", {
      id: parsed.bvid || id,
      link: parsed.videoUrl || normalizeBilibiliVideoUrl(parsed.bvid || id),
      title: parsed.title || "",
      tags: cleanBilibiliFormattedTags(parsed.tags || "", parsed.title || ""),
      publishedAt: parsed.publishedAt || ""
    }));
  });
}

async function readRepairSnapshotMetadata(root, store) {
  const snapshotRoot = path.join(root, "output", "feishu-content-repair");
  const entries = await fs.readdir(snapshotRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(snapshotRoot, entry.name);
    for (const platformId of PLATFORM_IDS) {
      const rows = JSON.parse(await fs.readFile(path.join(dir, `${platformId}.after.json`), "utf8").catch(() => "[]"));
      if (!Array.isArray(rows)) continue;
      for (const rawRow of rows) {
        const row = normalizeRowWidth(rawRow, PLATFORM_HEADERS[platformId].length);
        if (!rowHasValue(row) || isSeparatorRow(platformId, row)) continue;
        const fields = rowFields(PLATFORM_HEADERS[platformId], row);
        const title = cellText(fields["标题"]);
        const tags = cellText(fields["tag词"]);
        if (!title && !tags) continue;
        addMetadata(store, platformId, metadataFromItem(platformId, {
          id: repairSnapshotId(platformId, fields),
          link: extractFeishuCellLink(fields["内容链接"]),
          accountName: fields["账号"],
          title,
          tags,
          publishedAt: fullDateFromSheetCell(fields["投稿时间"])
        }));
      }
    }
  }
}

function repairSnapshotId(platformId, fields) {
  if (platformId === "xhs") return cellText(fields["笔记ID"]);
  if (platformId === "bilibili") return cellText(fields["短链id"]);
  return extractDouyinItemId(extractFeishuCellLink(fields["内容链接"]));
}

function fullDateFromSheetCell(value) {
  const text = cellText(value).trim();
  return /^20\d{2}-\d{2}-\d{2}$/u.test(text) ? text : "";
}

async function readCacheDir(dir, onEntry) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.replace(/\.json$/u, "");
    const parsed = JSON.parse(await fs.readFile(path.join(dir, entry.name), "utf8"));
    await onEntry(id, parsed);
  }
}

function metadataFromItem(platformId, item) {
  const rawLink = item.link || "";
  const id = normalizeMetadataId(platformId, item.id, rawLink);
  const link = normalizeMetadataLink(platformId, rawLink, id);
  return {
    platformId,
    id,
    link,
    accountName: normalizeAccountLabel(platformId, item.accountName || ""),
    title: cellText(item.title),
    tags: platformId === "bilibili"
      ? cleanBilibiliFormattedTags(item.tags || "", item.title || "")
      : cellText(item.tags),
    publishedAt: normalizeMetadataPublishedAt(platformId, id, item.publishedAt)
  };
}

function normalizeMetadataId(platformId, id, link) {
  if (platformId === "xhs") return String(id || extractXhsNoteId(link)).trim();
  if (platformId === "douyin") return String(id || extractDouyinItemId(link)).trim();
  return String(id || extractBilibiliBv(link)).trim();
}

function normalizeMetadataLink(platformId, link, id) {
  if (platformId === "xhs") return normalizeXhsLinkForRepair(link, id, "");
  if (platformId === "douyin") return link ? normalizeDouyinContentLink(link) : normalizeDouyinContentLink(id);
  return normalizeBilibiliVideoUrl(link || id);
}

function normalizeMetadataPublishedAt(platformId, id, publishedAt) {
  if (platformId === "xhs") return publishedDateFromXhsNoteId(id);
  if (platformId === "douyin") return publishedDateFromDouyinItemId(id);
  return String(publishedAt || "").trim();
}

function addMetadata(store, platformId, metadata) {
  if (!metadata?.id && !metadata?.link) return;
  const byId = store[`${platformId}ById`];
  const byLink = store[`${platformId}ByLink`];
  if (metadata.id) byId.set(metadata.id, mergeMetadata(byId.get(metadata.id), metadata));
  if (metadata.link) byLink.set(metadata.link, mergeMetadata(byLink.get(metadata.link), metadata));
}

function mergeMetadata(current = {}, next = {}) {
  return {
    platformId: next.platformId || current.platformId || "",
    id: next.id || current.id || "",
    link: next.link || current.link || "",
    accountName: next.accountName || current.accountName || "",
    title: chooseBetterText(current.title, next.title),
    tags: chooseBetterTags(current.tags, next.tags),
    publishedAt: next.publishedAt || current.publishedAt || ""
  };
}

function chooseBetterText(current = "", next = "") {
  const left = cellText(current);
  const right = cellText(next);
  if (!left) return right;
  if (!right) return left;
  return right.length > left.length ? right : left;
}

function chooseBetterTags(current = "", next = "") {
  const left = cellText(current);
  const right = cellText(next);
  if (!left) return right;
  if (!right) return left;
  return tagCount(right) > tagCount(left) ? right : left;
}

function rebuildFingerprintIndex(store) {
  const seen = new Map();
  for (const metadata of store.douyinById.values()) {
    const key = metadataFingerprint("douyin", metadata);
    if (!key) continue;
    if (seen.has(key)) {
      seen.set(key, null);
    } else {
      seen.set(key, metadata);
    }
  }
  for (const [key, metadata] of seen.entries()) {
    if (metadata) store.douyinByFingerprint.set(key, metadata);
  }
}

function rowFingerprint(platformId, fields) {
  return [
    normalizeAccountLabel(platformId, cellText(fields["账号"])),
    normalizeComparableText(cellText(fields["投稿时间"])),
    normalizeComparableText(cellText(fields["标题"])),
    normalizeComparableTags(cellText(fields["tag词"]))
  ].join("|");
}

function metadataFingerprint(platformId, metadata) {
  if (!metadata.accountName || !metadata.publishedAt || !metadata.title) return "";
  return [
    normalizeAccountLabel(platformId, metadata.accountName),
    normalizeComparableText(formatDisplayDate(metadata.publishedAt)),
    normalizeComparableText(metadata.title),
    normalizeComparableTags(metadata.tags)
  ].join("|");
}

async function fetchBilibiliMetadataFromApi(bvid) {
  if (!bvid) return null;
  const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (!view || view.code !== 0 || !view.data) return null;
  const tagResponse = await fetchJson(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`);
  const tagNames = Array.isArray(tagResponse?.data) ? tagResponse.data.map((tag) => tag.tag_name).filter(Boolean) : [];
  const title = cellText(view.data.title);
  return metadataFromItem("bilibili", {
    id: bvid,
    link: normalizeBilibiliVideoUrl(bvid),
    title,
    tags: extractBilibiliTags({ videoData: { tag: tagNames }, title }),
    publishedAt: dateFromBilibiliEpoch(view.data.pubdate || view.data.ctime || view.data.created)
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  }).catch(() => null);
  if (!response || !response.ok) return null;
  return await response.json().catch(() => null);
}

function normalizeXhsLinkForRepair(currentLink, id, metadataLink) {
  const source = currentLink || metadataLink || "";
  if (source) return normalizeXhsContentLink(source);
  return id ? buildXhsExploreUrl(id) : "";
}

function cleanBilibiliFormattedTags(tags, title = "") {
  const names = String(tags || "")
    .split(/\s+/u)
    .map((tag) => tag.replace(/^#+/u, ""))
    .filter(Boolean);
  return extractBilibiliTags({ videoData: { tag: names }, title });
}

function shouldRepairTags(platformId, tags) {
  const text = cellText(tags).trim();
  if (!text) return true;
  if (platformId === "douyin") return isLowConfidenceDouyinTags(text);
  if (platformId === "bilibili") return /#发现《|#B站\b|#哔哩哔哩|#视频\b/u.test(text);
  return false;
}

function isSeparatorRow(platformId, row) {
  const index = PLATFORM_HEADERS[platformId].indexOf("投稿时间");
  return /投稿视频/u.test(cellText(row[index]));
}

function rowFields(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
}

function rowHasValue(row) {
  return (row || []).some((cell) => cellText(cell).trim());
}

function normalizeRowWidth(row, width) {
  return Array.from({ length: width }, (_, index) => row?.[index] ?? "");
}

function changedRowPatches({ existingRows, repairedRows, columnCount, dataStartRow }) {
  const patches = [];
  let current = null;
  const maxLength = Math.max(existingRows.length, repairedRows.length);
  for (let index = 0; index < maxLength; index += 1) {
    const before = normalizeRowWidth(existingRows[index], columnCount);
    const after = normalizeRowWidth(repairedRows[index], columnCount);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      current = null;
      continue;
    }

    const rowNumber = dataStartRow + index;
    if (!current || current.endRow + 1 !== rowNumber) {
      current = { startRow: rowNumber, endRow: rowNumber, rows: [] };
      patches.push(current);
    } else {
      current.endRow = rowNumber;
    }
    current.rows.push(after);
  }
  return patches;
}

function feishuUrlText(value) {
  if (Array.isArray(value)) return feishuUrlText(value[0]);
  if (value && typeof value === "object") return String(value.text || "");
  return String(value || "");
}

function cellText(value) {
  if (Array.isArray(value)) return value.map((entry) => cellText(entry)).find(Boolean) || "";
  if (value && typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((entry) => cellText(entry)).filter(Boolean).join("、");
    return String(value.text || value.link || value.url || "");
  }
  return String(value || "");
}

function normalizeComparableText(value) {
  return cellText(value).replace(/\s+/gu, "").trim();
}

function normalizeComparableTags(value) {
  return cellText(value)
    .split(/\s+/u)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .sort()
    .join(" ");
}

function tagCount(value) {
  return (cellText(value).match(/#/g) || []).length;
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
