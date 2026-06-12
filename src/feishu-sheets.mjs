import {
  buildDailySheetRecords,
  filterNewDailySheetRecords,
  mapDailyRecordToFeishuFields,
  mapDailyRecordToSheetRowForHeaders,
  mapDailyRecordToSheetRow,
  materialKeyFromFields,
  materialKeyFromRecord,
  PLATFORM_DROPDOWN_COLUMNS,
  PLATFORM_HEADERS,
  PLATFORM_LEGACY_HEADERS,
  PLATFORM_SHEET_LAYOUTS,
  headersForRow,
  rowToFields,
  rowToFieldsWithHeaders
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
  step15: "FEISHU_SHEET_STEP15_FILTERED",
  douyinHistory: "FEISHU_SHEET_DOUYIN_HISTORY",
  xhsHistory: "FEISHU_SHEET_XHS_HISTORY",
  bilibiliHistory: "FEISHU_SHEET_BILIBILI_HISTORY"
};
const DROPDOWN_MAX_ROW = 5000;
const READ_CHUNK_SIZE = 5000;
const WRITE_CHUNK_SIZE = 1000;
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
  const douyinHistorySheet = String(env.FEISHU_SHEET_DOUYIN_HISTORY || "").trim();
  if (douyinHistorySheet) {
    sheets.douyinHistory = douyinHistorySheet;
  }
  const xhsHistorySheet = String(env.FEISHU_SHEET_XHS_HISTORY || "").trim();
  if (xhsHistorySheet) {
    sheets.xhsHistory = xhsHistorySheet;
  }
  const bilibiliHistorySheet = String(env.FEISHU_SHEET_BILIBILI_HISTORY || "").trim();
  if (bilibiliHistorySheet) {
    sheets.bilibiliHistory = bilibiliHistorySheet;
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
  const dataStartRow = dataStartRowFor(client, platformId);
  const headers = headersForClient(client, platformId);
  const existingLogicRows = rowsWithDetectedFields(platformId, existingRows, detectedHeadersForClient(client, platformId));
  const existingDateBlocks = dateBlocksFromExistingRows(platformId, targetDate, existingLogicRows, dataStartRow);
  const newRecords = withMissingYearSeparator(
    platformId,
    targetDate,
    filterNewDailySheetRecords(platformId, records, existingLogicRows, { targetDate, existingDateBlocks }),
    existingLogicRows,
    dataStartRow
  );
  const styleColumnCount = await styleColumnCountFor(client, platformId);
  const separatorRows = separatorRowNumbersFromDateBlocks(existingDateBlocks, targetDate);
  let updatedRecords = 0;
  let wroteRecords = false;
  if (newRecords.length > 0) {
    const startInsertRow = insertRowForNewRecords(platformId, existingDateBlocks, newRecords, existingLogicRows, targetDate, dataStartRow);
    const writeResult = await client.prependRows(
      platformId,
      newRecords.map((record) => mapDailyRecordToSheetRowForHeaders(platformId, record, headers)),
      startInsertRow
    );
    wroteRecords = true;
    const startRow = startRowFromWriteResult(writeResult);
    separatorRows.push(...separatorRowNumbersFromNewRecords(newRecords, startRow));
  }
  updatedRecords = await refreshExistingDailySheetRecordFields({
    platformId,
    records,
    existingRows: existingLogicRows,
    client,
    dataStartRow,
    headers
  });
  const rowsAfterWrite = wroteRecords ? await client.readRows(platformId) : existingRows;
  const rowsAfterWriteLogic = rowsWithDetectedFields(platformId, rowsAfterWrite, detectedHeadersForClient(client, platformId));
  const rowsAfterWriteDataStartRow = dataStartRowFor(client, platformId);
  await renumberTargetDateBatch(platformId, targetDate, client, rowsAfterWriteLogic, rowsAfterWriteDataStartRow);
  await clearTargetDateMaterialRowHighlights(platformId, targetDate, client, rowsAfterWriteLogic, rowsAfterWriteDataStartRow, styleColumnCount);
  separatorRows.push(...allSeparatorRowNumbersFromRows(platformId, targetDate, rowsAfterWriteLogic, rowsAfterWriteDataStartRow));
  if (separatorRows.length > 0 && typeof client.highlightSeparatorRows === "function") {
    await highlightRows(client, platformId, uniqueRowNumbers(separatorRows), styleColumnCount);
  }
  const totalRecords = Math.max(records.length, newRecords.length);
  return {
    total: totalRecords,
    created: newRecords.length,
    skipped: totalRecords - newRecords.length,
    updated: updatedRecords
  };
}

