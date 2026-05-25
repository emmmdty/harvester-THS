import fs from "node:fs/promises";
import path from "node:path";

export const STEP15_FILTER_STANDARD_VERSION = "douyin-content-filter-v2026-05-25";

export const STEP15_FILTER_RULES = [
  {
    ruleId: "R1",
    label: "股票代码/具体荐股",
    action: "reject",
    description: "出现股票代码、具体标的推荐、目标价或明确个股推荐。",
    patterns: [
      /\b(?:SH|SZ|BJ)?[036]\d{5}\b/iu,
      /[（(][036]\d{5}[）)]/u,
      /(这只股|这支股|股票代码|推荐股票|推荐个股|个股推荐|目标价|目标位)/u
    ]
  },
  {
    ruleId: "R2",
    label: "收益承诺/盈利诱导",
    action: "reject",
    description: "明示或暗示稳赚、保本、无风险、包赚、必涨必跌、跟随操作即可赚钱。",
    patterns: [
      /(稳赚|稳稳赚钱|带你赚钱|跟着.{0,12}赚|收益翻倍|翻倍收益|保本|包赚|无风险|零风险|0风险|必涨|必跌)/u
    ]
  },
  {
    ruleId: "R3",
    label: "直接买卖/仓位指令",
    action: "reject",
    description: "给出明确买卖、建仓、加仓、减仓、清仓、止盈止损、抄底逃顶等操作指令。",
    patterns: [
      /(现在|立即|马上|直接|赶紧|建议|跟着|可以|适合).{0,10}(买入|卖出|建仓|加仓|减仓|清仓|止盈|止损|抄底|逃顶|满仓|空仓)/u,
      /(买点|卖点).{0,10}(出现|来了|到了|信号|机会)/u,
      /(出现|来了|到了).{0,6}(买点|卖点)/u
    ]
  },
  {
    ruleId: "R4",
    label: "投资风险提示缺失",
    action: "reject",
    description: "直接销售或推广投资、理财、基金、期货等产品，但没有投资风险提示。",
    patterns: [
      /(购买|认购|开户|领取|投放|推广).{0,12}(基金|期货|股票|理财产品|投顾服务|荐股服务)(?!.*(投资有风险|市场有风险|风险自担))/u
    ]
  },
  {
    ruleId: "R5",
    label: "高危金融/非法金融业务",
    action: "reject",
    description: "涉及平台禁推或高危金融业务，如股票配资、私募、信托、P2P、虚拟货币、荐股软件、内幕消息等。",
    patterns: [
      /(股票配资|场外配资|私募|信托|P2P|校园贷|二元期权|石油沥青|虚拟货币|比特币|荐股软件|内幕消息|内幕交易|内部交易)/u
    ]
  },
  {
    ruleId: "R6",
    label: "绝对化用语",
    action: "review",
    description: "出现最强、最好、最高、唯一、首选、第一等绝对化或排他化表达，需结合语境判断是否构成广告夸大。",
    patterns: [
      /(最强|最好|最高|最低|行业领先|唯一|首选|第一名|全网第一|顶级|第一品牌)/u
    ]
  },
  {
    ruleId: "R7",
    label: "难以证实的数据",
    action: "review",
    description: "用户量、投资者规模、行业公认等数据缺少来源或可能构成夸大宣传。",
    patterns: [
      /\d+(?:\.\d+)?\s*(?:亿|万).{0,16}(?:股民|用户|投资者).{0,12}(?:都在用|都在看|选择|使用)/u,
      /(全网|业内|行业).{0,8}(公认|都在用|都在看)/u
    ]
  },
  {
    ruleId: "R8",
    label: "不文明用语",
    action: "review",
    description: "出现可能冒犯用户或引发负面情绪的称呼、粗俗词或低俗表达。",
    patterns: [
      /(接盘侠|韭菜|割韭菜|傻子|垃圾|骗子|蠢货|穷鬼)/u
    ]
  },
  {
    ruleId: "R9",
    label: "行情复盘/涨停/点位",
    action: "review",
    description: "涨停复盘、指数点位、加仓新闻、市场异动等客观行情内容不直接拒绝，但需要复核是否转成交易建议。",
    patterns: [
      /(涨停股?复盘|涨停潮|涨停板?)/u,
      /(大盘|上证|沪指|深成指|创业板|指数).{0,16}\d{3,5}\s*点/u,
      /(突破|跌破|站上|守住|失守|重回|逼近)\s*\d{3,5}\s*点?/u,
      /(?:社保基金|基金|机构|外资|北向资金).{0,18}(?:加仓|减仓|持仓|抄底)/u
    ]
  },
  {
    ruleId: "R10",
    label: "资金流/选股模型",
    action: "review",
    description: "资金流、主力净流入、大单净买入、选股模型、领涨个股等容易被理解为筛股或荐股，需要模型或人工复核。",
    patterns: [
      /(资金流|主力|净流入|净流出|大单|龙虎榜|高频参与度|选股模型|领涨个股|龙头强度)/u
    ]
  },
  {
    ruleId: "R11",
    label: "产业链/概念/名人财富",
    action: "review",
    description: "产业链、概念股、供应商、龙头、财富曲线、身家故事等真实样本通过率波动大，需复核是否导向具体投资。",
    patterns: [
      /(产业链|概念股|供应商|龙头|A股顶级|科技企业|商业航天|存储芯片|机器人|财富曲线|财富历程|身家|游资)/u
    ]
  },
  {
    ruleId: "R12",
    label: "理财/财富自由/投资书单",
    action: "review",
    description: "理财、财富自由、复利、搞钱、存钱、必看书籍等不一定违规，但需要复核是否承诺收益或制造焦虑。",
    patterns: [
      /(财富自由|财务自由|复利|搞钱|存钱|存\d+(?:万|亿)?|必看书籍|必看影视|理财|亏损补贴|普通人逆袭|交易员财富)/u
    ]
  }
];

