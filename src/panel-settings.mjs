import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SETTINGS_RELATIVE_PATH = path.join(".runtime", "panel-settings.secure.json");
const ENCRYPTION_VERSION = 1;
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const LEGACY_DEEPSEEK_MODELS = new Set(["deepseek-chat", "deepseek-reasoner"]);
const SECRET_FIELDS = new Set([
  "feishu.appSecret",
  "minimax.apiKey",
  "deepseek.apiKey"
]);

export function panelSettingsPath(root = process.cwd()) {
  return path.join(root, SETTINGS_RELATIVE_PATH);
}

export function getPanelSettingsPaths(root = process.cwd()) {
  const settingsPath = panelSettingsPath(root);
  return {
    settingsPath,
    secretsPath: settingsPath,
    keyPath: settingsPath
  };
}

export async function loadPanelSettings({ root = process.cwd(), secret = process.env.PANEL_SETTINGS_SECRET } = {}) {
  const filePath = panelSettingsPath(root);
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!raw) return {};
  const payload = JSON.parse(raw);
  if (payload.version !== ENCRYPTION_VERSION || !payload.iv || !payload.tag || !payload.data) {
    throw new Error("本地设置文件格式不受支持，请重新保存设置。");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveSettingsKey(secret),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]).toString("utf8");
  return normalizeSettings(JSON.parse(decrypted));
}

export async function savePanelSettings({ root = process.cwd(), settings = {}, secret = process.env.PANEL_SETTINGS_SECRET } = {}) {
  const normalized = normalizeSettings(settings && Object.keys(settings).length > 0 ? settings : envValuesToSettings(arguments[0]?.values || {}));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveSettingsKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(normalized)),
    cipher.final()
  ]);
  const payload = {
    version: ENCRYPTION_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
  const filePath = panelSettingsPath(root);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  return { ok: true, path: filePath, settings: publicPanelSettings(normalized) };
}

export function publicPanelSettings(settings = {}) {
  const normalized = normalizeSettings(settings);
  return {
    feishu: {
      appId: visibleValue(normalized.feishu.appId),
      appSecret: secretSummary(normalized.feishu.appSecret),
      spreadsheetToken: visibleValue(normalized.feishu.spreadsheetToken),
      wikiToken: visibleValue(normalized.feishu.wikiToken),
      sheets: {
        douyin: visibleValue(normalized.feishu.sheets.douyin),
        xhs: visibleValue(normalized.feishu.sheets.xhs),
        bilibili: visibleValue(normalized.feishu.sheets.bilibili),
        step15: visibleValue(normalized.feishu.sheets.step15),
        douyinHistory: visibleValue(normalized.feishu.sheets.douyinHistory),
        xhsHistory: visibleValue(normalized.feishu.sheets.xhsHistory),
        bilibiliHistory: visibleValue(normalized.feishu.sheets.bilibiliHistory)
      }
    },
    minimax: {
      apiKey: secretSummary(normalized.minimax.apiKey),
      baseUrl: visibleValue(normalized.minimax.baseUrl),
      model: visibleValue(normalized.minimax.model)
    },
    deepseek: {
      apiKey: secretSummary(normalized.deepseek.apiKey),
      baseUrl: visibleValue(normalized.deepseek.baseUrl),
      model: visibleValue(normalized.deepseek.model)
    },
    cache: {
      retentionDays: normalized.cache.retentionDays
    }
  };
}

export function publicEffectivePanelSettings(settings = {}, baseEnv = process.env) {
  return publicPanelSettings(envValuesToSettings(panelSettingsEnv(settings, baseEnv)));
}

export function panelSettingsEnv(settings = {}, baseEnv = process.env) {
  const normalized = normalizeSettings(settings);
  const env = { ...baseEnv };
  assignIfValue(env, "FEISHU_APP_ID", normalized.feishu.appId);
  assignIfValue(env, "FEISHU_APP_SECRET", normalized.feishu.appSecret);
  assignIfValue(env, "FEISHU_SPREADSHEET_TOKEN", normalized.feishu.spreadsheetToken);
  assignIfValue(env, "FEISHU_WIKI_TOKEN", normalized.feishu.wikiToken);
  assignIfValue(env, "FEISHU_SHEET_DOUYIN", normalized.feishu.sheets.douyin);
  assignIfValue(env, "FEISHU_SHEET_XHS", normalized.feishu.sheets.xhs);
  assignIfValue(env, "FEISHU_SHEET_BILIBILI", normalized.feishu.sheets.bilibili);
  assignIfValue(env, "FEISHU_SHEET_STEP15_FILTERED", normalized.feishu.sheets.step15);
  assignIfValue(env, "FEISHU_SHEET_DOUYIN_HISTORY", normalized.feishu.sheets.douyinHistory);
  assignIfValue(env, "FEISHU_SHEET_XHS_HISTORY", normalized.feishu.sheets.xhsHistory);
  assignIfValue(env, "FEISHU_SHEET_BILIBILI_HISTORY", normalized.feishu.sheets.bilibiliHistory);
  assignIfValue(env, "MINIMAX_API_KEY", normalized.minimax.apiKey);
  assignIfValue(env, "MINIMAX_BASE_URL", normalized.minimax.baseUrl);
  assignIfValue(env, "MINIMAX_MODEL", normalized.minimax.model);
  assignIfValue(env, "DEEPSEEK_API_KEY", normalized.deepseek.apiKey);
  assignIfValue(env, "DEEPSEEK_BASE_URL", normalized.deepseek.baseUrl);
  assignIfValue(env, "DEEPSEEK_MODEL", normalized.deepseek.model);
  return env;
}

