import fs from "node:fs/promises";
import path from "node:path";

import { buildMiniMaxPromptText } from "../douyin-channel-type-classifier/multimodal.mjs";
import { classifyDouyinChannelType } from "../douyin-channel-type-classifier/classifier.mjs";
import { buildPlatformTaxonomyPrompt, normalizePlatformClassification } from "./platform-taxonomies.mjs";

export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
export const DEFAULT_MINIMAX_MODEL = "MiniMax-M3";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const LEGACY_DEEPSEEK_MODELS = new Set(["deepseek-chat", "deepseek-reasoner"]);
export const DEFAULT_AI_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_MINIMAX_UPLOAD_TIMEOUT_MS = 60_000;

export function loadMiniMaxConfig(env = process.env) {
  const apiKey = String(env.MINIMAX_API_KEY || "").trim();
  const model = String(env.MINIMAX_MODEL || DEFAULT_MINIMAX_MODEL).trim();
  const baseUrl = normalizeBaseUrl(env.MINIMAX_BASE_URL || env.MINIMAX_IMAGE_UNDERSTANDING_ENDPOINT || DEFAULT_MINIMAX_BASE_URL);
  return {
    ok: Boolean(apiKey),
    missing: apiKey ? [] : ["MINIMAX_API_KEY"],
    apiKey,
    model,
    baseUrl
  };
}

export function loadDeepSeekConfig(env = process.env) {
  const apiKey = String(env.DEEPSEEK_API_KEY || env.DEEPSEEK_API || "").trim();
  const model = normalizeDeepSeekModel(env.DEEPSEEK_MODEL);
  const baseUrl = normalizeBaseUrl(env.DEEPSEEK_BASE_URL || env.DEEPSEEK_URL || DEFAULT_DEEPSEEK_BASE_URL);
  const missing = [];
  if (!apiKey) missing.push("DEEPSEEK_API_KEY");
  if (!model) missing.push("DEEPSEEK_MODEL");
  return {
    ok: missing.length === 0,
    missing,
    apiKey,
    model,
    baseUrl
  };
}

function normalizeDeepSeekModel(value) {
  const model = String(value || "").trim();
  if (!model || LEGACY_DEEPSEEK_MODELS.has(model)) return DEFAULT_DEEPSEEK_MODEL;
  return model;
}

export function resolveAiFetchTimeoutMs(env = process.env, key = "AI_FETCH_TIMEOUT_MS", fallback = DEFAULT_AI_FETCH_TIMEOUT_MS) {
  const candidates = [env?.[key], env?.AI_FETCH_TIMEOUT_MS, fallback];
  const value = candidates
    .map((candidate) => Number(candidate))
    .find((candidate) => Number.isFinite(candidate) && candidate > 0);
  return Math.max(1, value || fallback);
}