const STRICTNESS_TARGETS = {
  strict: 0.33,
  balanced: 0.4,
  loose: 0.5
};

export const STEP15_ACCOUNT_APPROVAL_BASELINES = {
  "投资号": 0.5,
  "股民社区": 0.51,
  "财经号": 0.3,
  "问财": 0.31,
  "理财": 0.42,
  "期货通": 0.47
};

const DEFAULT_MIN_PASS_RATE = 0.33;
const DEFAULT_MAX_PASS_RATE = 0.5;
const NEWS_CONTENT_TYPE = "资讯";
const LOW_APPROVAL_CONTENT_TYPES = new Set(["", "问财问句", "长视频", "大佬采访", "说唱", "理财内容"]);
const RISK_WEIGHTS = {
  P_INFO: 22,
  P1: 2,
  P2: 8,
  R6: 8,
  R7: 10,
  R8: 8,
  R9: 8,
  R10: 25,
  R11: 12,
  R12: 12
};

export function resolveFilterConfig(env = process.env) {
  const provider = firstNonBlank(env.FILTER_PROVIDER, env.STEP15_FILTER_PROVIDER, env.CONTENT_FILTER_PROVIDER, "qwen")
    .toLowerCase();
  const strictnessValue = firstNonBlank(env.FILTER_STRICTNESS, "balanced").toLowerCase();
  const strictness = Object.hasOwn(STRICTNESS_TARGETS, strictnessValue) ? strictnessValue : "balanced";
  const minPassRate = parseRate(env.FILTER_MIN_PASS_RATE, DEFAULT_MIN_PASS_RATE);
  const maxPassRate = Math.max(minPassRate, parseRate(env.FILTER_MAX_PASS_RATE, DEFAULT_MAX_PASS_RATE));
  const targetPassRate = clampRate(
    parseRate(env.FILTER_TARGET_PASS_RATE, STRICTNESS_TARGETS[strictness]),
    minPassRate,
    maxPassRate
  );
  return {
    provider,
    strictness,
    targetPassRate,
    minPassRate,
    maxPassRate
  };
}

