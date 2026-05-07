export const TAG_TYPE_RULES = [
  { tag: "#同花顺资讯", type: "资讯" },
  { tag: "#同花顺股友说", type: "股友说" },
  { tag: "#同顺图解", type: "图文" },
  { tag: "#同顺盘点", type: "盘点" },
  { tag: "#问财问句", type: "问财" },
  { tag: "#同顺深度财经", type: "长视频" },
  { tag: "#同顺财商", type: "财商动画" },
  { tag: "#同花顺股民话题", type: "社区话题" }
];

export function classifyTags(tags) {
  const tagSet = new Set(String(tags || "").split(/\s+/).filter(Boolean));
  for (const rule of TAG_TYPE_RULES) {
    if (tagSet.has(rule.tag)) return rule.type;
  }
  return "无";
}
