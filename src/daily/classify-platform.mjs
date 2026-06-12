import { classifyContentWithFallback } from "../ai/content-classification.mjs";
import { normalizePlatformItems } from "../platforms/index.mjs";
import { detectXhsMaterialKind } from "../platforms/xhs/material-kind.mjs";
import { classifyTags } from "../tag-rules.mjs";

export async function classifyPlatformItems({
  platformId,
  items = [],
  materialResult = {},
  classify = classifyContentWithFallback,
  env = process.env,
  fetch = globalThis.fetch,
  log = () => {}
} = {}) {
  const manifestsById = new Map((materialResult.manifests || []).map((manifest) => [String(manifest.id || ""), manifest]));
  const normalizedItems = normalizePlatformItems(platformId, items);
  const results = [];
  for (const item of normalizedItems) {
    const id = String(item.id || item.itemId || item.noteId || item.bvid || "");
    const manifest = manifestsById.get(id) || {};
    let classification;
    try {
      classification = await classify({
        platformId,
        item,
        materialManifest: manifest,
        env,
        fetch
      });
    } catch (error) {
      classification = {
        ok: false,
        primaryType: platformId === "bilibili" ? item.contentType || "无" : "",
        secondaryType: "",
        contentType: platformId === "bilibili" ? item.contentType || "无" : tagContentTypeForPlatform(platformId, item.tags),
        confidence: 0,
        reason: error.message || String(error),
        provider: "minimax",
        usedMultimodal: false,
        contentTypeReview: `需审核。因为${error.message || String(error)}。`,
        aiContentRemark: "使用minimax，没有使用多模态能力。"
      };
      log(`AI分类失败：${id || item.link || item.title || "未知素材"}：${classification.reason}`);
    }
    const primaryType = platformId === "bilibili"
      ? classification.primaryType || item.contentType || ""
      : classification.primaryType || "";
    const contentType = platformId === "bilibili"
      ? primaryType || item.contentType || "无"
      : tagContentTypeForPlatform(platformId, item.tags);
    results.push({
      ...item,
      contentType,
      primaryType,
      secondaryType: platformId === "bilibili" ? "" : (classification.secondaryType || ""),
      contentTypeReview: classification.contentTypeReview,
      aiContentRemark: classification.aiContentRemark,
      materialKind: platformId === "xhs" ? detectXhsMaterialKind(item, manifest) : (item.materialKind || manifest.materialKind || "")
    });
  }
  return results;
}

function tagContentTypeForPlatform(platformId, tags = "") {
  if (platformId !== "douyin" && platformId !== "xhs") return "";
  const tagType = classifyTags(tags, { platformId });
  if (platformId === "douyin") return tagType || "无";
  return tagType && tagType !== "无" ? tagType : "";
}
