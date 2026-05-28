import fs from "node:fs/promises";
import path from "node:path";

export const LOGISTIC_POLICY_VERSION = 1;
export const DEFAULT_PASS_RETENTION_TARGET = 0.98;

const BASE_FEATURE_NAMES = [
  "preliminary:pass",
  "preliminary:review",
  "preliminary:reject",
  "content:资讯",
  "content:图文",
  "content:盘点",
  "content:股友说",
  "content:问财问句",
  "content:财商动画",
  "content:说唱",
  "content:长视频",
  "content:段子",
  "content:社区话题",
  "content:AI虚拟人",
  "account:投资号",
  "account:理财",
  "account:问财",
  "account:股民社区",
  "account:财经号",
  "account:期货通",
  "account:达人内容",
  "rule:P_INFO",
  "rule:P1",
  "rule:P2",
  "rule:R1",
  "rule:R2",
  "rule:R3",
  "rule:R4",
  "rule:R5",
  "rule:R6",
  "rule:R7",
  "rule:R8",
  "rule:R9",
  "rule:R10",
  "rule:R11",
  "rule:R12",
  "kw:资金主力",
  "kw:涨停复盘",
  "kw:产业概念",
  "kw:财富收益",
  "kw:硬交易",
  "kw:低风险",
  "kw:社区互动",
  "kw:空标题",
  "kw:qwen低风险",
  "kw:qwen风险",
  "metric:规则数量",
  "metric:风险分"
];

const KEYWORD_FEATURES = [
  { name: "kw:资金主力", pattern: /(资金流|主力|净流入|净流出|大单|龙虎榜|选股模型|抱团|动向复盘|高频参与度)/u },
  { name: "kw:涨停复盘", pattern: /(涨停|复盘|行情回调)/u },
  { name: "kw:产业概念", pattern: /(产业链|概念股|概念|龙头|板块|赛道|科技企业|Top\d+)/iu },
  { name: "kw:财富收益", pattern: /(财富曲线|财富自由|财务自由|万倍|逆袭|搞钱|存\d|变富|收益|亏损|阶层|认知变现|投资大师|财富历程|身价|身家|富豪|首富|豪赚|年薪|万亿美元)/u },
  { name: "kw:硬交易", pattern: /(股票代码|推荐股票|推荐个股|买入|卖出|建仓|加仓|减仓|清仓|止盈|止损|目标价|必涨|稳赚|带你赚钱)/u },
  { name: "kw:低风险", pattern: /(低风险|未见|未发现|无具体荐股|无.{0,8}收益承诺|无.{0,8}交易指令|泛财经|科普|心理|社区|互动|品牌|情绪|比喻)/u },
  { name: "kw:社区互动", pattern: /(社区|互动|话题|提问|股友|段子|幽默|生活|情感|品牌|评论区)/u }
];

export function extractLogisticPolicyFeatures(item = {}, featureNames = null) {
  const featureMap = logisticPolicyFeatureMap(item);
  const names = Array.isArray(featureNames) && featureNames.length
    ? featureNames
    : featureNamesFromMap(featureMap);
  const values = names.map((name) => Number(featureMap.get(name) || 0));
  return {
    names,
    values,
    activeNames: [...featureMap.entries()]
      .filter(([, value]) => Number(value) !== 0)
      .map(([name]) => name),
    featureMap: Object.fromEntries(featureMap)
  };
}

export function buildLogisticPolicyModel(examples = [], options = {}) {
  const labeled = normalizeExamples(examples);
  if (!labeled.some((example) => example.y === 1) || !labeled.some((example) => example.y === 0)) {
    throw new Error("logistic-policy 至少需要 pass 和 reject 两类历史样本。");
  }

  const featureNames = Array.isArray(options.featureNames) && options.featureNames.length
    ? options.featureNames
    : featureNamesFromExamples(labeled);
  const dataset = labeled.map((example) => ({
    label: example.label,
    y: example.y,
    values: extractLogisticPolicyFeatures(example.item, featureNames).values
  }));
  const weights = trainLogisticWeights(dataset, featureNames.length, options);
  const predictions = dataset.map((example) => ({
    label: example.label,
    probability: probabilityForValues(weights, example.values)
  }));
  const passRetentionTarget = Number.isFinite(options.passRetentionTarget)
    ? Number(options.passRetentionTarget)
    : DEFAULT_PASS_RETENTION_TARGET;
  const threshold = selectLogisticPolicyThreshold(predictions, { passRetentionTarget });
  const trainingMetrics = evaluateLogisticPolicyPredictions(predictions, threshold);

  return {
    kind: "logistic-policy",
    version: LOGISTIC_POLICY_VERSION,
    featureNames,
    weights,
    threshold,
    passRetentionTarget,
    trainingSummary: {
      examples: dataset.length,
      pass: dataset.filter((example) => example.label === "pass").length,
      reject: dataset.filter((example) => example.label === "reject").length,
      ...trainingMetrics
    }
  };
}