export async function readPanelSettings({ root = process.cwd(), env = process.env, secret = process.env.PANEL_SETTINGS_SECRET } = {}) {
  const settings = await loadPanelSettings({ root, secret });
  const effective = panelSettingsEnv(settings, env);
  return {
    values: envFromSettings(settings),
    public: publicPanelSettings(settings),
    secrets: {
      FEISHU_APP_SECRET: legacySecretSummary(effective.FEISHU_APP_SECRET),
      MINIMAX_API_KEY: legacySecretSummary(effective.MINIMAX_API_KEY),
      DEEPSEEK_API_KEY: legacySecretSummary(effective.DEEPSEEK_API_KEY)
    }
  };
}

export async function buildEffectiveSettingsEnv({ root = process.cwd(), env = process.env, secret = process.env.PANEL_SETTINGS_SECRET } = {}) {
  const settings = await loadPanelSettings({ root, secret });
  return panelSettingsEnv(settings, env);
}

export function mergeSettingsPatch(current = {}, patch = {}) {
  const currentNormalized = normalizeSettings(current);
  const patchNormalized = normalizeSettings(patch);
  const merged = {
    feishu: {
      appId: patchNormalized.feishu.appId || currentNormalized.feishu.appId,
      appSecret: mergeSecretValue(currentNormalized.feishu.appSecret, patch?.feishu?.appSecret),
      spreadsheetToken: patchNormalized.feishu.spreadsheetToken || currentNormalized.feishu.spreadsheetToken,
      wikiToken: patchNormalized.feishu.wikiToken || currentNormalized.feishu.wikiToken,
      sheets: {
        douyin: patchNormalized.feishu.sheets.douyin || currentNormalized.feishu.sheets.douyin,
        xhs: patchNormalized.feishu.sheets.xhs || currentNormalized.feishu.sheets.xhs,
        bilibili: patchNormalized.feishu.sheets.bilibili || currentNormalized.feishu.sheets.bilibili,
        step15: patchNormalized.feishu.sheets.step15 || currentNormalized.feishu.sheets.step15,
        douyinHistory: patchNormalized.feishu.sheets.douyinHistory || currentNormalized.feishu.sheets.douyinHistory,
        xhsHistory: patchNormalized.feishu.sheets.xhsHistory || currentNormalized.feishu.sheets.xhsHistory,
        bilibiliHistory: patchNormalized.feishu.sheets.bilibiliHistory || currentNormalized.feishu.sheets.bilibiliHistory
      }
    },
    minimax: {
      apiKey: mergeSecretValue(currentNormalized.minimax.apiKey, patch?.minimax?.apiKey),
      baseUrl: patchNormalized.minimax.baseUrl || currentNormalized.minimax.baseUrl,
      model: patchNormalized.minimax.model || currentNormalized.minimax.model
    },
    deepseek: {
      apiKey: mergeSecretValue(currentNormalized.deepseek.apiKey, patch?.deepseek?.apiKey),
      baseUrl: patchNormalized.deepseek.baseUrl || currentNormalized.deepseek.baseUrl,
      model: patchNormalized.deepseek.model || currentNormalized.deepseek.model
    },
    cache: {
      retentionDays: patchNormalized.cache.retentionDays || currentNormalized.cache.retentionDays
    }
  };
  return normalizeSettings(merged);
}

