import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadPanelSettings,
  panelSettingsEnv,
  panelSettingsPath,
  publicPanelSettings,
  savePanelSettings
} from "../src/panel-settings.mjs";
import { checkDeepSeek, checkMiniMax } from "../src/config-checks.mjs";

test("panel settings store secrets encrypted under ignored runtime config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "panel-settings-"));
  const saved = await savePanelSettings({
    root,
    settings: {
      feishu: {
        appId: "cli_test",
        appSecret: "feishu-secret",
        spreadsheetToken: "spreadsheet-token",
        wikiToken: "",
        sheets: {
          douyin: "douyinSheet",
          xhs: "xhsSheet",
          bilibili: "bilibiliSheet"
        }
      },
      minimax: {
        apiKey: "sk-minimax-secret",
        baseUrl: "https://api.minimaxi.com/v1",
        model: "MiniMax-M3"
      },
      deepseek: {
        apiKey: "sk-deepseek-secret",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat"
      },
      cache: {
        retentionDays: 45
      }
    },
    secret: "unit-test-secret"
  });

  assert.equal(saved.ok, true);
  const filePath = panelSettingsPath(root);
  assert.match(filePath, /\.runtime\/panel-settings\.secure\.json$/u);
  const raw = await fs.readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /sk-minimax-secret|sk-deepseek-secret|feishu-secret|spreadsheet-token/u);

  const loaded = await loadPanelSettings({ root, secret: "unit-test-secret" });
  assert.equal(loaded.minimax.apiKey, "sk-minimax-secret");
  assert.equal(loaded.deepseek.apiKey, "sk-deepseek-secret");
  assert.equal(loaded.deepseek.model, "deepseek-v4-flash");
  assert.equal(loaded.cache.retentionDays, 45);

  const summary = publicPanelSettings(loaded);
  assert.equal(summary.minimax.apiKey.set, true);
  assert.equal(summary.minimax.apiKey.last4, "cret");
  assert.equal(summary.deepseek.apiKey.set, true);
  assert.equal(summary.deepseek.apiKey.last4, "cret");
  assert.equal(summary.feishu.appSecret.set, true);
  assert.equal(summary.feishu.appSecret.value, undefined);
  assert.equal(summary.minimax.apiKey.value, undefined);
});

test("panel settings can merge with env for provider checks without exposing secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "panel-settings-env-"));
  await savePanelSettings({
    root,
    settings: {
      minimax: {
        apiKey: "sk-mm",
        baseUrl: "https://api.minimaxi.com/v1",
        model: "MiniMax-M3"
      },
      deepseek: {
        apiKey: "sk-ds",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat"
      }
    },
    secret: "unit-test-secret"
  });
  const settings = await loadPanelSettings({ root, secret: "unit-test-secret" });
  const env = panelSettingsEnv(settings, {});
  assert.equal(env.MINIMAX_API_KEY, "sk-mm");
  assert.equal(env.MINIMAX_BASE_URL, "https://api.minimaxi.com/v1");
  assert.equal(env.DEEPSEEK_API_KEY, "sk-ds");
  assert.equal(env.DEEPSEEK_BASE_URL, "https://api.deepseek.com");
  assert.equal(env.DEEPSEEK_MODEL, "deepseek-v4-flash");

  const minimaxCalls = [];
  const miniMaxCheck = await checkMiniMax({
    env,
    fetch: async (url, options) => {
      minimaxCalls.push({ url, authorization: options.headers.Authorization });
      return { ok: true, async text() { return "{}"; } };
    }
  });
  assert.equal(miniMaxCheck.status, "ok");
  assert.equal(minimaxCalls[0].url, "https://api.minimaxi.com/v1/models");
  assert.equal(minimaxCalls[0].authorization, "Bearer sk-mm");

  const deepseekCalls = [];
  const deepSeekCheck = await checkDeepSeek({
    env,
    fetch: async (url, options) => {
      deepseekCalls.push({ url, authorization: options.headers.Authorization });
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: "CNY", total_balance: "8.88" }]
          });
        }
      };
    }
  });
  assert.equal(deepSeekCheck.status, "ok");
  assert.equal(deepseekCalls[0].url, "https://api.deepseek.com/user/balance");
  assert.equal(deepseekCalls[0].authorization, "Bearer sk-ds");
  assert.match(deepSeekCheck.message, /CNY 8\.88/u);
});