export function classifyLogisticPolicy(model = null, item = {}) {
  if (!model || model.kind !== "logistic-policy") return null;
  const featureNames = Array.isArray(model.featureNames) ? model.featureNames : [];
  const weights = Array.isArray(model.weights) ? model.weights.map(Number) : [];
  if (!featureNames.length || weights.length !== featureNames.length + 1) return null;
  const features = extractLogisticPolicyFeatures(item, featureNames);
  const probability = probabilityForValues(weights, features.values);
  const threshold = Number.isFinite(model.threshold) ? Number(model.threshold) : 0.5;
  return {
    status: probability >= threshold ? "pass" : "reject",
    probability,
    threshold,
    features
  };
}

export function selectLogisticPolicyThreshold(predictions = [], { passRetentionTarget = DEFAULT_PASS_RETENTION_TARGET } = {}) {
  const normalized = predictions
    .map((prediction) => ({
      label: normalizeLabel(prediction.label),
      probability: Number(prediction.probability)
    }))
    .filter((prediction) => prediction.label && Number.isFinite(prediction.probability));
  const passPredictions = normalized.filter((prediction) => prediction.label === "pass");
  if (!passPredictions.length) return 0.5;

  const candidates = [...new Set(normalized.map((prediction) => prediction.probability))]
    .sort((left, right) => right - left);
  let selected = candidates.at(-1) ?? 0.5;
  for (const threshold of candidates) {
    const metrics = evaluateLogisticPolicyPredictions(normalized, threshold);
    if (metrics.rates.historicalPassRetention >= passRetentionTarget) {
      selected = threshold;
      break;
    }
  }
  return selected;
}

export function evaluateLogisticPolicyPredictions(predictions = [], threshold = 0.5) {
  const matrix = {
    pass: { pass: 0, reject: 0 },
    reject: { pass: 0, reject: 0 }
  };
  for (const prediction of predictions) {
    const label = normalizeLabel(prediction.label);
    const probability = Number(prediction.probability);
    if (!label || !Number.isFinite(probability)) continue;
    const predicted = probability >= threshold ? "pass" : "reject";
    matrix[label][predicted] += 1;
  }
  const passTotal = matrix.pass.pass + matrix.pass.reject;
  const rejectTotal = matrix.reject.pass + matrix.reject.reject;
  return {
    threshold,
    matrix,
    rates: {
      historicalPassRetention: safeRate(matrix.pass.pass, passTotal),
      historicalRejectMispass: safeRate(matrix.reject.pass, rejectTotal)
    }
  };
}

export async function loadLogisticPolicyModel(env = process.env, root = process.cwd()) {
  const modelPath = String(env.LOGISTIC_POLICY_MODEL_PATH || "").trim();
  if (!modelPath) return null;
  const resolved = path.isAbsolute(modelPath) ? modelPath : path.resolve(root, modelPath);
  return JSON.parse(await fs.readFile(resolved, "utf8"));
}

