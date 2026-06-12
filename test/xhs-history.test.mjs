import test from "node:test";
import assert from "node:assert/strict";

import {
  XHS_HISTORY_COLUMN_WIDTHS,
  XHS_HISTORY_HEADERS,
  XHS_HISTORY_SHEET_KEY,
  XHS_HISTORY_SHEET_TITLE,
  createPendingXhsHistoryItem,
  extractXhsHistoryItemsFromSeedRows,
  historyItemsToCsv,
  mapXhsHistoryItemToSheetRow,
  mergeXhsHistoryLedgerItems,
  replaceXhsHistorySheet,
  upsertXhsHistorySheet
} from "../src/xhs-history.mjs";

const INVEST_ACCOUNT_URL = "https://www.xiaohongshu.com/user/profile/690c95fe000000003002b7f4";
const NOTE_ID = "6a198e0c0000000036000f68";
const NOTE_URL = `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?source=webshare&xhsshare=pc_web&xsec_token=secret&xsec_source=pc_share`;

test("XHS history headers match the required sheet order", () => {
  assert.deepEqual(XHS_HISTORY_HEADERS, [
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
  assert.equal(XHS_HISTORY_SHEET_KEY, "xhsHistory");
  assert.equal(XHS_HISTORY_SHEET_TITLE, "小红书历史台账");
  assert.deepEqual(XHS_HISTORY_COLUMN_WIDTHS, [120, 220, 110, 80, 180, 560, 420, 360, 120, 120, 100, 160, 260, 100]);
});

test("extractXhsHistoryItemsFromSeedRows parses legacy XHS channel rows and maps account labels", () => {
  const items = extractXhsHistoryItemsFromSeedRows([
    ["2026目标  5个爆款/月"],
    ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "内容类型标签审核", "tag词"],
    ["", "0529 投稿视频", "", "", "", "", "", ""],
    ["1", "05 30", NOTE_URL, NOTE_ID, "投资号", "图文", "通过", "#同顺图解 #玩转同花顺"]
  ], {
    collectedAt: "2026-06-09T00:00:00.000Z",
    accountHomeUrlsByLabel: new Map([["投资号", INVEST_ACCOUNT_URL]]),
    accountNamesByLabel: new Map([["投资号", "同花顺投资"]])
  });

  assert.deepEqual(items, [
    {
      accountName: "同花顺投资",
      accountHomeUrl: INVEST_ACCOUNT_URL,
      publishedAt: "2026-05-29",
      itemType: "图文",
      itemId: NOTE_ID,
      itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
      title: "",
      tags: "#同顺图解 #玩转同花顺",
      contentType: "图文",
      contentTypeReview: "通过",
      collectStatus: "待补全",
      collectedAt: "2026-06-09T00:00:00.000Z",
      failureReason: "标题缺失",
      source: "feishu-seed"
    }
  ]);
});

test("extractXhsHistoryItemsFromSeedRows keeps titles from current 9-column XHS rows", () => {
  const items = extractXhsHistoryItemsFromSeedRows([
    ["编号", "投稿时间", "内容链接", "笔记ID", "标题", "账号", "内容类型", "内容类型标签审核", "tag词"],
    ["1", "05 30", NOTE_URL, NOTE_ID, "A 股全行业市值王座", "投资号", "图文", "通过", "#同顺盘点"]
  ], {
    accountNamesByLabel: new Map([["投资号", "同花顺投资"]])
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "A 股全行业市值王座");
  assert.equal(items[0].accountName, "同花顺投资");
});

test("extractXhsHistoryItemsFromSeedRows keeps titles from current 16-column XHS channel rows", () => {
  const items = extractXhsHistoryItemsFromSeedRows([
    ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "标题", "tag词", "一级类型", "二级类型", "内容类型标签审核", "AI内容判断备注"],
    ["1", "2026-05-29", NOTE_URL, NOTE_ID, "投资号", "图文", "是", "否", "张三", "已投放", "A 股全行业市值王座", "#同顺盘点", "图文", "行业盘点", "通过", "使用minimax"]
  ], {
    accountNamesByLabel: new Map([["投资号", "同花顺投资"]])
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "A 股全行业市值王座");
  assert.equal(items[0].tags, "#同顺盘点");
  assert.equal(items[0].contentType, "图文");
  assert.equal(items[0].contentTypeReview, "通过");
  assert.equal(items[0].accountName, "同花顺投资");
});

test("extractXhsHistoryItemsFromSeedRows marks incomplete seed rows as pending", () => {
  const items = extractXhsHistoryItemsFromSeedRows([
    ["编号", "投稿时间", "内容链接", "笔记ID", "标题", "账号", "内容类型", "内容类型标签审核", "tag词"],
    ["1", "05 30", NOTE_URL, NOTE_ID, "", "投资号", "", "", ""]
  ], {
    accountNamesByLabel: new Map([["投资号", "同花顺投资"]])
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].collectStatus, "待补全");
  assert.equal(items[0].failureReason, "标题缺失；tag缺失；内容类型缺失");
});

test("mergeXhsHistoryLedgerItems dedupes by note id and fills blank fields", () => {
  const merged = mergeXhsHistoryLedgerItems([
    {
      itemId: NOTE_ID,
      itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
      title: "",
      tags: "",
      collectStatus: "待补全",
      failureReason: "tag缺失"
    }
  ], [
    {
      itemId: NOTE_ID,
      itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
      title: "A 股全行业市值王座",
      tags: "#同顺盘点",
      contentType: "图文",
      contentTypeReview: "通过",
      collectStatus: "已采集",
      failureReason: "",
      source: "profile-state+detail"
    },
    {
      itemId: "6a2397a5000000002202bc73",
      itemUrl: "https://www.xiaohongshu.com/discovery/item/6a2397a5000000002202bc73",
      title: "新增"
    }
  ]);

  assert.deepEqual(merged.map((item) => ({
    itemId: item.itemId,
    title: item.title,
    tags: item.tags,
    contentType: item.contentType,
    collectStatus: item.collectStatus,
    failureReason: item.failureReason,
    source: item.source
  })), [
    {
      itemId: NOTE_ID,
      title: "A 股全行业市值王座",
      tags: "#同顺盘点",
      contentType: "图文",
      collectStatus: "已采集",
      failureReason: "",
      source: "profile-state+detail"
    },
    {
      itemId: "6a2397a5000000002202bc73",
      title: "新增",
      tags: undefined,
      contentType: undefined,
      collectStatus: undefined,
      failureReason: undefined,
      source: undefined
    }
  ]);
});

test("mergeXhsHistoryLedgerItems does not downgrade collected rows with incomplete seed rows", () => {
  const merged = mergeXhsHistoryLedgerItems([
    {
      itemId: NOTE_ID,
      itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
      title: "A 股全行业市值王座",
      tags: "#同顺盘点",
      contentType: "图文",
      collectStatus: "已采集",
      failureReason: "",
      source: "profile-state+detail"
    }
  ], [
    {
      itemId: NOTE_ID,
      itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
      title: "",
      tags: "",
      contentType: "",
      collectStatus: "待补全",
      failureReason: "标题缺失；tag缺失；内容类型缺失",
      source: "feishu-seed"
    }
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].collectStatus, "已采集");
  assert.equal(merged[0].failureReason, "");
  assert.equal(merged[0].source, "profile-state+detail");
});

test("mergeXhsHistoryLedgerItems normalizes stale collected rows with missing fields", () => {
  const merged = mergeXhsHistoryLedgerItems([
    {
      itemId: NOTE_ID,
      itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
      title: "",
      tags: "#同顺盘点",
      contentType: "图文",
      collectStatus: "已采集",
      failureReason: "",
      source: "feishu-seed"
    }
  ], []);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].collectStatus, "待补全");
  assert.equal(merged[0].failureReason, "标题缺失");
});