export async function fetchWithTimeout(url, options = {}, {
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_AI_FETCH_TIMEOUT_MS,
  label = "AI请求"
} = {}) {
  if (typeof fetch !== "function") throw new Error("当前运行环境不支持 fetch。");
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_AI_FETCH_TIMEOUT_MS);
  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  let timeoutId = null;
  try {
    const requestOptions = abortController
      ? { ...options, signal: abortController.signal }
      : options;
    const response = await Promise.race([
      Promise.resolve().then(() => fetch(url, requestOptions)),
      new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          abortController?.abort();
          reject(new Error(`${label}请求超时：${timeout}ms`));
        }, timeout);
      })
    ]);
    return wrapResponseTextWithTimeout(response, { timeoutMs: timeout, label });
  } catch (error) {
    if (abortController?.signal?.aborted || error?.name === "AbortError") {
      throw new Error(`${label}请求超时：${timeout}ms`);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function wrapResponseTextWithTimeout(response, { timeoutMs, label }) {
  if (!response || (typeof response.text !== "function" && typeof response.arrayBuffer !== "function")) return response;
  return {
    ...response,
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    async text() {
      if (typeof response.text !== "function") throw new Error(`${label}响应读取失败：response.text 不可用`);
      return promiseWithTimeout(() => response.text(), {
        timeoutMs,
        message: `${label}响应读取超时：${timeoutMs}ms`
      });
    },
    async arrayBuffer() {
      if (typeof response.arrayBuffer !== "function") throw new Error(`${label}响应读取失败：response.arrayBuffer 不可用`);
      return promiseWithTimeout(() => response.arrayBuffer(), {
        timeoutMs,
        message: `${label}响应读取超时：${timeoutMs}ms`
      });
    }
  };
}

async function promiseWithTimeout(fn, { timeoutMs, message }) {
  let timeoutId = null;
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_AI_FETCH_TIMEOUT_MS);
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message || `请求超时：${timeout}ms`)), timeout);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function classifyContentWithFallback({
  platformId,
  item = {},
  materialManifest = {},
  env = process.env,
  fetch = globalThis.fetch,
  minimaxClassify = defaultMiniMaxClassify,
  deepseekClassify = defaultDeepSeekClassify
} = {}) {
  const hasMaterial = hasUsableMaterial(materialManifest);
  const mediaMode = hasMaterial ? "sampled-media" : "text-only";
  let minimaxError = "";

  try {
    const minimax = await minimaxClassify({
      platformId,
      item,
      materialManifest,
      hasMaterial,
      mediaMode,
      env,
      fetch
    });
    if (minimax?.ok) {
      return normalizeClassificationResult({
        ...minimax,
        provider: "minimax",
        usedMultimodal: Boolean(minimax.usedMultimodal ?? hasMaterial),
        platformId
      });
    }
    minimaxError = minimax?.reason || "MiniMax API失效";
  } catch (error) {
    minimaxError = error.message || String(error);
  }

  if (hasMaterial) {
    try {
      const minimaxText = await minimaxClassify({
        platformId,
        item,
        materialManifest: { ok: false, assets: [], imagePaths: [], framePaths: [], videoPath: "", error: minimaxError },
        hasMaterial: false,
        mediaMode: "text-only",
        env,
        fetch
      });
      if (minimaxText?.ok) {
        return normalizeClassificationResult({
          ...minimaxText,
          provider: "minimax",
          usedMultimodal: false,
          platformId
        });
      }
      minimaxError = [minimaxError, minimaxText?.reason].filter(Boolean).join("；");
    } catch (error) {
      minimaxError = [minimaxError, error.message || String(error)].filter(Boolean).join("；");
    }
  }

  const deepseek = await deepseekClassify({
    platformId,
    item,
    env,
    fetch,
    minimaxError
  });
  return normalizeClassificationResult({
    ...(deepseek || {}),
    provider: "deepseek",
    usedMultimodal: false,
    platformId,
    minimaxError
  });
}

export function formatContentTypeReview({ ok = false, confidence = 0, reason = "" } = {}) {
  const prefix = ok && Number(confidence) >= 0.45 ? "通过" : "需审核";
  const cleanReason = oneSentenceReason(reason || (ok ? "AI依据标题、tag和可用素材完成判断。" : "AI判断依据不足，建议复核内容类型。"));
  return `${prefix}。因为${cleanReason}`;
}

export function buildAiContentRemark({ provider = "", usedMultimodal = false, minimaxError = "" } = {}) {
  const normalizedProvider = String(provider || "").toLowerCase() === "deepseek" ? "deepseek" : "minimax";
  const capability = usedMultimodal ? "使用多模态能力" : "没有使用多模态能力";
  const fallback = normalizedProvider === "deepseek" && minimaxError
    ? `MiniMax API失效：${oneSentenceReason(minimaxError)}`
    : "";
  return fallback
    ? `使用${normalizedProvider}，${capability}。${fallback}`
    : `使用${normalizedProvider}，${capability}。`;
}