function logisticPolicyFeatureMap(item = {}) {
  const fields = item.sourceRow?.fields || {};
  const result = item.preliminaryResult || item.result || {};
  const ruleIds = normalizedRuleIds([
    ...(Array.isArray(result.ruleIds) ? result.ruleIds : []),
    ...(Array.isArray(item.localRisks) ? item.localRisks.map((risk) => risk.ruleId) : [])
  ]);
  const featureMap = new Map();
  const add = (name, value = 1) => {
    featureMap.set(name, Number(featureMap.get(name) || 0) + Number(value || 0));
  };

  const preliminaryStatus = String(result.status || "review").trim() || "review";
  add(`preliminary:${preliminaryStatus}`);
  const contentType = fieldText(fields["内容类型"]).trim();
  const account = fieldText(fields["账号"]).trim();
  if (contentType) add(`content:${contentType}`);
  if (account) add(`account:${account}`);
  for (const ruleId of ruleIds) add(`rule:${ruleId}`);

  const evaluationText = [
    fields["标题"],
    fields["tag词"],
    fields["TAG词"],
    item.assetBundle?.title,
    item.assetBundle?.sourceText,
    item.assetBundle?.asrText,
    item.assetBundle?.ocrText,
    result.briefReason,
    ...(Array.isArray(result.evidence) ? result.evidence : [])
  ].filter(Boolean).join("\n");

  for (const keyword of KEYWORD_FEATURES) {
    if (keyword.pattern.test(evaluationText)) add(keyword.name);
  }
  if (!fieldText(fields["标题"]).trim() && !fieldText(item.assetBundle?.title).trim()) add("kw:空标题");
  const providerReason = String(result.briefReason || "");
  if (/(未见|未发现|无具体荐股|低风险|属低风险|不构成投资建议)/u.test(providerReason)) add("kw:qwen低风险");
  if (/(高风险|不投放|收益承诺|交易指令|荐股|投资建议|风险)/u.test(providerReason)
    && !/(未见|未发现|无具体|低风险|不构成)/u.test(providerReason)) {
    add("kw:qwen风险");
  }

  add("metric:规则数量", Math.min(ruleIds.length, 8) / 8);
  const riskScore = Number(item.quota?.riskScore);
  if (Number.isFinite(riskScore)) add("metric:风险分", Math.max(0, Math.min(riskScore, 120)) / 120);
  return featureMap;
}

function normalizeExamples(examples = []) {
  return examples
    .map((example) => {
      const label = normalizeLabel(example.label || example.historyExpected || example.expected);
      if (!label || !example.item) return null;
      return { label, y: label === "pass" ? 1 : 0, item: example.item };
    })
    .filter(Boolean);
}

function featureNamesFromExamples(examples = []) {
  const names = new Set(BASE_FEATURE_NAMES);
  for (const example of examples) {
    for (const name of extractLogisticPolicyFeatures(example.item).activeNames) names.add(name);
  }
  return [...names];
}

function featureNamesFromMap(featureMap) {
  const names = new Set(BASE_FEATURE_NAMES);
  for (const name of featureMap.keys()) names.add(name);
  return [...names];
}

function trainLogisticWeights(dataset, featureCount, options = {}) {
  const epochs = Number.isFinite(options.epochs) ? Number(options.epochs) : 4000;
  const learningRate = Number.isFinite(options.learningRate) ? Number(options.learningRate) : 0.1;
  const l2 = Number.isFinite(options.l2) ? Number(options.l2) : 0.02;
  const weights = Array.from({ length: featureCount + 1 }, () => 0);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradients = Array.from({ length: weights.length }, () => 0);
    for (const example of dataset) {
      const probability = probabilityForValues(weights, example.values);
      const error = probability - example.y;
      gradients[0] += error;
      for (let index = 0; index < featureCount; index += 1) {
        gradients[index + 1] += error * example.values[index];
      }
    }
    for (let index = 1; index < weights.length; index += 1) {
      gradients[index] += l2 * weights[index];
    }
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= learningRate * gradients[index] / dataset.length;
    }
  }
  return weights.map((weight) => Number(weight.toFixed(8)));
}

function probabilityForValues(weights, values) {
  let logit = Number(weights[0] || 0);
  for (let index = 0; index < values.length; index += 1) {
    logit += Number(weights[index + 1] || 0) * Number(values[index] || 0);
  }
  const bounded = Math.max(-35, Math.min(35, logit));
  return 1 / (1 + Math.exp(-bounded));
}

function normalizeLabel(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["pass", "通过", "是", "yes", "1", "true"].includes(text)) return "pass";
  if (["reject", "不投放", "否", "no", "0", "false"].includes(text)) return "reject";
  return "";
}

function normalizedRuleIds(values = []) {
  return [...new Set(values
    .map((value) => String(value || "").trim().toUpperCase())
    .map((value) => {
      if (/^P(?:_INFO|\d+)$/u.test(value)) return value;
      const match = value.match(/^R?(\d+)$/u);
      return match ? `R${match[1]}` : value;
    })
    .filter(Boolean))];
}

function fieldText(value) {
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((item) => fieldText(item)).filter(Boolean).join("、");
    return String(value.text || value.link || value.url || "");
  }
  return String(value || "");
}

function safeRate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}
