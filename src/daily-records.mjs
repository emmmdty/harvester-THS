import { formatBatchTitle, formatDisplayDate } from "./date-utils.mjs";
import { canonicalizeContentLink, extractBilibiliBv, extractDouyinItem, extractLinkValue, extractXhsNoteId } from "./link-utils.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";
import { classifyTags } from "./tag-rules.mjs";

export const PLATFORM_HEADERS = {
  douyin: ["编号", "投稿时间", "内容链接", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "作品ID", "作品类型", "标题", "tag词", "一级类型", "二级类型", "内容类型标签审核", "AI内容判断备注"],
  xhs: ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "标题", "tag词", "一级类型", "二级类型", "内容类型标签审核", "AI内容判断备注"],
  bilibili: ["编号", "投稿时间", "内容链接", "短链id", "是否投放成功", "是否为爆款", "供稿人", "备注", "账号", "作品类型", "标题", "tag词", "内容类型", "内容类型标签审核", "AI内容判断备注"],
  step15: ["编号", "投稿时间", "内容链接", "账号", "内容类型", "简短理由", "是否投放成功", "是否为爆款", "供稿人", "备注"]
};

export const PLATFORM_LEGACY_HEADERS = {
  douyin: [
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "作品ID", "作品类型", "标题", "tag词", "内容类型标签审核"],
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注"],
    ["编号", "投稿时间", "内容链接", "标题", "tag词", "筛选状态", "简短理由", "账号", "内容类型", "内容类型标签审核", "本地素材目录"],
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "内容类型标签审核", "标题", "tag词", "筛选状态", "命中规则", "简短理由", "本地素材目录"],
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "内容类型标签审核", "标题", "tag词"]
  ],
  xhs: [
    ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "标题", "tag词", "一级类型", "二级类型", "内容类型标签审核", "AI内容判断备注", "图文/视频"],
    ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "标题", "内容类型标签审核", "tag词"],
    ["编号", "投稿时间", "内容链接", "笔记ID", "标题", "账号", "内容类型", "内容类型标签审核", "tag词"],
    ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "内容类型标签审核", "tag词"]
  ],
  bilibili: [
    ["编号", "投稿时间", "内容链接", "短链id", "是否投放成功", "是否为爆款", "供稿人", "备注", "账号", "作品类型", "标题", "tag词", "内容类型", "内容类型标签审核"],
    ["编号", "投稿时间", "内容链接", "短链id", "账号", "标题", "tag词"],
    ["编号", "投稿时间", "内容链接", "短链id", "账号"]
  ],
  step15: [
    ["平台", "编号", "投稿时间", "内容链接", "账号", "内容类型", "标题", "tag词", "筛选状态", "命中规则", "简短理由", "本地素材目录"],
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "内容类型标签审核", "标题", "tag词", "筛选状态", "命中规则", "简短理由", "本地素材目录"]
  ]
};

export const PLATFORM_SHEET_LAYOUTS = {
  douyin: { headerRow: 4, dataStartRow: 5 },
  xhs: { headerRow: 2, dataStartRow: 3 },
  bilibili: { headerRow: 2, dataStartRow: 3 },
  step15: { headerRow: 4, dataStartRow: 5 }
};

