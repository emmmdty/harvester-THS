import fs from "node:fs/promises";
import path from "node:path";

import { classifyLogisticPolicy } from "./logistic-policy.mjs";

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
const CALIBRATION_FAILURE_SOURCES = new Set(["asset-error", "provider-error"]);
const CALIBRATION_HIGH_RISK_PATTERNS = [
  { code: "market-flow", label: "资金流/主力筛股", pattern: /(资金流|主力|净流入|净流出|大单|龙虎榜|选股模型|领涨个股|龙头强度)/u },
  { code: "limit-up", label: "涨停复盘", pattern: /(涨停股?复盘|涨停潮|涨停板|涨停)/u },
  { code: "concept-chain", label: "概念/产业链/龙头", pattern: /(概念股|游资)/u },
  { code: "wealth-story", label: "财富收益叙事", pattern: /(万倍|暴富|普通人逆袭|稳赚|带你赚钱|收益翻倍|亏损补贴|交易员财富)/u },
  { code: "provider-risk", label: "模型风险判断", pattern: /(明确|直接|存在具体|构成明确).{0,12}(隐性荐股|荐股|收益承诺|盈利诱导|交易指令|买卖指令|投资建议|夸大推广)/u }
];
const CALIBRATION_EVIDENCE_GAP_PATTERNS = [
  /(素材抽取失败|模型筛选失败|API|接口|失败|缺少|不足|无法|不能确认|不确定|看不清|听不清|需结合|需人工|人工复核|信息有限|上下文)/u
];
const CALIBRATION_LOW_RISK_PATTERNS = [
  /(泛财经|宏观|政策解读|科普|知识分享|社区经验|经验分享|交易心理|风险教育|客观资讯|客观表达|中性表达|工具使用|功能介绍|普通市场资讯|市场资讯)/u,
  /(未见|未发现|无|没有|不含|不涉及).{0,20}(具体荐股|荐股|股票代码|个股推荐|收益承诺|盈利承诺|买卖指令|交易指令|交易建议|投资建议|开户|导流)/u,
  /(不构成|不是).{0,12}(投资建议|交易建议|荐股)/u
];

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

