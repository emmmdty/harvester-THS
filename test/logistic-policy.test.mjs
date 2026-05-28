import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLogisticPolicyModel,
  classifyLogisticPolicy,
  extractLogisticPolicyFeatures,
  evaluateLogisticPolicyPredictions,
  selectLogisticPolicyThreshold
} from "../src/logistic-policy.mjs";
import { calibrateStep15Decision } from "../src/step15-filter-provider.mjs";

const policyItem = ({
  title = "",
  tags = "",
  account = "投资号",
  contentType = "图文",
  status = "review",
  ruleIds = [],
  briefReason = "",
  localRisks = [],
  decisionSource = "provider",
  sourceRowNumber = 1,
  expected = ""
} = {}) => ({
  sourceRowNumber,
  decisionSource,
  sourceRow: {
    sourceRowNumber,
    link: `https://www.douyin.com/video/${sourceRowNumber}`,
    fields: {
      "标题": title,
      "tag词": tags,
      "账号": account,
      "内容类型": contentType,
      "是否投放成功": expected
    }
  },
  assetBundle: {
    title,
    sourceText: [title, tags].filter(Boolean).join("\n")
  },
  localRisks,
  preliminaryResult: {
    status,
    ruleIds,
    briefReason,
    evidence: []
  },
  result: {
    status,
    ruleIds,
    briefReason,
    evidence: []
  },
  quota: {
    riskScore: localRisks.reduce((sum, risk) => sum + (risk.riskWeight || 0), 0)
  }
});

test("logistic policy features exclude historical labels and row identity", () => {
  const features = extractLogisticPolicyFeatures(policyItem({
    title: "5月主力资金流向复盘",
    account: "问财",
    contentType: "图文",
    expected: "是",
    localRisks: [{ ruleId: "R10", label: "资金流/选股模型", action: "review", riskWeight: 25 }]
  }));

  assert.ok(features.activeNames.includes("content:图文"));
  assert.ok(features.activeNames.includes("account:问财"));
  assert.ok(features.activeNames.includes("rule:R10"));
  assert.ok(features.activeNames.includes("kw:资金主力"));
  assert.equal(features.activeNames.some((name) => /history|expected|投放|link|row/i.test(name)), false);
});

test("logistic policy threshold keeps the requested historical pass retention", () => {
  const predictions = [
    { label: "pass", probability: 0.91 },
    { label: "pass", probability: 0.81 },
    { label: "pass", probability: 0.21 },
    { label: "reject", probability: 0.65 },
    { label: "reject", probability: 0.16 }
  ];

  const threshold = selectLogisticPolicyThreshold(predictions, { passRetentionTarget: 2 / 3 });
  const metrics = evaluateLogisticPolicyPredictions(predictions, threshold);

  assert.equal(metrics.matrix.pass.pass, 2);
  assert.equal(metrics.matrix.pass.reject, 1);
  assert.ok(metrics.rates.historicalPassRetention >= 2 / 3);
  assert.equal(metrics.matrix.reject.pass, 0);
});

test("logistic policy trains a reusable model without direct history lookup", () => {
  const examples = [
    { label: "pass", item: policyItem({ sourceRowNumber: 1, title: "炒股就像谈恋爱", status: "pass", briefReason: "低风险互动内容" }) },
    { label: "pass", item: policyItem({ sourceRowNumber: 2, title: "交易心理分享", contentType: "股友说", briefReason: "未发现具体荐股" }) },
    { label: "pass", item: policyItem({ sourceRowNumber: 3, title: "财富曲线", briefReason: "低风险泛财经表达" }) },
    { label: "reject", item: policyItem({ sourceRowNumber: 4, title: "5月涨停复盘", account: "问财", ruleIds: ["R10"], briefReason: "主力资金复盘" }) },
    { label: "reject", item: policyItem({ sourceRowNumber: 5, title: "产业链概念股盘点", account: "问财", ruleIds: ["R11"], briefReason: "概念股盘点" }) }
  ];

  const model = buildLogisticPolicyModel(examples, {
    passRetentionTarget: 0.98,
    epochs: 800,
    learningRate: 0.2
  });

  const safe = classifyLogisticPolicy(model, policyItem({
    sourceRowNumber: 101,
    title: "社区交易心理分享",
    contentType: "股友说",
    briefReason: "未发现具体荐股"
  }));
  const risky = classifyLogisticPolicy(model, policyItem({
    sourceRowNumber: 102,
    title: "5月主力资金流向复盘",
    account: "问财",
    ruleIds: ["R10"],
    briefReason: "主力资金复盘"
  }));

  assert.equal(model.kind, "logistic-policy");
  assert.equal(model.passRetentionTarget, 0.98);
  assert.equal(safe.status, "pass");
  assert.equal(risky.status, "reject");
  assert.ok(safe.probability > risky.probability);
});

