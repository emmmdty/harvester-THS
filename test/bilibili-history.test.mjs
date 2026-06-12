import test from "node:test";
import assert from "node:assert/strict";

import {
  BILIBILI_HISTORY_COLUMN_WIDTHS,
  BILIBILI_HISTORY_HEADERS,
  BILIBILI_HISTORY_SHEET_KEY,
  BILIBILI_HISTORY_SHEET_TITLE,
  buildBilibiliHistoryVideoUrl,
  extractBilibiliHistoryItemsFromArcSearch,
  historyItemsToCsv,
  mapBilibiliHistoryItemToSheetRow,
  mergeBilibiliHistoryLedgerItems,
  replaceBilibiliHistorySheet,
  sortBilibiliHistoryItems,
  upsertBilibiliHistorySheet
} from "../src/bilibili-history.mjs";

test("Bilibili history headers match the required sheet order", () => {
  assert.deepEqual(BILIBILI_HISTORY_HEADERS, [
    "账号名称",
    "账号主页",
    "发布时间",
    "作品类型",
    "作品ID",
    "作品链接",
    "标题",
    "tag词",
    "内容类型",
    "内容类型标签审核",
    "采集状态",
    "采集时间",
    "失败原因",
    "来源"
  ]);
  assert.equal(BILIBILI_HISTORY_SHEET_KEY, "bilibiliHistory");
  assert.equal(BILIBILI_HISTORY_SHEET_TITLE, "B站历史台账");
  assert.deepEqual(BILIBILI_HISTORY_COLUMN_WIDTHS, [120, 220, 110, 80, 150, 560, 420, 360, 120, 120, 100, 160, 260, 100]);
});

test("buildBilibiliHistoryVideoUrl returns a space-card style URL with BVID", () => {
  assert.equal(
    buildBilibiliHistoryVideoUrl("BV1dFV66rELa"),
    "https://www.bilibili.com/video/BV1dFV66rELa/?spm_id_from=333.1387.upload.video_card.click"
  );
});

test("extractBilibiliHistoryItemsFromArcSearch maps and dedupes arc-search videos", () => {
  const payload = {
    data: {
      page: { count: 1011, pn: 1, ps: 40 },
      list: {
        vlist: [
          {
            bvid: "BV1dFV66rELa",
            title: "主力如何通过流动性真空，扫掉散户的止损挂单！",
            created: Date.parse("2026-06-05T08:00:00+08:00") / 1000,
            tag: "投资,股市"
          },
          {
            bvid: "BV1dFV66rELa",
            title: "重复",
            created: Date.parse("2026-06-05T08:00:00+08:00") / 1000
          }
        ]
      }
    }
  };

  const result = extractBilibiliHistoryItemsFromArcSearch(payload, {
    accountName: "同花顺投资",
    accountHomeUrl: "https://space.bilibili.com/1622777305/video",
    collectedAt: "2026-06-08T00:00:00.000Z"
  });

  assert.equal(result.totalCount, 1011);
  assert.equal(result.pageNumber, 1);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    accountName: "同花顺投资",
    accountHomeUrl: "https://space.bilibili.com/1622777305/video",
    publishedAt: "2026-06-05",
    itemType: "视频",
    itemId: "BV1dFV66rELa",
    itemUrl: "https://www.bilibili.com/video/BV1dFV66rELa/?spm_id_from=333.1387.upload.video_card.click",
    title: "主力如何通过流动性真空，扫掉散户的止损挂单！",
    tags: "#投资 #股市",
    contentType: "无",
    contentTypeReview: "需审核",
    collectStatus: "已采集",
    collectedAt: "2026-06-08T00:00:00.000Z",
    failureReason: "",
    source: "space-wbi-arc-search"
  });
});

