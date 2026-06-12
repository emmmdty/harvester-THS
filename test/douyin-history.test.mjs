import test from "node:test";
import assert from "node:assert/strict";

import {
  DOUYIN_HISTORY_HEADERS,
  buildPostApiCursorUrl,
  createHistoryAccountAudit,
  cursorPaginationStopReason,
  extractHistoryItemsFromPostResponse,
  extractPostPageInfo,
  filterHistoryItemsForAccount,
  historyItemsToCsv,
  mergeHistoryLedgerItems,
  mapHistoryItemToSheetRow,
  replaceHistorySheet,
  updateHistoryAccountAudit,
  upsertHistorySheet
} from "../src/douyin-history.mjs";

test("extractHistoryItemsFromPostResponse maps Douyin post API items to history records", () => {
  const response = {
    aweme_list: [
      {
        aweme_id: "7646703866871844139",
        aweme_type: 68,
        desc: "前 5 月 A 股最赚钱和最亏钱的行业都在这了！你踩中了哪个 #同顺图解 #同顺盘点 #玩转同花顺",
        caption: " #同顺图解 #同顺盘点 #玩转同花顺",
        create_time: Date.parse("2026-06-02T15:56:29+08:00") / 1000,
        author: {
          sec_uid: "MS4wLjABAAAArf6v6Z48Pma-bIrz00wVCu76ioePN0vKzHAM_w9DN8AOkLekEk13Ay8_L-74BBB8",
          nickname: "同花顺投资"
        },
        text_extra: [
          { hashtag_name: "同顺图解" },
          { hashtag_name: "同顺盘点" },
          { hashtag_name: "玩转同花顺" }
        ],
        video_tag: [
          { tag_name: "财经" }
        ]
      }
    ]
  };

  const records = extractHistoryItemsFromPostResponse(response, {
    accountName: "同花顺投资",
    accountHomeUrl: "https://www.douyin.com/user/source-account"
  });

  assert.deepEqual(records, [
    {
      accountName: "同花顺投资",
      accountHomeUrl: "https://www.douyin.com/user/source-account",
      actualAuthorName: "同花顺投资",
      authorProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAArf6v6Z48Pma-bIrz00wVCu76ioePN0vKzHAM_w9DN8AOkLekEk13Ay8_L-74BBB8",
      publishedAt: "2026-06-02",
      itemType: "图文",
      itemId: "7646703866871844139",
      itemUrl: "https://www.douyin.com/note/7646703866871844139",
      title: "前 5 月 A 股最赚钱和最亏钱的行业都在这了！你踩中了哪个",
      tags: "#同顺图解 #同顺盘点 #玩转同花顺",
      contentType: "图文",
      contentTypeReview: "通过",
      collectStatus: "已采集",
      failureReason: "",
      source: "aweme-post"
    }
  ]);
});

test("extractPostPageInfo parses Douyin cursor pagination metadata", () => {
  const info = extractPostPageInfo({
    has_more: 1,
    max_cursor: 1700000000000,
    aweme_count: "3120",
    aweme_list: [{ aweme_id: "1" }, { aweme_id: "2" }]
  });

  assert.deepEqual(info, {
    hasMore: true,
    maxCursor: "1700000000000",
    expected: 3120,
    itemCount: 2
  });

  assert.deepEqual(extractPostPageInfo({
    hasMore: false,
    maxCursor: "0",
    aweme_count: 0,
    aweme_list: []
  }), {
    hasMore: false,
    maxCursor: "0",
    expected: null,
    itemCount: 0
  });
});

test("buildPostApiCursorUrl updates cursor parameters while preserving account query", () => {
  const nextUrl = buildPostApiCursorUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=abc&max_cursor=0&count=18&a_bogus=old",
    { cursor: "1700000000000", count: 30 }
  );
  const url = new URL(nextUrl);

  assert.equal(url.searchParams.get("sec_user_id"), "abc");
  assert.equal(url.searchParams.get("max_cursor"), "1700000000000");
  assert.equal(url.searchParams.get("cursor"), "1700000000000");
  assert.equal(url.searchParams.get("count"), "30");
  assert.equal(url.searchParams.has("a_bogus"), false);
});

