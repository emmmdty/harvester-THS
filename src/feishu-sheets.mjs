import {
  buildDailySheetRecords,
  filterNewDailySheetRecords,
  mapDailyRecordToSheetRow,
  PLATFORM_DROPDOWN_COLUMNS,
  PLATFORM_HEADERS,
  PLATFORM_LEGACY_HEADERS,
  PLATFORM_SHEET_LAYOUTS
} from "./daily-records.mjs";
import { compareDateStrings, parseDateStringParts, pad } from "./date-utils.mjs";

export const REQUIRED_FEISHU_ENV = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_SHEET_DOUYIN",
  "FEISHU_SHEET_XHS",
  "FEISHU_SHEET_BILIBILI"
];

const SHEET_ENV_BY_PLATFORM = {
  douyin: "FEISHU_SHEET_DOUYIN",
  xhs: "FEISHU_SHEET_XHS",
  bilibili: "FEISHU_SHEET_BILIBILI",
  step15: "FEISHU_SHEET_STEP15_FILTERED"
};
const DROPDOWN_MAX_ROW = 5000;
const READ_CHUNK_SIZE = 5000;
const MATERIAL_ROW_STYLE = {
  backColor: "#FFFFFF"
};
const SEPARATOR_ROW_STYLE = {
  backColor: "#FEF258"
};

export function validateFeishuConfig(env = process.env) {
  const missing = REQUIRED_FEISHU_ENV.filter((key) => !String(env[key] || "").trim());
  if (!String(env.FEISHU_SPREADSHEET_TOKEN || "").trim() && !String(env.FEISHU_WIKI_TOKEN || "").trim()) {
    missing.push("FEISHU_SPREADSHEET_TOKEN 或 FEISHU_WIKI_TOKEN");
  }
  return {
    ok: missing.length === 0,
    missing,
    message: missing.length
      ? `缺少飞书配置：${missing.join(", ")}。请复制 .env.example 为 .env 后填入 wiki token 或普通表格 token，以及 sheet_id。`
      : "飞书普通表格配置完整。"
  };
}

export function loadFeishuConfig(env = process.env) {
  const validation = validateFeishuConfig(env);
  if (!validation.ok) {
    const error = new Error(validation.message);
    error.missing = validation.missing;
    throw error;
  }

  const sheets = {
    douyin: env.FEISHU_SHEET_DOUYIN.trim(),
    xhs: env.FEISHU_SHEET_XHS.trim(),
    bilibili: env.FEISHU_SHEET_BILIBILI.trim()
  };
  const step15Sheet = String(env.FEISHU_SHEET_STEP15_FILTERED || "").trim();
  if (step15Sheet) {
    sheets.step15 = step15Sheet;
  }

  return {
    appId: env.FEISHU_APP_ID.trim(),
    appSecret: env.FEISHU_APP_SECRET.trim(),
    spreadsheetToken: String(env.FEISHU_SPREADSHEET_TOKEN || "").trim(),
    wikiToken: String(env.FEISHU_WIKI_TOKEN || "").trim(),
    apiBaseUrl: String(env.FEISHU_OPEN_BASE_URL || "https://open.feishu.cn").replace(/\/+$/, ""),
    sheets
  };
}

