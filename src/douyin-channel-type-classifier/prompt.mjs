import { buildTaxonomyPromptText, DOUYIN_CHANNEL_PRIMARY_TYPES } from "./taxonomy.mjs";

export function buildClassificationMessages({ title = "", tags = "" } = {}) {
  return [
    {
      role: "system",
      content: buildSystemPrompt({
        jsonShape: "{\"primaryType\":\"\",\"secondaryType\":\"\",\"confidence\":0,\"reason\":\"\"}"
      })
    },
    {
      role: "user",
      content: JSON.stringify({
        title: String(title || "").trim(),
        tags: String(tags || "").trim()
      })
    }
  ];
}

export function buildBatchClassificationMessages({ items = [] } = {}) {
  return [
    {
      role: "system",
      content: buildSystemPrompt({
        jsonShape: "{\"results\":[{\"id\":\"\",\"primaryType\":\"\",\"secondaryType\":\"\",\"confidence\":0,\"reason\":\"\"}]}",
        extraRules: [
          "用户会给出 items 数组；每个输入 id 必须返回且只返回一条分类结果。",
          "results 数组中的 id 必须与输入 id 完全一致。"
        ]
      })
    },
    {
      role: "user",
      content: JSON.stringify({
        items: items.map((item) => ({
          id: String(item.id || ""),
          title: String(item.title || "").trim(),
          tags: String(item.tags || "").trim()
        }))
      })
    }
  ];
}

function buildSystemPrompt({ jsonShape, extraRules = [] }) {
  return [
    "你是抖音渠道内容分级分类助手。",
    "请根据标题和 tag词 判断一级类型、二级类型。",
    "一级类型只能从以下列表选择：",
    DOUYIN_CHANNEL_PRIMARY_TYPES.join("、"),
    "二级类型只能从对应一级类型下选择；一级类型为说唱或长视频时，secondaryType 必须为空字符串。",
    ...extraRules,
    "只返回 JSON，不要返回 Markdown、解释或额外文本。",
    `JSON 结构必须是：${jsonShape}。`,
    "confidence 是 0 到 1 的数字；reason 用一句中文说明依据，引用标题或 tag 中出现的线索。",
    "",
    "分类标准：",
    buildTaxonomyPromptText()
  ].join("\n");
}
