import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildDouyinChannelTypeABComparison,
  buildDouyinChannelTypePreview,
  DOUYIN_CHANNEL_TYPE_OUTPUT_HEADERS,
  ensureDouyinChannelTypeHeaders,
  runDouyinChannelTypeClassification
} from "../src/douyin-channel-type-classifier/feishu-runner.mjs";

test("ensureDouyinChannelTypeHeaders appends missing result columns to the header row", async () => {
  const calls = [];
  const client = fakeClient({
    rows: [
      ["目标说明"],
      [""],
      [""],
      ["编号", "投稿时间", "内容链接", "账号", "内容类型", "标题", "tag词"]
    ],
    calls
  });

  const result = await ensureDouyinChannelTypeHeaders({ client });

  assert.equal(result.headerRowNumber, 4);
  assert.equal(result.primaryColumn, 8);
  assert.equal(result.secondaryColumn, 9);
  assert.deepEqual(calls, [
    ["readSheetRows", "douyin", 30],
    ["writeRows", "douyin", "dySheet!H4:O4", [DOUYIN_CHANNEL_TYPE_OUTPUT_HEADERS]]
  ]);
});

test("ensureDouyinChannelTypeHeaders appends after the last non-empty header when Feishu pads rows", async () => {
  const calls = [];
  const paddedHeader = [
    "编号",
    "投稿时间",
    "内容链接",
    "账号",
    "内容类型",
    "是否投放成功",
    "是否为爆款",
    "供稿人",
    "备注",
    "作品ID",
    "作品类型",
    "标题",
    "tag词",
    "内容类型标签审核",
    "",
    "",
    ""
  ];
  const client = fakeClient({
    rows: [
      ["目标说明"],
      [""],
      [""],
      paddedHeader
    ],
    calls
  });

  const result = await ensureDouyinChannelTypeHeaders({ client });

  assert.equal(result.primaryColumn, 15);
  assert.equal(result.secondaryColumn, 16);
  assert.deepEqual(calls, [
    ["readSheetRows", "douyin", 30],
    ["writeRows", "douyin", "dySheet!O4:V4", [DOUYIN_CHANNEL_TYPE_OUTPUT_HEADERS]]
  ]);
});

test("buildDouyinChannelTypePreview skips separators, empty rows, and existing classifications by default", async () => {
  const rows = [
    ["目标说明"],
    [""],
    [""],
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "标题", "tag词", "一级类型", "二级类型"],
    ["", "0608 投稿视频", "", "", "", "", "", "", ""],
    ["1", "06 08", "", "投资号", "无", "6月1日涨停股复盘！", "#同顺盘点", "", ""],
    ["2", "06 08", "", "股民社区", "无", "已分类", "#股友说", "股友说", "股民洞察"],
    ["3", "06 08", "", "投资号", "无", "", "", "", ""]
  ];
  const classified = [];

  const preview = await buildDouyinChannelTypePreview({
    rows,
    classify: async ({ title }) => {
      classified.push(title);
      return {
        ok: true,
        primaryType: "盘点",
        secondaryType: "市场热点行业盘点",
        confidence: 0.88,
        reason: "涨停复盘"
      };
    }
  });

  assert.deepEqual(classified, ["6月1日涨停股复盘！"]);
  assert.equal(preview.summary.materialRows, 3);
  assert.equal(preview.summary.classifiedRows, 1);
  assert.equal(preview.summary.skippedExistingRows, 1);
  assert.equal(preview.summary.skippedEmptyRows, 1);
  assert.equal(preview.summary.skippedSeparatorRows, 1);
  assert.deepEqual(preview.updates.map(pickTypeUpdate), [
    {
      rowNumber: 6,
      primaryType: "盘点",
      secondaryType: "市场热点行业盘点",
      confidence: 0.88,
      reason: "涨停复盘",
      ok: true,
      reviewStatus: "通过",
      assetStatus: "文本分类"
    }
  ]);
});

