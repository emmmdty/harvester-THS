export const DOUYIN_CHANNEL_PRIMARY_TYPES = [
  "股友说",
  "财商动画",
  "图文",
  "社区话题",
  "说唱",
  "长视频",
  "盘点"
];

export const DOUYIN_CHANNEL_TAXONOMY = [
  {
    primaryType: "股友说",
    definition: "以股民身份、交易心态、炒股生活和投资悟道为核心的口播或观点内容。",
    boundaries: "如果重点是社区互动题目或评论区话题，优先归为社区话题；如果是图文市场复盘，优先归为图文或盘点。",
    secondaryTypes: [
      {
        label: "股民教学",
        description: "偏交易心态、励志语录、悟道方法、稳定盈利习惯。",
        clues: ["稳定盈利", "交易境界", "悟道", "每天看什么", "交易心法"],
        examples: [
          "稳定盈利的人，每天都在看什么？ #同花顺社区 #股友说 #悟道 #投资",
          "交易的最高境界，你悟到了吗？ #财经 #同花顺 #交易 #悟道"
        ]
      },
      {
        label: "股民优势",
        description: "强调炒股、交易或股民群体的优势、爽点、公平竞争和能力价值。",
        clues: ["股市公平", "炒股爽点", "顶级的存在", "交易能成功"],
        examples: [
          "为什么说股市是仅次于高考最公平的竞争？ #财经 #同花顺投资 #股市 #悟道 #同花顺APP",
          "炒股的爽点是什么？ #同花顺社区 #股友说",
          "做交易能成功的人，都是顶级的存在。 #财经 #同花顺 #交易 #悟道"
        ]
      },
      {
        label: "股民洞察",
        description: "围绕股民身份、关系、情绪、生活处境的洞察或反差观点。",
        clues: ["不要告诉别人你是炒股的", "炒股的女人", "恋爱脑", "股民交流"],
        examples: [
          "永远不要告诉别人你是炒股的，尤其是在你还没成功之前......",
          "为什么不能和炒股的女人吵架？ #同花顺社区 #股民交流 #股友说",
          "拯救恋爱脑的方法来了！那就是... #同花顺社区 #股民交流 #股友说 #炒股"
        ]
      }
    ]
  },
  {
    primaryType: "财商动画",
    definition: "用动画、故事化表达讲财商认知、投资选择、成长磨难的内容。",
    boundaries: "如果是纯股民话题互动，不要仅因出现股民就归入财商动画。",
    secondaryTypes: [
      {
        label: "对比分析类",
        description: "用二选一、前后对照、群体比例等方式讲财商选择。",
        clues: ["VS", "你选哪条路", "1%的股民", "对比"],
        examples: [
          "先苦后甜VS先甜后苦，你选哪条路？",
          "你是这1%的股民吗？ #同花顺社区"
        ]
      },
      {
        label: "历经磨难类",
        description: "突出炒股、投资或财富成长中的不容易、隐忍、挫折和逆袭。",
        clues: ["不容易", "一次涨停封神", "没看你", "磨难"],
        examples: [
          "你会把炒股的不容易告诉其他人吗？ #同花顺社区 #股民交流 #股友说",
          "别人只看你一次涨停封神 没看你…… #同顺财商 #财经 #同花顺APP #投资"
        ]
      }
    ]
  },
  {
    primaryType: "图文",
    definition: "以图文、清单、长图、知识卡片形式承载的信息整理或观点内容。",
    boundaries: "如果核心是资金、行情、榜单、产业链等盘点，且标签含同顺盘点或 AI 盘点，优先归为盘点。",
    secondaryTypes: [
      {
        label: "市场热点行业盘点",
        description: "市场热点、涨停复盘、行业板块、产业链企业梳理。",
        clues: ["涨停复盘", "板块", "产业链", "企业梳理", "市场热点"],
        examples: [
          "6月1日涨停股复盘！",
          "6月4日涨停复盘！",
          "创新药板块产业链相关企业梳理"
        ]
      },
      {
        label: "投资认知理财方法",
        description: "投资认知、理财思维、攒钱方法、财务自由方法论。",
        clues: ["攒100万", "理财思维", "财务自由", "普通人"],
        examples: [
          "普通人攒100万为什么总是被打断",
          "财务自由者的12个理财思维"
        ]
      },
      {
        label: "财富故事投资人物",
        description: "投资人物、财富曲线、游资、大佬、创投人物故事。",
        clues: ["财富曲线", "投资人物", "游资", "创投教父", "时代风口"],
        examples: [
          "A股首板之王，游资北京炒家的财富曲线",
          "踩中3个时代风口 创投教父沈南鹏财富曲线"
        ]
      },
      {
        label: "话题类内容",
        description: "图文化表达的人生、情绪、命运、认知变现等话题内容。",
        clues: ["大师说", "K线", "认知变现", "选择买单", "话题"],
        examples: [
          "大师说我最近会为情所困，我想了半天 亲情友情爱情 万万没想到",
          "人这一生不过3万根k线。所有命运馈赠，都是认知变现；所有遗憾亏损，都是选择买单。"
        ]
      }
    ]
  },
  {
    primaryType: "社区话题",
    definition: "以同花顺社区、股民评论区、互动提问、产品种草为核心的社交话题内容。",
    boundaries: "如果不是互动话题，而是股民身份洞察或交易悟道，优先归为股友说。",
    secondaryTypes: [
      {
        label: "股市段子互动",
        description: "评论区互动、段子、调侃、假期不开盘、颜值、战法梗等。",
        clues: ["评论区", "段子", "SB战法", "假期不开盘", "女股民"],
        examples: [
          "为什么炒股的女人更容易瘦下来？ #同花顺社区 #炒股 #股民交流 #股友",
          "传说中的SB战法，这么精准也是有水平的 #股市 #同花顺社区话题 #同花顺社区 #同花顺股民话题 #中国西电",
          "假期不开盘，想看看评论区女股民们的颜值... #同花顺社区 #股民交流 #同花顺股友说 #同花顺APP"
        ]
      },
      {
        label: "股民情绪共鸣",
        description: "股民情绪、上班对抗、悟道共鸣、身份认同类互动。",
        clues: ["对抗上班", "一句话证明", "悟道", "情绪共鸣"],
        examples: [
          "炒股是对抗上班最好的办法？ #同花顺社区 #股民交流 #股民 #股友说",
          "用一句话证明你悟道了？ #同花顺社区 #股民交流 #股友说 #股民"
        ]
      },
      {
        label: "同花顺产品种草",
        description: "直接推荐或种草同花顺 App、工具、功能、炒股神器。",
        clues: ["同花顺App", "同花顺APP", "炒股必备神器", "手游我只玩同花顺"],
        examples: [
          "2亿玩家同时在线，炒股必备神器同花顺 #同花顺App #股票 #股民 #财经",
          "手游我只玩同花顺的原因找到了 #同花顺APP #财经 #投资 #股票"
        ]
      }
    ]
  },
  {
    primaryType: "说唱",
    definition: "以说唱、押韵音乐、Rap 表达为主要形式的内容。",
    boundaries: "二级类型必须留空；不要强行归入其他二级标签。",
    secondaryTypes: []
  },
  {
    primaryType: "长视频",
    definition: "长视频、深度视频、长时长讲解或完整节目类内容。",
    boundaries: "二级类型必须留空；不要强行归入其他二级标签。",
    secondaryTypes: []
  },
  {
    primaryType: "盘点",
    definition: "围绕行情、资金、板块、品种、产业链、知识清单等进行系统盘点和梳理的内容。",
    boundaries: "如果只是图文表达但核心不是行情/清单/盘点，不要因为形式是图文就归入盘点。",
    secondaryTypes: [
      {
        label: "资金盘面盘点",
        description: "主力资金、抱团、涨跌、榜单、持仓、行情数据等盘面盘点。",
        clues: ["主力资金", "抱团", "增强前十", "减弱前十", "涨跌幅", "榜单", "持仓", "行情数据"],
        examples: [
          "盘点 5 月 18 日主力抱团增强前十 VS 减弱前十 #同花顺APP #同顺盘点 #投资 #龙头强度",
          "6月8日，主力资金都去哪儿了？ #同顺盘点 #投资 #财经 #玩转同花顺"
        ]
      },
      {
        label: "行业品种产业链解析",
        description: "赛道、板块、大宗商品、期货、产业、个股题材和产业链解析。",
        clues: ["赛道", "板块", "大宗商品", "期货", "产业", "题材", "黄金", "光纤概念"],
        examples: [
          "抄底的时机到了吗？黄金历史上六次跳水回顾 #财经 #股市 #同花顺ETF #同花顺产业地图 #黄金",
          "光纤概念持续走强，附上下游企业一览 #财经 #同花顺投资 #投资 #股票"
        ]
      },
      {
        label: "投资知识类盘点",
        description: "股息率、抗跌、业绩、社保基金持仓等投资知识清单盘点。",
        clues: ["股息率", "抗跌", "业绩优", "社保基金", "新建仓", "股票一览", "AI盘点"],
        examples: [
          "股息率最高 7.79%；抗跌 + 业绩优 股票一览！ #财经 #同花顺投资 #投资",
          "社保基金持仓曝光！新建仓股票盘点 #财经 #同花顺投资 #股票 #AI盘点"
        ]
      }
    ]
  }
];