export async function writeDailyPlatformRecords({ platformId, targetDate, items, client }) {
  const records = buildDailySheetRecords(platformId, targetDate, items);
  const existingRows = await client.readRows(platformId);
  const newRecords = filterNewDailySheetRecords(platformId, records, existingRows);
  const dataStartRow = dataStartRowFor(client, platformId);
  const existingDateBlocks = dateBlocksFromExistingRows(platformId, targetDate, existingRows, dataStartRow);
  const separatorRows = separatorRowNumbersFromDateBlocks(existingDateBlocks, targetDate);
  let wroteRecords = false;
  if (newRecords.length > 0) {
    const startInsertRow = insertRowForNewRecords(existingDateBlocks, newRecords, existingRows, targetDate, dataStartRow);
    const writeResult = await client.prependRows(
      platformId,
      newRecords.map((record) => mapDailyRecordToSheetRow(platformId, record)),
      startInsertRow
    );
    wroteRecords = true;
    const startRow = startRowFromWriteResult(writeResult);
    separatorRows.push(...separatorRowNumbersFromNewRecords(newRecords, startRow));
  }
  const rowsAfterWrite = wroteRecords ? await client.readRows(platformId) : existingRows;
  const rowsAfterWriteDataStartRow = dataStartRowFor(client, platformId);
  await renumberTargetDateBatch(platformId, targetDate, client, rowsAfterWrite, rowsAfterWriteDataStartRow);
  await clearTargetDateMaterialRowHighlights(platformId, targetDate, client, rowsAfterWrite, rowsAfterWriteDataStartRow);
  separatorRows.push(...allSeparatorRowNumbersFromRows(platformId, targetDate, rowsAfterWrite, rowsAfterWriteDataStartRow));
  if (separatorRows.length > 0 && typeof client.highlightSeparatorRows === "function") {
    await client.highlightSeparatorRows(platformId, uniqueRowNumbers(separatorRows));
  }
  return {
    total: records.length,
    created: newRecords.length,
    skipped: records.length - newRecords.length
  };
}

