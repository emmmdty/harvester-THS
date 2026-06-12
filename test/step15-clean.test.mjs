import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  STEP15_FEEDBACK_HEADERS,
  STEP15_FILTERED_HEADERS,
  cleanDailyStep15,
  sourceRowsForTargetDate
} from "../src/step15-cleaner.mjs";
import {
  STEP15_FILTER_STANDARD_VERSION,
  applyBatchPassQuota,
  applyHistoricalPassProtection,
  calibrateStep15Decision,
  detectHistoricalFilterPriors,
  detectLocalFilterRisks,
  detectLocalFilterSignals,
  filterWithConfiguredProvider,
  normalizeBriefReason,
  parseFilterProviderResponse,
  resolveFilterConfig
} from "../src/step15-filter-provider.mjs";

const urlCell = (url) => ({ type: "url", text: "打开链接", link: url });
const dropdown = (value) => ({ type: "multipleValue", values: [value] });
const douyinSeparatorRow = (title) => ["", title, "", "", "", "", "", "", "", "", "", "", "", ""];
function douyinRow({ sequence = "1", date = "05 19", link, title = "", tags = "", account = "投资号", contentType = "资讯", review = "通过" }) {
  return [
    sequence,
    date,
    urlCell(link),
    dropdown(account),
    dropdown(contentType),
    "",
    "",
    "",
    "",
    "",
    "视频",
    title,
    tags,
    review
  ];
}
const pickFilterConfig = (config) => ({
  provider: config.provider,
  strictness: config.strictness,
  targetPassRate: config.targetPassRate,
  minPassRate: config.minPassRate,
  maxPassRate: config.maxPassRate
});
const batchItem = (sourceRowNumber, result, options = {}) => ({
  sourceRowNumber,
  sourceRow: {
    sourceRowNumber,
    fields: {
      "标题": options.title || "",
      "tag词": options.tags || "",
      "账号": "投资号",
      "内容类型": options.contentType || "股友说"
    }
  },
  localRisks: options.localRisks || [],
  decisionSource: options.decisionSource || "provider",
  expected: options.expected,
  result
});

test("step15 local rules separate hard rejects from review signals", () => {
  const hardRejects = detectLocalFilterRisks([
    "这只股 600519 今天出现买点，目标价 30，跟着买稳赚。",
    "股票配资和荐股软件都能帮你必涨。"
  ].join("\n"));

  assert.deepEqual(
    hardRejects.map((item) => item.ruleId),
    ["R1", "R2", "R3", "R5"]
  );
  assert.ok(hardRejects.every((item) => item.action === "reject"));

  for (const text of [
    "5月18日涨停股复盘 #热点 #问财 #同顺图解",
    "期货必看书籍推荐 #期货通",
    "全国社保基金多次在A股大幅下跌时果断加仓 #同花顺资讯"
  ]) {
    assert.deepEqual(detectLocalFilterRisks(text), []);
    assert.ok(detectLocalFilterSignals(text).some((item) => item.action === "review"), text);
  }

  const modelSignals = detectLocalFilterSignals("跟着聪明钱走低估值，主力给你抬轿。大单净买入超1亿的选股模型。");
  assert.deepEqual(modelSignals.map((item) => item.ruleId), ["R10"]);
  assert.ok(modelSignals.every((item) => item.action === "review"));
});

test("step15 provider parser normalizes status and short reasons", () => {
  const parsed = parseFilterProviderResponse({
    output: {
      choices: [
        {
          message: {
            content: "```json\n{\"status\":\"reject\",\"ruleIds\":[\"R1\"],\"briefReason\":\"出现股票代码和个股推荐，不能投放。\",\"evidence\":[\"600519\"]}\n```"
          }
        }
      ]
    }
  });

  assert.deepEqual(parsed, {
    status: "reject",
    ruleIds: ["R1"],
    briefReason: "出现股票代码和个股推荐，不能投放。",
    evidence: ["600519"]
  });

  assert.deepEqual(parseFilterProviderResponse({
    choices: [
      {
        message: {
          content: "{\"status\":\"review\",\"ruleIds\":[\"R10\",\"R11\",\"R12\"],\"briefReason\":\"需要复核。\",\"evidence\":[\"主力资金\"]}"
        }
      }
    ]
  }).ruleIds, ["R10", "R11", "R12"]);

  assert.deepEqual(parseFilterProviderResponse({
    status: "review",
    ruleIds: ["P_INFO", "P2", "R10"]
  }).ruleIds, ["P_INFO", "P2", "R10"]);

  assert.equal(
    normalizeBriefReason("第一句说明风险。第二句不应该写入飞书。"),
    "第一句说明风险。"
  );
});