test("mapXhsHistoryItemToSheetRow writes content URL as a plain string", () => {
  const row = mapXhsHistoryItemToSheetRow({
    accountName: "同花顺投资",
    accountHomeUrl: INVEST_ACCOUNT_URL,
    publishedAt: "2026-05-29",
    itemType: "图文",
    itemId: NOTE_ID,
    itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
    title: "标题",
    tags: "#tag",
    contentType: "图文",
    contentTypeReview: "通过",
    collectStatus: "已采集",
    collectedAt: "2026-06-09T00:00:00.000Z",
    failureReason: "",
    source: "feishu-seed"
  });

  assert.equal(row[XHS_HISTORY_HEADERS.indexOf("作品链接")], `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`);
  assert.equal(typeof row[XHS_HISTORY_HEADERS.indexOf("作品链接")], "string");
});

test("createPendingXhsHistoryItem keeps profile inventory when detail enrichment is skipped", () => {
  const item = createPendingXhsHistoryItem({
    link: {
      id: NOTE_ID,
      exportUrl: NOTE_URL,
      title: "主页标题"
    },
    account: {
      name: "同花顺投资",
      url: INVEST_ACCOUNT_URL
    },
    collectedAt: "2026-06-09T00:00:00.000Z",
    failureReason: "详情补全达到上限",
    source: "profile-state"
  });

  assert.deepEqual({
    accountName: item.accountName,
    accountHomeUrl: item.accountHomeUrl,
    itemId: item.itemId,
    itemUrl: item.itemUrl,
    title: item.title,
    tags: item.tags,
    collectStatus: item.collectStatus,
    failureReason: item.failureReason,
    source: item.source
  }, {
    accountName: "同花顺投资",
    accountHomeUrl: INVEST_ACCOUNT_URL,
    itemId: NOTE_ID,
    itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
    title: "主页标题",
    tags: "",
    collectStatus: "待补全",
    failureReason: "详情补全达到上限",
    source: "profile-state"
  });
  assert.equal(item.publishedAt, "2026-05-29");
});