export function secondaryLabelsForPrimary(primaryType) {
  return (DOUYIN_CHANNEL_TAXONOMY.find((entry) => entry.primaryType === primaryType)?.secondaryTypes || [])
    .map((entry) => entry.label);
}

export function flattenSecondaryLabels() {
  return DOUYIN_CHANNEL_TAXONOMY.flatMap((entry) => secondaryLabelsForPrimary(entry.primaryType));
}

export function isValidPrimaryType(primaryType) {
  return DOUYIN_CHANNEL_PRIMARY_TYPES.includes(String(primaryType || "").trim());
}

export function isValidSecondaryForPrimary(primaryType, secondaryType) {
  const labels = secondaryLabelsForPrimary(primaryType);
  const secondary = String(secondaryType || "").trim();
  if (labels.length === 0) return secondary === "";
  return labels.includes(secondary);
}

export function buildTaxonomyPromptText() {
  return DOUYIN_CHANNEL_TAXONOMY.map((entry) => {
    const secondaryText = entry.secondaryTypes.length
      ? entry.secondaryTypes.map((secondary) => [
        `  - 二级类型：${secondary.label}`,
        `    定义：${secondary.description}`,
        `    线索：${secondary.clues.join("、")}`,
        `    示例：${secondary.examples.join(" | ")}`
      ].join("\n")).join("\n")
      : `  - ${entry.primaryType}：二级类型必须留空。`;
    return [
      `一级类型：${entry.primaryType}`,
      `定义：${entry.definition}`,
      `边界：${entry.boundaries}`,
      secondaryText
    ].join("\n");
  }).join("\n\n");
}