test("cursorPaginationStopReason stops only on configured hard limits", () => {
  assert.equal(cursorPaginationStopReason({
    pageInfo: { hasMore: true, maxCursor: "1" },
    pages: 1,
    maxPages: 300,
    emptyPages: 0,
    emptyPagesLimit: 3,
    collected: 10,
    itemLimit: 0
  }), "");

  assert.equal(cursorPaginationStopReason({
    pageInfo: { hasMore: false, maxCursor: "0" },
    pages: 4,
    maxPages: 300,
    emptyPages: 0,
    emptyPagesLimit: 3,
    collected: 100,
    itemLimit: 0
  }), "has-more-false");

  assert.equal(cursorPaginationStopReason({
    pageInfo: { hasMore: true, maxCursor: "5" },
    pages: 300,
    maxPages: 300,
    emptyPages: 0,
    emptyPagesLimit: 3,
    collected: 100,
    itemLimit: 0
  }), "max-pages");

  assert.equal(cursorPaginationStopReason({
    pageInfo: { hasMore: true, maxCursor: "5" },
    pages: 10,
    maxPages: 300,
    emptyPages: 3,
    emptyPagesLimit: 3,
    collected: 100,
    itemLimit: 0
  }), "empty-pages");

  assert.equal(cursorPaginationStopReason({
    pageInfo: { hasMore: true, maxCursor: "5" },
    pages: 10,
    maxPages: 300,
    emptyPages: 0,
    emptyPagesLimit: 3,
    collected: 20,
    itemLimit: 20
  }), "item-limit");
});

test("history account audit records expected counts, cursor pages, and stop status", () => {
  const audit = createHistoryAccountAudit({
    account: { name: "同花顺投资", url: "https://www.douyin.com/user/account" },
    expected: 3120
  });

  updateHistoryAccountAudit(audit, {
    source: "cursor-api",
    pageInfo: { hasMore: false, maxCursor: "0" },
    added: 18,
    collected: 3120,
    stopReason: "has-more-false"
  });

  assert.deepEqual(audit, {
    accountName: "同花顺投资",
    accountHomeUrl: "https://www.douyin.com/user/account",
    expected: 3120,
    collected: 3120,
    pages: 1,
    emptyPages: 0,
    hasMoreStopped: true,
    stopReason: "has-more-false",
    failureReason: "",
    source: "cursor-api",
    lastCursor: "0"
  });
});

test("history extraction keeps configured account name when Douyin nickname differs", () => {
  const records = extractHistoryItemsFromPostResponse({
    aweme_list: [
      {
        aweme_id: "7504969091573108007",
        desc: "第一视角带你走近巴菲特的生平往事 #巴菲特",
        create_time: Date.parse("2026-05-16T10:00:00+08:00") / 1000,
        author: {
          sec_uid: "MS4wLjABAAAAzuAZbgu03QhyuhKxMJGwrG0pnvDNfstYkT5ZCNGD-0U",
          nickname: "同顺股民社区"
        },
        text_extra: [{ hashtag_name: "巴菲特" }]
      }
    ]
  }, {
    accountName: "同花顺股民社区",
    accountHomeUrl: "https://www.douyin.com/user/MS4wLjABAAAAzuAZbgu03QhyuhKxMJGwrG0pnvDNfstYkT5ZCNGD-0U"
  });

  assert.equal(records[0].accountName, "同花顺股民社区");
  assert.equal(records[0].actualAuthorName, "同顺股民社区");
  assert.equal(records[0].authorProfileUrl, "https://www.douyin.com/user/MS4wLjABAAAAzuAZbgu03QhyuhKxMJGwrG0pnvDNfstYkT5ZCNGD-0U");
});

test("filterHistoryItemsForAccount excludes post-list items from other Douyin authors", () => {
  const expectedAccount = {
    name: "同花顺期货通",
    url: "https://www.douyin.com/user/MS4wLjABAAAAxr3bk2-4lsUB0XOErXDXFKIocqd2wOExCTAuRwQ19Vg"
  };
  const items = [
    {
      accountName: "同花顺期货通",
      actualAuthorName: "同花顺期货通",
      accountHomeUrl: expectedAccount.url,
      authorProfileUrl: expectedAccount.url,
      itemId: "1",
      itemUrl: "https://www.douyin.com/video/1",
      source: "aweme-post"
    },
    {
      accountName: "同花顺期货通",
      actualAuthorName: "同花顺大宗商品",
      accountHomeUrl: expectedAccount.url,
      authorProfileUrl: "https://www.douyin.com/user/other-author",
      itemId: "2",
      itemUrl: "https://www.douyin.com/video/2",
      source: "aweme-post"
    },
    {
      accountName: "同花顺期货通",
      accountHomeUrl: expectedAccount.url,
      authorProfileUrl: "",
      itemId: "3",
      itemUrl: "https://www.douyin.com/video/3",
      source: "visible-link"
    }
  ];

  const result = filterHistoryItemsForAccount(items, expectedAccount, { requireAuthor: true });

  assert.deepEqual(result.accepted.map((item) => item.itemId), ["1"]);
  assert.deepEqual(result.excluded.map((item) => ({
    itemId: item.itemId,
    exclusionReason: item.exclusionReason
  })), [
    { itemId: "2", exclusionReason: "作者主页不匹配" },
    { itemId: "3", exclusionReason: "作者主页缺失" }
  ]);
});