test("historyItemsToCsv exports the fixed XHS history header order", () => {
  const csv = historyItemsToCsv([
    {
      itemId: NOTE_ID,
      itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
      title: "标题"
    }
  ]);

  assert.equal(csv.split("\n")[0], XHS_HISTORY_HEADERS.join(","));
  assert.match(csv, new RegExp(`https://www\\.xiaohongshu\\.com/discovery/item/${NOTE_ID}`));
});

test("upsertXhsHistorySheet reuses a title-matched sheet and appends only new rows", async () => {
  const calls = [];
  const client = {
    config: { sheets: {} },
    async listSheets() {
      calls.push(["listSheets"]);
      return [{ properties: { sheet_id: "existingHistory", title: "小红书历史台账" } }];
    },
    async createSheet() {
      throw new Error("should not create sheet");
    },
    sheetId(sheetKey) {
      return this.config.sheets[sheetKey];
    },
    async readSheetRows(sheetKey, width) {
      calls.push(["readSheetRows", sheetKey, width]);
      return [
        XHS_HISTORY_HEADERS,
        [
          "同花顺投资",
          INVEST_ACCOUNT_URL,
          "2026-05-29",
          "图文",
          NOTE_ID,
          `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
          "旧标题",
          "#old",
          "图文",
          "通过",
          "已采集",
          "",
          "",
          "feishu-seed"
        ]
      ];
    },
    async writeRows(sheetKey, range, rows) {
      calls.push(["writeRows", sheetKey, range, rows]);
    },
    async appendRowsToSheet(sheetKey, rows, width) {
      calls.push(["appendRowsToSheet", sheetKey, rows, width]);
    },
    async freezeRows() {},
    async setRangeStyle() {},
    async setColumnWidths() {}
  };

  const result = await upsertXhsHistorySheet({
    client,
    items: [
      {
        accountName: "同花顺投资",
        itemId: NOTE_ID,
        itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
        title: "重复"
      },
      {
        accountName: "同花顺投资",
        itemId: "6a2397a5000000002202bc73",
        itemUrl: "https://www.xiaohongshu.com/discovery/item/6a2397a5000000002202bc73",
        title: "新增"
      }
    ]
  });

  assert.equal(client.config.sheets.xhsHistory, "existingHistory");
  assert.equal(result.createdSheetId, "");
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  const append = calls.find((call) => call[0] === "appendRowsToSheet");
  assert.equal(append[1], "xhsHistory");
  assert.equal(append[2][0][XHS_HISTORY_HEADERS.indexOf("作品ID")], "6a2397a5000000002202bc73");
  assert.equal(append[3], XHS_HISTORY_HEADERS.length);
});

test("replaceXhsHistorySheet rewrites the whole XHS history sheet", async () => {
  const calls = [];
  const client = {
    config: { sheets: { xhsHistory: "historySheet" } },
    async listSheets() {
      return [{ properties: { sheet_id: "historySheet", title: "小红书历史台账" } }];
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

  const result = await replaceXhsHistorySheet({
    client,
    sheetId: "historySheet",
    items: [
      {
        accountName: "同花顺投资",
        itemId: NOTE_ID,
        itemUrl: `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}`,
        publishedAt: "2026-05-29",
        title: "保留"
      }
    ]
  });

  assert.equal(result.created, 1);
  const replaceCall = calls.find((call) => call[0] === "replaceSheetRows");
  assert.equal(replaceCall[1], "xhsHistory");
  assert.equal(replaceCall[2][0], XHS_HISTORY_HEADERS);
  assert.equal(replaceCall[2][1][XHS_HISTORY_HEADERS.indexOf("作品ID")], NOTE_ID);
  assert.equal(replaceCall[3], XHS_HISTORY_HEADERS.length);
});
