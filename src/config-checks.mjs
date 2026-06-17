import { spawn as nodeSpawn } from "node:child_process";

import { loadDeepSeekConfig, loadMiniMaxConfig } from "./ai/content-classification.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import {
  resolveFfmpegCommand,
  resolveFfprobeCommand,
  resolveYtDlpCommand
} from "./media-tools.mjs";

export async function runConfigChecks({
  env = process.env,
  fetch = globalThis.fetch,
  commandExists = defaultCommandExists
} = {}) {
  const checks = [];
  checks.push(await checkFeishu({ env, fetch }));
  checks.push(await checkMiniMax({ env, fetch }));
  checks.push(await checkDeepSeek({ env, fetch }));
  checks.push(await checkCommand("yt-dlp", resolveYtDlpCommand({ env }), commandExists));
  checks.push(await checkCommand("ffmpeg", resolveFfmpegCommand({ env }), commandExists));
  checks.push(await checkCommand("ffprobe", resolveFfprobeCommand({ env }), commandExists));
  checks.push(checkMaterialCookies(env));
  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks
  };
}

export async function checkFeishu(options = {}) {
  const { env, fetch } = normalizeFeishuCheckOptions(options);
  try {
    const config = loadFeishuConfig(env);
    if (typeof fetch !== "function") {
      return check("feishu", "fail", "当前运行环境不支持 fetch，无法检测飞书表格连通性。");
    }
    const client = new FeishuSheetsClient(config, {
      fetch,
      maxRetries: 0
    });
    const sheets = await client.listSheets();
    const availableSheetIds = new Set((sheets || []).map((sheet) => String(sheet.sheet_id || sheet.sheetId || "").trim()).filter(Boolean));
    const configuredSheetIds = ["douyin", "xhs", "bilibili"]
      .map((key) => config.sheets[key])
      .filter(Boolean);
    const missingSheets = configuredSheetIds.filter((sheetId) => availableSheetIds.size > 0 && !availableSheetIds.has(sheetId));
    if (missingSheets.length > 0) {
      return check("feishu", "fail", `飞书表格可访问，但找不到配置的 Sheet ID：${missingSheets.join("、")}。`);
    }
    return check("feishu", "ok", `飞书配置可用，已读取到 ${sheets.length} 个工作表。`);
  } catch (error) {
    return check("feishu", "fail", error.message || String(error));
  }
}

export async function checkMiniMax({ env = process.env, fetch = globalThis.fetch } = {}) {
  const config = loadMiniMaxConfig(env);
  if (!config.ok) {
    return check("minimax", "fail", `MiniMax 配置缺失：${config.missing.join("、")}`);
  }
  if (typeof fetch !== "function") {
    return check("minimax", "fail", "当前运行环境不支持 fetch，无法检测 MiniMax。");
  }
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      }
    });
    const text = await response.text();
    if (!response.ok) return check("minimax", "fail", `MiniMax key 检测失败：HTTP ${response.status} ${shortText(text)}`);
    return check("minimax", "ok", "MiniMax key 可用；余额请以 MiniMax 控制台为准。");
  } catch (error) {
    return check("minimax", "fail", `MiniMax 检测失败：${error.message || String(error)}`);
  }
}

export async function checkDeepSeek({ env = process.env, fetch = globalThis.fetch } = {}) {
  const config = loadDeepSeekConfig(env);
  if (!config.ok) {
    return check("deepseek", "fail", `DeepSeek 配置缺失：${config.missing.join("、")}`);
  }
  if (typeof fetch !== "function") {
    return check("deepseek", "fail", "当前运行环境不支持 fetch，无法检测 DeepSeek。");
  }
  try {
    const response = await fetch(`${config.baseUrl}/user/balance`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      }
    });
    const text = await response.text();
    if (!response.ok) return check("deepseek", "fail", `DeepSeek key/余额检测失败：HTTP ${response.status} ${shortText(text)}`);
    const payload = text ? JSON.parse(text) : {};
    const available = payload.is_available !== false;
    const balanceText = summarizeDeepSeekBalance(payload.balance_infos || []);
    return check("deepseek", available ? "ok" : "fail", `DeepSeek ${available ? "可用" : "不可用"}${balanceText ? `，余额：${balanceText}` : ""}。`);
  } catch (error) {
    return check("deepseek", "fail", `DeepSeek 检测失败：${error.message || String(error)}`);
  }
}

export function checkMaterialCookies(env = process.env) {
  if (env.MATERIAL_YTDLP_COOKIES || env.YTDLP_COOKIES) {
    return check("material-cookies", "ok", "素材下载将使用全局 yt-dlp cookies 文件。");
  }
  const platformCookieKeys = ["DOUYIN", "XHS", "BILIBILI"]
    .map((platform) => [`${platform}_MATERIAL_YTDLP_COOKIES`, `${platform}_YTDLP_COOKIES`])
    .flat()
    .filter((key) => env[key]);
  if (platformCookieKeys.length > 0) {
    return check("material-cookies", "ok", `素材下载已配置 ${platformCookieKeys.length} 个平台 cookies 文件。`);
  }
  const exportValue = env.MATERIAL_EXPORT_PROFILE_COOKIES || env.YTDLP_EXPORT_PROFILE_COOKIES;
  if (exportValue !== undefined && !/^(1|true|yes)$/iu.test(String(exportValue))) {
    return check("material-cookies", "warn", "素材下载未启用 cookies 文件，也关闭了浏览器登录态 Cookie 导出；平台素材更容易获取失败。");
  }
  return check("material-cookies", "ok", "素材下载会优先从本地浏览器登录目录临时导出 Cookie，不会在面板显示或长期保存。");
}

async function checkCommand(id, command, commandExists) {
  const result = await commandExists(command);
  return result.ok
    ? check(id, "ok", `${id} 可用。${result.version ? `版本：${result.version}` : ""}`)
    : check(id, "warn", `未检测到 ${id}；素材下载、抽帧或视频识别可能受影响。`);
}

const COMMAND_VERSION_ARGS = {
  ffmpeg: ["-version"],
  ffprobe: ["-version"]
};

export function defaultCommandExists(command, { spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, COMMAND_VERSION_ARGS[command] || ["--version"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve({ ok: false, version: "" }));
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        version: firstLine(stdout || stderr)
      });
    });
  });
}

export function summarizeDeepSeekBalance(balanceInfos = []) {
  return (balanceInfos || [])
    .map((item) => {
      const currency = item.currency || "";
      const total = item.total_balance || item.granted_balance || item.topped_up_balance || "";
      return [currency, total].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("；");
}

function shortText(text = "") {
  return redactSecrets(String(text || "").replace(/\s+/g, " ")).slice(0, 180);
}

function redactSecrets(text = "") {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(/(api[_-]?key|authorization|access[_-]?token|secret)(["'\s:=]+)([^,"'\s}]+)/giu, "$1$2<redacted>")
    .replace(/\b(sk-[A-Za-z0-9._-]{8,})\b/gu, "<redacted>");
}

function firstLine(text = "") {
  return String(text || "").split(/\r?\n/u).find((line) => line.trim())?.trim() || "";
}

function check(id, status, message) {
  return { id, status, message };
}

function normalizeFeishuCheckOptions(options = {}) {
  if (options && typeof options === "object" && ("env" in options || "fetch" in options)) {
    return {
      env: options.env || process.env,
      fetch: options.fetch || globalThis.fetch
    };
  }
  return {
    env: options || process.env,
    fetch: globalThis.fetch
  };
}