test("mergeHistoryLedgerItems dedupes by item id and fills previously empty fields", () => {
  const existing = [
    {
      itemId: "1",
      itemUrl: "https://www.douyin.com/video/1",
      title: "",
      tags: "",
      collectStatus: "待补全"
    }
  ];
  const incoming = [
    {
      itemId: "1",
      itemUrl: "https://www.douyin.com/video/1",
      title: "新标题",
      tags: "#tag",
      collectStatus: "已采集"
    },
    {
      itemId: "2",
      itemUrl: "https://www.douyin.com/note/2",
      title: "图文",
      tags: "#图文"
    }
  ];

  assert.deepEqual(mergeHistoryLedgerItems(existing, incoming).map((item) => ({
    itemId: item.itemId,
    title: item.title,
    tags: item.tags,
    collectStatus: item.collectStatus
  })), [
    { itemId: "1", title: "新标题", tags: "#tag", collectStatus: "已采集" },
    { itemId: "2", title: "图文", tags: "#图文", collectStatus: undefined }
  ]);
});

test("mapHistoryItemToSheetRow writes content URL as a plain string", () => {
  const row = mapHistoryItemToSheetRow({
    accountName: "同花顺投资",
    accountHomeUrl: "https://www.douyin.com/user/a",
    publishedAt: "2026-06-02",
    itemType: "图文",
    itemId: "7646703866871844139",
    itemUrl: "https://www.douyin.com/note/7646703866871844139",
    title: "标题",
    tags: "#tag",
    contentType: "图文",
    contentTypeReview: "通过",
    collectStatus: "已采集",
    collectedAt: "2026-06-08T00:00:00.000Z",
    failureReason: "",
    source: "aweme-post"
  });

  assert.equal(row[DOUYIN_HISTORY_HEADERS.indexOf("作品链接")], "https://www.douyin.com/note/7646703866871844139");
  assert.equal(typeof row[DOUYIN_HISTORY_HEADERS.indexOf("作品链接")], "string");
});

test("historyItemsToCsv exports the fixed history header order", () => {
  const csv = historyItemsToCsv([
    {
      accountName: "同花顺投资",
      itemUrl: "https://www.douyin.com/video/1",
      title: "标题",
      tags: "#tag"
    }
  ]);

  assert.equal(csv.split("\n")[0], DOUYIN_HISTORY_HEADERS.join(","));
  assert.match(csv, /https:\/\/www\.douyin\.com\/video\/1/);
});

