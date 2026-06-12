import { classifyTags } from "./tag-rules.mjs";

export const CONTENT_TYPE_REVIEW_PASS = "通过";
export const CONTENT_TYPE_REVIEW_REQUIRED = "需审核";

export async function classifyContentType({
  platformId,
  accountName = "",
  title = "",
  tags = "",
  text = "",
  env = process.env,
  fetch = globalThis.fetch
} = {}) {
  const tagType = classifyTags(tags, { platformId });
  if (tagType && tagType !== "无") {
    return classificationResult(tagType, CONTENT_TYPE_REVIEW_PASS, "tag");
  }
  void platformId;
  void accountName;
  void title;
  void text;
  void env;
  void fetch;
  return classificationResult("无", CONTENT_TYPE_REVIEW_REQUIRED, "fallback");
}

export function parseDeepSeekClassification(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (content && typeof content === "object") return content;
  const text = String(content || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

function classificationResult(contentType, contentTypeReview, source) {
  return {
    contentType,
    contentTypeReview,
    source
  };
}
