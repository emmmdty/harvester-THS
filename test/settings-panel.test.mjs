import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  checkDeepSeek,
  checkFeishu,
  checkMiniMax,
  summarizeDeepSeekBalance
} from "../src/config-checks.mjs";
import {
  buildEffectiveSettingsEnv,
  DEFAULT_DEEPSEEK_MODEL,
  getPanelSettingsPaths,
  publicEffectivePanelSettings,
  readPanelSettings,
  savePanelSettings
} from "../src/panel-settings.mjs";
import { summarizeCacheStorage } from "../src/cache-summary.mjs";

const ROOT = process.cwd();

test("settings panel exposes ordinary-user fields while preserving account manager", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");

  assert.match(html, /id="account-manager"/u);
  assert.match(
    html,
    /data-platform="xhs"[\s\S]*data-platform="douyin"[\s\S]*data-platform="bilibili"[\s\S]*data-platform="daily"[\s\S]*data-platform="settings"/u
  );
  assert.match(html, /id="settings-page"/u);
  assert.doesNotMatch(html, /id="settings-account-summary"/u);
  assert.match(
    html,
    /id="account-manager"[\s\S]*id="settings-page"/u
  );
  assert.match(html, /id="setting-feishu-app-id"/u);
  assert.match(html, /id="setting-feishu-app-secret"/u);
  assert.match(html, /id="setting-feishu-spreadsheet-token"/u);
  assert.match(html, /id="setting-feishu-sheet-douyin"/u);
  assert.match(html, /id="setting-feishu-sheet-xhs"/u);
  assert.match(html, /id="setting-feishu-sheet-bilibili"/u);
  assert.match(html, /id="setting-minimax-api-key"/u);
  assert.match(html, /id="setting-minimax-base-url"/u);
  assert.match(html, /id="setting-minimax-model"/u);
  assert.match(html, /id="setting-deepseek-api-key"/u);
  assert.match(html, /id="setting-deepseek-config-status"/u);
  assert.match(html, /id="setting-deepseek-base-url"/u);
  assert.match(html, /id="setting-deepseek-model"/u);
  assert.match(html, /value="deepseek-v4-flash"/u);
  assert.match(html, /id="save-settings"/u);
  assert.doesNotMatch(html, /id="cache-clean-days"/u);
  assert.match(html, /id="cache-path"/u);
  assert.match(html, /id="cache-size"/u);
  assert.match(html, /id="open-cache-dir"/u);

  assert.match(app, /\/api\/settings/u);
  assert.match(app, /loadSettings/u);
  assert.match(app, /saveSettings/u);
  assert.match(app, /currentPlatform === "settings"/u);
  assert.match(app, /settingsPageEl\.hidden = currentPlatform !== "settings"/u);
  assert.match(app, /renderSettingsCacheSummary/u);
  assert.match(app, /postJson\("\/api\/cache\/cleanup", \{\}/u);
  assert.match(app, /postJson\("\/api\/cache\/open"/u);
  assert.match(app, /\/api\/accounts\?platform=/u);
});

test("settings routes exist on the server without exposing auth routes", async () => {
  const server = await fs.readFile(path.join(ROOT, "src", "server.mjs"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");

  assert.match(server, /url\.pathname === "\/api\/settings"/u);
  assert.match(server, /url\.pathname === "\/api\/cache\/open"/u);
  assert.match(server, /isSettingsPanelRequest/u);
  assert.match(server, /statusPayload\("settings"\)/u);
  assert.match(server, /sendJson\(res, \{ files: \[\] \}\)/u);
  assert.match(server, /cacheDirectoryOpener\(cacheSummary\.path\)/u);
  assert.match(server, /fileUrl: pathToFileUrl\(cacheSummary\.path\)/u);
  assert.match(app, /已尝试打开缓存目录/u);
  assert.match(server, /cleanupCacheStorage/u);
  assert.doesNotMatch(server, /cleanupOutputCache/u);
  assert.match(server, /req\.method === "GET"/u);
  assert.match(server, /req\.method === "POST"/u);
  assert.match(server, /effectiveEnv/u);
  assert.doesNotMatch(server, /\/api\/auth\//u);
});

test("local settings save secrets encrypted and read responses stay redacted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-settings-"));
  const rawSecret = "sk-deepseek-secret-123456";
  const rawMiniMax = "minimax-secret-abcdef";
  const rawFeishuSecret = "feishu-secret-xyz";

  const saved = await savePanelSettings({
    root,
    values: {
      FEISHU_APP_ID: "cli_app",
      FEISHU_APP_SECRET: rawFeishuSecret,
      FEISHU_SPREADSHEET_TOKEN: "sht_test",
      FEISHU_SHEET_DOUYIN: "douyinSheet",
      FEISHU_SHEET_XHS: "xhsSheet",
      FEISHU_SHEET_BILIBILI: "biliSheet",
      MINIMAX_API_KEY: rawMiniMax,
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
      MINIMAX_MODEL: "MiniMax-M3",
      DEEPSEEK_API_KEY: rawSecret,
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
      CACHE_CLEAN_DAYS: "45"
    }
  });

  assert.doesNotMatch(JSON.stringify(saved), new RegExp(rawSecret, "u"));
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(rawMiniMax, "u"));
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(rawFeishuSecret, "u"));

  const paths = getPanelSettingsPaths(root);
  assert.equal(path.relative(root, paths.settingsPath).startsWith(".runtime"), true);
  assert.equal(path.relative(root, paths.secretsPath).startsWith(".runtime"), true);
  assert.equal(path.relative(root, paths.keyPath).startsWith(".runtime"), true);

  const plainText = await fs.readFile(paths.settingsPath, "utf8");
  assert.doesNotMatch(plainText, new RegExp(rawSecret, "u"));
  assert.doesNotMatch(plainText, new RegExp(rawMiniMax, "u"));
  assert.doesNotMatch(plainText, new RegExp(rawFeishuSecret, "u"));

  const readBack = await readPanelSettings({ root, env: {} });
  const serialized = JSON.stringify(readBack);
  assert.doesNotMatch(serialized, new RegExp(rawSecret, "u"));
  assert.doesNotMatch(serialized, new RegExp(rawMiniMax, "u"));
  assert.equal(readBack.secrets.DEEPSEEK_API_KEY.hasValue, true);
  assert.match(readBack.secrets.DEEPSEEK_API_KEY.maskedValue, /^sk-/u);
  assert.equal(readBack.values.FEISHU_APP_ID, "cli_app");

  const effectiveEnv = await buildEffectiveSettingsEnv({ root, env: {} });
  assert.equal(effectiveEnv.DEEPSEEK_API_KEY, rawSecret);
  assert.equal(effectiveEnv.MINIMAX_API_KEY, rawMiniMax);
  assert.equal(effectiveEnv.FEISHU_APP_SECRET, rawFeishuSecret);
});