test("buildDouyinChannelTypePreview prepares sampled media once for duplicate materials", async () => {
  const prepared = [];
  const classified = [];
  const rows = [
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "作品ID", "作品类型", "标题", "tag词", "一级类型", "二级类型"],
    ["1", "06 08", urlCell("https://www.douyin.com/video/7645299366600674602"), "投资号", "盘点", "7645299366600674602", "视频", "6月8日，主力资金都去哪儿了？", "#同顺盘点", "", ""],
    ["2", "06 08", urlCell("https://www.douyin.com/video/7645299366600674602"), "投资号", "盘点", "7645299366600674602", "视频", "6月8日，主力资金都去哪儿了？", "#同顺盘点", "", ""]
  ];

  const preview = await buildDouyinChannelTypePreview({
    rows,
    provider: "minimax",
    mediaMode: "sampled-media",
    prepareAsset: async ({ sourceRow }) => {
      prepared.push(sourceRow.itemId);
      return {
        assetStatus: "视频抽帧",
        framePaths: ["/tmp/frame.jpg"]
      };
    },
    classify: async ({ sourceRow, assetBundle }) => {
      classified.push([sourceRow.itemId, assetBundle.assetStatus]);
      return {
        ok: true,
        primaryType: "盘点",
        secondaryType: "资金盘面盘点",
        confidence: 0.91,
        reason: "标题和抽帧指向资金盘面盘点",
        evidence: ["主力资金"],
        assetSignals: ["视频抽帧"],
        source: "minimax",
        model: "MiniMax-M3"
      };
    }
  });

  assert.deepEqual(prepared, ["7645299366600674602"]);
  assert.deepEqual(classified, [["7645299366600674602", "视频抽帧"]]);
  assert.equal(preview.summary.reusedDuplicateRows, 1);
  assert.equal(preview.summary.classifiedRows, 2);
  assert.deepEqual(preview.updates.map((update) => update.assetStatus), ["视频抽帧", "视频抽帧"]);
  assert.deepEqual(preview.updates.map((update) => update.model), ["MiniMax-M3", "MiniMax-M3"]);
});

test("buildDouyinChannelTypePreview does not call MiniMax when sampled media has no visual asset", async () => {
  let classifyCalls = 0;
  const preview = await buildDouyinChannelTypePreview({
    rows: [
      ["编号", "投稿时间", "内容链接", "账号", "内容类型", "作品ID", "作品类型", "标题", "tag词", "一级类型", "二级类型"],
      ["1", "06 08", urlCell("https://www.douyin.com/video/7645299366600674602"), "投资号", "盘点", "7645299366600674602", "视频", "6月8日，主力资金都去哪儿了？", "#同顺盘点", "", ""]
    ],
    provider: "minimax",
    mediaMode: "sampled-media",
    prepareAsset: async () => ({
      assetStatus: "素材获取失败需复核",
      imagePaths: [],
      framePaths: [],
      screenshotPaths: []
    }),
    classify: async () => {
      classifyCalls += 1;
      throw new Error("should not classify without media");
    }
  });

  assert.equal(classifyCalls, 0);
  assert.equal(preview.summary.minimaxRequests, 0);
  assert.equal(preview.summary.assetFailedRows, 1);
  assert.equal(preview.summary.failedRows, 1);
  assert.equal(preview.updates[0].reviewStatus, "需人工复核");
  assert.equal(preview.updates[0].assetStatus, "素材获取失败需复核");
});

