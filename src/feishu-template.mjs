import {
  PLATFORM_HEADERS,
  PLATFORM_LEGACY_HEADERS,
  PLATFORM_SHEET_LAYOUTS
} from "./daily-records.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { STEP15_FILTERED_HEADERS, STEP15_LEGACY_FILTERED_HEADERS } from "./step15-cleaner.mjs";

export const TEMPLATE_SHEET_TITLE = "抖音筛选结果";

const DARK_STYLE = {
  backColor: "#373C43",
  foreColor: "#FFFFFF",
  hAlign: 1,
  vAlign: 1
};
const RED_STYLE = {
  backColor: "#D83931",
  foreColor: "#FFFFFF",
  font: { bold: true },
  hAlign: 1,
  vAlign: 1
};
const HEADER_STYLE = {
  backColor: "#DEE0E3",
  hAlign: 1,
  vAlign: 1
};
const CENTER_STYLE = {
  hAlign: 1,
  vAlign: 1
};

const SHEET_TEMPLATES = {
  douyin: {
    title: "抖音渠道",
    width: PLATFORM_HEADERS.douyin.length,
    clearWidth: 12,
    headerRow: PLATFORM_SHEET_LAYOUTS.douyin.headerRow,
    dataStartRow: PLATFORM_SHEET_LAYOUTS.douyin.dataStartRow,
    topRows: douyinTopRows(PLATFORM_HEADERS.douyin.length),
    headers: PLATFORM_HEADERS.douyin,
    legacyHeaders: [PLATFORM_HEADERS.douyin, ...(PLATFORM_LEGACY_HEADERS.douyin || [])],
    merges: ["A1:C1", "D1:I1", "A2:A3"],
    styles: [
      ["A1:C1", DARK_STYLE],
      ["D1:I1", RED_STYLE],
      [`A4:${columnName(PLATFORM_HEADERS.douyin.length)}4`, HEADER_STYLE],
      ["A2:I3", CENTER_STYLE]
    ],
    frozenRowCount: 4
  },
  xhs: {
    title: "小红书渠道",
    width: PLATFORM_HEADERS.xhs.length,
    headerRow: PLATFORM_SHEET_LAYOUTS.xhs.headerRow,
    dataStartRow: PLATFORM_SHEET_LAYOUTS.xhs.dataStartRow,
    topRows: [["2026目标  5个爆款/月"]],
    headers: PLATFORM_HEADERS.xhs,
    legacyHeaders: [PLATFORM_HEADERS.xhs, ...(PLATFORM_LEGACY_HEADERS.xhs || [])],
    merges: [`A1:${columnName(PLATFORM_HEADERS.xhs.length)}1`],
    styles: [
      [`A1:${columnName(PLATFORM_HEADERS.xhs.length)}1`, DARK_STYLE],
      [`A2:${columnName(PLATFORM_HEADERS.xhs.length)}2`, HEADER_STYLE]
    ],
    frozenRowCount: 2
  },
  bilibili: {
    title: "B站渠道",
    width: PLATFORM_HEADERS.bilibili.length,
    headerRow: PLATFORM_SHEET_LAYOUTS.bilibili.headerRow,
    dataStartRow: PLATFORM_SHEET_LAYOUTS.bilibili.dataStartRow,
    topRows: [["2026目标  2个爆款/月"]],
    headers: PLATFORM_HEADERS.bilibili,
    legacyHeaders: [PLATFORM_HEADERS.bilibili, ...(PLATFORM_LEGACY_HEADERS.bilibili || [])],
    merges: [`A1:${columnName(PLATFORM_HEADERS.bilibili.length)}1`],
    styles: [
      [`A1:${columnName(PLATFORM_HEADERS.bilibili.length)}1`, DARK_STYLE],
      [`A2:${columnName(PLATFORM_HEADERS.bilibili.length)}2`, HEADER_STYLE]
    ],
    frozenRowCount: 2
  },
  step15: {
    title: TEMPLATE_SHEET_TITLE,
    width: STEP15_FILTERED_HEADERS.length,
    clearWidth: 12,
    headerRow: PLATFORM_SHEET_LAYOUTS.step15.headerRow,
    dataStartRow: PLATFORM_SHEET_LAYOUTS.step15.dataStartRow,
    topRows: douyinTopRows(STEP15_FILTERED_HEADERS.length),
    headers: STEP15_FILTERED_HEADERS,
    legacyHeaders: [STEP15_FILTERED_HEADERS, ...STEP15_LEGACY_FILTERED_HEADERS],
    merges: ["A1:C1", "D1:I1", "A2:A3"],
    styles: [
      ["A1:C1", DARK_STYLE],
      ["D1:I1", RED_STYLE],
      ["A4:J4", HEADER_STYLE],
      ["A2:I3", CENTER_STYLE]
    ],
    frozenRowCount: 4
  }
};

export async function applyFeishuSubmissionTemplate({ client } = {}) {
  const writer = client || new FeishuSheetsClient(loadFeishuConfig(process.env));
  const result = {
    renamedStep15: false,
    inserted: {}
  };
  await renameStep15IfNeeded(writer, result);

  for (const sheetKey of ["douyin", "xhs", "bilibili", "step15"]) {
    const template = SHEET_TEMPLATES[sheetKey];
    const rows = await writer.readSheetRows(sheetKey, template.width);
    const alreadyTemplate = rowMatches(rows[template.headerRow - 1], template.headers);
    if (!alreadyTemplate) {
      const legacyHeaderIndex = rows.findIndex((row) => rowMatchesAny(row, [template.headers, ...(template.legacyHeaders || [])]));
      if (legacyHeaderIndex >= 0 && legacyHeaderIndex < template.headerRow - 1) {
        const insertCount = template.headerRow - legacyHeaderIndex - 1;
        await writer.insertRowsBefore(sheetKey, 1, insertCount);
        result.inserted[sheetKey] = insertCount;
      }
    }
    await migrateLegacyDataRows(writer, sheetKey, template, rows);
    await writeTemplateContent(writer, sheetKey, template);
    await applyTemplateStyle(writer, sheetKey, template);
  }

  return result;
}

