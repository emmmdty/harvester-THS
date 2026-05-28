import { formatBatchTitle, formatDisplayDate } from "./date-utils.mjs";
import { canonicalizeContentLink, extractBilibiliBv, extractLinkValue, extractXhsNoteId } from "./link-utils.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";

export const PLATFORM_HEADERS = {
  douyin: ["编号", "投稿时间", "内容链接", "标题", "tag词", "筛选状态", "简短理由", "账号", "内容类型", "内容类型标签审核", "本地素材目录"],
  xhs: ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "内容类型标签审核", "tag词"],
  bilibili: ["编号", "投稿时间", "内容链接", "短链id", "账号", "标题", "tag词"],
  step15: ["编号", "投稿时间", "内容链接", "账号", "内容类型", "简短理由", "是否投放成功", "是否为爆款", "供稿人", "备注"]
};

export const PLATFORM_LEGACY_HEADERS = {
  douyin: [
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "内容类型标签审核", "标题", "tag词", "筛选状态", "命中规则", "简短理由", "本地素材目录"],
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "内容类型标签审核", "标题", "tag词"]
  ],
  bilibili: [
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
export const XHS_ACCOUNT_DROPDOWN_VALUES = ["问财", "投资号", "财经号", "股民社区", "理财", "喵懂投资", "研习社"];
export const XHS_ACCOUNT_DROPDOWN_COLORS = ["#FFE0A3", "#DCE8FF", "#BFEAF5", "#CFEFE2", "#F8E7A5", "#FFD8C7", "#E7D9FF"];
export const BILIBILI_ACCOUNT_DROPDOWN_VALUES = ["投资号"];
export const BILIBILI_ACCOUNT_DROPDOWN_COLORS = ["#DCE8FF"];
export const DOUYIN_CONTENT_TYPE_DROPDOWN_VALUES = ["资讯", "财商动画", "励志语录", "问财问句", "盘点", "股友说", "社区话题", "说唱", "长视频", "理财内容", "大佬采访", "图文", "AI虚拟人", "无"];
export const DOUYIN_CONTENT_TYPE_DROPDOWN_COLORS = ["#DCE8FF", "#DDF2D8", "#F8E7A5", "#FFE0A3", "#F4D8FF", "#BFEAF5", "#CFEFE2", "#FFD8C7", "#E7D9FF", "#D8E3FF", "#F7C8D0", "#D9F0FF", "#DDEBE0", "#E5E7EB"];
export const XHS_CONTENT_TYPE_DROPDOWN_VALUES = ["资讯", "财商动画", "励志语录", "问财问句", "盘点", "股友说", "社区话题", "说唱", "大佬采访", "长视频", "理财内容", "常老师", "图文", "AI视频 虚拟人", "段子"];
export const XHS_CONTENT_TYPE_DROPDOWN_COLORS = ["#DCE8FF", "#DDF2D8", "#F8E7A5", "#FFE0A3", "#F4D8FF", "#BFEAF5", "#CFEFE2", "#FFD8C7", "#F7C8D0", "#E7D9FF", "#D8E3FF", "#EAE6FF", "#D9F0FF", "#DDEBE0", "#FDE2E2"];
export const CONTENT_TYPE_DROPDOWN_VALUES = XHS_CONTENT_TYPE_DROPDOWN_VALUES;
export const CONTENT_TYPE_DROPDOWN_COLORS = XHS_CONTENT_TYPE_DROPDOWN_COLORS;
export const DOUYIN_FILTER_STATUS_VALUES = ["通过", "不投放", "需人工复核"];
export const DOUYIN_FILTER_STATUS_COLORS = ["#DDF2D8", "#FDE2E2", "#F8E7A5"];
export const YES_NO_DROPDOWN_VALUES = ["是", "否"];
export const YES_NO_DROPDOWN_COLORS = ["#DDF2D8", "#FDE2E2"];
export const PLATFORM_DROPDOWN_COLUMNS = {
  douyin: [
    { header: "筛选状态", values: DOUYIN_FILTER_STATUS_VALUES, colors: DOUYIN_FILTER_STATUS_COLORS },
    { header: "账号", values: DOUYIN_ACCOUNT_DROPDOWN_VALUES, colors: DOUYIN_ACCOUNT_DROPDOWN_COLORS },
    { header: "内容类型", values: DOUYIN_CONTENT_TYPE_DROPDOWN_VALUES, colors: DOUYIN_CONTENT_TYPE_DROPDOWN_COLORS }
  ],
  xhs: [
    { header: "账号", values: XHS_ACCOUNT_DROPDOWN_VALUES, colors: XHS_ACCOUNT_DROPDOWN_COLORS },
    { header: "内容类型", values: XHS_CONTENT_TYPE_DROPDOWN_VALUES, colors: XHS_CONTENT_TYPE_DROPDOWN_COLORS }
  ],
  bilibili: [
    { header: "账号", values: BILIBILI_ACCOUNT_DROPDOWN_VALUES, colors: BILIBILI_ACCOUNT_DROPDOWN_COLORS }
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
    .map((item, index) => ({
      kind: "material",
      platformId,
      sequence: String(index + 1),
      displayDate: formatDisplayDate(targetDate),
      targetDate,
      link: canonicalizeContentLink(platformId, item.link || item.noteUrl || item.itemUrl || item.videoUrl || ""),
      id: item.id || item.noteId || item.bvid || "",
      accountName: item.accountName || item.account || "",
      contentType: item.contentType || "",
      contentTypeReview: normalizeContentTypeReview(item.contentTypeReview, item.contentType),
      title: item.title || "",
      tags: item.tags || "",
      publishedAt: item.publishedAt || targetDate
    }));

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
    return {
      "编号": record.sequence || "",
      "投稿时间": record.displayDate || formatDisplayDate(record.targetDate),
      "内容链接": record.link || "",
      "标题": spreadsheetSafeText(record.title || ""),
      "tag词": spreadsheetSafeText(record.tags || ""),
      "筛选状态": record.filterStatus || "",
      "简短理由": spreadsheetSafeText(record.briefReason || ""),
      "账号": normalizeAccountLabel(platformId, record.accountName),
      "内容类型": record.contentType || "",
      "内容类型标签审核": record.contentTypeReview || "",
      "本地素材目录": spreadsheetSafeText(record.assetDir || "")
    };
  }

  if (platformId === "xhs") {
    return {
      "编号": record.sequence || "",
      "投稿时间": record.displayDate || formatDisplayDate(record.targetDate),
      "内容链接": record.link || "",
      "笔记ID": record.id || extractXhsNoteId(record.link),
      "账号": normalizeAccountLabel(platformId, record.accountName),
      "内容类型": record.contentType || "",
      "内容类型标签审核": record.contentTypeReview || "",
      "tag词": spreadsheetSafeText(record.tags || "")
    };
  }

  return {
    "编号": record.sequence || "",
    "投稿时间": record.displayDate || formatDisplayDate(record.targetDate),
    "内容链接": record.link || "",
    "短链id": record.id || extractBilibiliBv(record.link),
    "账号": normalizeAccountLabel(platformId, record.accountName || "同花顺投资"),
    "标题": spreadsheetSafeText(record.title || ""),
    "tag词": spreadsheetSafeText(record.tags || "")
  };
}

export function mapDailyRecordToSheetRow(platformId, record) {
  const fields = mapDailyRecordToFeishuFields(platformId, record);
  return PLATFORM_HEADERS[platformId].map((header) => {
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

export function filterNewDailySheetRecords(platformId, records, existingRows) {
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
  return link || "";
}

export function materialKeyFromFields(platformId, fields) {
  const link = canonicalizeContentLink(platformId, extractFeishuCellLink(fields["内容链接"]));
  if (platformId === "xhs") return fields["笔记ID"] || extractXhsNoteId(link) || link || "";
  if (platformId === "bilibili") return fields["短链id"] || extractBilibiliBv(link) || link || "";
  return link || "";
}

function emptyFields(platformId, overrides = {}) {
  return Object.fromEntries(PLATFORM_HEADERS[platformId].map((field) => [field, overrides[field] || ""]));
}

function normalizeContentTypeReview(value, contentType) {
  const text = String(value || "").trim();
  if (text === "通过" || text === "需审核") return text;
  const type = String(contentType || "").trim();
  if (type && type !== "无") return "通过";
  return "需审核";
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
  return Object.fromEntries(PLATFORM_HEADERS[platformId].map((header, index) => [header, row[index] || ""]));
}