test("DeepSeek default model follows current official API default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-deepseek-default-"));
  const readBack = await readPanelSettings({ root, env: {} });
  const effectiveEnv = await buildEffectiveSettingsEnv({ root, env: { DEEPSEEK_API_KEY: "deep" } });

  assert.equal(DEFAULT_DEEPSEEK_MODEL, "deepseek-v4-flash");
  assert.equal(readBack.values.DEEPSEEK_MODEL, "deepseek-v4-flash");
  assert.equal(readBack.public.deepseek.model.value, "deepseek-v4-flash");
  assert.equal(effectiveEnv.DEEPSEEK_MODEL, "deepseek-v4-flash");
});

test("settings page local DeepSeek status includes environment configuration", async () => {
  const summary = publicEffectivePanelSettings({}, {
    DEEPSEEK_API_KEY: "sk-local-deepseek-1234",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "deepseek-v4-flash"
  });

  assert.equal(summary.deepseek.apiKey.set, true);
  assert.equal(summary.deepseek.apiKey.last4, "1234");
  assert.equal(summary.deepseek.apiKey.value, undefined);
  assert.equal(summary.deepseek.model.value, "deepseek-v4-flash");
});

test("MiniMax and DeepSeek checks use official health URLs and summarize balances", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/user/balance")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "12.34" },
            { currency: "USD", granted_balance: "1.23" }
          ]
        })
      };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };

  const miniMax = await checkMiniMax({
    env: { MINIMAX_API_KEY: "mini", MINIMAX_BASE_URL: "https://api.minimaxi.com/v1" },
    fetch: fakeFetch
  });
  const deepSeek = await checkDeepSeek({
    env: { DEEPSEEK_API_KEY: "deep", DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_MODEL: "deepseek-v4-flash" },
    fetch: fakeFetch
  });

  assert.equal(miniMax.status, "ok");
  assert.equal(deepSeek.status, "ok");
  assert.deepEqual(calls, [
    "https://api.minimaxi.com/v1/models",
    "https://api.deepseek.com/user/balance"
  ]);
  assert.match(deepSeek.message, /CNY 12\.34/u);
  assert.match(deepSeek.message, /USD 1\.23/u);
  assert.equal(summarizeDeepSeekBalance([{ currency: "CNY", topped_up_balance: "8.00" }]), "CNY 8.00");
});

