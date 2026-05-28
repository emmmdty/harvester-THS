import test from "node:test";
import assert from "node:assert/strict";

import { FeishuSheetsClient } from "../src/feishu-sheets.mjs";

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
