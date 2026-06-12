import test from "node:test";
import assert from "node:assert/strict";

import {
  DOUYIN_CHANNEL_PRIMARY_TYPES,
  DOUYIN_CHANNEL_TAXONOMY,
  buildTaxonomyPromptText,
  flattenSecondaryLabels,
  secondaryLabelsForPrimary
} from "../src/douyin-channel-type-classifier/taxonomy.mjs";

test("Douyin channel taxonomy exposes the fixed primary types only", () => {
  assert.deepEqual(DOUYIN_CHANNEL_PRIMARY_TYPES, [
    "股友说",
    "财商动画",
    "图文",
    "社区话题",
    "说唱",
    "长视频",
    "盘点"
  ]);
  assert.deepEqual(DOUYIN_CHANNEL_TAXONOMY.map((entry) => entry.primaryType), DOUYIN_CHANNEL_PRIMARY_TYPES);
});

test("all secondary labels belong to valid primary types", () => {
  const labels = flattenSecondaryLabels();
  assert.ok(labels.includes("股民教学"));
  assert.ok(labels.includes("资金盘面盘点"));
  assert.ok(labels.includes("行业品种产业链解析"));
  assert.ok(labels.includes("投资知识类盘点"));

  for (const primaryType of DOUYIN_CHANNEL_PRIMARY_TYPES) {
    const secondaryLabels = secondaryLabelsForPrimary(primaryType);
    assert.ok(Array.isArray(secondaryLabels));
  }
});

test("rap and long-video primary types require blank secondary labels", () => {
  assert.deepEqual(secondaryLabelsForPrimary("说唱"), []);
  assert.deepEqual(secondaryLabelsForPrimary("长视频"), []);
});

test("taxonomy prompt text includes maintainable examples and boundary rules", () => {
  const text = buildTaxonomyPromptText();
  assert.match(text, /一级类型：股友说/u);
  assert.match(text, /二级类型：股民洞察/u);
  assert.match(text, /稳定盈利的人，每天都在看什么/u);
  assert.match(text, /长视频.*二级类型必须留空/u);
});
