import { extractBilibiliBv } from "../../link-utils.mjs";

export function normalizeBilibiliItem(item = {}) {
  const link = item.link || item.videoUrl || item.itemUrl || "";
  return {
    ...item,
    platformId: "bilibili",
    id: item.id || item.bvid || extractBilibiliBv(link) || "",
    bvid: item.bvid || item.id || extractBilibiliBv(link) || "",
    link,
    title: item.title || "",
    tags: item.tags || "",
    publishedAt: item.publishedAt || "",
    itemType: item.itemType || item.type || "视频"
  };
}
