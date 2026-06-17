import { classifyContentWithFallback } from "../ai/content-classification.mjs";
import { normalizePlatformItems } from "../platforms/index.mjs";
import { detectXhsMaterialKind } from "../platforms/xhs/material-kind.mjs";
import { classifyTags } from "../tag-rules.mjs";
import { emitProgress } from "../progress-events.mjs";

export async function classifyPlatformItems({
  platformId,
  items = [],
  materialResult = {},
  classify = classifyContentWithFallback,
  env = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  onProgress = null
} = {}) {
  const manifestsById = new Map((materialResult.manifests || []).map((manifest) => [String(manifest.id || ""), manifest]));
  const normalizedItems = normalizePlatformItems(platformId, items);
  const results = [];
  for (let index = 0; index < normalizedItems.length; index += 1) {
    const item = normalizedItems[index];
    const id = String(item.id || item.itemId || item.noteId || item.bvid || "");
    const manifest = manifestsById.get(id) || {};
    const hasMaterial = hasUsableMaterial(manifest);
    emitProgress({
      onProgress,
      log,
      logProgress: shouldLogProgress(env),
      platformId,
      stage: "classify",
      phase: "start",
      itemId: id || item.link || item.title || "",
      completed: index,
      total: normalizedItems.length,
      action: `AI分类中：${hasMaterial ? "多模态" : "文本"}`
    });
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
    emitProgress({
      onProgress,
      log,
      logProgress: shouldLogProgress(env),
      platformId,
      stage: "classify",
      phase: classification.ok ? "done" : "failed",
      itemId: id || item.link || item.title || "",
      completed: index + 1,
      total: normalizedItems.length,
      action: `AI分类${classification.ok ? "完成" : "失败"}：${classification.provider || "unknown"} ${classification.usedMultimodal ? "多模态" : "文本"}`
    });
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

function hasUsableMaterial(manifest = {}) {
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest.videoPath || manifest.imagePath) return true;
  if (Array.isArray(manifest.imagePaths) && manifest.imagePaths.length > 0) return true;
  if (Array.isArray(manifest.framePaths) && manifest.framePaths.length > 0) return true;
  if (Array.isArray(manifest.assets) && manifest.assets.some((asset) => asset?.path || asset?.url)) return true;
  return false;
}

function shouldLogProgress(env = process.env) {
  return /^(1|true|yes|on)$/iu.test(String(env.HARVESTER_PROGRESS_LOGS || "").trim());
}

function tagContentTypeForPlatform(platformId, tags = "") {
  if (platformId !== "douyin" && platformId !== "xhs") return "";
  const tagType = classifyTags(tags, { platformId });
  if (platformId === "douyin") return tagType || "无";
  return tagType && tagType !== "无" ? tagType : "";
}