async function defaultMiniMaxClassify({
  platformId,
  item = {},
  materialManifest = {},
  hasMaterial = false,
  mediaMode = "text-only",
  env = process.env,
  fetch = globalThis.fetch,
  uploadFile = uploadMiniMaxFile
} = {}) {
  const config = loadMiniMaxConfig(env);
  if (!config.ok) return { ok: false, reason: `缺少 MiniMax 配置：${config.missing.join(", ")}` };
  if (typeof fetch !== "function") return { ok: false, reason: "当前运行环境不支持 fetch，无法调用 MiniMax。" };

  const messageBundle = await buildGenericMiniMaxMessages({
    platformId,
    item,
    materialManifest,
    mediaMode,
    hasMaterial,
    config,
    fetch,
    uploadFile
  });
  const response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: messageBundle.messages
    })
  }, {
    fetch,
    timeoutMs: resolveAiFetchTimeoutMs(env, "MINIMAX_FETCH_TIMEOUT_MS"),
    label: "MiniMax 分类"
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, reason: `MiniMax API ${response.status || ""}: ${text}` };
  return {
    ...parseClassificationJson(JSON.parse(text)),
    usedMultimodal: messageBundle.mediaCount > 0
  };
}

async function defaultDeepSeekClassify({ platformId, item = {}, env = process.env, fetch = globalThis.fetch } = {}) {
  if (platformId === "douyin") {
    return await classifyDouyinChannelType({
      title: item.title || "",
      tags: item.tags || "",
      env,
      fetch,
      timeoutMs: resolveAiFetchTimeoutMs(env, "DEEPSEEK_FETCH_TIMEOUT_MS")
    });
  }
  const config = loadDeepSeekConfig(env);
  if (!config.ok) return { ok: false, reason: `缺少 DeepSeek 配置：${config.missing.join(", ")}` };
  if (typeof fetch !== "function") return { ok: false, reason: "当前运行环境不支持 fetch，无法调用 DeepSeek。" };
  const response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: buildTextClassificationMessages({ platformId, item })
    })
  }, {
    fetch,
    timeoutMs: resolveAiFetchTimeoutMs(env, "DEEPSEEK_FETCH_TIMEOUT_MS"),
    label: "DeepSeek 分类"
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, reason: `DeepSeek API ${response.status || ""}: ${text}` };
  return parseClassificationJson(JSON.parse(text));
}

function normalizeClassificationResult(result = {}) {
  const platformId = result.platformId || "";
  const rawPrimaryType = String(result.primaryType || result.primary_type || result.contentType || "").trim();
  const rawSecondaryType = platformId === "bilibili"
    ? ""
    : String(result.secondaryType || result.secondary_type || "").trim();
  const platformClassification = normalizePlatformClassification({
    platformId,
    primaryType: rawPrimaryType,
    secondaryType: rawSecondaryType,
    reason: result.reason
  });
  const primaryType = platformClassification.primaryType;
  const secondaryType = platformClassification.secondaryType;
  const confidence = normalizeConfidence(result.confidence);
  const ok = Boolean(result.ok) && Boolean(platformClassification.ok) && Boolean(primaryType);
  const reason = platformClassification.ok
    ? String(result.reason || "").trim() || (ok ? `AI判断为${primaryType}。` : "AI判断失败。")
    : platformClassification.reason;
  const provider = String(result.provider || "").toLowerCase() === "deepseek" ? "deepseek" : "minimax";
  const usedMultimodal = Boolean(result.usedMultimodal);
  const minimaxError = String(result.minimaxError || "").trim();
  return {
    ok,
    primaryType,
    secondaryType,
    contentType: primaryType || "无",
    confidence,
    reason,
    provider,
    usedMultimodal,
    contentTypeReview: formatContentTypeReview({ ok, confidence, reason }),
    aiContentRemark: buildAiContentRemark({ provider, usedMultimodal, minimaxError })
  };
}

function hasUsableMaterial(manifest = {}) {
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest.videoPath || manifest.imagePath) return true;
  if (Array.isArray(manifest.imagePaths) && manifest.imagePaths.length > 0) return true;
  if (Array.isArray(manifest.assets) && manifest.assets.some((asset) => asset?.path || asset?.url)) return true;
  return false;
}