async function renameStep15IfNeeded(client, result) {
  const step15SheetId = client.sheetId("step15");
  const sheets = typeof client.listSheets === "function" ? await client.listSheets() : [];
  const current = sheets
    .map((sheet) => sheet.properties || sheet)
    .find((sheet) => [sheet.sheet_id, sheet.sheetId, sheet.id].includes(step15SheetId));
  if (!current || current.title === TEMPLATE_SHEET_TITLE) return;
  await client.renameSheet("step15", TEMPLATE_SHEET_TITLE);
  result.renamedStep15 = true;
}

async function writeTemplateContent(client, sheetKey, template) {
  const sheetId = client.sheetId(sheetKey);
  if (template.topRows.length > 0) {
    await client.writeRows(
      sheetKey,
      `${sheetId}!A1:${columnName(template.width)}${template.topRows.length}`,
      template.topRows.map((row) => padRow(row, template.width))
    );
  }
  await client.writeRows(
    sheetKey,
    `${sheetId}!A${template.headerRow}:${columnName(template.width)}${template.headerRow}`,
    [padRow(template.headers, template.width)]
  );
  if ((template.clearWidth || template.width) > template.width) {
    await client.writeRows(
      sheetKey,
      `${sheetId}!${columnName(template.width + 1)}${template.headerRow}:${columnName(template.clearWidth)}${template.headerRow}`,
      [Array.from({ length: template.clearWidth - template.width }, () => "")]
    );
  }
}

async function migrateLegacyDataRows(client, sheetKey, template, rows) {
  const headerRow = rows[template.headerRow - 1] || [];
  if (rowMatches(headerRow, template.headers)) return;
  const sourceHeaders = [template.headers, ...(template.legacyHeaders || [])]
    .find((headers) => rowMatches(headerRow, headers));
  if (!sourceHeaders) return;

  const bodyRows = rows.slice(template.dataStartRow - 1);
  const occupiedCount = lastOccupiedRowCount(bodyRows);
  if (occupiedCount <= 0) return;

  const clearWidth = Math.max(template.clearWidth || template.width, sourceHeaders.length, template.width);
  const migratedRows = bodyRows.slice(0, occupiedCount)
    .map((row) => padRow(remapRowByHeaders(row, sourceHeaders, template.headers), clearWidth));
  const sheetId = client.sheetId(sheetKey);
  const rowEnd = template.dataStartRow + migratedRows.length - 1;
  await client.writeRows(
    sheetKey,
    `${sheetId}!A${template.dataStartRow}:${columnName(clearWidth)}${rowEnd}`,
    migratedRows
  );
}

async function applyTemplateStyle(client, sheetKey, template) {
  const sheetId = client.sheetId(sheetKey);
  for (const mergeRange of template.merges) {
    await client.mergeCells(sheetKey, `${sheetId}!${mergeRange}`, "MERGE_ALL").catch(() => {});
  }
  for (const [range, style] of template.styles) {
    await client.setRangeStyle(`${sheetId}!${range}`, style);
  }
  if (typeof client.freezeRows === "function") {
    await client.freezeRows(sheetKey, template.frozenRowCount).catch(() => {});
  }
}

function douyinTopRows(width) {
  const rows = [
    ["2026目标  10个爆款/月", "", "", "过审核率监控", "", "", "", "", "", douyinContentTypeNote()],
    ["投稿规则", "1、明显不符合广告平台规则的内容不投同花顺媒体平台内容合规指引", "", "投资号", "股民社区", "财经号", "问财", "理财", "期货通"],
    ["", "2、投稿账号连着2周过审率低于30%，停投2周(每周五观测一次)"]
  ];
  return rows.map((row) => padRow(row, width));
}

function douyinContentTypeNote() {
  return [
    "备注：内容类型公式：=IFS(",
    "ISNUMBER(SEARCH(\"同花顺资讯\",C6)),\"资讯\",",
    "ISNUMBER(SEARCH(\"同花顺股友说\",C6)),\"股友说\",",
    "ISNUMBER(SEARCH(\"同顺图解\",C6)),\"图文\",",
    "ISNUMBER(SEARCH(\"同顺盘点\",C6)),\"盘点\",",
    "TRUE,\"\")"
  ].join("\n");
}

function padRow(row, width) {
  return [
    ...row,
    ...Array.from({ length: Math.max(0, width - row.length) }, () => "")
  ].slice(0, width);
}

function remapRowByHeaders(row = [], sourceHeaders = [], targetHeaders = []) {
  return targetHeaders.map((header) => {
    const index = sourceHeaders.indexOf(header);
    return index >= 0 ? row[index] || "" : "";
  });
}

function lastOccupiedRowCount(rows = []) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if ((rows[index] || []).some((cell) => cellText(cell).trim())) return index + 1;
  }
  return 0;
}

function rowMatches(row = [], headers = []) {
  return headers.every((header, index) => cellText(row[index]) === header);
}

function rowMatchesAny(row = [], headerCandidates = []) {
  return headerCandidates.some((headers) => rowMatches(row, headers));
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