export const DOUYIN_ACCOUNT_DROPDOWN_VALUES = ["投资号", "问财", "财经号", "理财", "股民社区", "期货通", "达人内容", "福利官"];
export const DOUYIN_ACCOUNT_DROPDOWN_COLORS = ["#DCE8FF", "#FFE0A3", "#BFEAF5", "#F8E7A5", "#CFEFE2", "#FFD8C7", "#E7D9FF", "#DDF2D8"];
export const XHS_ACCOUNT_DROPDOWN_VALUES = ["问财", "投资号", "财经号", "股民社区", "理财", "喵懂投资", "研习社", "福利官"];
export const XHS_ACCOUNT_DROPDOWN_COLORS = ["#FFE0A3", "#DCE8FF", "#BFEAF5", "#CFEFE2", "#F8E7A5", "#FFD8C7", "#E7D9FF", "#DDF2D8"];
export const BILIBILI_ACCOUNT_DROPDOWN_VALUES = ["投资号"];
export const BILIBILI_ACCOUNT_DROPDOWN_COLORS = ["#DCE8FF"];
export const DOUYIN_CONTENT_TYPE_DROPDOWN_VALUES = ["资讯", "财商动画", "励志语录", "问财问句", "盘点", "股友说", "社区话题", "说唱", "长视频", "理财内容", "大佬采访", "图文", "AI虚拟人", "无"];
export const DOUYIN_CONTENT_TYPE_DROPDOWN_COLORS = ["#DCE8FF", "#DDF2D8", "#F8E7A5", "#FFE0A3", "#F4D8FF", "#BFEAF5", "#CFEFE2", "#FFD8C7", "#E7D9FF", "#D8E3FF", "#F7C8D0", "#D9F0FF", "#DDEBE0", "#E5E7EB"];
export const XHS_CONTENT_TYPE_DROPDOWN_VALUES = ["资讯", "财商动画", "励志语录", "问财问句", "盘点", "股友说", "社区话题", "说唱", "大佬采访", "长视频", "理财内容", "常老师", "图文", "AI视频 虚拟人", "段子"];
export const XHS_CONTENT_TYPE_DROPDOWN_COLORS = ["#DCE8FF", "#DDF2D8", "#F8E7A5", "#FFE0A3", "#F4D8FF", "#BFEAF5", "#CFEFE2", "#FFD8C7", "#F7C8D0", "#E7D9FF", "#D8E3FF", "#EAE6FF", "#D9F0FF", "#DDEBE0", "#FDE2E2"];
export const BILIBILI_CONTENT_TYPE_DROPDOWN_VALUES = ["采访内容", "大佬生平", "新手教学指标教学", "海外搬运", "短视频", "无"];
export const BILIBILI_CONTENT_TYPE_DROPDOWN_COLORS = ["#DCE8FF", "#DDF2D8", "#F8E7A5", "#FFE0A3", "#F4D8FF", "#E5E7EB"];
export const CONTENT_TYPE_DROPDOWN_VALUES = XHS_CONTENT_TYPE_DROPDOWN_VALUES;
export const CONTENT_TYPE_DROPDOWN_COLORS = XHS_CONTENT_TYPE_DROPDOWN_COLORS;
export const DOUYIN_FILTER_STATUS_VALUES = ["通过", "不投放", "需人工复核"];
export const DOUYIN_FILTER_STATUS_COLORS = ["#DDF2D8", "#FDE2E2", "#F8E7A5"];
export const YES_NO_DROPDOWN_VALUES = ["是", "否"];
export const YES_NO_DROPDOWN_COLORS = ["#DDF2D8", "#FDE2E2"];
export const PLATFORM_DROPDOWN_COLUMNS = {
  douyin: [
    { header: "账号", values: DOUYIN_ACCOUNT_DROPDOWN_VALUES, colors: DOUYIN_ACCOUNT_DROPDOWN_COLORS },
    { header: "内容类型", values: DOUYIN_CONTENT_TYPE_DROPDOWN_VALUES, colors: DOUYIN_CONTENT_TYPE_DROPDOWN_COLORS },
    { header: "是否投放成功", values: YES_NO_DROPDOWN_VALUES, colors: YES_NO_DROPDOWN_COLORS },
    { header: "是否为爆款", values: YES_NO_DROPDOWN_VALUES, colors: YES_NO_DROPDOWN_COLORS }
  ],
  xhs: [
    { header: "账号", values: XHS_ACCOUNT_DROPDOWN_VALUES, colors: XHS_ACCOUNT_DROPDOWN_COLORS },
    { header: "内容类型", values: XHS_CONTENT_TYPE_DROPDOWN_VALUES, colors: XHS_CONTENT_TYPE_DROPDOWN_COLORS },
    { header: "是否投放成功", values: YES_NO_DROPDOWN_VALUES, colors: YES_NO_DROPDOWN_COLORS },
    { header: "是否为爆款", values: YES_NO_DROPDOWN_VALUES, colors: YES_NO_DROPDOWN_COLORS }
  ],
  bilibili: [
    { header: "是否投放成功", values: YES_NO_DROPDOWN_VALUES, colors: YES_NO_DROPDOWN_COLORS },
    { header: "是否为爆款", values: YES_NO_DROPDOWN_VALUES, colors: YES_NO_DROPDOWN_COLORS },
    { header: "账号", values: BILIBILI_ACCOUNT_DROPDOWN_VALUES, colors: BILIBILI_ACCOUNT_DROPDOWN_COLORS },
    { header: "内容类型", values: BILIBILI_CONTENT_TYPE_DROPDOWN_VALUES, colors: BILIBILI_CONTENT_TYPE_DROPDOWN_COLORS }
  ],
  step15: [
    { header: "账号", values: DOUYIN_ACCOUNT_DROPDOWN_VALUES, colors: DOUYIN_ACCOUNT_DROPDOWN_COLORS },
    { header: "内容类型", values: DOUYIN_CONTENT_TYPE_DROPDOWN_VALUES, colors: DOUYIN_CONTENT_TYPE_DROPDOWN_COLORS },
    { header: "是否投放成功", values: YES_NO_DROPDOWN_VALUES, colors: YES_NO_DROPDOWN_COLORS },
    { header: "是否为爆款", values: YES_NO_DROPDOWN_VALUES, colors: YES_NO_DROPDOWN_COLORS }
  ]
};

