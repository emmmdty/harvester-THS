import "dotenv/config";
import {
  DOUYIN_CONTENT_TYPE_DROPDOWN_VALUES,
  extractFeishuCellLink,
  PLATFORM_HEADERS,
  rowToFields as dailyRowToFields,
  singleSelectDropdownCell,
  XHS_CONTENT_TYPE_DROPDOWN_VALUES
} from "./daily-records.mjs";
import { classifyContentType, CONTENT_TYPE_REVIEW_REQUIRED } from "./content-classifier.mjs";
import { FeishuSheetsClient, loadFeishuConfig, validateFeishuConfig } from "./feishu-sheets.mjs";
import { getPlatformConfig } from "./platform-config.mjs";

const REPAIR_PLATFORM_IDS = ["douyin", "xhs"];
const CONTENT_TYPES_BY_PLATFORM = {
  douyin: DOUYIN_CONTENT_TYPE_DROPDOWN_VALUES,
  xhs: XHS_CONTENT_TYPE_DROPDOWN_VALUES
};
const LEGACY_CONTENT_TYPE_MAP = {
  douyin: {
    "问财": "问财问句",
    "AI视频 虚拟人": "AI虚拟人"
  },
  xhs: {
    "问财": "问财问句",
    "AI虚拟人": "AI视频 虚拟人"
  }
};

export async function buildContentTypeRepairPlan({
  platformId,
  rows,
  classify = classifyContentType
}) {
  assertRepairPlatform(platformId);
  const updates = [];
  const stats = {
    materialRows: 0,
    wouldUpdateRows: 0,
    wouldUpdateType: 0,
    wouldUpdateReview: 0,
    tag: 0,
    deepseek: 0,
    fallback: 0,
    unclassifiable: 0,
    preservedExistingType: 0,
    needsReview: 0
  };

  for (const [index, row] of (rows || []).entries()) {
    const fields = rowToFields(platformId, row);
    const link = fields["内容链接"];
    if (!link) continue;
    stats.materialRows += 1;

    const classification = await classify({
      platformId,
      accountName: fields["账号"],
      title: fields["标题"] || "",
      tags: fields["tag词"] || "",
      text: ""
    });
    const source = classification.source || "fallback";
    if (Object.hasOwn(stats, source)) stats[source] += 1;

    const currentContentType = normalizeLegacyContentType(platformId, fields["内容类型"]);
    const currentReview = fields["内容类型标签审核"];
    const classifiedType = normalizeLegacyContentType(platformId, classification.contentType);
    const hasClassifiedType = Boolean(classifiedType && classifiedType !== "无");
    const nextContentType = hasClassifiedType
      ? classifiedType
      : fallbackContentType(platformId, currentContentType);
    const preservedExistingType = !hasClassifiedType && Boolean(currentContentType && currentContentType !== "无");
    const nextReview = preservedExistingType
      ? CONTENT_TYPE_REVIEW_REQUIRED
      : normalizeReview(classification.contentTypeReview);

    if (!hasClassifiedType) stats.unclassifiable += 1;
    if (preservedExistingType) stats.preservedExistingType += 1;
    if (nextReview === CONTENT_TYPE_REVIEW_REQUIRED) stats.needsReview += 1;

    const typeChanged = Boolean(nextContentType && nextContentType !== currentContentType);
    const reviewChanged = nextReview !== currentReview;
    if (!typeChanged && !reviewChanged) continue;

    stats.wouldUpdateRows += 1;
    if (typeChanged) stats.wouldUpdateType += 1;
    if (reviewChanged) stats.wouldUpdateReview += 1;
    updates.push({
      rowNumber: index + 2,
      sequence: fields["编号"],
      accountName: fields["账号"],
      link,
      title: fields["标题"] || "",
      tags: fields["tag词"] || "",
      currentContentType,
      currentReview,
      nextContentType,
      nextReview,
      source,
      typeChanged,
      reviewChanged
    });
  }

  return {
    platformId,
    materialRows: stats.materialRows,
    stats,
    updates
  };
}

export async function applyContentTypeRepairs({ platformId, client, updates }) {
  assertRepairPlatform(platformId);
  const sheetId = client.sheetId(platformId);
  const headers = PLATFORM_HEADERS[platformId];
  const contentTypeColumn = columnName(headers.indexOf("内容类型") + 1);
  const reviewColumn = columnName(headers.indexOf("内容类型标签审核") + 1);
  let writes = 0;

  for (const update of updates || []) {
    const rowNumber = Number(update.rowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) continue;
    const typeChanged = update.typeChanged ?? update.nextContentType !== update.currentContentType;
    const reviewChanged = update.reviewChanged ?? update.nextReview !== update.currentReview;
    if (typeChanged && update.nextContentType) {
      await client.writeRows(
        platformId,
        `${sheetId}!${contentTypeColumn}${rowNumber}:${contentTypeColumn}${rowNumber}`,
        [[contentTypeCell(platformId, update.nextContentType)]]
      );
      writes += 1;
    }
    if (reviewChanged) {
      await client.writeRows(
        platformId,
        `${sheetId}!${reviewColumn}${rowNumber}:${reviewColumn}${rowNumber}`,
        [[update.nextReview]]
      );
      writes += 1;
    }
  }

  return { writes };
}

