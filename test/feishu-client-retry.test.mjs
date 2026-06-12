import test from "node:test";
import assert from "node:assert/strict";

import { FeishuSheetsClient, loadFeishuConfig, writeDailyPlatformRecords } from "../src/feishu-sheets.mjs";

test("FeishuSheetsClient retries Feishu rate-limit responses", async () => {
  let calls = 0;
  const client = new FeishuSheetsClient(
    {
      appId: "app",
      appSecret: "secret",
      apiBaseUrl: "https://example.test",
      spreadsheetToken: "spreadsheet",
      sheets: { douyin: "douyin", xhs: "xhs", bilibili: "bilibili" }
    },
    {
      tenantAccessToken: "token",
      retryDelayMs: 0,
      maxRetries: 2,
      fetch: async () => ({
        ok: true,
        async text() {
          calls += 1;
          if (calls === 1) return JSON.stringify({ code: 99991400, msg: "too many request" });
          return JSON.stringify({ code: 0, data: { ok: true } });
        }
      })
    }
  );

  const result = await client.requestJson("/open-apis/sheets/v2/spreadsheets/token/style", { method: "PUT" });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test("FeishuSheetsClient extends sheet rows before inserting past current row count", async () => {
  const requests = [];
  const client = new FeishuSheetsClient(
    {
      appId: "app",
      appSecret: "secret",
      apiBaseUrl: "https://example.test",
      spreadsheetToken: "spreadsheet",
      sheets: { douyin: "douyin", xhs: "xhs", bilibili: "bilibili" }
    },
    {
      tenantAccessToken: "token",
      fetch: async (url, options = {}) => {
        requests.push({
          url,
          method: options.method || "GET",
          body: options.body ? JSON.parse(options.body) : null
        });
        if (url.includes("/sheets/query")) {
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                code: 0,
                data: {
                  sheets: [
                    { sheet_id: "douyin", grid_properties: { row_count: 5798 } }
                  ]
                }
              });
            }
          };
        }
        return {
          ok: true,
          async text() {
            return JSON.stringify({ code: 0, data: {} });
          }
        };
      }
    }
  );

  await client.insertRows("douyin", 5799, 10);

  const writeRequests = requests.filter((request) => request.method !== "GET");
  assert.match(writeRequests[0].url, /\/dimension_range$/);
  assert.deepEqual(writeRequests[0].body, {
    dimension: {
      sheetId: "douyin",
      majorDimension: "ROWS",
      length: 10
    }
  });
  assert.match(writeRequests[1].url, /\/insert_dimension_range$/);
  assert.deepEqual(writeRequests[1].body.dimension, {
    sheetId: "douyin",
    majorDimension: "ROWS",
    startIndex: 5798,
    endIndex: 5808
  });
});

test("loadFeishuConfig includes optional history sheet ids", () => {
  const config = loadFeishuConfig({
    FEISHU_APP_ID: "cli_xxx",
    FEISHU_APP_SECRET: "secret",
    FEISHU_SPREADSHEET_TOKEN: "sht_xxx",
    FEISHU_WIKI_TOKEN: "",
    FEISHU_SHEET_DOUYIN: "douyin",
    FEISHU_SHEET_XHS: "xhs",
    FEISHU_SHEET_BILIBILI: "bilibili",
    FEISHU_SHEET_DOUYIN_HISTORY: "douyinHistory",
    FEISHU_SHEET_XHS_HISTORY: "xhsHistory",
    FEISHU_SHEET_BILIBILI_HISTORY: "bilibiliHistory"
  });

  assert.equal(config.sheets.douyinHistory, "douyinHistory");
  assert.equal(config.sheets.xhsHistory, "xhsHistory");
  assert.equal(config.sheets.bilibiliHistory, "bilibiliHistory");
});