test("Qwen provider supports DashScope compatible-mode chat completions", async () => {
  const calls = [];
  const result = await filterWithConfiguredProvider({
    sourceRow: {
      platformId: "xhs",
      fields: {
        "标题": "普通财经资讯",
        "tag词": "#同花顺"
      }
    },
    assetBundle: {
      sourceText: "普通财经资讯",
      asrText: "",
      ocrText: "普通财经资讯",
      imagePaths: [],
      framePaths: []
    },
    localRisks: [
      { ruleId: "R10", label: "资金流/选股模型", action: "review", evidence: "主力资金净流入" }
    ],
    env: {
      FILTER_PROVIDER: "qwen",
      FILTER_STRICTNESS: "balanced",
      DASHSCOPE_API_KEY: "sk-test",
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      DASHSCOPE_NAME: "qwen3.6-flash"
    },
    fetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  content: "{\"status\":\"pass\",\"ruleIds\":[],\"briefReason\":\"未发现不投放风险。\",\"evidence\":[]}"
                }
              }
            ]
          });
        }
      };
    }
  });

  assert.equal(calls[0][0], "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(calls[0][1].model, "qwen3.6-flash");
  assert.equal(calls[0][1].messages[1].content[0].type, "text");
  assert.match(calls[0][1].messages[1].content[0].text, new RegExp(STEP15_FILTER_STANDARD_VERSION));
  assert.match(calls[0][1].messages[1].content[0].text, /筛选档位：balanced/);
  assert.match(calls[0][1].messages[1].content[0].text, /目标：提高投放审核通过率/);
  assert.match(calls[0][1].messages[1].content[0].text, /R10 资金流/);
  assert.match(calls[0][1].messages[1].content[0].text, /本地复核线索：R10/);
  assert.equal(result.status, "pass");
});

test("Qwen provider keeps legacy provider configuration as fallback", async () => {
  const calls = [];
  const result = await filterWithConfiguredProvider({
    sourceRow: {
      platformId: "douyin",
      fields: {
        "标题": "普通财经资讯",
        "tag词": "#同花顺"
      }
    },
    assetBundle: {
      sourceText: "普通财经资讯",
      asrText: "",
      ocrText: "",
      imagePaths: [],
      framePaths: []
    },
    localRisks: [],
    env: {
      STEP15_FILTER_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "sk-test",
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      DASHSCOPE_NAME: "qwen3.6-flash"
    },
    fetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  content: "{\"status\":\"pass\",\"ruleIds\":[],\"briefReason\":\"未发现不投放风险。\",\"evidence\":[]}"
                }
              }
            ]
          });
        }
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(result.status, "pass");
});

test("filter config resolves default provider and strictness pass-rate presets", () => {
  assert.deepEqual(
    pickFilterConfig(resolveFilterConfig({})),
    {
      provider: "qwen",
      strictness: "balanced",
      targetPassRate: 0.4,
      minPassRate: 0.33,
      maxPassRate: 0.5
    }
  );
  assert.equal(resolveFilterConfig({ FILTER_STRICTNESS: "strict" }).targetPassRate, 0.33);
  assert.equal(resolveFilterConfig({ FILTER_STRICTNESS: "loose" }).targetPassRate, 0.5);
  assert.equal(resolveFilterConfig({ FILTER_STRICTNESS: "balanced", FILTER_TARGET_PASS_RATE: "0.45" }).targetPassRate, 0.45);
  assert.equal(resolveFilterConfig({ FILTER_PROVIDER: "local", STEP15_FILTER_PROVIDER: "qwen" }).provider, "local");
});

test("batch pass quota defaults to about forty percent and keeps stable ranking", () => {
  const rows = Array.from({ length: 30 }, (_, index) => batchItem(index + 1, {
    status: "pass",
    ruleIds: [],
    briefReason: "模型判断低风险。",
    evidence: []
  }));

  const results = applyBatchPassQuota(rows, { FILTER_STRICTNESS: "balanced" });

  assert.equal(results.filter((item) => item.result.status === "pass").length, 12);
  assert.equal(results.filter((item) => item.result.status === "review").length, 18);
  assert.deepEqual(
    results.filter((item) => item.result.status === "pass").map((item) => item.sourceRowNumber),
    Array.from({ length: 12 }, (_, index) => index + 1)
  );
});

test("batch pass quota does not force the minimum when safe candidates are insufficient", () => {
  const lowRisk = Array.from({ length: 5 }, (_, index) => batchItem(index + 1, {
    status: "pass",
    ruleIds: [],
    briefReason: "模型判断低风险。",
    evidence: []
  }));
  const riskyReview = Array.from({ length: 25 }, (_, index) => batchItem(index + 6, {
    status: "review",
    ruleIds: ["R10"],
    briefReason: "资金流选股模型需要复核。",
    evidence: ["主力资金"]
  }, {
    localRisks: [{ ruleId: "R10", label: "资金流/选股模型", action: "review", evidence: "主力资金" }]
  }));

  const results = applyBatchPassQuota([...lowRisk, ...riskyReview], { FILTER_STRICTNESS: "balanced" });

  assert.equal(results.filter((item) => item.result.status === "pass").length, 5);
  assert.equal(results.filter((item) => item.result.status === "review").length, 25);
});