export class FeishuSheetsClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.tenantAccessToken = options.tenantAccessToken || "";
    this.detectedSheetLayouts = {};
  }

  async getTenantAccessToken() {
    if (this.tenantAccessToken) return this.tenantAccessToken;
    const response = await this.requestRaw("/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret
      }),
      auth: false
    });
    this.tenantAccessToken = response.tenant_access_token;
    if (!this.tenantAccessToken) throw new Error("飞书未返回 tenant_access_token。");
    return this.tenantAccessToken;
  }

  async getSpreadsheetToken() {
    if (this.config.spreadsheetToken) return this.config.spreadsheetToken;
    if (!this.config.wikiToken) throw new Error("缺少 FEISHU_SPREADSHEET_TOKEN 或 FEISHU_WIKI_TOKEN。");

    const data = await this.requestJson(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(this.config.wikiToken)}`);
    const node = data.node || {};
    const objType = String(node.obj_type || node.objType || "").toLowerCase();
    const objToken = node.obj_token || node.objToken || "";
    if (objType && objType !== "sheet") {
      throw new Error(`Wiki 节点不是普通表格，当前类型：${objType}`);
    }
    if (!objToken) {
      throw new Error("Wiki 节点未返回普通表格 token。请确认应用有 wiki:node:read 权限，并能访问该知识库节点。");
    }

    this.config.spreadsheetToken = objToken;
    return objToken;
  }

  async listSheets() {
    const spreadsheetToken = await this.getSpreadsheetToken();
    const data = await this.requestJson(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`);
    return data.sheets || data.items || [];
  }

  async readRows(platformId) {
    const sheetId = this.sheetId(platformId);
    const spreadsheetToken = await this.getSpreadsheetToken();
    const columnEnd = columnName(PLATFORM_HEADERS[platformId].length);
    const rowCount = Math.max(1, await this.sheetRowCount(platformId));
    const values = [];
    for (let rowStart = 1; rowStart <= rowCount; rowStart += READ_CHUNK_SIZE) {
      const rowEnd = Math.min(rowCount, rowStart + READ_CHUNK_SIZE - 1);
      const range = encodeURIComponent(`${sheetId}!A${rowStart}:${columnEnd}${rowEnd}`);
      const data = await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${range}`);
      values.push(...(data.valueRange?.values || data.values || []));
    }
    const headerIndex = detectHeaderIndex(platformId, values);
    const dataStartRow = headerIndex + 2;
    this.detectedSheetLayouts[platformId] = {
      headerRow: headerIndex + 1,
      dataStartRow
    };
    return values.slice(dataStartRow - 1);
  }

  async readSheetRows(sheetKey, columnCount) {
    const sheetId = this.sheetId(sheetKey);
    const spreadsheetToken = await this.getSpreadsheetToken();
    const columnEnd = columnName(columnCount);
    const rowCount = Math.max(1, await this.sheetRowCount(sheetKey));
    const values = [];
    for (let rowStart = 1; rowStart <= rowCount; rowStart += READ_CHUNK_SIZE) {
      const rowEnd = Math.min(rowCount, rowStart + READ_CHUNK_SIZE - 1);
      const range = encodeURIComponent(`${sheetId}!A${rowStart}:${columnEnd}${rowEnd}`);
      const data = await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${range}`);
      values.push(...(data.valueRange?.values || data.values || []));
    }
    return values;
  }

  async replaceSheetRows(sheetKey, rows, columnCount) {
    const sheetId = this.sheetId(sheetKey);
    const rowCount = Math.max(rows.length, await this.sheetRowCount(sheetKey));
    const columnEnd = columnName(columnCount);
    const blankRow = Array.from({ length: columnCount }, () => "");
    const paddedRows = [
      ...rows,
      ...Array.from({ length: Math.max(0, rowCount - rows.length) }, () => blankRow)
    ];
    return await this.writeRows(sheetKey, `${sheetId}!A1:${columnEnd}${paddedRows.length}`, paddedRows);
  }

  async replaceSheetDataRows(sheetKey, rows, columnCount) {
    const sheetId = this.sheetId(sheetKey);
    const layout = this.sheetLayout(sheetKey);
    const rowCount = Math.max(layout.dataStartRow, await this.sheetRowCount(sheetKey));
    const columnEnd = columnName(columnCount);
    const blankRow = Array.from({ length: columnCount }, () => "");
    const paddedRows = [
      ...rows,
      ...Array.from({ length: Math.max(0, rowCount - layout.dataStartRow + 1 - rows.length) }, () => blankRow)
    ];
    return await this.writeRows(
      sheetKey,
      `${sheetId}!A${layout.dataStartRow}:${columnEnd}${layout.dataStartRow + paddedRows.length - 1}`,
      paddedRows
    );
  }

  async appendRows(platformId, rows) {
    if (rows.length === 0) return;
    const sheetId = this.sheetId(platformId);
    const spreadsheetToken = await this.getSpreadsheetToken();
    const columnEnd = columnName(PLATFORM_HEADERS[platformId].length);
    const rowEnd = rows.length;
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_append`, {
      method: "POST",
      body: JSON.stringify({
        valueRange: {
          range: `${sheetId}!A1:${columnEnd}${rowEnd}`,
          values: rows
        }
      })
    });
  }

  async prependRows(platformId, rows, startRow = null) {
    if (rows.length === 0) return;
    const sheetId = this.sheetId(platformId);
    const columnEnd = columnName(PLATFORM_HEADERS[platformId].length);
    const dataStartRow = this.dataStartRow(platformId);
    const rowStart = Math.max(1, Number(startRow) || dataStartRow);
    const rowEnd = rowStart + rows.length - 1;
    await this.insertRows(platformId, rowStart, rows.length);
    return await this.writeRows(platformId, `${sheetId}!A${rowStart}:${columnEnd}${rowEnd}`, rows);
  }

  async insertRowsBefore(sheetKey, startRow, length) {
    const sheetId = this.sheetId(sheetKey);
    const spreadsheetToken = await this.getSpreadsheetToken();
    const startIndex = Math.max(0, Number(startRow) - 1);
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/insert_dimension_range`, {
      method: "POST",
      body: JSON.stringify({
        dimension: {
          sheetId,
          majorDimension: "ROWS",
          startIndex,
          endIndex: startIndex + length
        },
        inheritStyle: "BEFORE"
      })
    });
  }

  async insertRows(platformId, startRow, length) {
    const sheetId = this.sheetId(platformId);
    const spreadsheetToken = await this.getSpreadsheetToken();
    const startIndex = Math.max(1, Number(startRow) - 1);
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/insert_dimension_range`, {
      method: "POST",
      body: JSON.stringify({
        dimension: {
          sheetId,
          majorDimension: "ROWS",
          startIndex,
          endIndex: startIndex + length
        },
        inheritStyle: "BEFORE"
      })
    });
  }

  async writeRows(platformId, range, rows) {
    const spreadsheetToken = await this.getSpreadsheetToken();
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`, {
      method: "PUT",
      body: JSON.stringify({
        valueRange: {
          range,
          values: rows
        }
      })
    });
  }

  async configurePlatformDropdowns(platformId) {
    const sheetId = this.sheetId(platformId);
    const headers = PLATFORM_HEADERS[platformId];
    const dataStartRow = this.dataStartRow(platformId);
    const rowEnd = Math.min(DROPDOWN_MAX_ROW, Math.max(dataStartRow, await this.sheetRowCount(platformId)));
    for (const dropdown of PLATFORM_DROPDOWN_COLUMNS[platformId] || []) {
      const columnIndex = headers.indexOf(dropdown.header) + 1;
      if (columnIndex <= 0) continue;
      const column = columnName(columnIndex);
      await this.setDropdown(`${sheetId}!${column}${dataStartRow}:${column}${rowEnd}`, dropdown.values, dropdown.colors);
    }
  }

  async sheetRowCount(platformId) {
    const sheetId = this.sheetId(platformId);
    const sheets = await this.listSheets();
    const sheet = sheets.find((item) => {
      const properties = item.properties || item;
      return properties.sheet_id === sheetId || properties.sheetId === sheetId || properties.id === sheetId;
    });
    const properties = sheet?.properties || sheet || {};
    const gridProperties = properties.grid_properties || properties.gridProperties || {};
    return Number(gridProperties.row_count || gridProperties.rowCount || properties.row_count || properties.rowCount || 200);
  }

  async setDropdown(range, values, colors = []) {
    const spreadsheetToken = await this.getSpreadsheetToken();

    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/dataValidation`, {
      method: "POST",
      body: JSON.stringify({
        range,
        dataValidationType: "list",
        dataValidation: {
          conditionValues: values,
          options: {
            multipleValues: false,
            highlightValidData: true,
            colors
          }
        }
      })
    });
  }

  async highlightSeparatorRows(platformId, rowNumbers) {
    const sheetId = this.sheetId(platformId);
    const columnEnd = columnName(PLATFORM_HEADERS[platformId].length);
    const uniqueRowNumbers = [...new Set(rowNumbers)]
      .map((rowNumber) => Number(rowNumber))
      .filter((rowNumber) => Number.isInteger(rowNumber) && rowNumber > 0);

    for (const rowNumber of uniqueRowNumbers) {
      await this.setRangeStyle(`${sheetId}!A${rowNumber}:${columnEnd}${rowNumber}`, SEPARATOR_ROW_STYLE);
    }
  }

  async clearMaterialRowHighlights(platformId, rowRanges) {
    const sheetId = this.sheetId(platformId);
    const columnEnd = columnName(PLATFORM_HEADERS[platformId].length);
    const ranges = normalizeRowRanges(rowRanges);

    for (const range of ranges) {
      await this.setRangeStyle(`${sheetId}!A${range.startRow}:${columnEnd}${range.endRow}`, MATERIAL_ROW_STYLE);
    }
  }

  async setRangeStyle(range, style) {
    const spreadsheetToken = await this.getSpreadsheetToken();
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/style`, {
      method: "PUT",
      body: JSON.stringify({
        appendStyle: {
          range,
          style
        }
      })
    });
  }

  async renameSheet(sheetKey, title) {
    const sheetId = this.sheetId(sheetKey);
    return await this.operateSheets([
      {
        updateSheet: {
          properties: {
            sheetId,
            title
          }
        }
      }
    ]);
  }

  async freezeRows(sheetKey, frozenRowCount) {
    const sheetId = this.sheetId(sheetKey);
    return await this.operateSheets([
      {
        updateSheet: {
          properties: {
            sheetId,
            frozenRowCount
          }
        }
      }
    ]);
  }

  async mergeCells(sheetKey, range, mergeType = "MERGE_ALL") {
    const spreadsheetToken = await this.getSpreadsheetToken();
    const sheetId = this.sheetId(sheetKey);
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/merge_cells`, {
      method: "POST",
      body: JSON.stringify({
        range: range.includes("!") ? range : `${sheetId}!${range}`,
        mergeType
      })
    });
  }

  async operateSheets(requests) {
    const spreadsheetToken = await this.getSpreadsheetToken();
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets_batch_update`, {
      method: "POST",
      body: JSON.stringify({ requests })
    });
  }

  async readHeader(platformId) {
    const sheetId = this.sheetId(platformId);
    const spreadsheetToken = await this.getSpreadsheetToken();
    const columnEnd = columnName(PLATFORM_HEADERS[platformId].length);
    const headerRow = this.headerRow(platformId);
    const range = encodeURIComponent(`${sheetId}!A1:${columnEnd}${headerRow}`);
    const data = await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${range}`);
    const values = data.valueRange?.values || data.values || [];
    const headerIndex = detectHeaderIndex(platformId, values);
    return values[headerIndex] || [];
  }

  async verifySheet(platformId) {
    const sheetId = this.sheetId(platformId);
    const sheets = await this.listSheets();
    const sheetExists = sheets.some((sheet) => {
      const properties = sheet.properties || sheet;
      return properties.sheet_id === sheetId || properties.sheetId === sheetId || properties.id === sheetId;
    });
    const header = sheetExists ? await this.readHeader(platformId) : [];
    const missingHeaders = PLATFORM_HEADERS[platformId].filter((headerName, index) => header[index] !== headerName);
    return {
      ok: sheetExists && missingHeaders.length === 0,
      sheetExists,
      missingHeaders,
      header,
      sheets
    };
  }

  sheetId(platformId) {
    const sheetId = this.config.sheets[platformId];
    if (!sheetId) throw new Error(`缺少 ${SHEET_ENV_BY_PLATFORM[platformId]}。`);
    return sheetId;
  }

  sheetLayout(sheetKey) {
    return this.detectedSheetLayouts[sheetKey] || PLATFORM_SHEET_LAYOUTS[sheetKey] || { headerRow: 1, dataStartRow: 2 };
  }

  headerRow(sheetKey) {
    return this.sheetLayout(sheetKey).headerRow;
  }

  dataStartRow(sheetKey) {
    return this.sheetLayout(sheetKey).dataStartRow;
  }

  async requestJson(path, options = {}) {
    const payload = await this.requestRaw(path, {
      ...options,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(options.headers || {})
      }
    });
    if (payload.code !== 0) {
      throw new Error(formatFeishuApiError(payload, path, options));
    }
    return payload.data || {};
  }

  async requestRaw(path, options = {}) {
    const auth = options.auth !== false;
    const headers = { ...(options.headers || {}) };
    if (auth) headers.Authorization = `Bearer ${await this.getTenantAccessToken()}`;
    const response = await this.fetch(`${this.config.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
      ...options,
      headers
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`飞书 HTTP ${response.status}：${payload.msg || payload.message || text}`);
    }
    return payload;
  }
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