test("FeishuSheetsClient can create a sheet and append generic-width rows", async () => {
  const requests = [];
  const client = new FeishuSheetsClient(
    {
      appId: "app",
      appSecret: "secret",
      apiBaseUrl: "https://example.test",
      spreadsheetToken: "spreadsheet",
      sheets: { douyinHistory: "historySheet" }
    },
    {
      tenantAccessToken: "token",
      fetch: async (url, options = {}) => {
        requests.push({
          url,
          method: options.method || "GET",
          body: options.body ? JSON.parse(options.body) : null
        });
        return {
          ok: true,
          async text() {
            if (url.endsWith("/sheets_batch_update")) {
              return JSON.stringify({
                code: 0,
                data: {
                  replies: [
                    { addSheet: { properties: { sheetId: "createdSheet", title: "抖音历史台账" } } }
                  ]
                }
              });
            }
            return JSON.stringify({ code: 0, data: {} });
          }
        };
      }
    }
  );

  const created = await client.createSheet("抖音历史台账");
  await client.appendRowsToSheet("douyinHistory", [["账号", "https://www.douyin.com/video/1"]], 14);

  assert.equal(created.sheetId, "createdSheet");
  const appendRequest = requests.find((request) => request.url.endsWith("/values_append"));
  assert.equal(appendRequest.body.valueRange.range, "historySheet!A1:N1");
  assert.equal(typeof appendRequest.body.valueRange.values[0][1], "string");
});

test("FeishuSheetsClient updates column widths using column dimensions", async () => {
  const requests = [];
  const client = new FeishuSheetsClient(
    {
      appId: "app",
      appSecret: "secret",
      apiBaseUrl: "https://example.test",
      spreadsheetToken: "spreadsheet",
      sheets: { douyinHistory: "historySheet" }
    },
    {
      tenantAccessToken: "token",
      fetch: async (url, options = {}) => {
        requests.push({
          url,
          method: options.method || "GET",
          body: options.body ? JSON.parse(options.body) : null
        });
        return {
          ok: true,
          async text() {
            return JSON.stringify({ code: 0, data: {} });
          }
        };
      }
    }
  );

  await client.setColumnWidths("douyinHistory", [120, 560]);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.body.dimension), [
    {
      sheetId: "historySheet",
      majorDimension: "COLUMNS",
      startIndex: 0,
      endIndex: 1,
      fixedSize: 120
    },
    {
      sheetId: "historySheet",
      majorDimension: "COLUMNS",
      startIndex: 1,
      endIndex: 2,
      fixedSize: 560
    }
  ]);
});

test("writeDailyPlatformRecords renumbers sparse target date batches in compact writes", async () => {
  const writes = [];
  const client = {
    sheetId: () => "douyin",
    dataStartRow: () => 5,
    async readRows() {
      const rows = [
        ["", "0301 投稿视频", "", "", "", "", "", "", "", "", ""],
        ["1", "03 01", "old-link", "", "", "", "", "投资号", "", "", ""]
      ];
      for (let index = 0; index < 20; index += 1) rows.push(["", "", "", "", "", "", "", "", "", "", ""]);
      rows.push(["22", "03 01", "new-link", "", "", "", "", "投资号", "", "", ""]);
      rows.push(["", "0302 投稿视频", "", "", "", "", "", "", "", "", ""]);
      return rows;
    },
    async prependRows() {
      return { updates: { updatedRange: "douyin!A27:K27" } };
    },
    async writeRows(platformId, range, values) {
      writes.push({ platformId, range, values });
    }
  };

  await writeDailyPlatformRecords({
    platformId: "douyin",
    targetDate: "2026-03-01",
    items: [
      {
        link: "new-link",
        accountName: "投资号",
        title: "新标题",
        tags: "#投资",
        publishedAt: "2026-03-01"
      }
    ],
    client
  });

  assert.deepEqual(writes.filter((write) => /^douyin!A\d+:A\d+$/u.test(write.range)), [
    { platformId: "douyin", range: "douyin!A6:A6", values: [["1"]] },
    { platformId: "douyin", range: "douyin!A27:A27", values: [["2"]] }
  ]);
});