test("calibration uses logistic-policy when a model is provided", () => {
  const model = {
    kind: "logistic-policy",
    version: 1,
    featureNames: ["preliminary:review", "kw:资金主力", "kw:低风险"],
    weights: [-0.5, 0, -3, 3],
    threshold: 0.5,
    passRetentionTarget: 0.98
  };

  const rejected = calibrateStep15Decision(policyItem({
    title: "5月主力资金流向复盘",
    ruleIds: ["R10"],
    briefReason: "主力资金复盘"
  }), { logisticModel: model });
  const passed = calibrateStep15Decision(policyItem({
    title: "社区交易心理分享",
    briefReason: "未发现具体荐股、收益承诺或交易指令"
  }), { logisticModel: model });

  assert.equal(rejected.result.status, "reject");
  assert.equal(rejected.calibration.source, "logistic-policy");
  assert.doesNotMatch(rejected.result.briefReason, /评分|阈值|置信/);
  assert.match(rejected.result.briefReason, /资金|主力|投资建议|不投放/);
  assert.equal(passed.result.status, "pass");
  assert.equal(passed.calibration.source, "logistic-policy");
  assert.doesNotMatch(passed.result.briefReason, /评分|阈值|置信/);
  assert.match(passed.result.briefReason, /未见|荐股|收益承诺|交易指令/);
});

test("calibration explains review failures with actionable business context", () => {
  const providerFailure = calibrateStep15Decision(policyItem({
    title: "期货重仓真的能快速暴富吗？",
    briefReason: "模型筛选失败，需人工复核。",
    decisionSource: "provider-error"
  }));
  const assetFailure = calibrateStep15Decision(policyItem({
    title: "",
    briefReason: "素材抽取失败，需人工复核。",
    decisionSource: "asset-error"
  }));

  assert.equal(providerFailure.result.status, "review");
  assert.match(providerFailure.result.briefReason, /模型调用失败/);
  assert.match(providerFailure.result.briefReason, /期货|暴富/);
  assert.equal(assetFailure.result.status, "review");
  assert.match(assetFailure.result.briefReason, /素材抽取失败/);
  assert.match(assetFailure.result.briefReason, /缺少/);
});

test("logistic reject reasons explain short-title and wealth-story causes", () => {
  const model = {
    kind: "logistic-policy",
    version: 1,
    featureNames: ["content:说唱", "kw:财富收益"],
    weights: [-0.5, -3, -3],
    threshold: 0.5,
    passRetentionTarget: 0.98
  };
  const shortTitle = calibrateStep15Decision(policyItem({
    title: "开门啊",
    tags: "#同花顺app #翻唱",
    contentType: "说唱",
    status: "pass"
  }), { logisticModel: model });
  const wealthStory = calibrateStep15Decision(policyItem({
    title: "145亿身家，雅戈尔铁娘子的30年进阶之路",
    contentType: "资讯",
    status: "review"
  }), { logisticModel: model });

  assert.equal(shortTitle.result.status, "reject");
  assert.match(shortTitle.result.briefReason, /标题信息不足/);
  assert.doesNotMatch(shortTitle.result.briefReason, /标题涉及标题/);
  assert.doesNotMatch(shortTitle.result.briefReason, /模型|评分|阈值|置信/);
  assert.equal(wealthStory.result.status, "reject");
  assert.match(wealthStory.result.briefReason, /财富收益叙事/);
  assert.doesNotMatch(wealthStory.result.briefReason, /模型|评分|阈值|置信/);
});