export function buildDailySheetRecords(platformId, targetDate, items) {
  assertPlatform(platformId);
  const materialRows = items
    .filter((item) => !item.publishedAt || item.publishedAt === targetDate)
    .map((item, index) => {
      const classification = item.classification || {};
      const primaryType = item.primaryType || classification.primaryType || "";
      const secondaryType = platformId === "bilibili" ? "" : (item.secondaryType || classification.secondaryType || "");
      const tagOnlyContentType = tagContentTypeForPlatform(platformId, item.tags);
      const contentType = tagOnlyContentType === null ? (item.contentType || primaryType || "") : tagOnlyContentType;
      const publishedAt = item.publishedAt || targetDate;
      return {
        kind: "material",
        platformId,
        sequence: String(index + 1),
        displayDate: publishedAt,
        targetDate,
        link: canonicalizeContentLink(platformId, item.link || item.noteUrl || item.itemUrl || item.videoUrl || ""),
        id: item.id || item.itemId || item.noteId || item.bvid || douyinIdFromItem(platformId, item) || "",
        itemType: item.itemType || item.type || douyinTypeFromLink(item.link || item.noteUrl || item.itemUrl || item.videoUrl || ""),
        accountName: item.accountName || item.account || "",
        contentType,
        primaryType,
        secondaryType,
        materialKind: item.materialKind || item.assetType || "",
        contentTypeReview: normalizeContentTypeReview(item.contentTypeReview || classification.contentTypeReview, contentType, item.contentTypeReason || classification.reason),
        aiContentRemark: item.aiContentRemark || classification.aiContentRemark || "",
        title: item.title || "",
        tags: item.tags || "",
        publishedAt
      };
    });

  if (materialRows.length === 0) return [];

  return [
    {
      kind: "separator",
      platformId,
      targetDate,
      batchTitle: formatBatchTitle(targetDate)
    },
    ...materialRows
  ];
}