function normalizeSettings(settings = {}) {
  const feishu = settings.feishu || {};
  const sheets = feishu.sheets || {};
  const minimax = settings.minimax || {};
  const deepseek = settings.deepseek || {};
  const cache = settings.cache || {};
  return {
    feishu: {
      appId: clean(feishu.appId),
      appSecret: clean(feishu.appSecret),
      spreadsheetToken: clean(feishu.spreadsheetToken),
      wikiToken: clean(feishu.wikiToken),
      sheets: {
        douyin: clean(sheets.douyin),
        xhs: clean(sheets.xhs),
        bilibili: clean(sheets.bilibili),
        step15: clean(sheets.step15),
        douyinHistory: clean(sheets.douyinHistory),
        xhsHistory: clean(sheets.xhsHistory),
        bilibiliHistory: clean(sheets.bilibiliHistory)
      }
    },
    minimax: {
      apiKey: clean(minimax.apiKey),
      baseUrl: clean(minimax.baseUrl || "https://api.minimaxi.com/v1"),
      model: clean(minimax.model || "MiniMax-M3")
    },
    deepseek: {
      apiKey: clean(deepseek.apiKey),
      baseUrl: clean(deepseek.baseUrl || "https://api.deepseek.com"),
      model: normalizeDeepSeekModel(deepseek.model)
    },
    cache: {
      retentionDays: normalizeRetentionDays(cache.retentionDays)
    }
  };
}

function deriveSettingsKey(secret = "") {
  const seed = String(secret || process.env.PANEL_SETTINGS_SECRET || `${os.hostname()}|${os.homedir()}|harvester-THS`);
  return crypto.createHash("sha256").update(seed).digest();
}

function clean(value) {
  return String(value || "").trim();
}

function normalizeRetentionDays(value) {
  const days = Number(value || 30);
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(365, Math.trunc(days)));
}

function normalizeDeepSeekModel(value) {
  const model = clean(value);
  if (!model || LEGACY_DEEPSEEK_MODELS.has(model)) return DEFAULT_DEEPSEEK_MODEL;
  return model;
}

function visibleValue(value) {
  return { value: clean(value) };
}

function secretSummary(value) {
  const text = clean(value);
  return {
    set: Boolean(text),
    last4: text ? text.slice(-4) : ""
  };
}

function assignIfValue(env, key, value) {
  const text = clean(value);
  if (text) env[key] = text;
}

function mergeSecretValue(currentValue = "", patchValue = "") {
  const text = clean(patchValue);
  if (!text || text === "__KEEP__") return clean(currentValue);
  return text;
}

function envValuesToSettings(values = {}) {
  return {
    feishu: {
      appId: values.FEISHU_APP_ID,
      appSecret: values.FEISHU_APP_SECRET,
      spreadsheetToken: values.FEISHU_SPREADSHEET_TOKEN,
      wikiToken: values.FEISHU_WIKI_TOKEN,
      sheets: {
        douyin: values.FEISHU_SHEET_DOUYIN,
        xhs: values.FEISHU_SHEET_XHS,
        bilibili: values.FEISHU_SHEET_BILIBILI,
        step15: values.FEISHU_SHEET_STEP15_FILTERED,
        douyinHistory: values.FEISHU_SHEET_DOUYIN_HISTORY,
        xhsHistory: values.FEISHU_SHEET_XHS_HISTORY,
        bilibiliHistory: values.FEISHU_SHEET_BILIBILI_HISTORY
      }
    },
    minimax: {
      apiKey: values.MINIMAX_API_KEY,
      baseUrl: values.MINIMAX_BASE_URL,
      model: values.MINIMAX_MODEL
    },
    deepseek: {
      apiKey: values.DEEPSEEK_API_KEY,
      baseUrl: values.DEEPSEEK_BASE_URL,
      model: values.DEEPSEEK_MODEL
    },
    cache: {
      retentionDays: values.CACHE_CLEAN_DAYS
    }
  };
}

function envFromSettings(settings = {}) {
  const env = panelSettingsEnv(settings, {});
  return {
    FEISHU_APP_ID: env.FEISHU_APP_ID || "",
    FEISHU_SPREADSHEET_TOKEN: env.FEISHU_SPREADSHEET_TOKEN || "",
    FEISHU_WIKI_TOKEN: env.FEISHU_WIKI_TOKEN || "",
    FEISHU_SHEET_DOUYIN: env.FEISHU_SHEET_DOUYIN || "",
    FEISHU_SHEET_XHS: env.FEISHU_SHEET_XHS || "",
    FEISHU_SHEET_BILIBILI: env.FEISHU_SHEET_BILIBILI || "",
    MINIMAX_BASE_URL: env.MINIMAX_BASE_URL || "",
    MINIMAX_MODEL: env.MINIMAX_MODEL || "",
    DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL || "",
    DEEPSEEK_MODEL: env.DEEPSEEK_MODEL || "",
    CACHE_CLEAN_DAYS: String(normalizeSettings(settings).cache.retentionDays)
  };
}

function legacySecretSummary(value = "") {
  const text = clean(value);
  return {
    hasValue: Boolean(text),
    maskedValue: text ? `${text.slice(0, 3)}****${text.slice(-4)}` : ""
  };
}