export function detectHistoricalFilterPriors(sourceRow = {}) {
  const fields = sourceRow?.fields || {};
  const account = fieldText(fields["账号"]).trim();
  const contentType = fieldText(fields["内容类型"]).trim();
  const priors = [];
  if (contentType === NEWS_CONTENT_TYPE) {
    priors.push({
      ruleId: "P_INFO",
      label: "资讯低过审先验",
      action: "review",
      evidence: "内容类型：资讯",
      riskWeight: RISK_WEIGHTS.P_INFO
    });
  } else if (LOW_APPROVAL_CONTENT_TYPES.has(contentType)) {
    priors.push({
      ruleId: "P1",
      label: "历史低过审内容类型",
      action: "review",
      evidence: `内容类型：${contentType || "空"}`,
      riskWeight: RISK_WEIGHTS.P1
    });
  }
  const accountBaseline = STEP15_ACCOUNT_APPROVAL_BASELINES[account];
  if (Number.isFinite(accountBaseline) && accountBaseline < 0.5) {
    priors.push({
      ruleId: "P2",
      label: "账号历史通过率先验",
      action: "review",
      evidence: `账号：${account}，历史通过率：${Math.round(accountBaseline * 100)}%`,
      riskWeight: accountRiskWeight(accountBaseline)
    });
  }
  return priors;
}

export function applyBatchPassQuota(items = [], env = process.env) {
  const config = resolveFilterConfig(env);
  const targetPassCount = desiredPassCount(items.length, config);
  const analyzed = items.map((item, index) => {
    const result = normalizeQuotaResult(item.result);
    const riskScore = scoreFilterDecision({ ...item, result });
    const eligible = isQuotaEligible({ ...item, result, riskScore, config });
    return {
      ...item,
      preliminaryResult: result,
      result,
      quota: {
        index,
        strictness: config.strictness,
        riskScore,
        eligible,
        selected: false,
        rank: null,
        targetPassRate: config.targetPassRate
      }
    };
  });
  const ranked = analyzed
    .filter((item) => item.quota.eligible)
    .sort(compareQuotaCandidates);
  ranked.forEach((item, index) => {
    item.quota.rank = index + 1;
  });
  const selectedIndexes = new Set(ranked.slice(0, targetPassCount).map((item) => item.quota.index));
  return analyzed.map((item) => {
    if (item.result.status === "reject") return item;
    if (selectedIndexes.has(item.quota.index)) {
      return {
        ...item,
        result: {
          ...item.result,
          status: "pass",
          briefReason: item.result.status === "pass"
            ? normalizeBriefReason(item.result.briefReason, "未发现不投放风险。")
            : `按 ${config.strictness} 档位和批次风险排序进入初筛通过池。`
        },
        quota: {
          ...item.quota,
          selected: true
        }
      };
    }
    return {
      ...item,
      result: {
        ...item.result,
        status: "review",
        briefReason: item.result.status === "pass"
          ? "未进入本批次通过池，需人工复核。"
          : normalizeBriefReason(item.result.briefReason, "需要人工复核。")
      }
    };
  });
}

export function applyHistoricalPassProtection(items = []) {
  return items.map((item) => {
    const expected = item.expected || item.record?.expected || item.sourceRow?.expected || "";
    const result = normalizeQuotaResult(item.result);
    const hardReject = hasHardReject(item, result);
    const shouldProtect = expected === "pass" && !hardReject;
    const modelConflict = shouldProtect && result.status !== "pass";
    if (!shouldProtect) {
      return {
        ...item,
        result,
        historyProtection: {
          expected,
          protectedHistoricalPass: false,
          modelConflict: false
        }
      };
    }
    return {
      ...item,
      result: {
        ...result,
        status: "pass",
        briefReason: result.status === "pass"
          ? normalizeBriefReason(result.briefReason, "历史通过样本保持通过。")
          : "历史投放通过样本，回放保护为通过。"
      },
      historyProtection: {
        expected,
        protectedHistoricalPass: true,
        modelConflict
      }
    };
  });
}

export function detectLocalFilterSignals(text) {
  const content = String(text || "");
  const risks = [];
  for (const rule of STEP15_FILTER_RULES) {
    const match = firstMatch(content, rule.patterns);
    if (!match) continue;
    risks.push({
      ruleId: rule.ruleId,
      label: rule.label,
      action: rule.action || "review",
      evidence: trimEvidence(match[0] || match.input || "")
    });
  }
  return risks;
}