export function mapDailyRecordToFeishuFields(platformId, record) {
  assertPlatform(platformId);
  if (record.kind === "separator") {
    return emptyFields(platformId, { "投稿时间": record.batchTitle || formatBatchTitle(record.targetDate) });
  }

  if (platformId === "douyin") {
    const itemType = record.itemType || douyinTypeFromLink(record.link) || "视频";
    const contentType = tagContentTypeForPlatform(platformId, record.tags);
    return {
      "编号": record.sequence || "",
      "投稿时间": record.displayDate || record.publishedAt || record.targetDate || formatDisplayDate(record.targetDate),
      "内容链接": record.link || "",
      "账号": normalizeAccountLabel(platformId, record.accountName),
      "内容类型": contentType,
      "是否投放成功": record.deliverySuccess || record.isDelivered || "",
      "是否为爆款": record.isHot || record.hot || "",
      "供稿人": spreadsheetSafeText(record.contributor || ""),
      "备注": spreadsheetSafeText(record.remark || record.notes || ""),
      "作品ID": record.id || extractDouyinItem(record.link)?.id || "",
      "作品类型": itemType,
      "标题": spreadsheetSafeText(record.title || ""),
      "tag词": spreadsheetSafeText(record.tags || ""),
      "一级类型": record.primaryType || "",
      "二级类型": record.secondaryType || "",
      "内容类型标签审核": normalizeContentTypeReview(record.contentTypeReview, contentType, record.contentTypeReason || record.reason),
      "AI内容判断备注": record.aiContentRemark || ""
    };
  }

  if (platformId === "xhs") {
    const contentType = tagContentTypeForPlatform(platformId, record.tags);
    return {
      "编号": record.sequence || "",
      "投稿时间": record.displayDate || record.publishedAt || record.targetDate || formatDisplayDate(record.targetDate),
      "内容链接": record.link || "",
      "笔记ID": record.id || extractXhsNoteId(record.link),
      "账号": normalizeAccountLabel(platformId, record.accountName),
      "内容类型": contentType,
      "是否投放成功": record.deliverySuccess || record.isDelivered || "",
      "是否为爆款": record.isHot || record.hot || "",
      "供稿人": spreadsheetSafeText(record.contributor || ""),
      "备注": spreadsheetSafeText(record.remark || record.notes || ""),
      "标题": spreadsheetSafeText(record.title || ""),
      "tag词": spreadsheetSafeText(record.tags || ""),
      "一级类型": record.primaryType || "",
      "二级类型": record.secondaryType || "",
      "内容类型标签审核": normalizeContentTypeReview(record.contentTypeReview, contentType, record.contentTypeReason || record.reason),
      "AI内容判断备注": record.aiContentRemark || ""
    };
  }

  const bilibiliContentType = record.primaryType || record.contentType || "无";
  return {
    "编号": record.sequence || "",
    "投稿时间": record.displayDate || record.publishedAt || record.targetDate || formatDisplayDate(record.targetDate),
    "内容链接": record.link || "",
    "短链id": record.id || extractBilibiliBv(record.link),
    "是否投放成功": record.deliverySuccess || record.isDelivered || "",
    "是否为爆款": record.isHot || record.hot || "",
    "供稿人": spreadsheetSafeText(record.contributor || ""),
    "备注": spreadsheetSafeText(record.remark || record.notes || ""),
    "账号": normalizeAccountLabel(platformId, record.accountName || "同花顺投资"),
    "作品类型": record.itemType || "视频",
    "标题": spreadsheetSafeText(record.title || ""),
    "tag词": spreadsheetSafeText(record.tags || ""),
    "内容类型": bilibiliContentType,
    "内容类型标签审核": normalizeContentTypeReview(record.contentTypeReview, bilibiliContentType, record.contentTypeReason || record.reason),
    "AI内容判断备注": record.aiContentRemark || ""
  };
}

export function mapDailyRecordToSheetRow(platformId, record) {
  return mapDailyRecordToSheetRowForHeaders(platformId, record, PLATFORM_HEADERS[platformId]);
}

export function mapDailyRecordToSheetRowForHeaders(platformId, record, headers = PLATFORM_HEADERS[platformId]) {
  const fields = mapDailyRecordToFeishuFields(platformId, record);
  return (headers || PLATFORM_HEADERS[platformId]).map((header) => {
    const value = fields[header] || "";
    if (!value) return "";
    if (header === "内容链接") return buildFeishuUrlCell(value);
    return isDropdownHeader(platformId, header) ? singleSelectDropdownCell(value) : value;
  });
}

export function buildFeishuUrlCell(url) {
  const link = String(url || "").trim();
  return link ? { type: "url", text: link, link } : "";
}

export function extractFeishuCellLink(value) {
  return extractLinkValue(value);
}

export function normalizeAccountLabel(platformId, accountName = "") {
  if (!PLATFORM_HEADERS[platformId]) {
    accountName = platformId;
    platformId = "douyin";
  }
  const text = String(accountName || "").trim();
  if (!text) return "";

  if (platformId === "douyin") {
    if (/达人|达人内容/.test(text)) return "达人内容";
    if (/福利官|新手福利/.test(text)) return "福利官";
    if (/(同花顺|同顺)?问财/.test(text)) return "问财";
    if (/同花顺投资|^投资号$/.test(text)) return "投资号";
    if (/(同花顺|同顺)财经|^财经号$/.test(text)) return "财经号";
    if (/同花顺财富|同花顺理财|^理财$/.test(text)) return "理财";
    if (/(同花顺|同顺)股民社区|^股民社区$/.test(text)) return "股民社区";
    if (/同花顺期货通|^期货通$/.test(text)) return "期货通";
  }

  if (platformId === "xhs") {
    if (/福利官|新手福利/.test(text)) return "福利官";
    if (/研习社/.test(text)) return "研习社";
    if (/同花顺投资|^投资号$/.test(text)) return "投资号";
    if (/(同花顺|同顺)股民社区|^股民社区$/.test(text)) return "股民社区";
    if (/同花顺财富|同花顺理财|^理财$/.test(text)) return "理财";
    if (/(同花顺|同顺)财经|^财经号$/.test(text)) return "财经号";
    if (/(同花顺|同顺)?问财/.test(text)) return "问财";
    if (/喵懂投资/.test(text)) return "喵懂投资";
  }

  if (platformId === "bilibili") {
    if (/同花顺投资|^投资号$/.test(text)) return "投资号";
  }

  return text;
}