test("batch pass quota never passes hard rejects or Qwen rejects", () => {
  const results = applyBatchPassQuota([
    batchItem(1, { status: "review", ruleIds: ["R9"], briefReason: "行情复盘需复核。", evidence: [] }, {
      localRisks: [{ ruleId: "R9", label: "行情复盘/涨停/点位", action: "review", evidence: "涨停复盘" }]
    }),
    batchItem(2, { status: "pass", ruleIds: [], briefReason: "模型判断低风险。", evidence: [] }, {
      localRisks: [{ ruleId: "P1", label: "历史低过审内容类型", action: "review", evidence: "内容类型：资讯" }]
    }),
    batchItem(3, { status: "pass", ruleIds: [], briefReason: "模型判断低风险。", evidence: [] }),
    batchItem(4, { status: "reject", ruleIds: ["R1"], briefReason: "命中硬拒绝。", evidence: ["600519"] }, {
      decisionSource: "local-reject"
    }),
    batchItem(5, { status: "reject", ruleIds: ["R2"], briefReason: "Qwen 判断高风险。", evidence: ["稳赚"] }, {
      decisionSource: "provider"
    }),
    batchItem(6, { status: "pass", ruleIds: [], briefReason: "模型判断低风险。", evidence: [] })
  ], { FILTER_STRICTNESS: "loose" });

  assert.deepEqual(
    results.filter((item) => item.result.status === "pass").map((item) => item.sourceRowNumber),
    [2, 3, 6]
  );
  assert.equal(results.find((item) => item.sourceRowNumber === 4).result.status, "reject");
  assert.equal(results.find((item) => item.sourceRowNumber === 5).result.status, "reject");
  assert.ok(results.find((item) => item.sourceRowNumber === 3).quota.rank < results.find((item) => item.sourceRowNumber === 6).quota.rank);
});

test("batch pass quota never promotes review decisions to pass", () => {
  const newsReview = batchItem(1, {
    status: "review",
    ruleIds: ["P_INFO"],
    briefReason: "资讯内容需要复核。",
    evidence: []
  }, {
    contentType: "资讯",
    localRisks: [{ ruleId: "P_INFO", label: "资讯低过审先验", action: "review", evidence: "内容类型：资讯" }]
  });
  const nonNewsReview = batchItem(2, {
    status: "review",
    ruleIds: ["P1"],
    briefReason: "非资讯轻度复核。",
    evidence: []
  }, {
    contentType: "图文",
    localRisks: [{ ruleId: "P1", label: "历史低过审内容类型", action: "review", evidence: "内容类型：图文" }]
  });

  const results = applyBatchPassQuota([newsReview, nonNewsReview], {
    FILTER_STRICTNESS: "balanced",
    FILTER_TARGET_PASS_RATE: "1",
    FILTER_MAX_PASS_RATE: "1"
  });

  assert.equal(results.find((item) => item.sourceRowNumber === 1).result.status, "review");
  assert.equal(results.find((item) => item.sourceRowNumber === 2).result.status, "review");
});

test("step15 calibration passes explicit low-risk Qwen review", () => {
  const calibrated = calibrateStep15Decision(batchItem(1, {
    status: "review",
    ruleIds: [],
    briefReason: "内容属交易心理分享，未发现具体荐股、收益承诺或交易指令。",
    evidence: ["交易心理分享"]
  }));

  assert.equal(calibrated.result.status, "pass");
  assert.equal(calibrated.calibration.source, "calibrated-likely-pass");
  assert.match(calibrated.result.briefReason, /低风险|未见|未发现/);
});

test("step15 calibration rejects high-risk news review signals", () => {
  const calibrated = calibrateStep15Decision(batchItem(2, {
    status: "review",
    ruleIds: ["R10"],
    briefReason: "主力资金净流入榜单需要复核。",
    evidence: ["主力净流入"]
  }, {
    contentType: "资讯",
    localRisks: [{ ruleId: "R10", label: "资金流/选股模型", action: "review", evidence: "主力净流入" }]
  }));

  assert.equal(calibrated.result.status, "reject");
  assert.equal(calibrated.calibration.source, "calibrated-high-risk");
  assert.match(calibrated.result.briefReason, /资金流|主力|高风险/);
});

test("step15 calibration relaxes non-news high-risk review signals", () => {
  const calibrated = calibrateStep15Decision(batchItem(22, {
    status: "review",
    ruleIds: ["R10"],
    briefReason: "主力资金复盘需要复核。",
    evidence: ["主力资金"]
  }, {
    contentType: "图文",
    localRisks: [{ ruleId: "R10", label: "资金流/选股模型", action: "review", evidence: "主力资金" }]
  }));

  assert.equal(calibrated.result.status, "pass");
  assert.equal(calibrated.calibration.source, "calibrated-non-news-relaxed-pass");
});

