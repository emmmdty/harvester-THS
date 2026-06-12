import { normalizeBilibiliItem } from "./bilibili/adapter.mjs";
import { normalizeDouyinItem } from "./douyin/adapter.mjs";
import { normalizeXhsItem } from "./xhs/adapter.mjs";

export function normalizePlatformItem(platformId, item = {}) {
  if (platformId === "douyin") return normalizeDouyinItem(item);
  if (platformId === "xhs") return normalizeXhsItem(item);
  if (platformId === "bilibili") return normalizeBilibiliItem(item);
  throw new Error(`不支持的平台：${platformId}`);
}

export function normalizePlatformItems(platformId, items = []) {
  return (items || []).map((item) => normalizePlatformItem(platformId, item));
}