export class FeishuSheetsClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.tenantAccessToken = options.tenantAccessToken || "";
    this.detectedSheetLayouts = {};
    this.maxRetries = Number.isFinite(Number(options.maxRetries)) ? Number(options.maxRetries) : 6;
    this.retryDelayMs = Number.isFinite(Number(options.retryDelayMs)) ? Number(options.retryDelayMs) : 1200;
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
    const columnEnd = columnName(Math.max(PLATFORM_HEADERS[platformId].length, await this.sheetColumnCount(platformId)));
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
    const headers = normalizeHeaderRow(values[headerIndex], platformId);
    this.detectedSheetLayouts[platformId] = {
      headerRow: headerIndex + 1,
      dataStartRow,
      headers,
      columnByHeader: columnByHeader(headers)
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
    const rowCount = Math.max(rows.length, await this.sheetRowCount(sheetKey));
    const blankRow = Array.from({ length: columnCount }, () => "");
    const paddedRows = [
      ...rows,
      ...Array.from({ length: Math.max(0, rowCount - rows.length) }, () => blankRow)
    ];
    return await this.writeRowsInChunks(sheetKey, 1, columnCount, paddedRows);
  }

  async replaceSheetDataRows(sheetKey, rows, columnCount) {
    const layout = this.sheetLayout(sheetKey);
    const rowCount = Math.max(layout.dataStartRow, await this.sheetRowCount(sheetKey));
    const blankRow = Array.from({ length: columnCount }, () => "");
    const paddedRows = [
      ...rows,
      ...Array.from({ length: Math.max(0, rowCount - layout.dataStartRow + 1 - rows.length) }, () => blankRow)
    ];
    return await this.writeRowsInChunks(sheetKey, layout.dataStartRow, columnCount, paddedRows);
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

  async appendRowsToSheet(sheetKey, rows, columnCount) {
    if (rows.length === 0) return;
    const sheetId = this.sheetId(sheetKey);
    const spreadsheetToken = await this.getSpreadsheetToken();
    const width = Math.max(1, Number(columnCount) || maxRowWidth(rows) || 1);
    const columnEnd = columnName(width);
    const normalizedRows = rows.map((row) => padRow(row, width));
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_append`, {
      method: "POST",
      body: JSON.stringify({
        valueRange: {
          range: `${sheetId}!A1:${columnEnd}${normalizedRows.length}`,
          values: normalizedRows
        }
      })
    });
  }

  async prependRows(platformId, rows, startRow = null) {
    if (rows.length === 0) return;
    const sheetId = this.sheetId(platformId);
    const columnEnd = columnName(this.headerWidth(platformId));
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
    await this.ensureSheetRows(sheetKey, startIndex + length);
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
    await this.ensureSheetRows(platformId, startIndex + length);
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

  async ensureSheetRows(sheetKey, requiredRowCount) {
    const required = Math.ceil(Number(requiredRowCount) || 0);
    if (required <= 0) return;
    const current = await this.sheetRowCount(sheetKey);
    const missing = required - current;
    if (missing <= 0) return;
    return await this.addRows(sheetKey, missing);
  }

  async addRows(sheetKey, length) {
    const count = Math.ceil(Number(length) || 0);
    if (count <= 0) return;
    const sheetId = this.sheetId(sheetKey);
    const spreadsheetToken = await this.getSpreadsheetToken();
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/dimension_range`, {
      method: "POST",
      body: JSON.stringify({
        dimension: {
          sheetId,
          majorDimension: "ROWS",
          length: count
        }
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

  async writeRowsInChunks(sheetKey, startRow, columnCount, rows, chunkSize = WRITE_CHUNK_SIZE) {
    const sheetId = this.sheetId(sheetKey);
    const width = Math.max(1, Number(columnCount) || maxRowWidth(rows) || 1);
    const columnEnd = columnName(width);
    const size = Math.max(1, Number(chunkSize) || WRITE_CHUNK_SIZE);
    const results = [];
    for (let index = 0; index < rows.length; index += size) {
      const chunk = rows.slice(index, index + size).map((row) => padRow(row, width));
      const rowStart = Number(startRow) + index;
      const rowEnd = rowStart + chunk.length - 1;
      results.push(await this.writeRows(sheetKey, `${sheetId}!A${rowStart}:${columnEnd}${rowEnd}`, chunk));
    }
    return results;
  }

  async configurePlatformDropdowns(platformId) {
    const sheetId = this.sheetId(platformId);
    const headers = this.headers(platformId);
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

  async sheetColumnCount(platformId) {
    const sheetId = this.sheetId(platformId);
    const sheets = await this.listSheets();
    const sheet = sheets.find((item) => {
      const properties = item.properties || item;
      return properties.sheet_id === sheetId || properties.sheetId === sheetId || properties.id === sheetId;
    });
    const properties = sheet?.properties || sheet || {};
    const gridProperties = properties.grid_properties || properties.gridProperties || {};
    return Number(gridProperties.column_count || gridProperties.columnCount || properties.column_count || properties.columnCount || PLATFORM_HEADERS[platformId]?.length || 1);
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

  async highlightSeparatorRows(platformId, rowNumbers, { columnCount = null } = {}) {
    const sheetId = this.sheetId(platformId);
    const columnEnd = columnName(Number(columnCount) || PLATFORM_HEADERS[platformId].length);
    const ranges = rowRangesFromRowNumbers(rowNumbers)
      .map((range) => `${sheetId}!A${range.startRow}:${columnEnd}${range.endRow}`);

    if (ranges.length === 0) return;

    try {
      return await this.setRangesStyle(ranges, SEPARATOR_ROW_STYLE);
    } catch {
      // Older Feishu tenants may not support batch style writes; keep a safe fallback.
    }

    for (const range of ranges) {
      await this.setRangeStyle(range, SEPARATOR_ROW_STYLE);
    }
  }

  async clearMaterialRowHighlights(platformId, rowRanges, { columnCount = null } = {}) {
    const sheetId = this.sheetId(platformId);
    const columnEnd = columnName(Number(columnCount) || PLATFORM_HEADERS[platformId].length);
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

  async setRangesStyle(ranges, style) {
    const normalizedRanges = [...new Set(ranges.map((range) => String(range || "").trim()).filter(Boolean))];
    if (normalizedRanges.length === 0) return;
    const spreadsheetToken = await this.getSpreadsheetToken();
    return await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/styles_batch_update`, {
      method: "PUT",
      body: JSON.stringify({
        data: [
          {
            ranges: normalizedRanges,
            style
          }
        ]
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

  async createSheet(title) {
    const data = await this.operateSheets([
      {
        addSheet: {
          properties: {
            title
          }
        }
      }
    ]);
    const reply = (data.replies || data.responses || [])
      .map((item) => item.addSheet || item.add_sheet || item)
      .find((item) => item?.properties || item?.sheetId || item?.sheet_id)
      || data.addSheet
      || data.add_sheet
      || {};
    const properties = reply.properties || reply;
    return {
      sheetId: properties.sheetId || properties.sheet_id || properties.id || "",
      title: properties.title || title,
      properties
    };
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

  async setColumnWidths(sheetKey, widths = []) {
    const sheetId = this.sheetId(sheetKey);
    const spreadsheetToken = await this.getSpreadsheetToken();
    const results = [];
    for (let index = 0; index < widths.length; index += 1) {
      const fixedSize = Math.max(20, Math.round(Number(widths[index]) || 0));
      results.push(await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/dimension_range`, {
        method: "PUT",
        body: JSON.stringify({
          dimension: {
            sheetId,
            majorDimension: "COLUMNS",
            startIndex: index,
            endIndex: index + 1,
            fixedSize
          }
        })
      }));
    }
    return results;
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
    const columnEnd = columnName(Math.max(PLATFORM_HEADERS[platformId].length, await this.sheetColumnCount(platformId)));
    const headerRow = this.headerRow(platformId);
    const range = encodeURIComponent(`${sheetId}!A1:${columnEnd}${headerRow}`);
    const data = await this.requestJson(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${range}`);
    const values = data.valueRange?.values || data.values || [];
    const headerIndex = detectHeaderIndex(platformId, values);
    const headers = normalizeHeaderRow(values[headerIndex], platformId);
    this.detectedSheetLayouts[platformId] = {
      ...this.sheetLayout(platformId),
      headerRow: headerIndex + 1,
      dataStartRow: headerIndex + 2,
      headers,
      columnByHeader: columnByHeader(headers)
    };
    return headers;
  }

  async verifySheet(platformId) {
    const sheetId = this.sheetId(platformId);
    const sheets = await this.listSheets();
    const sheetExists = sheets.some((sheet) => {
      const properties = sheet.properties || sheet;
      return properties.sheet_id === sheetId || properties.sheetId === sheetId || properties.id === sheetId;
    });
    const header = sheetExists ? await this.readHeader(platformId) : [];
    const missingHeaders = PLATFORM_HEADERS[platformId].filter((headerName) => !header.includes(headerName));
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

  headers(sheetKey) {
    return this.sheetLayout(sheetKey).headers || PLATFORM_HEADERS[sheetKey] || [];
  }

  headerWidth(sheetKey) {
    return Math.max(PLATFORM_HEADERS[sheetKey]?.length || 1, this.headers(sheetKey).length || 1);
  }

  async requestJson(path, options = {}) {
    let lastPayload = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const payload = await this.requestRaw(path, {
        ...options,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...(options.headers || {})
        }
      });
      if (payload.code === 0) return payload.data || {};
      lastPayload = payload;
      if (!isFeishuRateLimitPayload(payload) || attempt >= this.maxRetries) break;
      await sleep(retryDelayForAttempt(this.retryDelayMs, attempt));
    }
    if (lastPayload) {
      const payload = lastPayload;
      throw new Error(formatFeishuApiError(payload, path, options));
    }
    throw new Error("飞书 API 调用失败：未返回响应。");
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

function isFeishuRateLimitPayload(payload) {
  const text = `${payload?.code || ""} ${payload?.msg || ""} ${payload?.message || ""}`.toLowerCase();
  return text.includes("too many request") || text.includes("rate limit") || text.includes("too many requests");
}

function retryDelayForAttempt(baseDelayMs, attempt) {
  const base = Math.max(0, Number(baseDelayMs) || 0);
  return Math.min(15000, base * (2 ** attempt));
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
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

function maxRowWidth(rows = []) {
  return Math.max(0, ...rows.map((row) => Array.isArray(row) ? row.length : 0));
}

function padRow(row = [], width = 0) {
  return Array.from({ length: width }, (_, index) => row?.[index] ?? "");
}

function separatorRowNumbersFromDateBlocks(dateBlocks, targetDate) {
  return dateBlocks
    .filter((block) => block.date === targetDate)
    .map((block) => block.startRow);
}

function allSeparatorRowNumbersFromRows(platformId, targetDate, rows, dataStartRow = 2) {
  return [
    ...yearSeparatorRowNumbersFromRows(platformId, rows, dataStartRow),
    ...dateBlocksFromExistingRows(platformId, targetDate, rows, dataStartRow).map((block) => block.startRow)
  ];
}

function yearSeparatorRowNumbersFromRows(platformId, rows, dataStartRow = 2) {
  return yearSeparatorRowsFromExistingRows(platformId, rows, dataStartRow)
    .map((row) => row.rowNumber);
}

async function styleColumnCountFor(client, platformId) {
  if (typeof client?.sheetColumnCount !== "function") return null;
  try {
    const columnCount = Number(await client.sheetColumnCount(platformId));
    return Number.isFinite(columnCount) && columnCount > 0
      ? Math.max(PLATFORM_HEADERS[platformId]?.length || 1, columnCount)
      : null;
  } catch {
    return null;
  }
}

async function highlightRows(client, platformId, rowNumbers, columnCount = null) {
  if (columnCount) {
    return await client.highlightSeparatorRows(platformId, rowNumbers, { columnCount });
  }
  return await client.highlightSeparatorRows(platformId, rowNumbers);
}

async function refreshExistingDailySheetRecordFields({
  platformId,
  records,
  existingRows,
  client,
  dataStartRow = 2,
  headers = PLATFORM_HEADERS[platformId]
}) {
  if (typeof client?.writeRows !== "function" || typeof client?.sheetId !== "function") return 0;

  const recordsByKey = new Map();
  for (const record of records || []) {
    if (record?.kind !== "material") continue;
    const key = materialKeyFromRecord(platformId, record);
    if (key) recordsByKey.set(key, record);
  }
  if (recordsByKey.size === 0) return 0;

  const refreshHeaders = refreshHeadersForPlatform(platformId)
    .filter((header) => (headers || []).includes(header));
  if (refreshHeaders.length === 0) return 0;
  let updated = 0;

  for (let index = 0; index < (existingRows || []).length; index += 1) {
    const existing = existingRows[index];
    const fields = existing?.fields || (Array.isArray(existing) ? rowToFields(platformId, existing) : existing || {});
    const key = materialKeyFromFields(platformId, fields);
    if (!key || !recordsByKey.has(key)) continue;

    const nextRecord = recordsByKey.get(key);
    const rowHeaders = existing?.headers || headers || PLATFORM_HEADERS[platformId];
    const nextFields = mapDailyRecordToFeishuFields(platformId, nextRecord);
    const nextSheetRow = mapDailyRecordToSheetRowForHeaders(platformId, nextRecord, rowHeaders);
    const patches = [];
    for (const header of refreshHeaders) {
      const column = (rowHeaders || []).indexOf(header) + 1;
      if (column <= 0) continue;
      const nextValue = nextSheetRow[column - 1] ?? nextFields[header];
      if (!hasUsefulRefreshValue(nextValue)) continue;
      const currentValue = fields[header];
      if (cellText(currentValue) === cellText(nextValue)) continue;
      patches.push({ column, value: nextValue });
    }
    if (patches.length === 0) continue;

    const rowNumber = index + dataStartRow;
    for (const group of contiguousPatches(patches)) {
      const startColumn = columnName(group[0].column);
      const endColumn = columnName(group[group.length - 1].column);
      await client.writeRows(
        platformId,
        `${client.sheetId(platformId)}!${startColumn}${rowNumber}:${endColumn}${rowNumber}`,
        [group.map((patch) => patch.value)]
      );
    }
    updated += 1;
  }

  return updated;
}

function refreshHeadersForPlatform(platformId) {
  const shared = ["内容类型", "内容类型标签审核", "AI内容判断备注"];
  if (platformId === "douyin") return ["标题", "tag词", "一级类型", "二级类型", ...shared];
  if (platformId === "xhs") return ["标题", "tag词", "一级类型", "二级类型", ...shared];
  if (platformId === "bilibili") return ["标题", "tag词", ...shared];
  return shared;
}

function hasUsefulRefreshValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "object") return Boolean(cellText(value));
  return String(value || "").trim() !== "";
}

function contiguousPatches(patches = []) {
  const sorted = [...patches].sort((left, right) => left.column - right.column);
  const groups = [];
  for (const patch of sorted) {
    const previous = groups.at(-1);
    if (previous && previous.at(-1).column + 1 === patch.column) {
      previous.push(patch);
    } else {
      groups.push([patch]);
    }
  }
  return groups;
}

function uniqueRowNumbers(rowNumbers) {
  return [...new Set(rowNumbers)]
    .map((rowNumber) => Number(rowNumber))
    .filter((rowNumber) => Number.isInteger(rowNumber) && rowNumber > 0)
    .sort((left, right) => left - right);
}

function separatorRowNumbersFromNewRecords(records, startRow) {
  if (!startRow) return [];
  return records
    .map((record, index) => (record.kind === "separator" ? startRow + index : null))
    .filter(Boolean);
}

function withMissingYearSeparator(platformId, targetDate, records, existingRows, dataStartRow = 2) {
  if (!records.some((record) => record.kind === "material")) return records;
  if (!records.some((record) => isDateSeparatorRecord(record))) return records;

  const yearRows = yearSeparatorRowsFromExistingRows(platformId, existingRows, dataStartRow);
  if (yearRows.length === 0) return records;

  const targetYear = String(targetDate || "").slice(0, 4);
  if (!targetYear || yearRows.some((row) => row.year === targetYear)) return records;
  if (records.some((record) => parseYearSeparatorTitle(record?.batchTitle))) return records;

  return [
    {
      kind: "separator",
      platformId,
      targetDate,
      batchTitle: `${targetYear}年投稿`
    },
    ...records
  ];
}

function isDateSeparatorRecord(record) {
  if (record?.kind !== "separator") return false;
  return Boolean(parseBatchTitle(record.batchTitle || ""));
}

function insertRowForNewRecords(platformId, dateBlocks, records, existingRows, targetDate, dataStartRow = 2) {
  const hasNewSeparator = records.some((record) => record.kind === "separator");
  const targetBlock = dateBlocks.find((block) => block.date === targetDate);
  if (!hasNewSeparator && targetBlock) {
    return targetBlock.endRowExclusive;
  }

  if (hasNewSeparator) {
    const targetYear = String(targetDate || "").slice(0, 4);
    const yearRows = yearSeparatorRowsFromExistingRows(platformId, existingRows, dataStartRow);
    const activeYear = yearRows.find((row) => row.year === targetYear);
    if (activeYear) {
      const nextYear = yearRows.find((row) => row.rowNumber > activeYear.rowNumber);
      const yearEndRow = nextYear ? nextYear.rowNumber : lastOccupiedSheetRow(existingRows, dataStartRow) + 1;
      const olderBlockInYear = dateBlocks.find((block) => (
        String(block.date || "").startsWith(`${targetYear}-`)
        && block.startRow > activeYear.rowNumber
        && block.startRow < yearEndRow
        && compareDateStrings(block.date, targetDate) < 0
      ));
      return olderBlockInYear ? olderBlockInYear.startRow : yearEndRow;
    }

    const newYearSeparator = records.find((record) => parseYearSeparatorTitle(record?.batchTitle));
    if (newYearSeparator) {
      const nextOlderYear = yearRows.find((row) => Number(row.year) < Number(targetYear));
      return nextOlderYear ? nextOlderYear.rowNumber : lastOccupiedSheetRow(existingRows, dataStartRow) + 1;
    }

    const olderBlock = dateBlocks.find((block) => compareDateStrings(block.date, targetDate) < 0);
    return olderBlock ? olderBlock.startRow : lastOccupiedSheetRow(existingRows, dataStartRow) + 1;
  }

  return dataStartRow;
}

function dateBlocksFromExistingRows(platformId, targetDate, existingRows, dataStartRow = 2) {
  const blocks = [];
  const { year: targetYear } = parseDateStringParts(targetDate);
  let activeYear = "";
  for (let index = 0; index < (existingRows || []).length; index += 1) {
    const batchTitle = rowFieldValue(platformId, existingRows[index], "投稿时间");
    const yearTitle = parseYearSeparatorTitle(batchTitle);
    if (yearTitle) {
      activeYear = yearTitle;
      continue;
    }
    const monthDay = parseBatchTitle(batchTitle);
    if (!monthDay) continue;

    const nextSeparatorIndex = nextSeparatorRowIndex(platformId, existingRows, index + 1);
    const date = dateForExistingBlock(platformId, targetDate, existingRows, index + 1, nextSeparatorIndex, monthDay, activeYear || targetYear);
    if (date) {
      blocks.push({
        date,
        year: date.slice(0, 4),
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

  let sequence = 1;
  for (const range of rowRangesFromRowNumbers(materialRows)) {
    const values = [];
    for (let rowNumber = range.startRow; rowNumber <= range.endRow; rowNumber += 1) {
      values.push([String(sequence++)]);
    }
    await client.writeRows(platformId, `${client.sheetId(platformId)}!A${range.startRow}:A${range.endRow}`, values);
  }
}

async function clearTargetDateMaterialRowHighlights(platformId, targetDate, client, rows, dataStartRow = 2, columnCount = null) {
  if (typeof client.clearMaterialRowHighlights !== "function") return;
  const materialRows = materialRowNumbersForTargetDateBatch(platformId, targetDate, rows, dataStartRow);
  if (materialRows.length === 0) return;
  const ranges = rowRangesFromRowNumbers(materialRows);
  if (columnCount) {
    await client.clearMaterialRowHighlights(platformId, ranges, { columnCount });
    return;
  }
  await client.clearMaterialRowHighlights(platformId, ranges);
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
    const title = rowFieldValue(platformId, rows[index], "投稿时间");
    if (parseBatchTitle(title) || parseYearSeparatorTitle(title)) {
      return index;
    }
  }
  return (rows || []).length;
}

function dateForExistingBlock(platformId, targetDate, rows, startIndex, endIndex, monthDay, fallbackYear = "") {
  const materialDate = materialDateFromBlockRows(platformId, rows, startIndex, endIndex, monthDay);
  if (materialDate) return materialDate;

  const { year } = fallbackYear ? { year: fallbackYear } : parseDateStringParts(targetDate);
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

function parseYearSeparatorTitle(value) {
  const match = String(value || "").trim().match(/^(20\d{2})年投稿$/);
  return match ? match[1] : "";
}

function yearSeparatorRowsFromExistingRows(platformId, rows, dataStartRow = 2) {
  return (rows || [])
    .map((row, index) => ({
      year: parseYearSeparatorTitle(rowFieldValue(platformId, row, "投稿时间")),
      rowNumber: index + dataStartRow
    }))
    .filter((row) => row.year);
}

function rowFieldValue(platformId, row, header) {
  if (row?.fields && Object.hasOwn(row.fields, header)) return row.fields[header] || "";
  if (Array.isArray(row)) {
    return row[PLATFORM_HEADERS[platformId].indexOf(header)];
  }
  return row?.fields?.[header] || row?.[header] || "";
}

function isMaterialRow(platformId, row) {
  if (!row) return false;
  const title = rowFieldValue(platformId, row, "投稿时间");
  if (parseBatchTitle(title) || parseYearSeparatorTitle(title)) return false;
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
  return headers.every((header) => (row || []).map(cellText).includes(header));
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

function normalizeHeaderRow(row = [], platformId) {
  const currentHeaders = PLATFORM_HEADERS[platformId] || [];
  const raw = (row || []).map((value) => cellText(value).trim());
  let end = raw.length;
  while (end > 0 && !raw[end - 1]) end -= 1;
  const trimmed = raw.slice(0, end);
  if (trimmed.length === 0) return currentHeaders;
  const seen = new Set();
  for (const header of trimmed) {
    if (header) seen.add(header);
  }
  const missing = currentHeaders.filter((header) => !seen.has(header));
  return [...trimmed, ...missing];
}

function columnByHeader(headers = []) {
  return Object.fromEntries((headers || []).map((header, index) => [header, index + 1]).filter(([header]) => header));
}

function headersForClient(client, platformId) {
  if (typeof client?.headers === "function") return client.headers(platformId);
  const layoutHeaders = client?.detectedSheetLayouts?.[platformId]?.headers;
  return layoutHeaders || PLATFORM_HEADERS[platformId] || [];
}

function detectedHeadersForClient(client, platformId) {
  const layoutHeaders = client?.detectedSheetLayouts?.[platformId]?.headers;
  if (layoutHeaders) return layoutHeaders;
  if (client instanceof FeishuSheetsClient && typeof client.headers === "function") return client.headers(platformId);
  return null;
}

function rowsWithDetectedFields(platformId, rows = [], headers = null) {
  return (rows || []).map((row) => {
    if (!Array.isArray(row)) return row;
    if (!headers) {
      const rowHeaders = headersForRow(platformId, row);
      return {
        row,
        headers: rowHeaders,
        fields: rowToFieldsWithHeaders(platformId, row, rowHeaders)
      };
    }
    return {
      row,
      headers,
      fields: rowToFieldsWithHeaders(platformId, row, headers)
    };
  });
}