function formatFeishuApiError(payload, path, options = {}) {
  const message = payload.msg || payload.message || payload.code;
  const details = [apiPathContext(path), requestBodyContext(options.body)].filter(Boolean);
  return details.length
    ? `飞书 API 调用失败：${message}（${details.join("；")}）`
    : `飞书 API 调用失败：${message}`;
}

function apiPathContext(path) {
  const sanitized = String(path || "")
    .replace(/(\/spreadsheets\/)[^/?]+/g, "$1<token>")
    .replace(/([?&]token=)[^&]+/g, "$1<token>");
  return sanitized ? `接口：${sanitized}` : "";
}

function requestBodyContext(body) {
  if (!body) return "";
  let parsed;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return "";
  }

  const range = parsed.range || parsed.valueRange?.range;
  if (range) return `range: ${range}`;

  const dimension = parsed.dimension;
  if (dimension) {
    return [
      "dimension:",
      dimension.sheetId,
      dimension.majorDimension,
      `${dimension.startIndex}-${dimension.endIndex}`
    ].filter(Boolean).join(" ");
  }

  return "";
}

function separatorRowNumbersFromDateBlocks(dateBlocks, targetDate) {
  return dateBlocks
    .filter((block) => block.date === targetDate)
    .map((block) => block.startRow);
}