test("buildDouyinChannelTypePreview can run media preparation without classification", async () => {
  let classifyCalls = 0;
  const preview = await buildDouyinChannelTypePreview({
    rows: [
      ["编号", "投稿时间", "内容链接", "账号", "内容类型", "作品ID", "作品类型", "标题", "tag词", "一级类型", "二级类型"],
      ["1", "06 08", urlCell("https://www.douyin.com/video/7645299366600674602"), "投资号", "盘点", "7645299366600674602", "视频", "6月8日，主力资金都去哪儿了？", "#同顺盘点", "", ""]
    ],
    noClassify: true,
    provider: "minimax",
    mediaMode: "sampled-media",
    prepareAsset: async () => ({
      assetStatus: "视频抽帧",
      framePaths: ["/tmp/frame.jpg"]
    }),
    classify: async () => {
      classifyCalls += 1;
      throw new Error("should not classify in no-classify mode");
    }
  });

  assert.equal(classifyCalls, 0);
  assert.equal(preview.summary.assetPreparedRows, 1);
  assert.equal(preview.summary.assetReadyRows, 1);
  assert.equal(preview.summary.minimaxRequests, 0);
  assert.equal(preview.summary.classifiedRows, 0);
  assert.equal(preview.updates[0].reviewStatus, "未分类");
  assert.equal(preview.updates[0].assetStatus, "视频抽帧");
});

test("buildDouyinChannelTypeABComparison compares text-only and sampled-media classifications", async () => {
  const rows = [
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "作品ID", "作品类型", "标题", "tag词", "一级类型", "二级类型"],
    ["1", "06 08", urlCell("https://www.douyin.com/video/7645299366600674602"), "投资号", "盘点", "7645299366600674602", "视频", "6月8日，主力资金都去哪儿了？", "#同顺盘点", "", ""]
  ];

  const comparison = await buildDouyinChannelTypeABComparison({
    rows,
    textClassify: async () => ({
      ok: true,
      primaryType: "图文",
      secondaryType: "投资认知理财方法",
      confidence: 0.64,
      reason: "标题信息不足",
      source: "minimax",
      model: "MiniMax-M3"
    }),
    mediaClassify: async () => ({
      ok: true,
      primaryType: "盘点",
      secondaryType: "资金盘面盘点",
      confidence: 0.92,
      reason: "抽帧出现资金盘点页",
      source: "minimax",
      model: "MiniMax-M3"
    }),
    prepareAsset: async () => ({
      assetStatus: "视频抽帧",
      framePaths: ["/tmp/frame.jpg"]
    })
  });

  assert.equal(comparison.summary.totalRows, 1);
  assert.equal(comparison.summary.conflictRows, 1);
  assert.equal(comparison.summary.mediaAssetReadyRows, 1);
  assert.deepEqual(comparison.comparisons.map((row) => ({
    rowNumber: row.rowNumber,
    title: row.title,
    textPrimaryType: row.textPrimaryType,
    mediaPrimaryType: row.mediaPrimaryType,
    conflict: row.conflict,
    assetStatus: row.assetStatus
  })), [{
    rowNumber: 2,
    title: "6月8日，主力资金都去哪儿了？",
    textPrimaryType: "图文",
    mediaPrimaryType: "盘点",
    conflict: true,
    assetStatus: "视频抽帧"
  }]);
});

test("Douyin channel type runner uses its own asset module, not Step 1.5 assets", async () => {
  const source = await fs.readFile(
    path.join(process.cwd(), "src", "douyin-channel-type-classifier", "feishu-runner.mjs"),
    "utf8"
  );

  assert.doesNotMatch(source, /step15-douyin-assets/u);
  assert.match(source, /from "\.\/assets\.mjs"/u);
});

test("buildDouyinChannelTypePreview reuses persisted cache across reruns", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-channel-type-cache-"));
  const rows = [
    ["编号", "投稿时间", "内容链接", "账号", "内容类型", "作品ID", "作品类型", "标题", "tag词", "一级类型", "二级类型"],
    ["1", "06 08", urlCell("https://www.douyin.com/video/7645299366600674602"), "投资号", "盘点", "7645299366600674602", "视频", "6月8日，主力资金都去哪儿了？", "#同顺盘点", "", ""]
  ];
  let classifyCalls = 0;

  const first = await buildDouyinChannelTypePreview({
    rows,
    cacheDir,
    provider: "minimax",
    classify: async () => {
      classifyCalls += 1;
      return {
        ok: true,
        primaryType: "盘点",
        secondaryType: "资金盘面盘点",
        confidence: 0.93,
        reason: "首次模型结果",
        source: "minimax",
        model: "MiniMax-M3"
      };
    }
  });
  const second = await buildDouyinChannelTypePreview({
    rows,
    cacheDir,
    provider: "minimax",
    classify: async () => {
      classifyCalls += 1;
      throw new Error("cache miss");
    }
  });

  assert.equal(classifyCalls, 1);
  assert.equal(first.summary.cacheHits, 0);
  assert.equal(first.summary.cacheWrites, 1);
  assert.equal(second.summary.cacheHits, 1);
  assert.equal(second.summary.classifiedRows, 1);
  assert.equal(second.updates[0].reason, "首次模型结果");
});