test("upsertHistorySheet creates the sheet, writes headers, and appends only new plain-url rows", async () => {
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
        DOUYIN_HISTORY_HEADERS,
        [
          "同花顺投资",
          "",
          "",
          "视频",
          "1",
          "https://www.douyin.com/video/1",
          "旧标题",
          "#old",
          "",
          "",
          "已采集",
          "",
          "",
          "aweme-post"
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

  const result = await upsertHistorySheet({
    client,
    sheetId: "",
    items: [
      {
        accountName: "同花顺投资",
        itemId: "1",
        itemUrl: "https://www.douyin.com/video/1",
        title: "重复",
        tags: "#tag"
      },
      {
        accountName: "同花顺投资",
        itemId: "2",
        itemUrl: "https://www.douyin.com/note/2",
        title: "新增",
        tags: "#tag"
      }
    ]
  });

  assert.equal(result.createdSheetId, "historySheet");
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  const append = calls.find((call) => call[0] === "appendRowsToSheet");
  assert.equal(append[1], "douyinHistory");
  assert.equal(append[2][0][DOUYIN_HISTORY_HEADERS.indexOf("作品链接")], "https://www.douyin.com/note/2");
});

test("upsertHistorySheet reuses a title-matched existing history sheet without reporting creation", async () => {
  const client = {
    config: { sheets: {} },
    async listSheets() {
      return [{ properties: { sheet_id: "existingHistory", title: "抖音历史台账" } }];
    },
    async createSheet() {
      throw new Error("should not create sheet");
    },
    sheetId(sheetKey) {
      return this.config.sheets[sheetKey];
    },
    async readSheetRows() {
      return [DOUYIN_HISTORY_HEADERS];
    },
    async writeRows() {},
    async appendRowsToSheet() {},
    async setRangeStyle() {},
    async freezeRows() {},
    async setColumnWidths() {}
  };

  const result = await upsertHistorySheet({
    client,
    sheetId: "",
    items: []
  });

  assert.equal(client.config.sheets.douyinHistory, "existingHistory");
  assert.equal(result.createdSheetId, "");
});

test("upsertHistorySheet fills blank fields on existing rows without appending duplicates", async () => {
  const calls = [];
  const existingRow = [
    "同花顺投资",
    "https://www.douyin.com/user/a",
    "",
    "视频",
    "1",
    "https://www.douyin.com/video/1",
    "",
    "",
    "",
    "",
    "待补全",
    "",
    "tag缺失",
    "aweme-post"
  ];
  const client = {
    config: { sheets: { douyinHistory: "historySheet" } },
    async listSheets() {
      return [{ properties: { sheet_id: "historySheet", title: "抖音历史台账" } }];
    },
    sheetId(sheetKey) {
      return this.config.sheets[sheetKey];
    },
    async readSheetRows() {
      return [DOUYIN_HISTORY_HEADERS, existingRow];
    },
    async writeRows(sheetKey, range, rows) {
      calls.push(["writeRows", sheetKey, range, rows]);
    },
    async appendRowsToSheet(sheetKey, rows) {
      calls.push(["appendRowsToSheet", sheetKey, rows]);
    },
    async freezeRows() {},
    async setRangeStyle() {},
    async setColumnWidths() {}
  };

  const result = await upsertHistorySheet({
    client,
    items: [
      {
        accountName: "同花顺投资",
        accountHomeUrl: "https://www.douyin.com/user/a",
        publishedAt: "2026-06-02",
        itemType: "视频",
        itemId: "1",
        itemUrl: "https://www.douyin.com/video/1",
        title: "补全标题",
        tags: "#同花顺资讯",
        contentType: "资讯",
        contentTypeReview: "通过",
        collectStatus: "已采集",
        collectedAt: "2026-06-08T00:00:00.000Z",
        failureReason: "",
        source: "aweme-post"
      }
    ]
  });

  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(calls.some((call) => call[0] === "appendRowsToSheet"), false);
  const rowUpdate = calls.find((call) => call[0] === "writeRows" && call[2] === "historySheet!A2:N2");
  assert.ok(rowUpdate);
  assert.equal(rowUpdate[3][0][DOUYIN_HISTORY_HEADERS.indexOf("标题")], "补全标题");
  assert.equal(rowUpdate[3][0][DOUYIN_HISTORY_HEADERS.indexOf("tag词")], "#同花顺资讯");
  assert.equal(rowUpdate[3][0][DOUYIN_HISTORY_HEADERS.indexOf("采集状态")], "已采集");
  assert.equal(rowUpdate[3][0][DOUYIN_HISTORY_HEADERS.indexOf("失败原因")], "");
});

test("replaceHistorySheet rewrites the whole history sheet and clears stale rows", async () => {
  const calls = [];
  const client = {
    config: { sheets: { douyinHistory: "historySheet" } },
    async listSheets() {
      calls.push(["listSheets"]);
      return [{ properties: { sheet_id: "historySheet", title: "抖音历史台账" } }];
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

  const result = await replaceHistorySheet({
    client,
    sheetId: "historySheet",
    items: [
      {
        accountName: "同花顺投资",
        itemId: "1",
        itemUrl: "https://www.douyin.com/video/1",
        title: "保留",
        tags: "#tag"
      }
    ]
  });

  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  const replaceCall = calls.find((call) => call[0] === "replaceSheetRows");
  assert.equal(replaceCall[1], "douyinHistory");
  assert.equal(replaceCall[2][0], DOUYIN_HISTORY_HEADERS);
  assert.equal(replaceCall[2][1][DOUYIN_HISTORY_HEADERS.indexOf("作品链接")], "https://www.douyin.com/video/1");
  assert.equal(replaceCall[3], DOUYIN_HISTORY_HEADERS.length);
});