function allSeparatorRowNumbersFromRows(platformId, targetDate, rows, dataStartRow = 2) {
  return dateBlocksFromExistingRows(platformId, targetDate, rows, dataStartRow)
    .map((block) => block.startRow);
}

function uniqueRowNumbers(rowNumbers) {
  return [...new Set(rowNumbers)]
    .map((rowNumber) => Number(rowNumber))
    .filter((rowNumber) => Number.isInteger(rowNumber) && rowNumber > 0);
}

function separatorRowNumbersFromNewRecords(records, startRow) {
  if (!startRow) return [];
  return records
    .map((record, index) => (record.kind === "separator" ? startRow + index : null))
    .filter(Boolean);
}

function insertRowForNewRecords(dateBlocks, records, existingRows, targetDate, dataStartRow = 2) {
  const hasNewSeparator = records.some((record) => record.kind === "separator");
  const targetBlock = dateBlocks.find((block) => block.date === targetDate);
  if (!hasNewSeparator && targetBlock) {
    return targetBlock.endRowExclusive;
  }

  if (hasNewSeparator) {
    const olderBlock = dateBlocks.find((block) => compareDateStrings(block.date, targetDate) < 0);
    return olderBlock ? olderBlock.startRow : lastOccupiedSheetRow(existingRows, dataStartRow) + 1;
  }

  return dataStartRow;
}

