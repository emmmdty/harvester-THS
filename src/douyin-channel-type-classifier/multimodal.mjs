import fs from "node:fs/promises";
import path from "node:path";

import { validateClassification } from "./classifier.mjs";
import { buildTaxonomyPromptText, DOUYIN_CHANNEL_PRIMARY_TYPES } from "./taxonomy.mjs";

export const MINIMAX_PROMPT_VERSION = "douyin-channel-type-multimodal-v2026-06-10";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M3";
const MAX_SAMPLED_IMAGES = 8;
const MAX_FULL_IMAGES = 12;

export async function classifyDouyinChannelTypeWithMiniMax({
  sourceRow = {},
  assetBundle = {},
  mediaMode = "text-only",
  env = process.env,
  fetch = globalThis.fetch,
  timeoutMs = 60000,
  maxRetries = 2,
  retryDelayMs = 800,
  uploadFile = uploadMiniMaxFile
} = {}) {
  const config = loadMiniMaxConfig(env);
  if (!config.ok) return failureResult(`缺少 MiniMax 配置：${config.missing.join(", ")}`, config);
  if (typeof fetch !== "function") return failureResult("当前运行环境不支持 fetch，无法调用 MiniMax。", config);

  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = abortController
    ? setTimeout(() => abortController.abort(), Math.max(1000, Number(timeoutMs) || 60000))
    : null;
  try {
    const messages = await buildMiniMaxClassificationMessages({
      sourceRow,
      assetBundle,
      mediaMode,
      config,
      fetch,
      uploadFile
    });
    const attempts = Math.max(1, Number(maxRetries) || 1);
    let parseFailure = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await fetchMiniMaxWithRetry(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        signal: abortController?.signal,
        body: JSON.stringify({
          model: config.model,
          response_format: { type: "json_object" },
          temperature: 0,
          messages
        })
      }, { fetch, maxRetries, retryDelayMs });
      const responseText = await response.text();
      if (!response.ok) return failureResult(`MiniMax API ${response.status || ""}: ${responseText}`, config);

      let parsed;
      try {
        parsed = parseMiniMaxTypeResponse(JSON.parse(responseText));
      } catch (error) {
        parseFailure = `MiniMax 返回非严格 JSON：${error.message || String(error)}`;
        if (attempt < attempts && retryDelayMs > 0) await sleep(retryDelayMs);
        continue;
      }
      const validated = validateClassification(parsed);
      if (!validated.ok) {
        return {
          ...validated,
          evidence: normalizeStringArray(parsed.evidence),
          assetSignals: normalizeStringArray(parsed.assetSignals),
          source: "minimax",
          model: config.model,
          mediaMode
        };
      }
      return {
        ...validated,
        evidence: normalizeStringArray(parsed.evidence),
        assetSignals: normalizeStringArray(parsed.assetSignals),
        source: "minimax",
        model: config.model,
        mediaMode
      };
    }
    return failureResult(parseFailure || "MiniMax 返回非严格 JSON。", config);
  } catch (error) {
    return failureResult(`MiniMax 分类失败：${error.message || String(error)}`, config);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchMiniMaxWithRetry(url, options, { fetch, maxRetries = 2, retryDelayMs = 800 } = {}) {
  const attempts = Math.max(1, Number(maxRetries) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, options);
    if (response.ok || !isRetryableStatus(response.status)) return response;
    const text = await response.text().catch(() => "");
    if (attempt === attempts) return responseWithBufferedText(response, text);
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }
  throw new Error("MiniMax 请求未返回响应。");
}

function responseWithBufferedText(response, bufferedText) {
  return {
    ...response,
    ok: response.ok,
    status: response.status,
    async text() {
      return bufferedText;
    }
  };
}