async function buildGenericMiniMaxMessages({
  platformId,
  item = {},
  materialManifest = {},
  mediaMode = "text-only",
  config = loadMiniMaxConfig(),
  fetch = globalThis.fetch,
  uploadFile = uploadMiniMaxFile
} = {}) {
  const userContent = [{
    type: "text",
    text: [
      `平台：${platformId}`,
      `素材模式：${mediaMode}`,
      "请根据素材、标题和tag判断内容分类，只返回 JSON：{\"primaryType\":\"\",\"secondaryType\":\"\",\"confidence\":0,\"reason\":\"\"}。",
      "抖音和小红书必须给出一级类型和二级类型；B站只给一级类型，secondaryType 留空。",
      "",
      "素材字段：",
      `账号：${item.accountName || item.account || ""}`,
      `作品类型：${item.itemType || item.type || ""}`,
      `标题：${item.title || ""}`,
      `tag：${item.tags || ""}`,
      `内容链接：${item.link || item.noteUrl || item.itemUrl || item.videoUrl || ""}`,
      `素材缓存：${materialManifest.dir || materialManifest.cacheDir || ""}`,
      "",
      platformId === "douyin" ? buildMiniMaxPromptText({ sourceRow: item, assetBundle: materialManifest, mediaMode }) : "",
      platformId !== "douyin" ? buildPlatformTaxonomyPrompt(platformId) : ""
    ].filter(Boolean).join("\n")
  }];

  for (const asset of await mediaContentAssets(materialManifest, { mediaMode, config, fetch, uploadFile })) {
    const url = asset.dataUrl || asset.url || "";
    if (!url) continue;
    if (String(asset.kind || "").includes("video")) userContent.push({ type: "video_url", video_url: { url } });
    else userContent.push({ type: "image_url", image_url: { url } });
  }

  return {
    mediaCount: Math.max(0, userContent.length - 1),
    messages: [
    {
      role: "system",
      content: "你是三渠道内容分类助手，必须按用户给定字段和本地分类体系判断，只返回 JSON。"
    },
    {
      role: "user",
      content: userContent
    }
    ]
  };
}

async function mediaContentAssets(manifest = {}, { mediaMode = "text-only", config, fetch, uploadFile } = {}) {
  if (mediaMode === "text-only") return [];
  const assets = [];
  const imageAssets = [];
  const videoAssets = [];
  for (const asset of manifest.assets || []) {
    if (isVideoAsset(asset)) videoAssets.push(asset);
    else if (isImageAsset(asset)) imageAssets.push(asset);
  }

  const explicitImages = [
    ...(Array.isArray(manifest.imageDataUrls) ? manifest.imageDataUrls.map((dataUrl) => ({ kind: "image", dataUrl })) : []),
    ...(Array.isArray(manifest.imagePaths) ? manifest.imagePaths.map((assetPath) => ({ kind: "image", path: assetPath })) : []),
    ...(Array.isArray(manifest.framePaths) ? manifest.framePaths.map((assetPath) => ({ kind: "image", path: assetPath })) : []),
    ...(manifest.imagePath ? [{ kind: "image", path: manifest.imagePath }] : []),
    ...imageAssets
  ];

  for (const asset of explicitImages.slice(0, 8)) {
    const dataUrl = asset.dataUrl || asset.url || (asset.path ? await filePathToDataUrl(asset.path).catch(() => "") : "");
    if (dataUrl) assets.push({ kind: "image", dataUrl });
  }

  if (assets.length > 0) return assets;

  const videoAsset = manifest.videoPath
    ? { kind: "video", path: manifest.videoPath }
    : videoAssets.find((asset) => asset.path || asset.url);
  if (!videoAsset) return assets;
  if (videoAsset.url) return [{ kind: "video", url: videoAsset.url }];
  if (!videoAsset.path || typeof uploadFile !== "function") return assets;
  const fileId = await uploadFile({ filePath: videoAsset.path, config, fetch }).catch(() => "");
  return fileId ? [{ kind: "video", url: `mm_file://${fileId}` }] : assets;
}