function dateBlocksFromExistingRows(platformId, targetDate, existingRows, dataStartRow = 2) {
  const blocks = [];
  for (let index = 0; index < (existingRows || []).length; index += 1) {
    const batchTitle = rowFieldValue(platformId, existingRows[index], "投稿时间");
    const monthDay = parseBatchTitle(batchTitle);
    if (!monthDay) continue;

    const nextSeparatorIndex = nextSeparatorRowIndex(platformId, existingRows, index + 1);
    const date = dateForExistingBlock(platformId, targetDate, existingRows, index + 1, nextSeparatorIndex, monthDay);
    if (date) {
      blocks.push({
        date,
        startRow: index + dataStartRow,
        endRowExclusive: nextSeparatorIndex + dataStartRow
      });
    }
  }
  return blocks;
}

async function renumberTargetDateBatch(platformId, targetDate, client, rows, dataStartRow = 2) {
  if (typeof client.writeRows !== "function" || typeof client.sheetId !== "function") return;
  const materialRows = materialRowNumbersForTargetDateBatch(platformId, targetDate, rows, dataStartRow);
  if (materialRows.length === 0) return;

  const materialRowSet = new Set(materialRows);
  const rowStart = materialRows[0];
  const rowEnd = materialRows.at(-1);
  let sequence = 1;
  const values = [];
  for (let rowNumber = rowStart; rowNumber <= rowEnd; rowNumber += 1) {
    values.push([materialRowSet.has(rowNumber) ? String(sequence++) : ""]);
  }

  await client.writeRows(platformId, `${client.sheetId(platformId)}!A${rowStart}:A${rowEnd}`, values);
}

async function clearTargetDateMaterialRowHighlights(platformId, targetDate, client, rows, dataStartRow = 2) {
  if (typeof client.clearMaterialRowHighlights !== "function") return;
  const materialRows = materialRowNumbersForTargetDateBatch(platformId, targetDate, rows, dataStartRow);
  if (materialRows.length === 0) return;
  await client.clearMaterialRowHighlights(platformId, rowRangesFromRowNumbers(materialRows));
}

function materialRowNumbersForTargetDateBatch(platformId, targetDate, rows, dataStartRow = 2) {
  const targetBlock = dateBlocksFromExistingRows(platformId, targetDate, rows, dataStartRow)
    .find((block) => block.date === targetDate);
  if (!targetBlock) return [];

  const materialRows = [];
  for (let rowNumber = targetBlock.startRow + 1; rowNumber < targetBlock.endRowExclusive; rowNumber += 1) {
    const row = rows[rowNumber - dataStartRow];
    if (isMaterialRow(platformId, row)) materialRows.push(rowNumber);
  }
  return materialRows;
}

function rowRangesFromRowNumbers(rowNumbers) {
  const sortedRows = [...new Set(rowNumbers)]
    .map((rowNumber) => Number(rowNumber))
    .filter((rowNumber) => Number.isInteger(rowNumber) && rowNumber > 0)
    .sort((left, right) => left - right);
  const ranges = [];
  for (const rowNumber of sortedRows) {
    const previousRange = ranges.at(-1);
    if (previousRange && previousRange.endRow + 1 === rowNumber) {
      previousRange.endRow = rowNumber;
    } else {
      ranges.push({ startRow: rowNumber, endRow: rowNumber });
    }
  }
  return ranges;
}