test("step15 calibration relaxes non-news local false-positive rejects", () => {
  const calibrated = calibrateStep15Decision(batchItem(23, {
    status: "reject",
    ruleIds: ["R3"],
    briefReason: "命中直接买卖/仓位指令规则，不能投放。",
    evidence: ["买点，没信号"]
  }, {
    contentType: "图文",
    decisionSource: "local-reject",
    localRisks: [{ ruleId: "R3", label: "直接买卖/仓位指令", action: "reject", evidence: "买点，没信号" }]
  }));

  assert.equal(calibrated.result.status, "pass");
  assert.equal(calibrated.calibration.source, "calibrated-non-news-relaxed-pass");
});

test("step15 calibration keeps explicit hard violations rejected even outside news", () => {
  const calibrated = calibrateStep15Decision(batchItem(24, {
    status: "reject",
    ruleIds: ["R1"],
    briefReason: "命中股票代码和具体荐股，不能投放。",
    evidence: ["600519"]
  }, {
    contentType: "图文",
    title: "600519 今日买点",
    decisionSource: "local-reject",
    localRisks: [{ ruleId: "R1", label: "股票代码/具体荐股", action: "reject", evidence: "600519" }]
  }));

  assert.equal(calibrated.result.status, "reject");
});

test("step15 calibration keeps provider and asset failures in review", () => {
  const providerError = calibrateStep15Decision(batchItem(3, {
    status: "review",
    ruleIds: [],
    briefReason: "模型筛选失败，需人工复核。",
    evidence: ["quota exceeded"]
  }, {
    decisionSource: "provider-error"
  }));
  const assetError = calibrateStep15Decision(batchItem(4, {
    status: "review",
    ruleIds: [],
    briefReason: "素材抽取失败，需人工复核。",
    evidence: ["missing asset"]
  }, {
    decisionSource: "asset-error"
  }));

  assert.equal(providerError.result.status, "review");
  assert.equal(providerError.calibration.source, "calibrated-failure-review");
  assert.equal(assetError.result.status, "review");
  assert.equal(assetError.calibration.source, "calibrated-failure-review");
});

test("step15 calibration does not use historical expected labels", () => {
  const historicalPassButHighRisk = calibrateStep15Decision(batchItem(5, {
    status: "review",
    ruleIds: ["R10"],
    briefReason: "主力资金净流入榜单需要复核。",
    evidence: ["主力净流入"]
  }, {
    contentType: "资讯",
    expected: "pass",
    localRisks: [{ ruleId: "R10", label: "资金流/选股模型", action: "review", evidence: "主力净流入" }]
  }));
  const historicalRejectButLowRisk = calibrateStep15Decision(batchItem(6, {
    status: "review",
    ruleIds: [],
    briefReason: "泛财经科普，未发现具体荐股、收益承诺或交易指令。",
    evidence: ["风险教育"]
  }, {
    expected: "reject"
  }));

  assert.equal(historicalPassButHighRisk.result.status, "reject");
  assert.equal(historicalRejectButLowRisk.result.status, "pass");
});

test("step15 calibration does not treat negated Qwen pass reasons as high risk", () => {
  const calibrated = calibrateStep15Decision(batchItem(7, {
    status: "pass",
    ruleIds: [],
    briefReason: "未发现具体荐股、收益承诺或交易指令，属于低风险素材。",
    evidence: ["无具体荐股、收益承诺或交易指令"]
  }, {
    localRisks: [{ ruleId: "P2", label: "账号历史通过率先验", action: "review", evidence: "账号：问财" }]
  }));

  assert.equal(calibrated.result.status, "pass");
  assert.equal(calibrated.calibration.source, "calibrated-qwen-pass");
});

test("step15 calibration keeps generic R12 finance reviews out of automatic reject", () => {
  const calibrated = calibrateStep15Decision(batchItem(8, {
    status: "review",
    ruleIds: ["R12"],
    briefReason: "理财知识分享，未发现具体荐股、收益承诺或交易指令。",
    evidence: ["理财知识"]
  }, {
    localRisks: [{ ruleId: "R12", label: "理财/财富自由/投资书单", action: "review", evidence: "理财" }]
  }));

  assert.equal(calibrated.result.status, "pass");
  assert.equal(calibrated.calibration.source, "calibrated-likely-pass");
});