function isRetryableStatus(status) {
  return status === 429 || (Number(status) >= 500 && Number(status) <= 599);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function buildMiniMaxClassificationMessages({
  sourceRow = {},
  assetBundle = {},
  mediaMode = "text-only",
  config = loadMiniMaxConfig(process.env),
  fetch = globalThis.fetch,
  uploadFile = uploadMiniMaxFile
} = {}) {
  const content = [{
    type: "text",
    text: buildMiniMaxPromptText({ sourceRow, assetBundle, mediaMode })
  }];

  if (mediaMode !== "text-only") {
    const imageUrls = await imageUrlsForAssetBundle(assetBundle, mediaMode);
    for (const url of imageUrls) {
      content.push({ type: "image_url", image_url: { url } });
    }
  }

  if (mediaMode === "full-media" && assetBundle.videoPath) {
    const fileId = await uploadFile({ filePath: assetBundle.videoPath, config, fetch });
    if (fileId) content.push({ type: "video_url", video_url: { url: `mm_file://${fileId}` } });
  }

  return [
    {
      role: "system",
      content: [
        "你是抖音渠道内容分级分类助手。",
        "唯一分类依据是用户提供的本地分类标准，不允许引入外部抖音垂类口径。",
        "必须只返回 JSON。"
      ].join("\n")
    },
    {
      role: "user",
      content
    }
  ];
}

export function buildMiniMaxPromptText({ sourceRow = {}, assetBundle = {}, mediaMode = "text-only" } = {}) {
  const candidates = detectPrimaryTypeCandidates(sourceRow);
  return [
    `Prompt版本：${MINIMAX_PROMPT_VERSION}`,
    `素材模式：${mediaMode}`,
    "请按以下步骤判断：先判一级类型，再只在该一级类型下选择二级类型。",
    "只返回 JSON：{\"primaryType\":\"\",\"secondaryType\":\"\",\"confidence\":0,\"reason\":\"\",\"evidence\":[],\"assetSignals\":[]}。",
    "confidence 是 0 到 1；reason 用一句中文说明；evidence 引用标题、tag 或画面线索中的短片段。",
    `候选一级类型：${candidates.join("、")}`,
    "",
    "素材字段：",
    `行号：${sourceRow.rowNumber || ""}`,
    `账号：${sourceRow.account || ""}`,
    `作品类型：${sourceRow.itemType || ""}`,
    `现有内容类型：${sourceRow.contentType || ""}`,
    `作品ID：${sourceRow.itemId || ""}`,
    `内容链接：${sourceRow.link || ""}`,
    `标题：${sourceRow.title || ""}`,
    `tag：${sourceRow.tags || ""}`,
    `文本：${assetBundle.sourceText || ""}`,
    `素材状态：${assetBundle.assetStatus || ""}`,
    "",
    "分类标准：",
    buildTaxonomyPromptText()
  ].join("\n");
}

export function detectPrimaryTypeCandidates({ title = "", tags = "", itemType = "", contentType = "" } = {}) {
  const text = [title, tags, itemType, contentType].map((value) => String(value || "")).join(" ");
  if (/(^|[#\s])(?:说唱|Rap|RAP|rap)(?=$|[#\s])/u.test(text) || /押韵|节奏/u.test(text)) return ["说唱"];
  if (/长视频|完整版|深度解读|完整节目/u.test(text)) return ["长视频"];
  if (/同顺盘点|AI盘点|主力资金|资金流|龙头强度|产业链|涨停复盘|社保基金|股票一览/u.test(text)) return ["盘点"];
  if (/同花顺社区|同顺社区|社区话题|股民交流|评论区/u.test(text)) return ["社区话题", "股友说"];
  if (/同顺图解|图文|长图|知识卡片|note/u.test(text)) return ["图文", "盘点"];
  if (/股友说|悟道|交易心法|炒股的/u.test(text)) return ["股友说", "社区话题"];
  if (/财商|动画|先苦后甜|磨难/u.test(text)) return ["财商动画"];
  return DOUYIN_CHANNEL_PRIMARY_TYPES;
}

export function parseMiniMaxTypeResponse(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  const parsed = content && typeof content === "object"
    ? content
    : parseJsonContent(String(content || "").trim());
  return {
    primaryType: String(parsed.primaryType || parsed.primary_type || "").trim(),
    secondaryType: String(parsed.secondaryType || parsed.secondary_type || "").trim(),
    confidence: normalizeConfidence(parsed.confidence),
    reason: String(parsed.reason || "").trim(),
    evidence: normalizeStringArray(parsed.evidence),
    assetSignals: normalizeStringArray(parsed.assetSignals || parsed.asset_signals)
  };
}

export function loadMiniMaxConfig(env = process.env) {
  const apiKey = String(env.MINIMAX_API_KEY || "").trim();
  const model = String(env.MINIMAX_MODEL || DEFAULT_MINIMAX_MODEL).trim();
  const baseUrl = normalizeMiniMaxBaseUrl(
    env.MINIMAX_BASE_URL || env.MINIMAX_IMAGE_UNDERSTANDING_ENDPOINT || DEFAULT_MINIMAX_BASE_URL
  );
  const missing = [];
  if (!apiKey) missing.push("MINIMAX_API_KEY");
  return {
    ok: missing.length === 0,
    missing,
    apiKey,
    model,
    baseUrl
  };
}

function normalizeMiniMaxBaseUrl(value) {
  const text = String(value || DEFAULT_MINIMAX_BASE_URL).trim().replace(/\/+$/, "");
  return text.replace(/\/chat\/completions$/u, "");
}

export async function uploadMiniMaxFile({ filePath, config = loadMiniMaxConfig(), fetch = globalThis.fetch } = {}) {
  if (!filePath) return "";
  if (typeof fetch !== "function") throw new Error("当前运行环境不支持 fetch，无法上传 MiniMax 文件。");
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([buffer]), path.basename(filePath));
  form.append("purpose", "assistant");
  const response = await fetch(`${config.baseUrl}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    body: form
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MiniMax 文件上传失败 ${response.status || ""}: ${text}`);
  const parsed = JSON.parse(text);
  return String(parsed.id || parsed.file_id || parsed.file?.id || parsed.data?.id || "").trim();
}

async function imageUrlsForAssetBundle(assetBundle = {}, mediaMode = "sampled-media") {
  const explicit = normalizeStringArray(assetBundle.imageDataUrls);
  const limit = mediaMode === "full-media" ? MAX_FULL_IMAGES : MAX_SAMPLED_IMAGES;
  if (explicit.length) return explicit.slice(0, limit);
  const paths = [
    ...(assetBundle.imagePaths || []),
    ...(assetBundle.framePaths || [])
  ].filter(Boolean).slice(0, limit);
  const urls = [];
  for (const filePath of paths) {
    urls.push(await filePathToDataUrl(filePath));
  }
  return urls;
}

async function filePathToDataUrl(filePath) {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === ".png"
    ? "image/png"
    : ext === ".webp"
      ? "image/webp"
      : "image/jpeg";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function parseJsonContent(text) {
  if (!text) return {};
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1] || text.match(/\{[\s\S]*\}/u)?.[0] || text;
  return JSON.parse(candidate);
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    const text = String(value || "").trim();
    return text ? [text] : [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function failureResult(reason, config = {}) {
  return {
    ok: false,
    primaryType: "",
    secondaryType: "",
    confidence: 0,
    reason,
    evidence: [],
    assetSignals: [],
    source: "minimax",
    model: config.model || DEFAULT_MINIMAX_MODEL,
    mediaMode: ""
  };
}