function normalizeRowRanges(rowRanges) {
  return (rowRanges || [])
    .map((range) => ({
      startRow: Number(range?.startRow),
      endRow: Number(range?.endRow)
    }))
    .filter((range) => (
      Number.isInteger(range.startRow)
      && Number.isInteger(range.endRow)
      && range.startRow > 0
      && range.endRow >= range.startRow
    ));
}

function nextSeparatorRowIndex(platformId, rows, startIndex) {
  for (let index = startIndex; index < (rows || []).length; index += 1) {
    if (parseBatchTitle(rowFieldValue(platformId, rows[index], "投稿时间"))) {
      return index;
    }
  }
  return (rows || []).length;
}

function dateForExistingBlock(platformId, targetDate, rows, startIndex, endIndex, monthDay) {
  const materialDate = materialDateFromBlockRows(platformId, rows, startIndex, endIndex, monthDay);
  if (materialDate) return materialDate;

  const { year } = parseDateStringParts(targetDate);
  const fallbackDate = `${year}-${monthDay.month}-${monthDay.day}`;
  try {
    parseDateStringParts(fallbackDate);
    return fallbackDate;
  } catch {
    return "";
  }
}

function materialDateFromBlockRows(platformId, rows, startIndex, endIndex, monthDay) {
  for (let index = startIndex; index < endIndex; index += 1) {
    const sequence = rowFieldValue(platformId, rows[index], "编号");
    const match = String(sequence || "").match(/^(20\d{2}-\d{2}-\d{2})-\d+$/);
    if (match && match[1].slice(5, 7) === monthDay.month && match[1].slice(8, 10) === monthDay.day) {
      return match[1];
    }
  }
  return "";
}

function parseBatchTitle(value) {
  const match = String(value || "").trim().match(/^(\d{2})(\d{2})\s+投稿视频$/);
  if (!match) return null;
  return {
    month: pad(match[1]),
    day: pad(match[2])
  };
}

function rowFieldValue(platformId, row, header) {
  if (Array.isArray(row)) {
    return row[PLATFORM_HEADERS[platformId].indexOf(header)];
  }
  return row?.fields?.[header] || row?.[header] || "";
}

function isMaterialRow(platformId, row) {
  if (!row) return false;
  if (parseBatchTitle(rowFieldValue(platformId, row, "投稿时间"))) return false;
  return Array.isArray(row)
    ? row.some((value) => String(value || "").trim())
    : Object.values(row?.fields || row || {}).some((value) => String(value || "").trim());
}

function lastOccupiedSheetRow(existingRows, dataStartRow = 2) {
  for (let index = (existingRows || []).length - 1; index >= 0; index -= 1) {
    const row = existingRows[index];
    if (Array.isArray(row) ? row.some((value) => String(value || "").trim()) : Object.keys(row?.fields || row || {}).length > 0) {
      return index + dataStartRow;
    }
  }
  return dataStartRow - 1;
}

function startRowFromWriteResult(result) {
  const range = result?.updates?.updatedRange
    || result?.updates?.updated_range
    || result?.updatedRange
    || result?.updated_range
    || "";
  const match = String(range).match(/![A-Z]+(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function dataStartRowFor(client, sheetKey) {
  return typeof client?.dataStartRow === "function"
    ? client.dataStartRow(sheetKey)
    : 2;
}

function detectHeaderIndex(platformId, values) {
  const headers = PLATFORM_HEADERS[platformId] || [];
  const headerCandidates = [headers, ...(PLATFORM_LEGACY_HEADERS[platformId] || [])];
  const expected = PLATFORM_SHEET_LAYOUTS[platformId]?.headerRow
    ? PLATFORM_SHEET_LAYOUTS[platformId].headerRow - 1
    : 0;
  if (rowStartsWithAnyHeader(values[expected], headerCandidates)) return expected;
  const fallback = values.findIndex((row) => rowStartsWithAnyHeader(row, headerCandidates));
  return fallback >= 0 ? fallback : 0;
}

function rowStartsWithHeaders(row = [], headers = []) {
  return headers.every((header, index) => cellText(row[index]) === header);
}

function rowStartsWithAnyHeader(row = [], headerCandidates = []) {
  return headerCandidates.some((headers) => rowStartsWithHeaders(row, headers));
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