export function singleSelectDropdownCell(value) {
  return {
    type: "multipleValue",
    values: [value]
  };
}

export function filterNewDailySheetRecords(platformId, records, existingRows, { targetDate = "", existingDateBlocks = null } = {}) {
  assertPlatform(platformId);
  const existingSeparators = new Set();
  const existingMaterialKeys = new Set();

  for (const existing of existingRows || []) {
    const fields = Array.isArray(existing)
      ? rowToFields(platformId, existing)
      : existing.fields || existing || {};
    if (fields["投稿时间"]) existingSeparators.add(String(fields["投稿时间"]));
    const key = materialKeyFromFields(platformId, fields);
    if (key) existingMaterialKeys.add(key);
  }

  return records.filter((record) => {
    if (record.kind === "separator") {
      const batchTitle = record.batchTitle || formatBatchTitle(record.targetDate);
      const separatorDate = targetDate || record.targetDate || "";
      if (separatorDate && Array.isArray(existingDateBlocks)) {
        return !existingDateBlocks.some((block) => block.date === separatorDate);
      }
      return !existingSeparators.has(batchTitle);
    }

    const key = materialKeyFromRecord(platformId, record);
    return key ? !existingMaterialKeys.has(key) : true;
  });
}

export function materialKeyFromRecord(platformId, record) {
  const link = canonicalizeContentLink(platformId, record.link);
  if (platformId === "xhs") return record.id || extractXhsNoteId(link) || link || "";
  if (platformId === "bilibili") return record.id || extractBilibiliBv(link) || link || "";
  if (platformId === "douyin") return record.id || extractDouyinItem(link)?.id || link || "";
  return link || "";
}

export function materialKeyFromFields(platformId, fields) {
  const link = canonicalizeContentLink(platformId, extractFeishuCellLink(fields["内容链接"]));
  if (platformId === "xhs") return fields["笔记ID"] || extractXhsNoteId(link) || link || "";
  if (platformId === "bilibili") return fields["短链id"] || extractBilibiliBv(link) || link || "";
  if (platformId === "douyin") return fields["作品ID"] || extractDouyinItem(link)?.id || link || "";
  return link || "";
}

function emptyFields(platformId, overrides = {}) {
  return Object.fromEntries(PLATFORM_HEADERS[platformId].map((field) => [field, overrides[field] || ""]));
}

function normalizeContentTypeReview(value, contentType, reason = "") {
  const text = String(value || "").trim();
  if (/^(通过|需审核)。因为/u.test(text)) return oneSentenceReview(text);
  if (text === "通过") return reviewText("通过", reason || defaultPassReason(contentType));
  if (text === "需审核") return reviewText("需审核", reason || "AI判断依据不足，建议复核内容类型。");
  const type = String(contentType || "").trim();
  if (type && type !== "无") return reviewText("通过", reason || defaultPassReason(type));
  return reviewText("需审核", reason || "标题和tag线索不足，无法稳定判断内容类型。");
}

function defaultPassReason(contentType = "") {
  const type = String(contentType || "").trim();
  return type && type !== "无"
    ? `AI依据标题、tag和可用素材判断为${type}。`
    : "AI依据标题、tag和可用素材完成判断。";
}

function reviewText(prefix, reason = "") {
  const normalizedPrefix = prefix === "需审核" ? "需审核" : "通过";
  const cleanReason = String(reason || "").trim()
    .replace(/^(通过|需审核)。因为/u, "")
    .replace(/^[，。；:\s]+/u, "");
  return oneSentenceReview(`${normalizedPrefix}。因为${cleanReason || "AI已给出内容类型判断依据。"}`);
}