export function calibrateStep15Decision(item = {}, options = {}) {
  const preliminaryResult = normalizeQuotaResult(item.preliminaryResult || item.result);
  const decisionSource = item.decisionSource || "";
  if (CALIBRATION_FAILURE_SOURCES.has(decisionSource)) {
    return calibrationEnvelope({
      ...preliminaryResult,
      status: "review",
      briefReason: failureReviewBriefReason(item, preliminaryResult, decisionSource)
    }, {
      source: "calibrated-failure-review",
      reason: "素材抽取或模型调用失败",
      signals: detectCalibrationHighRiskSignals(item, preliminaryResult, { includeProviderText: true })
    });
  }

  const logisticDecision = classifyLogisticPolicy(options.logisticModel, item);
  if (logisticDecision && hasExplicitHardViolationInPrimaryText(item)) {
    return calibrationEnvelope({
      ...preliminaryResult,
      status: "reject",
      briefReason: normalizeBriefReason(preliminaryResult.briefReason, "标题或 tag 命中明确硬违规，不投放。")
    }, {
      source: "logistic-policy",
      reason: "逻辑回归前置硬违规保护",
      signals: logisticPolicySignals(logisticDecision)
    });
  }
  if (logisticDecision) {
    return calibrationEnvelope({
      ...preliminaryResult,
      status: logisticDecision.status,
      briefReason: logisticPolicyBriefReason(item, preliminaryResult, logisticDecision)
    }, {
      source: "logistic-policy",
      reason: "逻辑回归二分类校准",
      signals: logisticPolicySignals(logisticDecision)
    });
  }

  if (preliminaryResult.status === "pass") {
    return calibrationEnvelope({
      ...preliminaryResult,
      status: "pass",
      briefReason: normalizeBriefReason(preliminaryResult.briefReason, "未发现不投放风险。")
    }, {
      source: "calibrated-qwen-pass",
      reason: "Qwen 初判 pass 且未命中本地硬拒",
      signals: []
    });
  }

  if (hasLowRiskPassEvidence(item, preliminaryResult)) {
    return calibrationEnvelope({
      status: "pass",
      ruleIds: preliminaryResult.ruleIds,
      briefReason: "低风险泛财经表达，未见具体荐股、收益承诺或交易指令。",
      evidence: preliminaryResult.evidence
    }, {
      source: "calibrated-likely-pass",
      reason: "Qwen review 但文本明确低风险",
      signals: []
    });
  }

  if (hasSoftLikelyPassEvidence(item, preliminaryResult)) {
    return calibrationEnvelope({
      status: "pass",
      ruleIds: preliminaryResult.ruleIds,
      briefReason: "软风险内容未见明确荐股、收益承诺或交易指令，按可能通过处理。",
      evidence: preliminaryResult.evidence
    }, {
      source: "calibrated-soft-likely-pass",
      reason: "仅命中软复核线索，未见具体交易导向",
      signals: calibrationRuleSignals(item, preliminaryResult)
    });
  }

  if (shouldRelaxNonNewsDecision(item, preliminaryResult)) {
    return calibrationEnvelope({
      status: "pass",
      ruleIds: preliminaryResult.ruleIds,
      briefReason: "非资讯内容未见明确硬违规，按宽松档通过处理。",
      evidence: preliminaryResult.evidence
    }, {
      source: "calibrated-non-news-relaxed-pass",
      reason: "非资讯内容类型宽松校准",
      signals: calibrationRuleSignals(item, preliminaryResult)
    });
  }

  const hardReject = hasHardReject(item, preliminaryResult);
  if (hardReject || preliminaryResult.status === "reject") {
    const result = {
      ...preliminaryResult,
      status: "reject",
      briefReason: normalizeBriefReason(
        preliminaryResult.briefReason,
        hardReject ? "命中硬拒规则，不投放。" : "Qwen 判断高风险，不投放。"
      )
    };
    return calibrationEnvelope(result, {
      source: hardReject ? "calibrated-hard-reject" : "calibrated-qwen-reject",
      reason: hardReject ? "本地硬拒或硬拒规则命中" : "Qwen 初判 reject",
      signals: calibrationRuleSignals(item, preliminaryResult)
    });
  }

  const highRiskSignals = detectCalibrationHighRiskSignals(item, preliminaryResult, {
    includeProviderText: preliminaryResult.status !== "pass"
  });
  if (highRiskSignals.length > 0) {
    return calibrationEnvelope({
      status: "reject",
      ruleIds: mergeRuleIds(preliminaryResult.ruleIds, highRiskSignals.map((signal) => signal.ruleId).filter(Boolean)),
      briefReason: normalizeBriefReason(
        `涉及${highRiskSignals.slice(0, 2).map((signal) => signal.label).join("、")}高风险信号，不投放。`,
        "命中高风险信号，不投放。"
      ),
      evidence: [...preliminaryResult.evidence, ...highRiskSignals.map((signal) => signal.evidence).filter(Boolean)]
    }, {
      source: "calibrated-high-risk",
      reason: "本地校准层识别高风险信号",
      signals: highRiskSignals
    });
  }

  if (hasEvidenceGap(item, preliminaryResult)) {
    return calibrationEnvelope({
      ...preliminaryResult,
      status: "review",
      briefReason: normalizeBriefReason(preliminaryResult.briefReason, "证据不足，需人工复核。")
    }, {
      source: "calibrated-evidence-gap",
      reason: "上下文或素材证据不足",
      signals: []
    });
  }

  return calibrationEnvelope({
    ...preliminaryResult,
    status: "review",
    briefReason: normalizeBriefReason(preliminaryResult.briefReason, "边界内容，需人工复核。")
  }, {
    source: "calibrated-boundary-review",
    reason: "低风险和高风险证据不足以自动判定",
    signals: calibrationRuleSignals(item, preliminaryResult)
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
  if (result.status !== "pass") return false;
  const ruleIds = new Set([...normalizeRuleIds(result.ruleIds || []), ...normalizeLocalSignals(localRisks).map((risk) => risk.ruleId)]);
  const isNews = ruleIds.has("P_INFO");
  if (config.strictness === "strict") {
    return riskScore <= 15;
  }
  if (config.strictness === "loose") {
    return true;
  }
  if (isNews && (ruleIds.has("R10") || ruleIds.has("R12"))) return false;
  return true;
}

function calibrationEnvelope(result, calibration) {
  const normalized = normalizeQuotaResult(result);
  return {
    result: normalized,
    calibratedResult: normalized,
    calibration: {
      source: calibration.source || "calibrated",
      reason: calibration.reason || "",
      signals: Array.isArray(calibration.signals) ? calibration.signals : []
    }
  };
}

function logisticPolicySignals(decision = {}) {
  return [
    {
      code: "probability",
      label: "逻辑回归通过概率",
      evidence: `${formatProbability(decision.probability)} / 阈值 ${formatProbability(decision.threshold)}`
    }
  ];
}

function formatProbability(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "0.000";
}

function logisticPolicyBriefReason(item = {}, result = {}, decision = {}) {
  if (decision.status === "reject") return rejectBriefReason(item, result, decision);
  return passBriefReason(item, result, decision);
}

function passBriefReason(item = {}, result = {}, decision = {}) {
  const highRiskSignals = detectCalibrationHighRiskSignals(item, result, { includeProviderText: true });
  const highRiskLabels = businessRiskLabels(highRiskSignals);
  if (highRiskLabels.length > 0) {
    return normalizeBriefReason(
      `涉及${highRiskLabels.slice(0, 2).join("、")}，但未见具体荐股、收益承诺或买卖指令，按边界内容通过。`,
      "未见明确荐股、收益承诺或交易指令，按低风险内容通过。"
    );
  }

  const activeNames = new Set(decision.features?.activeNames || []);
  if (activeNames.has("kw:社区互动")) {
    return "社区互动或品牌表达，未见具体荐股、收益承诺或交易指令。";
  }
  if (activeNames.has("kw:低风险") || activeNames.has("kw:qwen低风险") || hasLowRiskPassEvidence(item, result)) {
    return "低风险泛财经表达，未见具体荐股、收益承诺或交易指令。";
  }
  const contentType = fieldText(item.sourceRow?.fields?.["内容类型"]).trim();
  if (contentType && contentType !== NEWS_CONTENT_TYPE) {
    return "非资讯内容未见明确硬违规，未含具体荐股、收益承诺或买卖指令。";
  }
  return "未见明确荐股、收益承诺或交易指令，按低风险素材通过。";
}

function rejectBriefReason(item = {}, result = {}, decision = {}) {
  if (hasExplicitHardViolationInPrimaryText(item)) {
    return "标题或 tag 含具体标的、收益承诺或买卖指令，不投放。";
  }
  const highRiskSignals = detectCalibrationHighRiskSignals(item, result, { includeProviderText: true });
  const highRiskLabels = businessRiskLabels(highRiskSignals);
  if (highRiskLabels.length > 0) {
    return normalizeBriefReason(
      `涉及${highRiskLabels.slice(0, 2).join("、")}，容易形成投资建议或收益诱导，不投放。`,
      "命中高风险投放信号，不投放。"
    );
  }

  const activeNames = new Set(decision.features?.activeNames || []);
  const titleRisk = titleRiskLabel(item, result);
  if (titleRisk) {
    if (titleRisk.startsWith("标题信息不足")) {
      return `${titleRisk}，缺少可判断的投放安全信息，不投放。`;
    }
    return `标题涉及${titleRisk}，容易引发投资联想或收益诱导，不投放。`;
  }
  if (activeNames.has("kw:qwen风险")) {
    return "模型判断存在荐股、收益承诺或交易指令风险，不投放。";
  }
  const contentType = fieldText(item.sourceRow?.fields?.["内容类型"]).trim();
  if (contentType === NEWS_CONTENT_TYPE) {
    return "资讯类内容缺少明确低风险证据，按历史低过审风险不投放。";
  }
  return "风险信号多于低风险证据，可能形成投资建议，不投放。";
}

function failureReviewBriefReason(item = {}, result = {}, decisionSource = "") {
  if (decisionSource === "asset-error") {
    return "素材抽取失败，缺少可判断的标题、画面或文本证据，需人工查看原视频。";
  }
  const highRiskSignals = detectCalibrationHighRiskSignals(item, result, { includeProviderText: true });
  const highRiskLabels = businessRiskLabels(highRiskSignals);
  const titleRisk = titleRiskLabel(item, result);
  if (highRiskLabels.length > 0) {
    return normalizeBriefReason(
      `模型调用失败，且素材涉及${titleRisk || highRiskLabels.slice(0, 2).join("、")}，需人工确认是否可投放。`,
      "模型调用失败，且素材存在风险线索，需人工复核。"
    );
  }
  if (titleRisk) {
    return `模型调用失败，标题涉及${titleRisk}，需人工确认是否可投放。`;
  }
  return "模型调用失败，无法完成内容判断，需人工复核。";
}

function businessRiskLabels(signals = []) {
  const labels = [];
  const add = (label) => {
    if (label && !labels.includes(label)) labels.push(label);
  };
  for (const signal of signals) {
    if (signal.code === "market-flow" || signal.ruleId === "R10") add("资金流/主力筛股");
    else if (signal.code === "limit-up" || signal.ruleId === "R9") add("涨停或行情复盘");
    else if (signal.code === "concept-chain" || signal.ruleId === "R11") add("概念股/产业链/龙头");
    else if (signal.code === "wealth-story" || signal.ruleId === "R12") add("财富收益叙事");
    else if (signal.code === "provider-risk") add("荐股或投资建议");
  }
  return labels;
}

function titleRiskLabel(item = {}, result = {}) {
  const fields = item.sourceRow?.fields || {};
  const rawTitle = [
    fields["标题"],
    item.assetBundle?.title,
    item.title,
    item.record?.title
  ].find((value) => fieldText(value).trim());
  const primaryTitle = fieldText(rawTitle || "")
    .replace(/\s*#.*$/u, "")
    .trim();
  const text = [
    fields["标题"],
    item.title,
    item.record?.title,
    item.assetBundle?.title,
    result.evidence?.join(" "),
    result.briefReason
  ].filter(Boolean).join("\n");
  if (/(炒股必备|神器|工具|平台|富途|老虎|被查)/u.test(text)) return "投资工具或平台推广/监管信息";
  if (/(期货|重仓|暴富)/u.test(text)) return "期货重仓或暴富叙事";
  if (/(资金流|主力|净流入|净流出|大单|龙虎榜)/u.test(text)) return "资金流或主力动向";
  if (/(涨停|复盘|行情回调)/u.test(text)) return "涨停或行情复盘";
  if (/(产业链|概念股|概念|龙头|板块|赛道|机器人行业|科技企业|五巨头)/u.test(text)) return "概念板块或产业链";
  if (/(财富曲线|财富自由|财务自由|万倍|逆袭|收益|亏损|身价|身家|富豪|首富|豪赚|变富|年薪|\\d+\\s*(?:万|亿).{0,10}\\d+\\s*(?:万|亿)|万亿美元)/u.test(text)) return "财富收益叙事";
  if (/(股王|牛股|牛散|A股|股市|日经|韩股|暴涨|新高|投资大事件)/u.test(text)) return "市场行情或个股热度资讯";
  if (/(破产|压垮|影视巨头|SK海力士|运营商|Token套餐|工装)/u.test(text)) return "公司事件或行业热点资讯";
  if (/(一股不卖|持仓|仓位)/u.test(text)) return "持仓或交易暗示";
  if (/(投资理财|投资铁律|投资大师|必看书|穷.*书|存银行|买黄金)/u.test(text)) return "理财或投资教育内容";
  if (/(买入|卖出|加仓|减仓|止盈|止损|目标价|股票代码)/u.test(text)) return "具体交易指令或标的";
  if (primaryTitle.length > 0 && primaryTitle.length <= 6) return "标题信息不足且内容类型历史低过审";
  return "";
}

function shouldRelaxNonNewsDecision(item = {}, result = {}) {
  const contentType = fieldText(item.sourceRow?.fields?.["内容类型"]).trim();
  if (!contentType || contentType === NEWS_CONTENT_TYPE) return false;
  if (contentType === "长视频" || contentType === "理财内容") return false;
  if (hasExplicitHardViolationInPrimaryText(item)) return false;
  if (CALIBRATION_FAILURE_SOURCES.has(item.decisionSource || "")) return false;
  return result.status === "reject"
    || result.status === "review"
    || detectCalibrationHighRiskSignals(item, result, { includeProviderText: true }).length > 0;
}

function hasExplicitHardViolationInPrimaryText(item = {}) {
  const fields = item.sourceRow?.fields || {};
  const text = [
    fields["标题"],
    fields["tag词"],
    fields["TAG词"],
    item.assetBundle?.title
  ].filter(Boolean).join("\n");
  if (!text.trim()) return false;
  return /\b(?:SH|SZ|BJ)?[036]\d{5}\b/iu.test(text)
    || /[（(][036]\d{5}[）)]/u.test(text)
    || /(股票代码|推荐股票|推荐个股|个股推荐|目标价|目标位)/u.test(text)
    || /(稳赚|稳稳赚钱|带你赚钱|跟着.{0,12}赚|收益翻倍|保本|包赚|无风险|零风险|0风险|必涨|必跌)/u.test(text)
    || /(现在|立即|马上|直接|赶紧|建议|跟着|可以|适合).{0,10}(买入|卖出|建仓|加仓|减仓|清仓|止盈|止损|抄底|逃顶|满仓|空仓)/u.test(text)
    || /(股票配资|场外配资|私募|信托|P2P|校园贷|二元期权|石油沥青|虚拟货币|比特币|荐股软件|内幕消息|内幕交易|内部交易)/u.test(text);
}

function detectCalibrationHighRiskSignals(item = {}, result = {}, options = {}) {
  const signals = [];
  const materialText = calibrationMaterialText(item, result, options);
  for (const pattern of CALIBRATION_HIGH_RISK_PATTERNS) {
    const match = materialText.match(pattern.pattern);
    if (!match) continue;
    signals.push({
      ruleId: calibrationRuleIdForPattern(pattern.code),
      code: pattern.code,
      label: pattern.label,
      evidence: trimEvidence(match[0])
    });
  }

  for (const signal of calibrationRuleSignals(item, result)) {
    if (!signalIsHighRisk(signal)) continue;
    signals.push(signal);
  }
  return dedupeCalibrationSignals(signals);
}

function calibrationMaterialText(item = {}, result = {}, options = {}) {
  const fields = item.sourceRow?.fields || {};
  const assetBundle = item.assetBundle || {};
  return [
    fields["标题"],
    fields["tag词"],
    fields["TAG词"],
    assetBundle.sourceText,
    assetBundle.text,
    assetBundle.asrText,
    assetBundle.ocrText,
    options.includeProviderText ? result.evidence?.join(" ") : "",
    options.includeProviderText ? result.briefReason : ""
  ].filter(Boolean).join("\n");
}

function calibrationEvaluationText(item = {}, result = {}) {
  const fields = item.sourceRow?.fields || {};
  return [
    fields["标题"],
    fields["tag词"],
    fields["TAG词"],
    fields["内容类型"],
    item.assetBundle?.sourceText,
    item.assetBundle?.text,
    item.assetBundle?.asrText,
    item.assetBundle?.ocrText,
    result.evidence?.join(" "),
    result.briefReason
  ].filter(Boolean).join("\n");
}

function calibrationRuleSignals(item = {}, result = {}) {
  const localSignals = normalizeLocalSignals(item.localRisks || []).map((risk) => ({
    ruleId: risk.ruleId,
    code: risk.ruleId,
    label: risk.label || risk.ruleId,
    evidence: risk.evidence || ""
  }));
  const resultSignals = normalizeRuleIds(result.ruleIds || []).map((ruleId) => {
    const rule = STEP15_FILTER_RULES.find((item) => item.ruleId === ruleId);
    return {
      ruleId,
      code: ruleId,
      label: rule?.label || ruleId,
      evidence: ""
    };
  });
  return dedupeCalibrationSignals([...localSignals, ...resultSignals]);
}

function signalIsHighRisk(signal = {}) {
  const evidence = String(signal.evidence || "");
  if (signal.ruleId === "R10") return evidence ? /(资金流|主力|净流入|净流出|大单|龙虎榜|选股模型|领涨个股|龙头强度)/u.test(evidence) : true;
  if (signal.ruleId === "R9") return /(涨停|点位|加仓|减仓|抄底|突破|跌破|失守)/u.test(evidence);
  if (signal.ruleId === "R11") return /(概念股|游资)/u.test(evidence);
  if (signal.ruleId === "R12") return /(万倍|暴富|普通人逆袭|交易员财富|收益翻倍|稳赚|带你赚钱|亏损补贴)/u.test(evidence);
  if (signal.ruleId === "R6" || signal.ruleId === "R7") return false;
  return evidence ? CALIBRATION_HIGH_RISK_PATTERNS.some((pattern) => pattern.pattern.test(evidence)) : false;
}

function hasLowRiskPassEvidence(item = {}, result = {}) {
  const text = calibrationEvaluationText(item, result);
  if (hasEvidenceGap(item, result) && !CALIBRATION_LOW_RISK_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  return CALIBRATION_LOW_RISK_PATTERNS.some((pattern) => pattern.test(text));
}

function hasSoftLikelyPassEvidence(item = {}, result = {}) {
  if (/(需要人工|人工确认|人工复核|需人工)/u.test(String(result.briefReason || ""))) return false;
  const contentType = fieldText(item.sourceRow?.fields?.["内容类型"]).trim();
  if (["资讯", "长视频", "盘点", "理财内容"].includes(contentType)) return false;
  const localSignals = normalizeLocalSignals(item.localRisks || []);
  if (!localSignals.length) return false;
  const softRuleIds = new Set(["P_INFO", "P1", "P2", "R6", "R7", "R8", "R11", "R12"]);
  if (!localSignals.every((signal) => softRuleIds.has(signal.ruleId))) return false;
  const materialText = calibrationMaterialText(item, result, { includeProviderText: false });
  if (/(股票代码|目标价|目标位|买入|卖出|建仓|加仓|减仓|清仓|止盈|止损|抄底|逃顶|涨停复盘|涨停股复盘|资金流|主力|净流入|净流出|龙虎榜|概念股|游资|万倍|暴富|稳赚|收益翻倍|带你赚钱)/u.test(materialText)) {
    return false;
  }
  const evaluationText = calibrationEvaluationText(item, result);
  return /(隐含|可能|需复核|理财|财富|财经|资讯|书籍|影视|知识|经验|故事|人物|产业链|供应商|龙头|身家|财富曲线|财富历程|存钱|投资)/u.test(evaluationText);
}

function hasEvidenceGap(item = {}, result = {}) {
  const text = calibrationEvaluationText(item, result);
  return CALIBRATION_EVIDENCE_GAP_PATTERNS.some((pattern) => pattern.test(text));
}

function calibrationRuleIdForPattern(code) {
  if (code === "market-flow") return "R10";
  if (code === "limit-up") return "R9";
  if (code === "concept-chain") return "R11";
  if (code === "wealth-story") return "R12";
  if (code === "overclaim") return "R6";
  return "";
}

function mergeRuleIds(...groups) {
  return [...new Set(groups.flatMap((group) => normalizeRuleIds(group || [])))];
}

function dedupeCalibrationSignals(signals = []) {
  const deduped = [];
  const seen = new Set();
  for (const signal of signals) {
    const key = [signal.ruleId || "", signal.code || "", signal.label || "", signal.evidence || ""].join("\t");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(signal);
  }
  return deduped;
}

function hasHardReject(item = {}, result = {}) {
  const ruleIds = new Set([
    ...normalizeRuleIds(result.ruleIds || []),
    ...normalizeLocalSignals(item.localRisks || []).map((risk) => risk.ruleId)
  ]);
  return item.decisionSource === "local-reject"
    || normalizeLocalSignals(item.localRisks || []).some((risk) => risk.action === "reject")
    || (result.status === "reject" && [...ruleIds].some((ruleId) => /^R[1-5]$/u.test(ruleId)));
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