test("buildDouyinChannelTypePreview reads the first visible type columns when duplicate headers exist", async () => {
  const classified = [];

  const preview = await buildDouyinChannelTypePreview({
    rows: [
      ["编号", "标题", "tag词", "一级类型", "二级类型", "", "一级类型", "二级类型"],
      ["1", "已填可见列", "#同顺盘点", "盘点", "资金盘面盘点", "", "", ""],
      ["2", "只填误写远端列", "#同顺盘点", "", "", "", "盘点", "资金盘面盘点"]
    ],
    classify: async ({ title }) => {
      classified.push(title);
      return {
        ok: true,
        primaryType: "盘点",
        secondaryType: "资金盘面盘点",
        confidence: 0.9,
        reason: "测试"
      };
    }
  });

  assert.deepEqual(classified, ["只填误写远端列"]);
  assert.equal(preview.summary.skippedExistingRows, 1);
  assert.equal(preview.summary.classifiedRows, 1);
  assert.equal(preview.updates[0].rowNumber, 3);
});

test("buildDouyinChannelTypePreview overwrites existing classifications when requested", async () => {
  const rows = [
    ["编号", "标题", "tag词", "一级类型", "二级类型"],
    ["1", "已分类", "#股友说", "股友说", "股民洞察"]
  ];
  let calls = 0;

  const preview = await buildDouyinChannelTypePreview({
    rows,
    overwrite: true,
    classify: async () => {
      calls += 1;
      return {
        ok: true,
        primaryType: "股友说",
        secondaryType: "股民优势",
        confidence: 0.7,
        reason: "重算"
      };
    }
  });

  assert.equal(calls, 1);
  assert.equal(preview.summary.classifiedRows, 1);
  assert.equal(preview.updates[0].rowNumber, 2);
});

test("buildDouyinChannelTypePreview reuses one DeepSeek result for duplicate title and tags", async () => {
  const calls = [];
  const progress = [];

  const preview = await buildDouyinChannelTypePreview({
    rows: [
      ["编号", "标题", "tag词", "一级类型", "二级类型"],
      ["1", "6月1日涨停股复盘！", "#同顺盘点", "", ""],
      ["2", "6月1日涨停股复盘！", "#同顺盘点", "", ""],
      ["3", "6月4日涨停复盘！", "#同顺盘点", "", ""]
    ],
    onProgress: (event) => progress.push(event),
    classify: async ({ title, tags }) => {
      calls.push({ title, tags });
      return {
        ok: true,
        primaryType: "盘点",
        secondaryType: "市场热点行业盘点",
        confidence: 0.9,
        reason: "涨停复盘"
      };
    }
  });

  assert.deepEqual(calls, [
    { title: "6月1日涨停股复盘！", tags: "#同顺盘点" },
    { title: "6月4日涨停复盘！", tags: "#同顺盘点" }
  ]);
  assert.equal(preview.summary.classifiedRows, 3);
  assert.equal(preview.summary.deepseekRequests, 2);
  assert.equal(preview.summary.reusedDuplicateRows, 1);
  assert.deepEqual(preview.updates.map((update) => update.rowNumber), [2, 3, 4]);
  assert.deepEqual(progress.map((event) => [event.completed, event.total, event.ok]), [
    [1, 2, true],
    [2, 2, true]
  ]);
});