test("news content scores R10 and R12 higher than non-news with the same rules", () => {
  const results = applyBatchPassQuota([
    batchItem(1, {
      status: "review",
      ruleIds: ["R10"],
      briefReason: "资金流需复核。",
      evidence: []
    }, {
      contentType: "资讯",
      localRisks: [
        { ruleId: "P_INFO", label: "资讯低过审先验", action: "review", evidence: "内容类型：资讯" },
        { ruleId: "R10", label: "资金流/选股模型", action: "review", evidence: "资金流" }
      ]
    }),
    batchItem(2, {
      status: "review",
      ruleIds: ["R10"],
      briefReason: "资金流需复核。",
      evidence: []
    }, {
      contentType: "图文",
      localRisks: [{ ruleId: "R10", label: "资金流/选股模型", action: "review", evidence: "资金流" }]
    }),
    batchItem(3, {
      status: "review",
      ruleIds: ["R12"],
      briefReason: "理财内容需复核。",
      evidence: []
    }, {
      contentType: "资讯",
      localRisks: [
        { ruleId: "P_INFO", label: "资讯低过审先验", action: "review", evidence: "内容类型：资讯" },
        { ruleId: "R12", label: "理财/财富自由/投资书单", action: "review", evidence: "理财" }
      ]
    }),
    batchItem(4, {
      status: "review",
      ruleIds: ["R12"],
      briefReason: "理财内容需复核。",
      evidence: []
    }, {
      contentType: "图文",
      localRisks: [{ ruleId: "R12", label: "理财/财富自由/投资书单", action: "review", evidence: "理财" }]
    })
  ], {
    FILTER_STRICTNESS: "balanced",
    FILTER_TARGET_PASS_RATE: "1",
    FILTER_MAX_PASS_RATE: "1"
  });

  assert.ok(results.find((item) => item.sourceRowNumber === 1).quota.riskScore > results.find((item) => item.sourceRowNumber === 2).quota.riskScore);
  assert.ok(results.find((item) => item.sourceRowNumber === 3).quota.riskScore > results.find((item) => item.sourceRowNumber === 4).quota.riskScore);
  assert.equal(results.find((item) => item.sourceRowNumber === 1).result.status, "review");
  assert.equal(results.find((item) => item.sourceRowNumber === 3).result.status, "review");
});

test("historical pass protection keeps non-hard-reject positives and records model conflicts", () => {
  const protectedResults = applyHistoricalPassProtection([
    batchItem(1, {
      status: "review",
      ruleIds: ["P_INFO"],
      briefReason: "资讯复核。",
      evidence: []
    }, {
      contentType: "资讯",
      expected: "pass",
      localRisks: [{ ruleId: "P_INFO", label: "资讯低过审先验", action: "review", evidence: "内容类型：资讯" }]
    }),
    batchItem(2, {
      status: "reject",
      ruleIds: ["R7"],
      briefReason: "模型判断高风险。",
      evidence: ["数据"]
    }, {
      expected: "pass",
      localRisks: [{ ruleId: "P1", label: "历史低过审内容类型", action: "review", evidence: "内容类型：图文" }]
    }),
    batchItem(3, {
      status: "reject",
      ruleIds: ["R1"],
      briefReason: "命中股票代码。",
      evidence: ["600519"]
    }, {
      expected: "pass",
      decisionSource: "local-reject",
      localRisks: [{ ruleId: "R1", label: "股票代码/具体荐股", action: "reject", evidence: "600519" }]
    })
  ]);

  assert.equal(protectedResults[0].result.status, "pass");
  assert.equal(protectedResults[0].historyProtection.protectedHistoricalPass, true);
  assert.equal(protectedResults[0].historyProtection.modelConflict, true);
  assert.equal(protectedResults[1].result.status, "pass");
  assert.equal(protectedResults[1].historyProtection.modelConflict, true);
  assert.equal(protectedResults[2].result.status, "reject");
  assert.equal(protectedResults[2].historyProtection.protectedHistoricalPass, false);
});

test("historical low-approval priors mark risky Douyin account and content types for model context", () => {
  const priors = detectHistoricalFilterPriors({
    fields: {
      "账号": "财经号",
      "内容类型": "资讯"
    }
  });

  assert.deepEqual(priors.map((item) => item.ruleId), ["P_INFO", "P2"]);
  assert.ok(priors.every((item) => item.action === "review"));
});

test("local review signals return review when local provider is configured", async () => {
  const result = await filterWithConfiguredProvider({
    sourceRow: {
      platformId: "douyin",
      fields: {
        "标题": "5月18日涨停股复盘",
        "tag词": "#问财 #同顺图解"
      }
    },
    assetBundle: {
      sourceText: "5月18日涨停股复盘",
      asrText: "",
      ocrText: "",
      imagePaths: [],
      framePaths: []
    },
    localRisks: detectLocalFilterSignals("5月18日涨停股复盘"),
    env: {
      FILTER_PROVIDER: "local"
    }
  });

  assert.deepEqual(result, {
    status: "review",
    ruleIds: ["R9"],
    briefReason: "命中行情复盘/涨停/点位复核线索，需人工复核。",
    evidence: ["涨停股复盘"]
  });
});

