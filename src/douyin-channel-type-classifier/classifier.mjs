import { buildBatchClassificationMessages, buildClassificationMessages } from "./prompt.mjs";
import {
  isValidPrimaryType,
  isValidSecondaryForPrimary,
  secondaryLabelsForPrimary
} from "./taxonomy.mjs";

export async function classifyDouyinChannelType({
  title = "",
  tags = "",
  env = process.env,
  fetch = globalThis.fetch,
  timeoutMs = 30000
} = {}) {
  const config = loadDeepSeekConfig(env);
  if (!config.ok) {
    return failureResult(`缺少 DeepSeek 配置：${config.missing.join(", ")}`);
  }
  if (typeof fetch !== "function") {
    return failureResult("当前运行环境不支持 fetch，无法调用 DeepSeek。");
  }

  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = abortController
    ? setTimeout(() => abortController.abort(), Math.max(1000, Number(timeoutMs) || 30000))
    : null;
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
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
        messages: buildClassificationMessages({ title, tags })
      })
    });
    const responseText = await response.text();
    if (!response.ok) {
      return failureResult(`DeepSeek API ${response.status || ""}: ${responseText}`);
    }

    const parsed = parseDeepSeekTypeResponse(JSON.parse(responseText));
    const validated = validateClassification(parsed);
    return {
      ...validated,
      source: "deepseek"
    };
  } catch (error) {
    return failureResult(`DeepSeek 分类失败：${error.message || String(error)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function classifyDouyinChannelTypesBatch({
  items = [],
  env = process.env,
  fetch = globalThis.fetch,
  timeoutMs = 45000
} = {}) {
  const normalizedItems = items.map((item, index) => ({
    id: String(item.id || `item-${index + 1}`),
    title: String(item.title || ""),
    tags: String(item.tags || "")
  }));
  if (!normalizedItems.length) return [];

  const config = loadDeepSeekConfig(env);
  if (!config.ok) {
    return normalizedItems.map(() => failureResult(`缺少 DeepSeek 配置：${config.missing.join(", ")}`));
  }
  if (typeof fetch !== "function") {
    return normalizedItems.map(() => failureResult("当前运行环境不支持 fetch，无法调用 DeepSeek。"));
  }

  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = abortController
    ? setTimeout(() => abortController.abort(), Math.max(1000, Number(timeoutMs) || 45000))
    : null;
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
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
        messages: buildBatchClassificationMessages({ items: normalizedItems })
      })
    });
    const responseText = await response.text();
    if (!response.ok) {
      return normalizedItems.map(() => failureResult(`DeepSeek API ${response.status || ""}: ${responseText}`));
    }

    const parsed = parseDeepSeekBatchTypeResponse(JSON.parse(responseText));
    const parsedById = new Map(parsed.map((item) => [String(item.id || ""), item]));
    return normalizedItems.map((item) => {
      const parsedItem = parsedById.get(item.id);
      if (!parsedItem) {
        return failureResult(`DeepSeek 批量分类缺少返回 id：${item.id}`);
      }
      return {
        ...validateClassification(parsedItem),
        source: "deepseek"
      };
    });
  } catch (error) {
    return normalizedItems.map(() => failureResult(`DeepSeek 批量分类失败：${error.message || String(error)}`));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function parseDeepSeekTypeResponse(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (content && typeof content === "object") return normalizeParsedContent(content);
  const text = String(content || "").trim();
  if (!text) return {};

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1] || text.match(/\{[\s\S]*\}/u)?.[0] || text;
  return normalizeParsedContent(JSON.parse(candidate));
}

export function parseDeepSeekBatchTypeResponse(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  const parsed = content && typeof content === "object"
    ? content
    : parseJsonContent(String(content || "").trim());
  const results = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(results)) return [];
  return results.map((item) => ({
    id: String(item.id || "").trim(),
    ...normalizeParsedContent(item)
  }));
}

export function validateClassification(classification = {}) {
  const primaryType = String(classification.primaryType || "").trim();
  const secondaryType = String(classification.secondaryType || "").trim();
  const confidence = normalizeConfidence(classification.confidence);
  const reason = String(classification.reason || "").trim();

  if (!isValidPrimaryType(primaryType)) {
    return invalidResult(`DeepSeek 返回了非法一级类型：${primaryType || "空"}`);
  }

  const labels = secondaryLabelsForPrimary(primaryType);
  const normalizedSecondary = labels.length === 0 ? "" : secondaryType;
  if (!isValidSecondaryForPrimary(primaryType, normalizedSecondary)) {
    return invalidResult(`DeepSeek 返回的二级类型不属于一级类型 ${primaryType}：${secondaryType || "空"}`);
  }

  return {
    ok: true,
    primaryType,
    secondaryType: normalizedSecondary,
    confidence,
    reason
  };
}

const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const LEGACY_DEEPSEEK_MODELS = new Set(["deepseek-chat", "deepseek-reasoner"]);

function loadDeepSeekConfig(env = process.env) {
  const apiKey = String(env.DEEPSEEK_API_KEY || env.DEEPSEEK_API || "").trim();
  const model = normalizeDeepSeekModel(env.DEEPSEEK_MODEL);
  const baseUrl = String(env.DEEPSEEK_BASE_URL || env.DEEPSEEK_URL || "https://api.deepseek.com")
    .trim()
    .replace(/\/+$/, "");
  const missing = [];
  if (!apiKey) missing.push("DEEPSEEK_API_KEY");
  if (!model) missing.push("DEEPSEEK_MODEL");
  if (!baseUrl) missing.push("DEEPSEEK_BASE_URL");
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

function normalizeParsedContent(content = {}) {
  return {
    primaryType: String(content.primaryType || content.primary_type || "").trim(),
    secondaryType: String(content.secondaryType || content.secondary_type || "").trim(),
    confidence: normalizeConfidence(content.confidence),
    reason: String(content.reason || "").trim()
  };
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

function invalidResult(reason) {
  return {
    ok: false,
    primaryType: "",
    secondaryType: "",
    confidence: 0,
    reason
  };
}

function failureResult(reason) {
  return {
    ...invalidResult(reason),
    source: "deepseek"
  };
}