test("mapBilibiliHistoryItemToSheetRow writes content URL as a plain string", () => {
  const row = mapBilibiliHistoryItemToSheetRow({
    accountName: "同花顺投资",
    accountHomeUrl: "https://space.bilibili.com/1622777305/video",
    publishedAt: "2026-06-05",
    itemType: "视频",
    itemId: "BV1dFV66rELa",
    itemUrl: "https://www.bilibili.com/video/BV1dFV66rELa/?spm_id_from=333.1387.upload.video_card.click",
    title: "标题",
    tags: "#tag",
    contentType: "无",
    contentTypeReview: "需审核",
    collectStatus: "已采集",
    collectedAt: "2026-06-08T00:00:00.000Z",
    failureReason: "",
    source: "space-wbi-arc-search"
  });

  assert.equal(row[BILIBILI_HISTORY_HEADERS.indexOf("账号名称")], "同花顺投资");
  assert.equal(row[BILIBILI_HISTORY_HEADERS.indexOf("作品链接")], "https://www.bilibili.com/video/BV1dFV66rELa/?spm_id_from=333.1387.upload.video_card.click");
  assert.equal(typeof row[BILIBILI_HISTORY_HEADERS.indexOf("作品链接")], "string");
});

test("sortBilibiliHistoryItems orders newer publish dates first", () => {
  const sorted = sortBilibiliHistoryItems([
    { itemId: "BV-old", publishedAt: "2021-01-26" },
    { itemId: "BV-new", publishedAt: "2026-06-05" },
    { itemId: "BV-mid", publishedAt: "2025-12-31" }
  ]);

  assert.deepEqual(sorted.map((item) => item.itemId), ["BV-new", "BV-mid", "BV-old"]);
});

test("sortBilibiliHistoryItems puts blank publish dates after dated rows", () => {
  const sorted = sortBilibiliHistoryItems([
    { itemId: "BV-blank", publishedAt: "" },
    { itemId: "BV-new", publishedAt: "2026-06-05" }
  ]);

  assert.deepEqual(sorted.map((item) => item.itemId), ["BV-new", "BV-blank"]);
});

test("mergeBilibiliHistoryLedgerItems dedupes by BVID and fills blank fields", () => {
  const merged = mergeBilibiliHistoryLedgerItems([
    {
      itemId: "BV1",
      itemUrl: "https://www.bilibili.com/video/BV1/?spm_id_from=333.1387.upload.video_card.click",
      title: "",
      collectStatus: "待补全"
    }
  ], [
    {
      itemId: "BV1",
      itemUrl: "https://www.bilibili.com/video/BV1/?spm_id_from=333.1387.upload.video_card.click",
      title: "补全",
      tags: "#tag",
      collectStatus: "已采集",
      source: "space-wbi-arc-search+detail"
    },
    {
      itemId: "BV2",
      itemUrl: "https://www.bilibili.com/video/BV2/?spm_id_from=333.1387.upload.video_card.click",
      title: "新增"
    }
  ]);

  assert.deepEqual(merged.map((item) => ({
    itemId: item.itemId,
    title: item.title,
    tags: item.tags,
    collectStatus: item.collectStatus,
    source: item.source
  })), [
    { itemId: "BV1", title: "补全", tags: "#tag", collectStatus: "已采集", source: "space-wbi-arc-search+detail" },
    { itemId: "BV2", title: "新增", tags: undefined, collectStatus: undefined, source: undefined }
  ]);
});

test("historyItemsToCsv exports the fixed Bilibili history header order", () => {
  const csv = historyItemsToCsv([
    {
      itemId: "BV1",
      itemUrl: "https://www.bilibili.com/video/BV1/?spm_id_from=333.1387.upload.video_card.click",
      title: "标题"
    }
  ]);

  assert.equal(csv.split("\n")[0], BILIBILI_HISTORY_HEADERS.join(","));
  assert.match(csv, /https:\/\/www\.bilibili\.com\/video\/BV1\/\?spm_id_from=333\.1387\.upload\.video_card\.click/);
});