test("cleanDailyStep15 applies the default batch pass quota", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "step15-quota-clean-"));
  const rows = [
    douyinSeparatorRow("0519 投稿视频"),
    ...Array.from({ length: 30 }, (_, index) => douyinRow({
      sequence: String(index + 1),
      link: `https://www.douyin.com/video/pass-${index + 1}`,
      title: `普通市场资讯 ${index + 1}`,
      tags: "#同花顺",
      account: "投资号",
      contentType: "股友说"
    }))
  ];
  const calls = [];
  const client = {
    async readRows(platformId) {
      return platformId === "douyin" ? rows : [];
    },
    async readSheetRows() {
      return [STEP15_FILTERED_HEADERS];
    },
    async replaceSheetRows(sheetKey, replacementRows, columnCount) {
      calls.push(["replaceSheetRows", sheetKey, replacementRows, columnCount]);
    },
    sheetId(platformId) {
      return platformId === "douyin" ? "dySheet" : "filteredSheet";
    },
    async writeRows(platformId, range, replacementRows) {
      calls.push(["writeRows", platformId, range, replacementRows]);
    }
  };

  const result = await cleanDailyStep15({
    root,
    targetDate: "2026-05-19",
    client,
    platforms: ["douyin"],
    extractDouyinAsset: async ({ sourceRow }) => ({
      awemeId: sourceRow.link.split("/").pop(),
      mediaType: "video",
      title: sourceRow.fields["标题"],
      text: sourceRow.fields["标题"]
    }),
    filterWithProvider: async () => ({ status: "pass", ruleIds: [], briefReason: "模型判断低风险。", evidence: [] }),
    env: {
      FILTER_STRICTNESS: "balanced"
    }
  });

  assert.equal(result.summary.douyin.total, 30);
  assert.equal(result.summary.douyin.pass, 30);
  assert.equal(result.summary.douyin.review, 0);
  assert.equal(result.details.filter((item) => item.quota?.selected).length, 12);
  const replaceCall = calls.find((call) => call[0] === "replaceSheetRows");
  assert.equal(replaceCall[2].filter((row) => row[1] === "05 19").length, 30);
});

test("package exposes clean daily CLI script", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.scripts["clean:daily"], "node src/clean-daily.mjs");
});

test("step15 filtered sheet follows Douyin columns plus filter feedback", () => {
  assert.deepEqual(STEP15_FILTERED_HEADERS, [
    "编号",
    "投稿时间",
    "内容链接",
    "账号",
    "内容类型",
    "简短理由",
    "是否投放成功",
    "是否为爆款",
    "供稿人",
    "备注"
  ]);
  assert.equal(STEP15_FILTERED_HEADERS.includes("内容类型标签审核"), false);
});

test("sourceRowsForTargetDate reads material rows and keeps Feishu source row numbers", () => {
  const rows = [
    douyinSeparatorRow("0519 投稿视频"),
    douyinRow({
      sequence: "1",
      link: "https://www.douyin.com/video/7641910769218506003",
      title: "早盘观点",
      tags: "#同花顺",
      account: "投资号"
    }),
    douyinRow({
      sequence: "2",
      date: "05 20",
      link: "https://www.douyin.com/video/7642330487012281641",
      title: "隔日内容",
      tags: "#同花顺",
      account: "财经号"
    })
  ];

  const sourceRows = sourceRowsForTargetDate("douyin", "2026-05-19", rows);

  assert.equal(sourceRows.length, 1);
  assert.equal(sourceRows[0].sourceRowNumber, 3);
  assert.equal(sourceRows[0].fields["账号"], "投资号");
  assert.equal(sourceRows[0].link, "https://www.douyin.com/video/7641910769218506003");
});

test("sourceRowsForTargetDate can map template-backed rows to real Feishu row numbers", () => {
  const rows = [
    douyinSeparatorRow("0519 投稿视频"),
    douyinRow({
      sequence: "1",
      link: "https://www.douyin.com/video/7641910769218506003",
      title: "早盘观点",
      tags: "#同花顺",
      account: "投资号"
    })
  ];

  const sourceRows = sourceRowsForTargetDate("douyin", "2026-05-19", rows, 5);

  assert.equal(sourceRows.length, 1);
  assert.equal(sourceRows[0].sourceRowNumber, 6);
});

