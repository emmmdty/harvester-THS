import { extractDouyinItem } from "../../link-utils.mjs";

export function normalizeDouyinItem(item = {}) {
  const link = item.link || item.itemUrl || item.videoUrl || "";
  const extracted = extractDouyinItem(link);
  return {
    ...item,
    platformId: "douyin",
    id: item.id || item.itemId || extracted?.id || "",
    link,
    title: item.title || "",
    tags: item.tags || "",
    publishedAt: item.publishedAt || "",
    itemType: item.itemType || item.type || (extracted?.type === "note" ? "图文" : "视频")
  };
}