async function uploadMiniMaxFile({ filePath, config = loadMiniMaxConfig(), fetch = globalThis.fetch } = {}) {
  if (!filePath) return "";
  if (typeof fetch !== "function") throw new Error("当前运行环境不支持 fetch，无法上传 MiniMax 文件。");
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([buffer]), path.basename(filePath));
  form.append("purpose", "assistant");
  const response = await fetchWithTimeout(`${config.baseUrl}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    body: form
  }, {
    fetch,
    timeoutMs: resolveAiFetchTimeoutMs(process.env, "MINIMAX_UPLOAD_TIMEOUT_MS", DEFAULT_MINIMAX_UPLOAD_TIMEOUT_MS),
    label: "MiniMax 文件上传"
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MiniMax 文件上传失败 ${response.status || ""}: ${text}`);
  const parsed = JSON.parse(text);
  return String(parsed.id || parsed.file_id || parsed.file?.id || parsed.data?.id || "").trim();
}

async function filePathToDataUrl(filePath) {
  const buffer = await fs.readFile(filePath);
  return `data:${mimeTypeForPath(filePath)};base64,${buffer.toString("base64")}`;
}

function mimeTypeForPath(filePath = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function isImageAsset(asset = {}) {
  const text = `${asset.kind || asset.type || asset.mediaType || ""} ${asset.path || asset.url || asset.fileName || ""}`.toLowerCase();
  return /image|photo|jpg|jpeg|png|webp|gif/u.test(text);
}

function isVideoAsset(asset = {}) {
  const text = `${asset.kind || asset.type || asset.mediaType || ""} ${asset.path || asset.url || asset.fileName || ""}`.toLowerCase();
  return /video|mp4|mov|m4v|webm|mkv|m3u8/u.test(text);
}

function buildTextClassificationMessages({ platformId, item = {} } = {}) {
  return [
    {
      role: "system",
      content: "你是内容分类助手。只根据标题和tag判断分类，只返回 JSON。"
    },
    {
      role: "user",
      content: [
        `平台：${platformId}`,
        `标题：${item.title || ""}`,
        `tag：${item.tags || ""}`,
        `作品类型：${item.itemType || item.type || ""}`,
        "返回 JSON：{\"primaryType\":\"\",\"secondaryType\":\"\",\"confidence\":0,\"reason\":\"\"}。",
        "抖音和小红书返回一级/二级分类；B站只返回一级分类，secondaryType 留空。",
        "",
        platformId === "douyin" ? "" : buildPlatformTaxonomyPrompt(platformId)
      ].join("\n")
    }
  ];
}

function parseClassificationJson(responseJson = {}) {
  const content = responseJson?.choices?.[0]?.message?.content;
  const parsed = content && typeof content === "object"
    ? content
    : JSON.parse(String(content || "{}").match(/\{[\s\S]*\}/u)?.[0] || "{}");
  return {
    ok: true,
    primaryType: String(parsed.primaryType || parsed.primary_type || "").trim(),
    secondaryType: String(parsed.secondaryType || parsed.secondary_type || "").trim(),
    confidence: normalizeConfidence(parsed.confidence),
    reason: String(parsed.reason || "").trim()
  };
}

function oneSentenceReason(text = "") {
  const clean = String(text || "").trim()
    .replace(/^(通过|需审核)。因为/u, "")
    .replace(/\s+/g, " ");
  const match = clean.match(/^(.+?[。！？])(?:\s|$)/u);
  const value = (match ? match[1] : clean).replace(/[。！？]+$/u, "");
  return `${value || "AI已给出判断依据"}。`;
}

function normalizeBaseUrl(value = "") {
  return String(value || "").trim().replace(/\/+$/u, "").replace(/\/chat\/completions$/u, "");
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}