test("buildDouyinChannelTypePreview reports progress for classified rows", async () => {
  const progress = [];

  await buildDouyinChannelTypePreview({
    rows: [
      ["编号", "标题", "tag词", "一级类型", "二级类型"],
      ["1", "6月1日涨停股复盘！", "#同顺盘点", "", ""],
      ["2", "普通人攒100万为什么总是被打断", "#同顺图解", "", ""]
    ],
    onProgress: (event) => progress.push(event),
    classify: async ({ title }) => ({
      ok: true,
      primaryType: title.includes("攒100万") ? "图文" : "盘点",
      secondaryType: title.includes("攒100万") ? "投资认知理财方法" : "资金盘面盘点",
      confidence: 0.9,
      reason: "测试"
    })
  });

  assert.deepEqual(progress.map((event) => [event.completed, event.total, event.ok]), [
    [1, 2, true],
    [2, 2, true]
  ]);
});

test("runDouyinChannelTypeClassification writes type and audit columns in write mode", async () => {
  const calls = [];
  const client = fakeClient({
    rows: [
      ["目标说明"],
      [""],
      [""],
      ["编号", "投稿时间", "内容链接", "账号", "内容类型", "标题", "tag词"],
      ["1", "06 08", "", "投资号", "无", "6月1日涨停股复盘！", "#同顺盘点"]
    ],
    calls
  });

  const result = await runDouyinChannelTypeClassification({
    client,
    write: true,
    writeAudit: false,
    generatedAt: "2026-06-10T01:02:03.000Z",
    classify: async () => ({
      ok: true,
      primaryType: "盘点",
      secondaryType: "市场热点行业盘点",
      confidence: 0.9,
      reason: "标题包含涨停复盘",
      model: "unit-model"
    })
  });

  assert.equal(result.written, true);
  assert.deepEqual(calls, [
    ["readSheetRows", "douyin", 30],
    ["writeRows", "douyin", "dySheet!H4:O4", [DOUYIN_CHANNEL_TYPE_OUTPUT_HEADERS]],
    ["readSheetRows", "douyin", 30],
    ["writeRows", "douyin", "dySheet!H5:O5", [[
      "盘点",
      "市场热点行业盘点",
      0.9,
      "标题包含涨停复盘",
      "通过",
      "文本分类",
      "unit-model",
      "2026-06-10T01:02:03.000Z"
    ]]]
  ]);
});

test("runDouyinChannelTypeClassification does not append headers or write values in dry-run mode", async () => {
  const calls = [];
  const client = fakeClient({
    rows: [
      ["目标说明"],
      [""],
      [""],
      ["编号", "投稿时间", "内容链接", "账号", "内容类型", "标题", "tag词"],
      ["1", "06 08", "", "投资号", "无", "6月1日涨停股复盘！", "#同顺盘点"]
    ],
    calls
  });

  const result = await runDouyinChannelTypeClassification({
    client,
    write: false,
    writeAudit: false,
    classify: async () => ({
      ok: true,
      primaryType: "盘点",
      secondaryType: "市场热点行业盘点",
      confidence: 0.9,
      reason: "标题包含涨停复盘"
    })
  });

  assert.equal(result.written, false);
  assert.equal(result.writtenRows, 0);
  assert.deepEqual(calls, [
    ["readSheetRows", "douyin", 30]
  ]);
});

function fakeClient({ rows, calls }) {
  return {
    sheetId(sheetKey) {
      assert.equal(sheetKey, "douyin");
      return "dySheet";
    },
    async readSheetRows(sheetKey, columnCount) {
      calls.push(["readSheetRows", sheetKey, columnCount]);
      return rows;
    },
    async writeRows(sheetKey, range, values) {
      calls.push(["writeRows", sheetKey, range, values]);
    }
  };
}

function pickTypeUpdate(update) {
  return {
    rowNumber: update.rowNumber,
    primaryType: update.primaryType,
    secondaryType: update.secondaryType,
    confidence: update.confidence,
    reason: update.reason,
    ok: update.ok,
    reviewStatus: update.reviewStatus,
    assetStatus: update.assetStatus
  };
}

function urlCell(url) {
  return { type: "url", text: url, link: url };
}