test("cleanDailyStep15 defaults to filtering Douyin only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "step15-clean-"));
  const calls = [];
  const client = {
    async readRows(platformId) {
      if (platformId === "douyin") {
        return [
          douyinSeparatorRow("0519 投稿视频"),
          douyinRow({ sequence: "1", link: "https://www.douyin.com/video/pass1", title: "普通市场资讯", tags: "#同花顺", account: "投资号" }),
          douyinRow({ sequence: "2", link: "https://www.douyin.com/video/reject1", title: "600519 今日买点", tags: "#股票", account: "财经号" }),
          douyinRow({ sequence: "3", link: "https://www.douyin.com/video/review1", title: "模型复核内容", tags: "#同花顺", account: "问财" })
        ];
      }
      if (platformId === "xhs") {
        return [
          ["", "0519 投稿视频", "", "", "", "", "", ""],
          ["1", "05 19", urlCell("https://www.xiaohongshu.com/discovery/item/x1"), "x1", dropdown("问财"), dropdown("图文"), "通过", "#tag"]
        ];
      }
      if (platformId === "bilibili") {
        return [
          ["", "0519 投稿视频", "", "", ""],
          ["1", "05 19", urlCell("https://www.bilibili.com/video/BV1tNLA6hEQh/"), "BV1tNLA6hEQh", dropdown("投资号")]
        ];
      }
      throw new Error(`unexpected platform ${platformId}`);
    },
    async readSheetRows(sheetKey, columnCount) {
      calls.push(["readSheetRows", sheetKey, columnCount]);
      assert.equal(sheetKey, "step15");
      return [
        STEP15_FILTERED_HEADERS,
        ["9", "05 18", urlCell("https://www.douyin.com/video/old"), "投资号", "资讯", "旧日期保留", "", "", "", ""],
        ["1", "05 19", urlCell("https://www.douyin.com/video/stale"), "投资号", "资讯", "应被替换", "", "", "", ""]
      ];
    },
    async replaceSheetRows(sheetKey, rows, columnCount) {
      calls.push(["replaceSheetRows", sheetKey, rows, columnCount]);
    },
    sheetId(platformId) {
      return platformId === "douyin" ? "dySheet" : "filteredSheet";
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    }
  };

  const result = await cleanDailyStep15({
    root,
    targetDate: "2026-05-19",
    client,
    extractDouyinAsset: async ({ sourceRow }) => ({
      awemeId: sourceRow.link.split("/").pop(),
      mediaType: "video",
      title: sourceRow.fields["标题"],
      text: sourceRow.fields["标题"],
      localTexts: {
        asr: sourceRow.link.includes("pass1") ? "普通财经知识分享" : "",
        ocr: sourceRow.link.includes("review1") ? "需要模型复核" : ""
      }
    }),
    filterWithProvider: async ({ sourceRow }) => {
      if (sourceRow.link.includes("pass1")) {
        return { status: "pass", ruleIds: [], briefReason: "未发现不投放风险。", evidence: [] };
      }
      if (sourceRow.link.includes("review1")) {
        return { status: "review", ruleIds: ["R7"], briefReason: "数据表述需要人工确认。", evidence: ["需要模型复核"] };
      }
      throw new Error("local reject row should not call provider");
    }
  });

  assert.equal(result.summary.douyin.total, 3);
  assert.equal(result.summary.douyin.pass, 1);
  assert.equal(result.summary.douyin.reject, 1);
  assert.equal(result.summary.douyin.review, 1);
  assert.equal(result.summary.xhs.kept, 0);
  assert.equal(result.summary.bilibili.kept, 0);

  assert.equal(calls.some((call) => call[0] === "writeRows" && String(call[2]).startsWith("dySheet!")), false);

  const replaceCall = calls.find((call) => call[0] === "replaceSheetRows");
  assert.ok(replaceCall, "expected filtered sheet replacement");
  assert.deepEqual(replaceCall[3], STEP15_FILTERED_HEADERS.length);
  assert.deepEqual(replaceCall[2][0], STEP15_FILTERED_HEADERS);
  assert.equal(replaceCall[2].filter((row) => row[1] === "05 19").length, 1);
  assert.equal(replaceCall[2].some((row) => String(row[5]).includes("应被替换")), false);
  assert.equal(replaceCall[2].some((row) => String(row[5]).includes("旧日期保留")), true);
  const passRow = replaceCall[2].find((row) => JSON.stringify(row[2]).includes("pass1"));
  assert.ok(passRow, "expected passed Douyin row in filtered sheet");
  assert.equal(passRow[3], "投资号");
  assert.equal(passRow[4], "资讯");
  assert.equal(passRow[5], "未发现不投放风险。");
  assert.deepEqual(passRow.slice(6), ["", "", "", ""]);
  assert.equal(replaceCall[2].some((row) => row[0] === "抖音"), false);
  assert.equal(replaceCall[2].some((row) => JSON.stringify(row).includes("xiaohongshu")), false);
  assert.equal(replaceCall[2].some((row) => JSON.stringify(row).includes("bilibili")), false);
  assert.equal(replaceCall[2].some((row) => String(row[5]).includes("600519")), false);

  const manifestPath = path.join(root, "output", "step15-assets", "2026-05-19", "douyin", "pass1", "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.sourceRowNumber, 3);
  assert.equal(manifest.link, "https://www.douyin.com/video/pass1");
});