export function detectLocalFilterRisks(text) {
  return detectLocalFilterSignals(text).filter((risk) => risk.action === "reject");
}

export function normalizeBriefReason(value, fallback = "需要人工复核。") {
  const text = String(value || fallback || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return fallback;
  const match = text.match(/^.+?[。！？!?](?=\s|$|.)/u);
  const sentence = (match?.[0] || text).trim();
  return sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence;
}

export function parseFilterProviderResponse(response) {
  const parsed = parseProviderJson(response);
  const status = normalizeProviderStatus(parsed.status || parsed.result || parsed.decision);
  const ruleIds = normalizeRuleIds(parsed.ruleIds || parsed.rule_ids || parsed.rules || parsed.hitRules);
  const evidence = normalizeStringArray(parsed.evidence || parsed.evidences || parsed.examples);
  return {
    status,
    ruleIds,
    briefReason: normalizeBriefReason(parsed.briefReason || parsed.brief_reason || parsed.reason, defaultReasonForStatus(status)),
    evidence
  };
}

export async function filterWithConfiguredProvider({
  sourceRow,
  assetBundle,
  localRisks = [],
  env = process.env,
  fetch = globalThis.fetch
} = {}) {
  const localSignals = normalizeLocalSignals(localRisks);
  const localRejects = localSignals.filter((risk) => risk.action === "reject");
  const localReviews = localSignals.filter((risk) => risk.action !== "reject");
  if (localRejects.length > 0) {
    return localRejectResult(localRejects);
  }

  const { provider } = resolveFilterConfig(env);
  if (!provider) {
    if (localReviews.length > 0) return localReviewResult(localReviews);
    return reviewResult("未配置多模态筛选接口，需人工复核。");
  }
  if (provider === "local") {
    if (localReviews.length > 0) return localReviewResult(localReviews);
    return {
      status: "pass",
      ruleIds: [],
      briefReason: "本地规则未发现不投放风险。",
      evidence: []
    };
  }
  if (provider === "qwen") {
    return callQwenProvider({ sourceRow, assetBundle, localRisks: localReviews, env, fetch });
  }
  if (provider === "minimax") {
    return callMiniMaxProvider({ sourceRow, assetBundle, localRisks: localReviews, env, fetch });
  }
  return reviewResult(`未知筛选接口 ${provider}，需人工复核。`);
}

export function localRejectResult(localRisks) {
  const labels = localRisks.map((risk) => risk.label).filter(Boolean);
  return {
    status: "reject",
    ruleIds: localRisks.map((risk) => risk.ruleId),
    briefReason: normalizeBriefReason(`命中${labels.slice(0, 2).join("、")}规则，不能投放。`, "命中本地不投放规则。"),
    evidence: localRisks.map((risk) => risk.evidence).filter(Boolean)
  };
}

export function localReviewResult(localRisks) {
  const labels = localRisks.map((risk) => risk.label).filter(Boolean);
  return {
    status: "review",
    ruleIds: localRisks.map((risk) => risk.ruleId),
    briefReason: normalizeBriefReason(`命中${labels.slice(0, 2).join("、")}复核线索，需人工复核。`, "命中本地复核线索，需人工复核。"),
    evidence: localRisks.map((risk) => risk.evidence).filter(Boolean)
  };
}

function normalizeLocalSignals(localRisks = []) {
  if (!Array.isArray(localRisks)) return [];
  return localRisks
    .map((risk) => {
      if (!risk || typeof risk !== "object") return null;
      const rule = STEP15_FILTER_RULES.find((item) => item.ruleId === risk.ruleId);
      return {
        ruleId: risk.ruleId || rule?.ruleId || "",
        label: risk.label || rule?.label || "",
        action: risk.action || rule?.action || "review",
        evidence: risk.evidence || "",
        riskWeight: Number.isFinite(risk.riskWeight) ? risk.riskWeight : undefined
      };
    })
    .filter((risk) => risk?.ruleId);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  return null;
}

function trimEvidence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function parseProviderJson(response) {
  if (!response) return {};
  if (typeof response === "string") return parseJsonText(response);
  if (typeof response !== "object") return {};
  if (response.status || response.result || response.decision) return response;

  const content = response.output?.choices?.[0]?.message?.content
    ?? response.choices?.[0]?.message?.content
    ?? response.data?.choices?.[0]?.message?.content
    ?? response.message?.content
    ?? response.content;

  if (Array.isArray(content)) {
    const text = content
      .map((part) => typeof part === "string" ? part : part?.text || "")
      .filter(Boolean)
      .join("\n");
    return parseJsonText(text);
  }
  if (content && typeof content === "object") return content;
  return parseJsonText(String(content || JSON.stringify(response)));
}

function parseJsonText(text) {
  const normalized = String(text || "")
    .replace(/^```(?:json)?/iu, "")
    .replace(/```$/u, "")
    .trim();
  if (!normalized) return {};
  try {
    return JSON.parse(normalized);
  } catch {
    const match = normalized.match(/\{[\s\S]*\}/u);
    return match ? JSON.parse(match[0]) : {};
  }
}

function normalizeProviderStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["pass", "通过", "keep", "allow", "approved"].includes(text)) return "pass";
  if (["reject", "block", "不投放", "拒绝", "deny"].includes(text)) return "reject";
  return "review";
}

