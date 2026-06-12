import test from "node:test";
import assert from "node:assert/strict";
import {
  applyContentTypeRepairs,
  buildContentTypeRepairPlan
} from "../src/repair-content-types.mjs";

function urlCell(link) {
  return [{ type: "url", text: link, link }];
}

test("content type repair reads Feishu URL arrays and updates tag-classified rows", async () => {
  const plan = await buildContentTypeRepairPlan({
    platformId: "douyin",
    rows: [
      [
        "1",
        "05 21",
        urlCell("https://www.douyin.com/video/1"),
        "标题",
        "#同花顺资讯 #投资",
        "",
        "",
        "投资号",
        "无",
        "",
        ""
      ]
    ],
    classify: async () => ({ contentType: "资讯", contentTypeReview: "通过", source: "tag" })
  });

  assert.equal(plan.materialRows, 1);
  assert.equal(plan.stats.wouldUpdateType, 1);
  assert.equal(plan.stats.wouldUpdateReview, 1);
  assert.deepEqual(plan.updates.map(({ rowNumber, nextContentType, nextReview, source }) => ({
    rowNumber,
    nextContentType,
    nextReview,
    source
  })), [
    {
      rowNumber: 2,
      nextContentType: "资讯",
      nextReview: "通过",
      source: "tag"
    }
  ]);
});

test("content type repair preserves existing type when evidence is insufficient", async () => {
  const plan = await buildContentTypeRepairPlan({
    platformId: "douyin",
    rows: [
      [
        "2",
        "05 20",
        urlCell("https://www.douyin.com/video/2"),
        "",
        "",
        "",
        "",
        "投资号",
        "长视频",
        "",
        ""
      ]
    ],
    classify: async () => ({ contentType: "无", contentTypeReview: "需审核", source: "deepseek" })
  });

  assert.equal(plan.stats.wouldUpdateType, 0);
  assert.equal(plan.stats.wouldUpdateReview, 1);
  assert.equal(plan.stats.unclassifiable, 1);
  assert.equal(plan.updates[0].currentContentType, "长视频");
  assert.equal(plan.updates[0].nextContentType, "长视频");
  assert.equal(plan.updates[0].nextReview, "需审核");
});

test("content type repair writes only content type and review cells", async () => {
  const calls = [];
  const client = {
    sheetId(platformId) {
      assert.equal(platformId, "xhs");
      return "sheet_xhs";
    },
    async writeRows(platformId, range, rows) {
      calls.push({ platformId, range, rows });
    }
  };

  await applyContentTypeRepairs({
    platformId: "xhs",
    client,
    updates: [
      {
        rowNumber: 8,
        currentContentType: "无",
        nextContentType: "图文",
        currentReview: "",
        nextReview: "需审核"
      }
    ]
  });

  assert.deepEqual(calls, [
    {
      platformId: "xhs",
      range: "sheet_xhs!F8:F8",
      rows: [[{ type: "multipleValue", values: ["图文"] }]]
    },
    {
      platformId: "xhs",
      range: "sheet_xhs!O8:O8",
      rows: [["需审核"]]
    }
  ]);
});
