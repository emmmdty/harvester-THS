import {
  DOUYIN_CHANNEL_PRIMARY_TYPES,
  secondaryLabelsForPrimary
} from "../douyin-channel-type-classifier/taxonomy.mjs";

export const BILIBILI_PRIMARY_TYPES = [
  "采访内容",
  "大佬生平",
  "新手教学指标教学",
  "海外搬运",
  "短视频"
];

export const XHS_TAXONOMY = {
  primaryTypes: ["图文", "视频"],
  secondaryTypes: {
    "图文": ["财富人物", "理财方法", "行业盘点", "互动话题"],
    "视频": ["股友说", "社区话题", "资讯", "说唱", "段子", "长视频"]
  }
};

export function normalizePlatformClassification({ platformId, primaryType = "", secondaryType = "", reason = "" } = {}) {
  const primary = String(primaryType || "").trim();
  const secondary = String(secondaryType || "").trim();
  if (platformId === "douyin") {
    if (!DOUYIN_CHANNEL_PRIMARY_TYPES.includes(primary)) {
      return invalidPlatformClassification(
        `抖音一级类型只能是${DOUYIN_CHANNEL_PRIMARY_TYPES.join("、")}，模型返回了${primary || "空"}。`
      );
    }
    const allowedSecondary = secondaryLabelsForPrimary(primary);
    if (allowedSecondary.length === 0) {
      if (secondary) {
        return invalidPlatformClassification(`抖音${primary}二级类型必须为空，模型返回了${secondary}。`);
      }
      return { ok: true, primaryType: primary, secondaryType: "" };
    }
    if (!allowedSecondary.includes(secondary)) {
      return invalidPlatformClassification(
        `抖音${primary}二级类型只能是${allowedSecondary.join("、")}，模型返回了${secondary || "空"}。`
      );
    }
    return { ok: true, primaryType: primary, secondaryType: secondary };
  }
  if (platformId === "bilibili") {
    if (!BILIBILI_PRIMARY_TYPES.includes(primary)) {
      return invalidPlatformClassification(
        `B站内容类型只能是${BILIBILI_PRIMARY_TYPES.join("、")}，模型返回了${primary || "空"}。`
      );
    }
    return { ok: true, primaryType: primary, secondaryType: "" };
  }
  if (platformId === "xhs") {
    if (!XHS_TAXONOMY.primaryTypes.includes(primary)) {
      return invalidPlatformClassification(`小红书一级类型只能是图文或视频，模型返回了${primary || "空"}。`);
    }
    const allowedSecondary = XHS_TAXONOMY.secondaryTypes[primary] || [];
    if (!allowedSecondary.includes(secondary)) {
      return invalidPlatformClassification(
        `小红书${primary}二级类型只能是${allowedSecondary.join("、")}，模型返回了${secondary || "空"}。`
      );
    }
    return { ok: true, primaryType: primary, secondaryType: secondary };
  }
  return { ok: true, primaryType: primary, secondaryType: secondary, reason };
}

export function buildPlatformTaxonomyPrompt(platformId) {
  if (platformId === "bilibili") return buildBilibiliTaxonomyPrompt();
  if (platformId === "xhs") return buildXhsTaxonomyPrompt();
  return "";
}

function invalidPlatformClassification(reason) {
  return {
    ok: false,
    primaryType: "",
    secondaryType: "",
    reason
  };
}

function buildBilibiliTaxonomyPrompt() {
  return [
    "B站本地分类体系：",
    `- primaryType 只能是：${BILIBILI_PRIMARY_TYPES.join("、")}。`,
    "- secondaryType 必须是空字符串。",
    "- 不允许输出 资讯、财经、盘点、图文、视频 等旧标签或泛化标签。",
    "- 采访内容：人物采访、投资经历访谈、交易者访谈或对话型内容。",
    "- 大佬生平：企业家、投资大佬、创始人、接班人等人物成长史、财富史或传记故事。",
    "- 新手教学指标教学：新手投资教学、指标教学、K线形态、盘面强弱、技术指标用法。",
    "- 海外搬运：海外交易者、海外亿万富翁、海外采访、翻译或搬运内容。",
    "- 短视频：歌曲祝福、轻量口播、热点盘点、短小创意或平台传播型视频，且不属于采访、人物传记、教学、海外搬运。",
    "- 易混边界：访谈/对话归采访内容；人物成长史、企业史、财富史归大佬生平；方法指标归新手教学指标教学；海外人物或海外采访优先归海外搬运；短视频只用于轻量表达或短内容兜底，不抢占前四类明确内容。"
  ].join("\n");
}

function buildXhsTaxonomyPrompt() {
  return [
    "小红书本地分类体系：",
    "- primaryType 只能是：图文、视频。",
    "- 图文 secondaryType 只能是：财富人物、理财方法、行业盘点、互动话题。",
    "- 视频 secondaryType 只能是：股友说、社区话题、资讯、说唱、段子、长视频。",
    "- primaryType 优先根据作品类型或素材形态判断；无法确认图文/视频时不要硬猜。",
    "- 图文/财富人物：财富曲线、游资、牛散、老板、投资大师、行业龙头等人物故事。",
    "- 图文/理财方法：财务自由、存钱法、复利思维、K线形态、交易成长路径、投资境界、书单和纪录片推荐。",
    "- 图文/行业盘点：涨停复盘、资金流向、ETF排名、AI应用、机器人、PCB、存储芯片、产业链梳理。",
    "- 图文/互动话题：提问、选择题、观点句引导互动的图文话题。",
    "- 视频/股友说：股民身份、炒股生活、交易心态、悟道观点。",
    "- 视频/社区话题：同花顺社区、评论区、互动提问或股民社交话题。",
    "- 视频/资讯：财经资讯、市场消息、热点事件，且不属于其他视频二级类型。",
    "- 视频/说唱：说唱、押韵音乐、Rap。",
    "- 视频/段子：玩梗、反差、喜剧、调侃。",
    "- 视频/长视频：长视频、深度讲解、完整节目或长时长内容。"
  ].join("\n");
}