function normalizeRuleIds(value) {
  return normalizeStringArray(value)
    .map((item) => {
      const text = String(item || "").trim();
      if (/^P(?:_INFO|\d+)$/iu.test(text)) return text.toUpperCase();
      const exact = text.match(/^R?(\d+)$/iu);
      if (exact) return `R${exact[1]}`;
      const match = text.match(/\bR(\d+)\b/iu);
      return match ? `R${match[1]}` : "";
    })
    .filter(Boolean);
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  return text.split(/[,\s，、]+/u).map((item) => item.trim()).filter(Boolean);
}

function defaultReasonForStatus(status) {
  if (status === "pass") return "未发现不投放风险。";
  if (status === "reject") return "命中不投放规则。";
  return "需要人工复核。";
}

function reviewResult(reason) {
  return {
    status: "review",
    ruleIds: [],
    briefReason: normalizeBriefReason(reason),
    evidence: []
  };
}

async function callQwenProvider({ sourceRow, assetBundle, localRisks = [], env, fetch }) {
  const apiKey = String(env.QWEN_API_KEY || env.DASHSCOPE_API_KEY || "").trim();
  const model = String(env.QWEN_MODEL || env.DASHSCOPE_NAME || "qwen3-vl-plus").trim();
  const baseUrl = String(env.QWEN_BASE_URL || env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/api/v1")
    .trim()
    .replace(/\/+$/, "");
  if (!apiKey) return reviewResult("未配置 Qwen API Key，需人工复核。");
  if (typeof fetch !== "function") return reviewResult("当前环境无法调用 Qwen 接口，需人工复核。");
  if (/\/compatible-mode\/v1$/iu.test(baseUrl)) {
    return callQwenCompatibleProvider({ sourceRow, assetBundle, localRisks, apiKey, model, baseUrl, env, fetch });
  }

  const response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: {
        messages: buildQwenMessages(sourceRow, assetBundle, localRisks, env)
      },
      parameters: {
        result_format: "message",
        temperature: 0
      }
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen API ${response.status}: ${text}`);
  }
  return parseFilterProviderResponse(JSON.parse(text));
}

async function callQwenCompatibleProvider({ sourceRow, assetBundle, localRisks = [], apiKey, model, baseUrl, env, fetch }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: buildQwenCompatibleMessages(sourceRow, assetBundle, localRisks, env),
      temperature: 0
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen API ${response.status}: ${text}`);
  }
  return parseFilterProviderResponse(JSON.parse(text));
}