function oneSentenceReview(text = "") {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^(通过|需审核)。因为(.+?)(?:[。！？\n]|$)/u);
  if (!match) return "需审核。因为AI判断依据不足，建议复核内容类型。";
  const reason = match[2].trim().replace(/[。！？]+$/u, "");
  return `${match[1]}。因为${reason || "AI已给出内容类型判断依据"}。`;
}

function assertPlatform(platformId) {
  if (!PLATFORM_HEADERS[platformId]) {
    throw new Error(`不支持的平台：${platformId}`);
  }
}

function isDropdownHeader(platformId, header) {
  return (PLATFORM_DROPDOWN_COLUMNS[platformId] || []).some((column) => column.header === header);
}

export function rowToFields(platformId, row) {
  const headers = headersForRow(platformId, row);
  return rowToFieldsWithHeaders(platformId, row, headers);
}

export function rowToFieldsWithHeaders(platformId, row, headers = PLATFORM_HEADERS[platformId]) {
  const outputHeaders = PLATFORM_HEADERS[platformId] || [];
  return Object.fromEntries(PLATFORM_HEADERS[platformId].map((header) => {
    const index = (headers || outputHeaders).indexOf(header);
    return [header, index >= 0 ? row[index] || "" : ""];
  }));
}

function douyinIdFromItem(platformId, item = {}) {
  if (platformId !== "douyin") return "";
  const link = item.link || item.noteUrl || item.itemUrl || item.videoUrl || "";
  return extractDouyinItem(link)?.id || "";
}

function douyinTypeFromLink(link = "") {
  const item = extractDouyinItem(link);
  if (!item) return "";
  return item.type === "note" ? "图文" : "视频";
}

export function headersForRow(platformId, row = []) {
  const current = PLATFORM_HEADERS[platformId] || [];
  const legacy = PLATFORM_LEGACY_HEADERS[platformId] || [];
  if (platformId === "douyin") {
    const paddedLegacyMatch = legacy.find((headers) => looksLikePaddedLegacyDouyinRow(row, headers));
    if (paddedLegacyMatch) return paddedLegacyMatch;
  }
  const exactWidthMatch = legacy.find((headers) => headers.length === row.length);
  if (exactWidthMatch) return exactWidthMatch;
  return current;
}

function looksLikePaddedLegacyDouyinRow(row = [], headers = []) {
  if (!Array.isArray(row) || row.length < headers.length) return false;
  const titleIndex = headers.indexOf("标题");
  const tagIndex = headers.indexOf("tag词");
  const accountIndex = headers.indexOf("账号");
  const contentTypeIndex = headers.indexOf("内容类型");
  if (titleIndex < 0 || tagIndex < 0 || accountIndex < 0 || contentTypeIndex < 0) return false;

  const legacyAccount = normalizedCellText(row[accountIndex]);
  const legacyContentType = normalizedCellText(row[contentTypeIndex]);
  const currentAccount = normalizedCellText(row[PLATFORM_HEADERS.douyin.indexOf("账号")]);
  const currentContentType = normalizedCellText(row[PLATFORM_HEADERS.douyin.indexOf("内容类型")]);
  const title = normalizedCellText(row[titleIndex]);
  const tags = normalizedCellText(row[tagIndex]);

  if (!isKnownDouyinAccount(legacyAccount) && !isKnownDouyinContentType(legacyContentType)) return false;
  if (isKnownDouyinAccount(currentAccount) && isKnownDouyinContentType(currentContentType)) return false;
  return Boolean(title || tags);
}

function isKnownDouyinAccount(value) {
  return DOUYIN_ACCOUNT_DROPDOWN_VALUES.includes(normalizedCellText(value));
}

function isKnownDouyinContentType(value) {
  return DOUYIN_CONTENT_TYPE_DROPDOWN_VALUES.includes(normalizedCellText(value));
}

function normalizedCellText(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizedCellText(entry)).find(Boolean) || "";
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((entry) => normalizedCellText(entry)).filter(Boolean).join("、");
    return String(value.text || value.link || value.url || "").trim();
  }
  return String(value || "").trim();
}

function tagContentTypeForPlatform(platformId, tags = "") {
  if (platformId !== "douyin" && platformId !== "xhs") return null;
  const tagType = classifyTags(tags, { platformId });
  if (platformId === "douyin") return tagType || "无";
  return tagType && tagType !== "无" ? tagType : "";
}