export async function repairContentTypes({ client, platformIds = REPAIR_PLATFORM_IDS, apply = false, classify = classifyContentType } = {}) {
  const writer = client || new FeishuSheetsClient(loadFeishuConfig());
  const results = [];
  for (const platformId of platformIds) {
    assertRepairPlatform(platformId);
    const rows = await writer.readRows(platformId);
    const plan = await buildContentTypeRepairPlan({ platformId, rows, classify });
    const applyResult = apply ? await applyContentTypeRepairs({ platformId, client: writer, updates: plan.updates }) : { writes: 0 };
    results.push({ ...plan, applied: apply, writes: applyResult.writes });
  }
  return results;
}

function rowToFields(platformId, row) {
  const fields = dailyRowToFields(platformId, row);
  return Object.fromEntries(PLATFORM_HEADERS[platformId].map((header) => {
    const value = fields[header];
    const text = header === "内容链接" ? extractFeishuCellLink(value) : cellText(value);
    return [header, text];
  }));
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map((item) => cellText(item)).filter(Boolean).join(" ").trim();
  if (typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((item) => cellText(item)).filter(Boolean).join(" ").trim();
    return String(value.text || value.link || value.value || "").trim();
  }
  return String(value).trim();
}

function normalizeLegacyContentType(platformId, value) {
  const text = cellText(value);
  if (!text) return "";
  return LEGACY_CONTENT_TYPE_MAP[platformId]?.[text] || text;
}

function fallbackContentType(platformId, currentContentType) {
  if (currentContentType) return currentContentType;
  return platformId === "douyin" ? "无" : "";
}

function normalizeReview(value) {
  return value === "通过" ? "通过" : CONTENT_TYPE_REVIEW_REQUIRED;
}

function contentTypeCell(platformId, value) {
  const allowed = CONTENT_TYPES_BY_PLATFORM[platformId] || [];
  return allowed.includes(value) ? singleSelectDropdownCell(value) : value;
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

function assertRepairPlatform(platformId) {
  if (!REPAIR_PLATFORM_IDS.includes(platformId)) {
    throw new Error(`内容类型修复仅支持：${REPAIR_PLATFORM_IDS.join(", ")}`);
  }
}

function parseArgs(args) {
  const options = { apply: false, platformIds: REPAIR_PLATFORM_IDS };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--platform" || arg === "-p") {
      options.platformIds = parsePlatforms(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      options.platformIds = parsePlatforms(arg.slice("--platform=".length));
      continue;
    }
  }
  return options;
}

function parsePlatforms(value) {
  if (!value || value === "all") return REPAIR_PLATFORM_IDS;
  const platformIds = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  platformIds.forEach(assertRepairPlatform);
  return platformIds;
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const validation = validateFeishuConfig();
  if (!validation.ok) {
    console.error(validation.message);
    process.exitCode = 1;
    return;
  }

  const client = new FeishuSheetsClient(loadFeishuConfig());
  const results = await repairContentTypes({
    client,
    platformIds: options.platformIds,
    apply: options.apply,
    classify: (input) => classifyContentType({ ...input, fetch: fetchWithTimeout })
  });

  for (const result of results) {
    const label = getPlatformConfig(result.platformId).label;
    console.log(`${label}：素材 ${result.materialRows} 条，待更新行 ${result.stats.wouldUpdateRows} 条，内容类型 ${result.stats.wouldUpdateType} 个，内容类型标签审核 ${result.stats.wouldUpdateReview} 个，需人工审核 ${result.stats.needsReview} 个。`);
    const samples = result.updates.slice(0, 8);
    for (const sample of samples) {
      console.log(`  - 第 ${sample.rowNumber} 行 #${sample.sequence || "-"}：${sample.currentContentType || "空"} / ${sample.currentReview || "空"} -> ${sample.nextContentType || "空"} / ${sample.nextReview}（${sample.source}）`);
    }
    if (result.updates.length > samples.length) {
      console.log(`  - 其余 ${result.updates.length - samples.length} 行省略。`);
    }
    if (options.apply) {
      console.log(`  已写入 ${result.writes} 个单元格。`);
    }
  }

  if (!options.apply) {
    console.log("当前为 dry-run，未写入飞书。确认后运行：npm run repair:content-types -- --apply");
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