test("upsertBilibiliHistorySheet creates B站历史台账 and appends only new plain-url rows", async () => {
  const calls = [];
  const client = {
    config: { sheets: {} },
    async listSheets() {
      calls.push(["listSheets"]);
      return [];
    },
    async createSheet(title) {
      calls.push(["createSheet", title]);
      return { sheetId: "historySheet" };
    },
    sheetId(sheetKey) {
      return this.config.sheets[sheetKey];
    },
    async readSheetRows(sheetKey, width) {
      calls.push(["readSheetRows", sheetKey, width]);
      return [
        BILIBILI_HISTORY_HEADERS,
        [
          "同花顺投资",
          "https://space.bilibili.com/1622777305/video",
          "2026-06-05",
          "视频",
          "BV1",
          "https://www.bilibili.com/video/BV1/?spm_id_from=333.1387.upload.video_card.click",
          "旧标题",
          "#old",
          "",
          "",
          "已采集",
          "",
          "",
          "space-wbi-arc-search"
        ]
      ];
    },
    async writeRows(sheetKey, range, rows) {
      calls.push(["writeRows", sheetKey, range, rows]);
    },
    async appendRowsToSheet(sheetKey, rows, width) {
      calls.push(["appendRowsToSheet", sheetKey, rows, width]);
    },
    async setRangeStyle(range, style) {
      calls.push(["setRangeStyle", range, style]);
    },
    async freezeRows(sheetKey, count) {
      calls.push(["freezeRows", sheetKey, count]);
    },
    async setColumnWidths(sheetKey, widths) {
      calls.push(["setColumnWidths", sheetKey, widths]);
    }
  };

  const result = await upsertBilibiliHistorySheet({
    client,
    sheetId: "",
    items: [
      {
        accountName: "同花顺投资",
        itemId: "BV1",
        itemUrl: "https://www.bilibili.com/video/BV1/?spm_id_from=333.1387.upload.video_card.click",
        title: "重复"
      },
      {
        accountName: "同花顺投资",
        itemId: "BV2",
        itemUrl: "https://www.bilibili.com/video/BV2/?spm_id_from=333.1387.upload.video_card.click",
        title: "新增"
      }
    ]
  });

  assert.equal(result.createdSheetId, "historySheet");
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(calls.find((call) => call[0] === "createSheet"), ["createSheet", "B站历史台账"]);
  const append = calls.find((call) => call[0] === "appendRowsToSheet");
  assert.equal(append[1], "bilibiliHistory");
  assert.equal(append[2][0][BILIBILI_HISTORY_HEADERS.indexOf("账号名称")], "同花顺投资");
  assert.equal(append[2][0][BILIBILI_HISTORY_HEADERS.indexOf("作品链接")], "https://www.bilibili.com/video/BV2/?spm_id_from=333.1387.upload.video_card.click");
  assert.equal(append[3], BILIBILI_HISTORY_HEADERS.length);
});

test("replaceBilibiliHistorySheet rewrites the whole Bilibili history sheet", async () => {
  const calls = [];
  const client = {
    config: { sheets: { bilibiliHistory: "historySheet" } },
    async listSheets() {
      calls.push(["listSheets"]);
      return [{ properties: { sheet_id: "historySheet", title: "B站历史台账" } }];
    },
    sheetId(sheetKey) {
      return this.config.sheets[sheetKey];
    },
    async writeRows(sheetKey, range, rows) {
      calls.push(["writeRows", sheetKey, range, rows]);
    },
    async replaceSheetRows(sheetKey, rows, width) {
      calls.push(["replaceSheetRows", sheetKey, rows, width]);
    },
    async freezeRows() {},
    async setRangeStyle() {},
    async setColumnWidths() {}
  };

  const result = await replaceBilibiliHistorySheet({
    client,
    sheetId: "historySheet",
    items: [
      {
        accountName: "同花顺投资",
        itemId: "BV1",
        itemUrl: "https://www.bilibili.com/video/BV1/?spm_id_from=333.1387.upload.video_card.click",
        publishedAt: "2025-01-01",
        title: "保留"
      },
      {
        accountName: "同花顺投资",
        itemId: "BV2",
        itemUrl: "https://www.bilibili.com/video/BV2/?spm_id_from=333.1387.upload.video_card.click",
        publishedAt: "2026-06-05",
        title: "最新"
      }
    ]
  });

  assert.equal(result.created, 2);
  const replaceCall = calls.find((call) => call[0] === "replaceSheetRows");
  assert.equal(replaceCall[1], "bilibiliHistory");
  assert.equal(replaceCall[2][0], BILIBILI_HISTORY_HEADERS);
  assert.equal(replaceCall[2][1][BILIBILI_HISTORY_HEADERS.indexOf("作品ID")], "BV2");
  assert.equal(replaceCall[2][1][BILIBILI_HISTORY_HEADERS.indexOf("账号名称")], "同花顺投资");
  assert.equal(replaceCall[2][1][BILIBILI_HISTORY_HEADERS.indexOf("作品链接")], "https://www.bilibili.com/video/BV2/?spm_id_from=333.1387.upload.video_card.click");
  assert.equal(replaceCall[3], BILIBILI_HISTORY_HEADERS.length);
});