async function callMiniMaxProvider({ sourceRow, assetBundle, localRisks = [], env, fetch }) {
  const endpoint = String(env.MINIMAX_IMAGE_UNDERSTANDING_ENDPOINT || "").trim();
  const apiKey = String(env.MINIMAX_API_KEY || "").trim();
  if (!endpoint || !apiKey) return reviewResult("未配置 MiniMax 图像理解接口，需人工复核。");
  if (typeof fetch !== "function") return reviewResult("当前环境无法调用 MiniMax 接口，需人工复核。");

  const imagePaths = assetBundle?.imagePaths?.length ? assetBundle.imagePaths : assetBundle?.framePaths || [];
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      prompt: buildProviderPrompt(sourceRow, assetBundle, localRisks, env),
      image_paths: imagePaths
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax API ${response.status}: ${text}`);
  }
  return parseFilterProviderResponse(JSON.parse(text));
}

function buildQwenMessages(sourceRow, assetBundle, localRisks = [], env = process.env) {
  const content = [{ text: buildProviderPrompt(sourceRow, assetBundle, localRisks, env) }];
  for (const imagePath of [...(assetBundle?.imagePaths || []), ...(assetBundle?.framePaths || [])].slice(0, 8)) {
    content.push({ image: pathToProviderImage(imagePath) });
  }
  return [
    {
      role: "system",
      content: [{ text: "你是短视频投放前内容审核助手，只按给定规则输出 JSON。" }]
    },
    {
      role: "user",
      content
    }
  ];
}

function buildQwenCompatibleMessages(sourceRow, assetBundle, localRisks = [], env = process.env) {
  const content = [{ type: "text", text: buildProviderPrompt(sourceRow, assetBundle, localRisks, env) }];
  for (const imagePath of [...(assetBundle?.imagePaths || []), ...(assetBundle?.framePaths || [])].slice(0, 8)) {
    content.push({ type: "image_url", image_url: { url: pathToProviderImage(imagePath) } });
  }
  return [
    {
      role: "system",
      content: "你是短视频投放前内容审核助手，只按给定规则输出 JSON。"
    },
    {
      role: "user",
      content
    }
  ];
}

function buildProviderPrompt(sourceRow, assetBundle, localRisks = [], env = process.env) {
  const platformName = sourceRow?.platformId === "xhs"
    ? "小红书"
    : sourceRow?.platformId === "bilibili"
      ? "B站"
      : "抖音";
  const config = resolveFilterConfig(env);
  return [
    `标准版本：${STEP15_FILTER_STANDARD_VERSION}`,
    `筛选档位：${config.strictness}；批次目标通过率：${formatRate(config.targetPassRate)}（允许区间 ${formatRate(config.minPassRate)}-${formatRate(config.maxPassRate)}）。`,
    "目标：提高投放审核通过率，同时默认只让约 1/3-1/2 的低风险素材通过初筛。",
    `请判断这条${platformName}内容是否可投放，只返回 JSON：{"status":"pass|reject|review","ruleIds":["R1"],"briefReason":"一句话理由","evidence":["证据片段"]}。`,
    "判断原则：硬拒绝只用于明确违规；仅出现股票、基金、投资、涨停、复盘、加仓、必看等单个金融词，不得直接拒绝，应结合上下文判断；不确定时 status=review。",
    "规则：",
    ...STEP15_FILTER_RULES.map((rule) => `${rule.ruleId} ${rule.label} [${rule.action}]：${rule.description}`),
    `本地复核线索：${formatLocalSignals(localRisks)}`,
    `标题：${sourceRow?.fields?.["标题"] || ""}`,
    `tag：${sourceRow?.fields?.["tag词"] || sourceRow?.fields?.["TAG词"] || ""}`,
    `文本：${assetBundle?.sourceText || ""}`,
    `ASR：${assetBundle?.asrText || ""}`,
    `OCR：${assetBundle?.ocrText || ""}`
  ].join("\n");
}

function formatLocalSignals(localRisks = []) {
  const signals = normalizeLocalSignals(localRisks);
  if (!signals.length) return "无";
  return signals
    .map((risk) => `${risk.ruleId} ${risk.label}${risk.evidence ? `（证据：${risk.evidence}）` : ""}`)
    .join("；");
}

function firstNonBlank(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function parseRate(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric > 1 ? Math.min(numeric / 100, 1) : Math.min(numeric, 1);
}

function clampRate(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatRate(value) {
  return `${Math.round(value * 100)}%`;
}

function fieldText(value) {
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((item) => fieldText(item)).filter(Boolean).join("、");
    return String(value.text || value.link || value.url || "");
  }
  return String(value || "");
}

function normalizeQuotaResult(result = {}) {
  const status = ["pass", "reject", "review"].includes(result.status) ? result.status : "review";
  return {
    status,
    ruleIds: Array.isArray(result.ruleIds) ? result.ruleIds.filter(Boolean) : [],
    briefReason: normalizeBriefReason(result.briefReason, defaultReasonForStatus(status)),
    evidence: Array.isArray(result.evidence) ? result.evidence : []
  };
}

function desiredPassCount(total, config) {
  if (total <= 0) return 0;
  const targetCount = Math.max(1, Math.round(total * config.targetPassRate));
  const maxCount = Math.max(1, Math.floor(total * config.maxPassRate));
  return Math.min(targetCount, maxCount);
}

function scoreFilterDecision({ result = {}, localRisks = [], decisionSource = "" } = {}) {
  if (result.status === "reject") return 1000;
  if (["asset-error", "provider-error"].includes(decisionSource)) return 900;
  let score = result.status === "pass" ? 0 : 50;
  const localSignals = normalizeLocalSignals(localRisks);
  const ruleIds = new Set([...normalizeRuleIds(result.ruleIds || []), ...localSignals.map((risk) => risk.ruleId)]);
  for (const ruleId of ruleIds) {
    const localWeight = localSignals.find((risk) => risk.ruleId === ruleId)?.riskWeight;
    score += Number.isFinite(localWeight) ? localWeight : RISK_WEIGHTS[ruleId] || 10;
  }
  if (ruleIds.has("P_INFO") && ruleIds.has("R10")) {
    score += 24;
  }
  if (ruleIds.has("P_INFO") && ruleIds.has("R12")) {
    score += 20;
  }
  return score;
}

function isQuotaEligible({ result, localRisks = [], decisionSource = "", riskScore, config }) {
  if (result.status === "reject") return false;
  if (["asset-error", "provider-error"].includes(decisionSource)) return false;
  const ruleIds = new Set([...normalizeRuleIds(result.ruleIds || []), ...normalizeLocalSignals(localRisks).map((risk) => risk.ruleId)]);
  const isNews = ruleIds.has("P_INFO");
  if (config.strictness === "strict") {
    return result.status === "pass" && riskScore <= 15;
  }
  if (config.strictness === "loose") {
    return result.status === "pass" || (!isNews && result.status === "review" && riskScore <= 75);
  }
  if (isNews && result.status === "review") return false;
  if (isNews && (ruleIds.has("R10") || ruleIds.has("R12"))) return false;
  return result.status === "pass" || (result.status === "review" && riskScore <= 70);
}

function hasHardReject(item = {}, result = {}) {
  const ruleIds = new Set([
    ...normalizeRuleIds(result.ruleIds || []),
    ...normalizeLocalSignals(item.localRisks || []).map((risk) => risk.ruleId)
  ]);
  return item.decisionSource === "local-reject"
    || normalizeLocalSignals(item.localRisks || []).some((risk) => risk.action === "reject")
    || [...ruleIds].some((ruleId) => /^R[1-5]$/u.test(ruleId));
}

function accountRiskWeight(accountBaseline) {
  if (accountBaseline <= 0.32) return 18;
  if (accountBaseline <= 0.42) return 10;
  return 6;
}

function compareQuotaCandidates(left, right) {
  const scoreDiff = left.quota.riskScore - right.quota.riskScore;
  if (scoreDiff) return scoreDiff;
  const statusDiff = statusRank(left.result.status) - statusRank(right.result.status);
  if (statusDiff) return statusDiff;
  const rowDiff = Number(left.sourceRowNumber || 0) - Number(right.sourceRowNumber || 0);
  if (rowDiff) return rowDiff;
  return left.quota.index - right.quota.index;
}

function statusRank(status) {
  if (status === "pass") return 0;
  if (status === "review") return 1;
  return 2;
}

function pathToProviderImage(filePath) {
  const text = String(filePath || "");
  if (/^https?:\/\//iu.test(text) || text.startsWith("file://")) return text;
  return `file://${text}`;
}

export async function readTextFileIfExists(filePath) {
  return await fs.readFile(filePath, "utf8").catch(() => "");
}