test("settings cache summary reports path, size, and cache roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-cache-summary-"));
  await fs.mkdir(path.join(root, ".runtime", "detail-cache", "xhs"), { recursive: true });
  await fs.writeFile(path.join(root, ".runtime", "detail-cache", "xhs", "one.json"), "12345", "utf8");
  await fs.mkdir(path.join(root, ".runtime", "douyin-channel-type-classifier", "cache-batch"), { recursive: true });
  await fs.writeFile(path.join(root, ".runtime", "douyin-channel-type-classifier", "cache-batch", "one.json"), "1234567", "utf8");
  await fs.mkdir(path.join(root, "output", "2026-06-12"), { recursive: true });
  await fs.writeFile(path.join(root, "output", "2026-06-12", "daily.json"), "1234567890", "utf8");

  const summary = await summarizeCacheStorage(root);

  assert.equal(summary.path, path.join(root, ".runtime"));
  assert.equal(summary.relativePath, ".runtime");
  assert.equal(summary.roots.some((item) => item.relativePath === path.join(".runtime", "detail-cache")), true);
  assert.equal(summary.roots.some((item) => item.relativePath === path.join(".runtime", "douyin-channel-type-classifier", "cache-batch")), true);
  assert.equal(summary.roots.some((item) => item.relativePath === "output"), false);
  assert.equal(summary.bytes, 12);
  assert.match(summary.formattedSize, /B$/u);
});

test("Feishu check validates required fields and reachable spreadsheet", async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push([String(url), options.method || "GET"]);
    if (String(url).includes("/tenant_access_token/internal")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, tenant_access_token: "tenant-token" })
      };
    }
    if (String(url).includes("/sheets/query")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: {
            sheets: [
              { sheet_id: "douyinSheet" },
              { sheet_id: "xhsSheet" },
              { sheet_id: "biliSheet" }
            ]
          }
        })
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await checkFeishu({
    env: {
      FEISHU_APP_ID: "cli_app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_SPREADSHEET_TOKEN: "sht_test",
      FEISHU_SHEET_DOUYIN: "douyinSheet",
      FEISHU_SHEET_XHS: "xhsSheet",
      FEISHU_SHEET_BILIBILI: "biliSheet",
      FEISHU_OPEN_BASE_URL: "https://open.feishu.cn"
    },
    fetch: fakeFetch
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(calls, [
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", "POST"],
    ["https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/sht_test/sheets/query", "GET"]
  ]);

  const missing = await checkFeishu({ env: {}, fetch: fakeFetch });
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /FEISHU_APP_ID/u);
});

test("ignored local config and secret paths cannot be accidentally tracked", async () => {
  const gitignore = await fs.readFile(path.join(ROOT, ".gitignore"), "utf8");
  const paths = getPanelSettingsPaths(ROOT);

  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
  assert.match(gitignore, /^\.runtime\/$/m);
  assert.equal(path.relative(ROOT, paths.settingsPath), path.join(".runtime", "panel-settings.secure.json"));
  assert.equal(path.relative(ROOT, paths.secretsPath), path.join(".runtime", "panel-settings.secure.json"));
  assert.equal(path.relative(ROOT, paths.keyPath), path.join(".runtime", "panel-settings.secure.json"));
});