test("cleanDailyStep15 sends review signals to the provider before calibration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "step15-review-signal-"));
  const calls = [];
  const seenProviderSignals = [];
  const client = {
    async readRows(platformId) {
      if (platformId !== "douyin") return [];
      return [
        douyinSeparatorRow("0519 投稿视频"),
        douyinRow({
          sequence: "1",
          link: "https://www.douyin.com/video/review-signal",
          title: "5月18日涨停股复盘",
          tags: "#热点 #问财",
          account: "问财",
          contentType: "图文",
          review: ""
        })
      ];
    },
    async readSheetRows() {
      return [STEP15_FILTERED_HEADERS];
    },
    async replaceSheetRows(sheetKey, rows, columnCount) {
      calls.push(["replaceSheetRows", sheetKey, rows, columnCount]);
    },
    sheetId(platformId) {
      return platformId === "douyin" ? "dySheet" : "filteredSheet";
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    }
  };

  const result = await cleanDailyStep15({
    root,
    targetDate: "2026-05-19",
    client,
    extractDouyinAsset: async ({ sourceRow }) => ({
      awemeId: sourceRow.link.split("/").pop(),
      mediaType: "video",
      title: sourceRow.fields["标题"],
      text: sourceRow.fields["标题"]
    }),
    filterWithProvider: async ({ localRisks }) => {
      seenProviderSignals.push(...localRisks);
      return { status: "pass", ruleIds: [], briefReason: "模型判断为客观复盘，可投放。", evidence: [] };
    }
  });

  assert.deepEqual(seenProviderSignals.map((item) => item.ruleId), ["R9", "P2"]);
  assert.equal(result.summary.douyin.pass, 1);
  assert.equal(result.summary.douyin.reject, 0);
  assert.equal(calls.some((call) => call[0] === "writeRows" && String(call[2]).startsWith("dySheet!")), false);
});

test("cleanDailyStep15 writes template-backed feedback and filtered rows below the template header", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "step15-template-clean-"));
  const calls = [];
  const client = {
    dataStartRow(sheetKey) {
      return sheetKey === "step15" || sheetKey === "douyin" ? 5 : 3;
    },
    headerRow(sheetKey) {
      return sheetKey === "step15" || sheetKey === "douyin" ? 4 : 2;
    },
    async readRows(platformId) {
      if (platformId === "douyin") {
        return [
          douyinSeparatorRow("0519 投稿视频"),
          douyinRow({
            sequence: "1",
            link: "https://www.douyin.com/video/pass-template",
            title: "普通市场资讯",
            tags: "#同花顺",
            account: "投资号"
          })
        ];
      }
      return [];
    },
    async readSheetRows(sheetKey, columnCount) {
      calls.push(["readSheetRows", sheetKey, columnCount]);
      return [
        ["2026目标  10个爆款/月", "", "", "过审核率监控", "", "", "", "", "", "", "", ""],
        ["投稿规则", "1、明显不符合广告平台规则的内容不投", "", "", "", "", "", "", "", "", "", ""],
        ["", "2、投稿账号连着2周过审率低于30%，停投2周(每周五观测一次)", "", "", "", "", "", "", "", "", "", ""],
        STEP15_FILTERED_HEADERS,
        ["9", "05 18", urlCell("https://www.douyin.com/video/old"), "投资号", "资讯", "旧日期保留", "", "", "", ""]
      ];
    },
    async replaceSheetDataRows(sheetKey, rows, columnCount) {
      calls.push(["replaceSheetDataRows", sheetKey, rows, columnCount]);
    },
    async clearMaterialRowHighlights(sheetKey, rowRanges) {
      calls.push(["clearMaterialRowHighlights", sheetKey, rowRanges]);
    },
    async highlightSeparatorRows(sheetKey, rowNumbers) {
      calls.push(["highlightSeparatorRows", sheetKey, rowNumbers]);
    },
    sheetId(platformId) {
      return platformId === "douyin" ? "dySheet" : "filteredSheet";
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    }
  };

  await cleanDailyStep15({
    root,
    targetDate: "2026-05-19",
    client,
    platforms: ["douyin"],
    extractDouyinAsset: async ({ sourceRow }) => ({
      awemeId: sourceRow.link.split("/").pop(),
      mediaType: "video",
      title: sourceRow.fields["标题"],
      text: sourceRow.fields["标题"]
    }),
    filterWithProvider: async () => ({ status: "pass", ruleIds: [], briefReason: "未发现不投放风险。", evidence: [] })
  });

  assert.equal(calls.some((call) => call[0] === "writeRows" && String(call[2]).startsWith("dySheet!")), false);
  const replaceCall = calls.find((call) => call[0] === "replaceSheetDataRows");
  assert.ok(replaceCall);
  assert.equal(replaceCall[1], "step15");
  assert.deepEqual(replaceCall[2].map((row) => row[1]), ["0519 投稿视频", "05 19", "0518 投稿视频", "05 18"]);
  const highlightCall = calls.find((call) => call[0] === "highlightSeparatorRows");
  assert.deepEqual(highlightCall, ["highlightSeparatorRows", "step15", [5, 7]]);
});
