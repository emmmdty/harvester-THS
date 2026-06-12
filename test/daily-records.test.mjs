import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addDaysToDateString,
  endExclusiveDateToInclusiveUntilDate,
  enumerateDateStrings,
  enumerateHalfOpenDateStrings,
  formatBatchTitle,
  formatDisplayDate,
  normalizeDateInput,
  parsePublishedDateText,
  previousDateString
} from "../src/date-utils.mjs";
import {
  BILIBILI_CONTENT_TYPE_DROPDOWN_VALUES,
  buildDailySheetRecords,
  buildFeishuUrlCell,
  CONTENT_TYPE_DROPDOWN_VALUES,
  DOUYIN_ACCOUNT_DROPDOWN_VALUES,
  extractFeishuCellLink,
  filterNewDailySheetRecords,
  mapDailyRecordToFeishuFields,
  mapDailyRecordToSheetRow,
  normalizeAccountLabel,
  PLATFORM_SHEET_LAYOUTS,
  PLATFORM_HEADERS,
  rowToFields,
  XHS_ACCOUNT_DROPDOWN_VALUES
} from "../src/daily-records.mjs";
import { FeishuSheetsClient, loadFeishuConfig, validateFeishuConfig, writeDailyPlatformRecords } from "../src/feishu-sheets.mjs";
import { applyFeishuSubmissionTemplate } from "../src/feishu-template.mjs";
import { writePlatformJsonToFeishu } from "../src/feishu-writer.mjs";
import { buildXhsExploreUrl, canonicalizeContentLink, extractBilibiliBv, extractXhsNoteId } from "../src/link-utils.mjs";
import { classifyLoginProbe, summarizeLoginCheckResults } from "../src/login-check.mjs";
import { spreadsheetSafeText } from "../src/spreadsheet-safe.mjs";
import { classifyTags } from "../src/tag-rules.mjs";

const PLATFORM_XHS_HEADER = ["编号", "投稿时间", "内容链接", "笔记ID", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "标题", "tag词", "一级类型", "二级类型", "内容类型标签审核", "AI内容判断备注"];
const PLATFORM_DOUYIN_HEADER = ["编号", "投稿时间", "内容链接", "账号", "内容类型", "是否投放成功", "是否为爆款", "供稿人", "备注", "作品ID", "作品类型", "标题", "tag词", "一级类型", "二级类型", "内容类型标签审核", "AI内容判断备注"];
const STEP15_FILTERED_HEADER = ["编号", "投稿时间", "内容链接", "账号", "内容类型", "简短理由", "是否投放成功", "是否为爆款", "供稿人", "备注"];
const PLATFORM_BILIBILI_HEADER = ["编号", "投稿时间", "内容链接", "短链id", "是否投放成功", "是否为爆款", "供稿人", "备注", "账号", "作品类型", "标题", "tag词", "内容类型", "内容类型标签审核", "AI内容判断备注"];
const EXPECTED_DOUYIN_CONTENT_TYPES = [
  "资讯",
  "财商动画",
  "励志语录",
  "问财问句",
  "盘点",
  "股友说",
  "社区话题",
  "说唱",
  "长视频",
  "理财内容",
  "大佬采访",
  "图文",
  "AI虚拟人",
  "无"
];
const EXPECTED_XHS_CONTENT_TYPES = [
  "资讯",
  "财商动画",
  "励志语录",
  "问财问句",
  "盘点",
  "股友说",
  "社区话题",
  "说唱",
  "大佬采访",
  "长视频",
  "理财内容",
  "常老师",
  "图文",
  "AI视频 虚拟人",
  "段子"
];
const EXPECTED_BILIBILI_CONTENT_TYPES = [
  "采访内容",
  "大佬生平",
  "新手教学指标教学",
  "海外搬运",
  "短视频",
  "无"
];

function urlCell(link) {
  return { type: "url", text: link, link };
}

function assertFieldsInclude(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, key);
  }
}

async function assertNewDateInsertRow({ platformId, targetDate, existingDate, expectedStartRow }) {
  const calls = [];
  const client = {
    async readRows(readPlatformId) {
      calls.push(["readRows", readPlatformId]);
      return existingRowsForDate(platformId, existingDate);
    },
    async prependRows(writePlatformId, rows, startRow) {
      calls.push(["prependRows", writePlatformId, rows, startRow]);
      return {
        updates: {
          updatedRange: `${writePlatformId}!A${startRow}:Z${startRow + rows.length - 1}`
        }
      };
    }
  };

  await writeDailyPlatformRecords({
    platformId,
    targetDate,
    items: [itemForPlatform(platformId, targetDate)],
    client
  });

  assert.equal(calls[1][0], "prependRows");
  assert.equal(calls[1][1], platformId);
  assert.equal(calls[1][3], expectedStartRow);
}

function existingRowsForDate(platformId, date) {
  return [
    separatorRow(platformId, formatBatchTitle(date)),
    existingMaterialRow(platformId, date)
  ];
}

function separatorRow(platformId, title) {
  const row = Array(PLATFORM_HEADERS[platformId].length).fill("");
  row[1] = title;
  return row;
}

function existingMaterialRow(platformId, date) {
  const displayDate = formatDisplayDate(date);
  if (platformId === "xhs") return ["1", displayDate, `${platformId}-old-link`, `${platformId}-old-id`, "投资号", "图文", "", "", "", "", "旧标题", "", "#old"];
  if (platformId === "bilibili") return ["1", displayDate, `${platformId}-old-link`, "BVold", "投资号", "旧标题", "#old"];
  return ["1", displayDate, `${platformId}-old-link`, "投资号", "资讯", "旧标题", "#tag"];
}

function itemForPlatform(platformId, date) {
  if (platformId === "xhs") {
    return {
      link: `${platformId}-${date}-new-link`,
      id: `${platformId}-${date}-new-id`,
      accountName: "同花顺投资",
      contentType: "图文",
      tags: "#tag",
      publishedAt: date
    };
  }
  if (platformId === "bilibili") {
    return {
      link: `${platformId}-${date}-new-link`,
      id: "BVnew",
      accountName: "同花顺投资",
      title: "B站市场机会复盘",
      tags: "#同花顺资讯 #投资",
      publishedAt: date
    };
  }
  return {
    link: `${platformId}-${date}-new-link`,
    accountName: "同花顺投资",
    contentType: "资讯",
    title: "今日市场机会",
    tags: "#同花顺资讯",
    publishedAt: date
  };
}

test("date helpers format the previous Shanghai calendar day", () => {
  const base = new Date("2026-05-20T04:00:00.000Z");

  assert.equal(previousDateString(base), "2026-05-19");
  assert.equal(normalizeDateInput("5/9", base), "2026-05-09");
  assert.equal(formatDisplayDate("2026-05-19"), "05 19");
  assert.equal(formatBatchTitle("2026-05-19"), "0519 投稿视频");
  assert.deepEqual(enumerateDateStrings("2026-05-18", "2026-05-20"), [
    "2026-05-18",
    "2026-05-19",
    "2026-05-20"
  ]);
  assert.equal(addDaysToDateString("2026-05-20", -1), "2026-05-19");
  assert.equal(endExclusiveDateToInclusiveUntilDate("2026-05-19", "2026-05-20"), "2026-05-19");
  assert.deepEqual(enumerateHalfOpenDateStrings("2026-05-19", "2026-05-20"), ["2026-05-19"]);
  assert.deepEqual(enumerateHalfOpenDateStrings("2026-05-19", "2026-05-22"), [
    "2026-05-19",
    "2026-05-20",
    "2026-05-21"
  ]);
  assert.throws(
    () => endExclusiveDateToInclusiveUntilDate("2026-05-19", "2026-05-19"),
    /结束日期必须晚于开始日期/
  );
});

test("relative publish times use the actual crawl date, not the filter date", () => {
  assert.equal(parsePublishedDateText("今天", "2026-05-20"), "2026-05-20");
  assert.equal(parsePublishedDateText("昨天", "2026-05-20"), "2026-05-19");
  assert.equal(parsePublishedDateText("3小时前", "2026-05-20"), "2026-05-20");
  assert.equal(parsePublishedDateText("发布时间：5月19日", "2026-05-20"), "2026-05-19");
  assert.equal(parsePublishedDateText("12月31日", "2027-01-01"), "2026-12-31");
});

test("link helpers extract platform ids from supported urls", () => {
  assert.equal(
    extractXhsNoteId("https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare"),
    "6a0c4c5e000000003502a761"
  );
  assert.equal(
    extractBilibiliBv("https://www.bilibili.com/video/BV1tNLA6hEQh/?spm_id_from=333"),
    "BV1tNLA6hEQh"
  );
});

test("link helpers build canonical links and read Feishu URL cells", () => {
  assert.deepEqual(buildFeishuUrlCell("https://www.douyin.com/video/7641910769218506003"), {
    type: "url",
    text: "https://www.douyin.com/video/7641910769218506003",
    link: "https://www.douyin.com/video/7641910769218506003"
  });
  assert.equal(
    extractFeishuCellLink({ type: "url", text: "打开链接", link: "https://v.douyin.com/2X5A3XRH1g4/" }),
    "https://v.douyin.com/2X5A3XRH1g4/"
  );
  assert.equal(
    extractFeishuCellLink([
      { type: "url", text: "打开链接", link: "https://www.douyin.com/video/7642330487012281641" }
    ]),
    "https://www.douyin.com/video/7642330487012281641"
  );
  assert.equal(
    canonicalizeContentLink(
      "xhs",
      "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_token=secret&xsec_source=pc_share"
    ),
    "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_token=secret&xsec_source=pc_share"
  );
});

test("XHS content links preserve raw openable query parameters", () => {
  const rawLink = "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_token=secret&xsec_source=pc_share";
  const rows = buildDailySheetRecords("xhs", "2026-05-19", [
    {
      link: rawLink,
      accountName: "同花顺投资",
      contentType: "图文",
      tags: "#同顺图解",
      publishedAt: "2026-05-19"
    }
  ]);

  assert.equal(rows[1].link, rawLink);
  assert.equal(mapDailyRecordToFeishuFields("xhs", rows[1])["内容链接"], rawLink);
  assert.deepEqual(mapDailyRecordToSheetRow("xhs", rows[1])[2], urlCell(rawLink));
});

test("XHS explore links are converted to share-style discovery URLs", () => {
  assert.equal(
    canonicalizeContentLink(
      "xhs",
      "https://www.xiaohongshu.com/explore/6a0c4c5e000000003502a761?xsec_token=secret&xsec_source=pc_user"
    ),
    "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_token=secret&xsec_source=pc_share"
  );
});

test("XHS discovery links use the canonical share parameter order", () => {
  assert.equal(
    canonicalizeContentLink(
      "xhs",
      "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?xsec_source=pc_user&foo=bar&xsec_token=secret&xhsshare=pc_web"
    ),
    "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_token=secret&xsec_source=pc_share"
  );
});

test("XHS state fallback links use share-style discovery URLs to avoid 404", () => {
  assert.equal(
    buildXhsExploreUrl("6a0c4c5e000000003502a761", "secret"),
    "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_token=secret&xsec_source=pc_share"
  );
  assert.equal(
    buildXhsExploreUrl("6a0c4c5e000000003502a761", ""),
    "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_source=pc_share"
  );
});

test("tag classification keeps the configured content type precedence", () => {
  assert.equal(classifyTags("#同花顺APP #同花顺股友说 #投资"), "股友说");
  assert.equal(classifyTags("#同顺图解 #同花顺资讯"), "资讯");
  assert.equal(classifyTags("#投资"), "无");
});

test("tag classification fuzzily matches configured Douyin tag words", () => {
  assert.equal(classifyTags("#同花顺资讯2026 #同花顺APP"), "资讯");
  assert.equal(classifyTags("#问财 #热点"), "问财问句");
  assert.equal(classifyTags("#问财问句 #同花顺APP"), "问财问句");
  assert.equal(classifyTags("#同顺深度财经长视频"), "长视频");
});

test("XHS uses the Feishu content type labels configured for Xiaohongshu", () => {
  assert.equal(classifyTags("#问财", { platformId: "xhs" }), "问财问句");
  assert.equal(classifyTags("#问财问句", { platformId: "xhs" }), "问财问句");
  assert.equal(classifyTags("#常老师", { platformId: "xhs" }), "常老师");
  assert.equal(classifyTags("#虚拟人", { platformId: "xhs" }), "AI视频 虚拟人");
  assert.equal(classifyTags("#段子", { platformId: "xhs" }), "段子");
});

test("spreadsheet-safe text escapes formula prefixes in free-text fields", () => {
  assert.equal(spreadsheetSafeText("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(spreadsheetSafeText("+话题"), "'+话题");
  assert.equal(spreadsheetSafeText("-标题"), "'-标题");
  assert.equal(spreadsheetSafeText("@tag"), "'@tag");
  assert.equal(spreadsheetSafeText("普通标题"), "普通标题");
});

test("daily records include a separator row and per-platform material fields", () => {
  const canonicalXhsLink = "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_source=pc_share";
  const rows = buildDailySheetRecords("xhs", "2026-05-19", [
    {
      link: "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare",
      id: "6a0c4c5e000000003502a761",
      accountName: "同花顺投资",
      contentType: "不应采用",
      primaryType: "视频",
      secondaryType: "资讯",
      title: "小红书标题",
      tags: "#同顺盘点",
      publishedAt: "2026-05-19"
    }
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(PLATFORM_HEADERS.xhs, PLATFORM_XHS_HEADER);
  assert.equal(PLATFORM_HEADERS.xhs.includes("图文/视频"), false);
  assertFieldsInclude(mapDailyRecordToFeishuFields("xhs", rows[0]), {
    "编号": "",
    "投稿时间": "0519 投稿视频",
    "内容链接": "",
    "笔记ID": "",
    "账号": "",
    "内容类型": "",
    "是否投放成功": "",
    "是否为爆款": "",
    "供稿人": "",
    "备注": "",
    "标题": "",
    "tag词": "",
    "一级类型": "",
    "二级类型": "",
    "内容类型标签审核": "",
    "AI内容判断备注": ""
  });
  assertFieldsInclude(mapDailyRecordToFeishuFields("xhs", rows[1]), {
    "编号": "1",
    "投稿时间": "2026-05-19",
    "内容链接": canonicalXhsLink,
    "笔记ID": "6a0c4c5e000000003502a761",
    "账号": "投资号",
    "内容类型": "盘点",
    "是否投放成功": "",
    "是否为爆款": "",
    "供稿人": "",
    "备注": "",
    "标题": "小红书标题",
    "tag词": "#同顺盘点",
    "一级类型": "视频",
    "二级类型": "资讯",
    "内容类型标签审核": "通过。因为AI依据标题、tag和可用素材判断为盘点。",
    "AI内容判断备注": ""
  });
  const sheetRow = mapDailyRecordToSheetRow("xhs", rows[1]);
  assert.equal(sheetRow[1], "2026-05-19");
  assert.deepEqual(sheetRow[2], urlCell(canonicalXhsLink));
  assert.equal(sheetRow[5].values[0], "盘点");
  assert.equal(sheetRow[11], "#同顺盘点");
  assert.equal(sheetRow[12], "视频");
  assert.equal(sheetRow.length, 16);
});

test("daily records omit the 5.30 separator row when the target date has no material", () => {
  const rows = buildDailySheetRecords("xhs", "2026-05-30", [
    {
      link: "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761",
      id: "6a0c4c5e000000003502a761",
      accountName: "同花顺投资",
      contentType: "图文",
      tags: "#同顺图解",
      publishedAt: "2026-05-29"
    }
  ]);

  assert.deepEqual(rows, []);
});

test("Douyin daily records use the submission review column order", () => {
  assert.deepEqual(PLATFORM_HEADERS.douyin, PLATFORM_DOUYIN_HEADER);

  const rows = buildDailySheetRecords("douyin", "2026-05-19", [
    {
      link: "https://www.douyin.com/video/7641910769218506003",
      accountName: "同花顺投资",
      contentType: "不应采用",
      primaryType: "盘点",
      secondaryType: "资金盘面盘点",
      title: "一文看懂今日市场机会",
      tags: "#同花顺资讯 #同花顺APP",
      publishedAt: "2026-05-19"
    }
  ]);

  assertFieldsInclude(mapDailyRecordToFeishuFields("douyin", rows[0]), {
    "编号": "",
    "投稿时间": "0519 投稿视频",
    "内容链接": "",
    "账号": "",
    "内容类型": "",
    "是否投放成功": "",
    "是否为爆款": "",
    "供稿人": "",
    "备注": "",
    "作品ID": "",
    "作品类型": "",
    "标题": "",
    "tag词": "",
    "一级类型": "",
    "二级类型": "",
    "内容类型标签审核": "",
    "AI内容判断备注": ""
  });
  assertFieldsInclude(mapDailyRecordToFeishuFields("douyin", rows[1]), {
    "编号": "1",
    "投稿时间": "2026-05-19",
    "内容链接": "https://www.douyin.com/video/7641910769218506003",
    "账号": "投资号",
    "内容类型": "资讯",
    "是否投放成功": "",
    "是否为爆款": "",
    "供稿人": "",
    "备注": "",
    "作品ID": "7641910769218506003",
    "作品类型": "视频",
    "标题": "一文看懂今日市场机会",
    "tag词": "#同花顺资讯 #同花顺APP",
    "一级类型": "盘点",
    "二级类型": "资金盘面盘点",
    "内容类型标签审核": "通过。因为AI依据标题、tag和可用素材判断为资讯。",
    "AI内容判断备注": ""
  });
  const douyinSheetRow = mapDailyRecordToSheetRow("douyin", rows[1]);
  assert.equal(douyinSheetRow[1], "2026-05-19");
  assert.equal(douyinSheetRow[4].values[0], "资讯");
  assert.equal(douyinSheetRow[13], "盘点");
  assert.match(douyinSheetRow[15], /^通过。因为/u);
});

test("account names are normalized to Feishu dropdown labels", () => {
  assert.equal(normalizeAccountLabel("douyin", "同花顺投资"), "投资号");
  assert.equal(normalizeAccountLabel("douyin", "同顺财经"), "财经号");
  assert.equal(normalizeAccountLabel("douyin", "同花顺股民社区"), "股民社区");
  assert.equal(normalizeAccountLabel("douyin", "同花顺理财"), "理财");
  assert.equal(normalizeAccountLabel("douyin", "同花顺财富"), "理财");
  assert.equal(normalizeAccountLabel("douyin", "同花顺问财"), "问财");
  assert.equal(normalizeAccountLabel("douyin", "同花顺期货通"), "期货通");
  assert.equal(normalizeAccountLabel("douyin", "同花顺新手福利官"), "福利官");
  assert.equal(normalizeAccountLabel("douyin", "同花顺达人内容"), "达人内容");
  assert.equal(normalizeAccountLabel("xhs", "同花顺投资"), "投资号");
  assert.equal(normalizeAccountLabel("xhs", "同花顺股民社区"), "股民社区");
  assert.equal(normalizeAccountLabel("xhs", "同花顺理财"), "理财");
  assert.equal(normalizeAccountLabel("xhs", "同顺财经"), "财经号");
  assert.equal(normalizeAccountLabel("xhs", "同花顺研习社"), "研习社");
  assert.equal(normalizeAccountLabel("xhs", "同花顺新手福利官"), "福利官");
  assert.equal(normalizeAccountLabel("xhs", "新手福利官"), "福利官");
  assert.equal(normalizeAccountLabel("xhs", "福利官"), "福利官");
  assert.equal(XHS_ACCOUNT_DROPDOWN_VALUES.includes("福利官"), true);
  assert.equal(normalizeAccountLabel("bilibili", "同花顺投资"), "投资号");
  assert.equal(normalizeAccountLabel("bilibili", "投资号"), "投资号");
});

test("Douyin account crawl config omits Miaodong investment", async () => {
  const accountConfig = JSON.parse(await fs.readFile(path.join(process.cwd(), "platform-accounts.json"), "utf8"));
  assert.equal(accountConfig.douyin.some((account) => account.name === "喵懂投资"), false);
});

test("bilibili daily records map BV ids, fixed account names, title, and tags", () => {
  assert.deepEqual(PLATFORM_HEADERS.bilibili, PLATFORM_BILIBILI_HEADER);

  const rows = buildDailySheetRecords("bilibili", "2026-05-19", [
    {
      link: "https://www.bilibili.com/video/BV1tNLA6hEQh/",
      id: "BV1tNLA6hEQh",
      accountName: "同花顺投资",
      title: "B站市场机会复盘",
      tags: "#同花顺资讯 #投资",
      publishedAt: "2026-05-19"
    }
  ]);

  assertFieldsInclude(mapDailyRecordToFeishuFields("bilibili", rows[0]), {
    "编号": "",
    "投稿时间": "0519 投稿视频",
    "内容链接": "",
    "短链id": "",
    "是否投放成功": "",
    "是否为爆款": "",
    "供稿人": "",
    "备注": "",
    "账号": "",
    "作品类型": "",
    "标题": "",
    "tag词": "",
    "内容类型": "",
    "内容类型标签审核": "",
    "AI内容判断备注": ""
  });
  assertFieldsInclude(mapDailyRecordToFeishuFields("bilibili", rows[1]), {
    "编号": "1",
    "投稿时间": "2026-05-19",
    "内容链接": "https://www.bilibili.com/video/BV1tNLA6hEQh/",
    "短链id": "BV1tNLA6hEQh",
    "是否投放成功": "",
    "是否为爆款": "",
    "供稿人": "",
    "备注": "",
    "账号": "投资号",
    "作品类型": "视频",
    "标题": "B站市场机会复盘",
    "tag词": "#同花顺资讯 #投资",
    "内容类型": "无",
    "内容类型标签审核": "需审核。因为标题和tag线索不足，无法稳定判断内容类型。",
    "AI内容判断备注": ""
  });
  const bilibiliSheetRow = mapDailyRecordToSheetRow("bilibili", rows[1]);
  assert.equal(bilibiliSheetRow[1], "2026-05-19");
  assert.equal(bilibiliSheetRow[12].values[0], "无");
  assert.match(bilibiliSheetRow[13], /^需审核。因为/u);
});

test("duplicate separator and material rows are skipped before spreadsheet writes", () => {
  const rows = buildDailySheetRecords("douyin", "2026-05-19", [
    {
      link: "https://v.douyin.com/2X5A3XRH1g4/",
      accountName: "投资号",
      contentType: "股友说",
      title: "旧视频",
      tags: "#同花顺股友说",
      publishedAt: "2026-05-19"
    },
    {
      link: "https://v.douyin.com/new-video/",
      accountName: "财富号",
      contentType: "资讯",
      title: "新视频",
      tags: "#同花顺资讯",
      publishedAt: "2026-05-19"
    }
  ]);

  const filtered = filterNewDailySheetRecords("douyin", rows, [
    ["", "0519 投稿视频", "", "", "", "", ""],
    ["1", "2026-05-19", "https://v.douyin.com/2X5A3XRH1g4/", "投资号", "股友说", "旧视频", "#同花顺股友说"]
  ]);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].link, "https://v.douyin.com/new-video/");
});

test("duplicate detection accepts both legacy plain URLs and Feishu URL objects", () => {
  const xhsRows = buildDailySheetRecords("xhs", "2026-05-19", [
    {
      link: "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?xsec_token=secret&xsec_source=pc_share",
      accountName: "同花顺投资",
      contentType: "图文",
      tags: "#tag",
      publishedAt: "2026-05-19"
    }
  ]);
  const douyinRows = buildDailySheetRecords("douyin", "2026-05-19", [
    {
      link: "https://v.douyin.com/2X5A3XRH1g4/",
      accountName: "投资号",
      contentType: "资讯",
      title: "旧视频",
      tags: "#tag",
      publishedAt: "2026-05-19"
    }
  ]);

  assert.deepEqual(filterNewDailySheetRecords("xhs", xhsRows, [
    ["", "0519 投稿视频", "", "", "", "", "", "", ""],
    ["1", "2026-05-19", "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare", "", "", "投资号", "图文", "通过", "#tag"]
  ]), []);
  assert.deepEqual(filterNewDailySheetRecords("douyin", douyinRows, [
    ["", "0519 投稿视频", "", "", "", "", ""],
    ["1", "2026-05-19", urlCell("https://v.douyin.com/2X5A3XRH1g4/"), "投资号", "资讯", "旧视频", "#tag"]
  ]), []);
});

test("padded legacy Douyin rows are read with the old title and account columns", () => {
  const legacyRowPaddedToNewWidth = [
    "1",
    "2026-05-19",
    urlCell("https://www.douyin.com/note/7643770579069209897"),
    "旧标题",
    "#同花顺APP",
    "",
    "",
    "投资号",
    "无",
    "需审核",
    "",
    "",
    "",
    ""
  ];

  assertFieldsInclude(rowToFields("douyin", legacyRowPaddedToNewWidth), {
    "编号": "1",
    "投稿时间": "2026-05-19",
    "内容链接": urlCell("https://www.douyin.com/note/7643770579069209897"),
    "账号": "投资号",
    "内容类型": "无",
    "是否投放成功": "",
    "是否为爆款": "",
    "供稿人": "",
    "备注": "",
    "作品ID": "",
    "作品类型": "",
    "标题": "旧标题",
    "tag词": "#同花顺APP",
    "内容类型标签审核": "需审核"
  });
});

test("Feishu rows use URL objects and escape formula-like free text", () => {
  const rows = buildDailySheetRecords("douyin", "2026-05-19", [
    {
      link: "https://www.douyin.com/video/7641910769218506003",
      accountName: "同花顺投资",
      contentType: "资讯",
      title: "=危险标题",
      tags: "@危险tag",
      publishedAt: "2026-05-19"
    }
  ]);

  const row = mapDailyRecordToSheetRow("douyin", rows[1]);
  assert.equal(row[1], "2026-05-19");
  assert.deepEqual(row[2], urlCell("https://www.douyin.com/video/7641910769218506003"));
  assert.equal(row[4].values[0], "无");
  assert.equal(row[11], "'=危险标题");
  assert.equal(row[12], "'@危险tag");
  assert.equal(row[13], "");
  assert.match(row[15], /^需审核。因为/u);
});

test("missing Feishu configuration reports every required placeholder", () => {
  const result = validateFeishuConfig({
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
    FEISHU_SPREADSHEET_TOKEN: "",
    FEISHU_SHEET_DOUYIN: "",
    FEISHU_SHEET_XHS: "",
    FEISHU_SHEET_BILIBILI: ""
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_SHEET_DOUYIN",
    "FEISHU_SHEET_XHS",
    "FEISHU_SHEET_BILIBILI",
    "FEISHU_SPREADSHEET_TOKEN 或 FEISHU_WIKI_TOKEN"
  ]);
  assert.match(result.message, /缺少飞书配置/);
});

test("Feishu configuration accepts a wiki token instead of a spreadsheet token", () => {
  const env = {
    FEISHU_APP_ID: "cli_xxx",
    FEISHU_APP_SECRET: "secret",
    FEISHU_WIKI_TOKEN: "YxQewsjm5iKw5Fk5PfgcdSqNnyc",
    FEISHU_SPREADSHEET_TOKEN: "",
    FEISHU_SHEET_DOUYIN: "d0de52",
    FEISHU_SHEET_XHS: "4z96Ou",
    FEISHU_SHEET_BILIBILI: "1FOmKl"
  };

  assert.equal(validateFeishuConfig(env).ok, true);
  assert.deepEqual(loadFeishuConfig(env), {
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "",
    wikiToken: "YxQewsjm5iKw5Fk5PfgcdSqNnyc",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  });
});

test("single platform JSON output can be written to its Feishu sheet", async () => {
  const canonicalXhsLink = "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_source=pc_share";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-ths-"));
  await fs.mkdir(path.join(root, "output"));
  await fs.writeFile(path.join(root, "output", "xhs_notes_2026-05-19_to_2026-05-19.json"), JSON.stringify({
    items: [
      {
        link: "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare",
        id: "6a0c4c5e000000003502a761",
        accountName: "同花顺投资",
        contentType: "图文",
        tags: "#同顺图解",
        publishedAt: "2026-05-19"
      }
    ]
  }), "utf8");

  const calls = [];
  const client = {
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return [];
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
    }
  };

  const result = await writePlatformJsonToFeishu({
    platformId: "xhs",
    targetDate: "2026-05-19",
    root,
    client
  });

  assert.equal(result.collected, 1);
  assert.equal(result.feishu.created, 2);
  assert.deepEqual(calls[0], ["readRows", "xhs"]);
  assert.equal(calls[1][0], "prependRows");
  assert.equal(calls[1][1], "xhs");
  assert.equal(calls[1][2][0][1], "0519 投稿视频");
  assert.equal(calls[1][2][0].length, PLATFORM_HEADERS.xhs.length);
  assert.equal(calls[1][2][1][1], "2026-05-19");
  assert.deepEqual(calls[1][2][1][2], urlCell(canonicalXhsLink));
  assert.equal(calls[1][2][1][11], "#同顺图解");
  assert.equal(calls[1][2][1][5].values[0], "图文");
});

test("single XHS account JSON output with an account suffix can be written to Feishu", async () => {
  const canonicalXhsLink = "https://www.xiaohongshu.com/discovery/item/6b0c4c5e000000003502a762?source=webshare&xhsshare=pc_web&xsec_source=pc_share";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-ths-"));
  await fs.mkdir(path.join(root, "output"));
  await fs.writeFile(path.join(root, "output", "xhs_notes_2026-05-19_to_2026-05-19_研习社.json"), JSON.stringify({
    items: [
      {
        link: "https://www.xiaohongshu.com/discovery/item/6b0c4c5e000000003502a762?source=webshare",
        id: "6b0c4c5e000000003502a762",
        accountName: "研习社",
        contentType: "图文",
        tags: "#同顺图解",
        publishedAt: "2026-05-19"
      }
    ]
  }), "utf8");

  const calls = [];
  const client = {
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return [];
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
    }
  };

  const result = await writePlatformJsonToFeishu({
    platformId: "xhs",
    targetDate: "2026-05-19",
    accountName: "研习社",
    root,
    client
  });

  assert.equal(result.collected, 1);
  assert.equal(result.feishu.created, 2);
  assert.equal(calls[1][2][1][1], "2026-05-19");
  assert.deepEqual(calls[1][2][1][2], urlCell(canonicalXhsLink));
  assert.equal(calls[1][2][1][3], "6b0c4c5e000000003502a762");
  assert.equal(calls[1][2][1][11], "#同顺图解");
  assert.equal(calls[1][2][1][5].values[0], "图文");
});

test("Feishu dropdown setup failures do not block row writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-ths-"));
  await fs.mkdir(path.join(root, "output"));
  await fs.writeFile(path.join(root, "output", "xhs_notes_2026-05-19_to_2026-05-19.json"), JSON.stringify({
    items: [
      {
        link: "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare",
        id: "6a0c4c5e000000003502a761",
        accountName: "同花顺投资",
        contentType: "图文",
        tags: "#同顺图解",
        publishedAt: "2026-05-19"
      }
    ]
  }), "utf8");

  const calls = [];
  const client = {
    async configurePlatformDropdowns(platformId) {
      calls.push(["configurePlatformDropdowns", platformId]);
      throw new Error("飞书 API 调用失败：validate RangeVal fail");
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return [];
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      return {
        updates: {
          updatedRange: "4z96Ou!A2:G3"
        }
      };
    }
  };

  const result = await writePlatformJsonToFeishu({
    platformId: "xhs",
    targetDate: "2026-05-19",
    root,
    client
  });

  assert.equal(result.feishu.created, 2);
  assert.equal(calls.filter((call) => call[0] === "prependRows").length, 1);
  assert.deepEqual(result.feishu.warnings, [
    "下拉选项配置失败，已跳过：飞书 API 调用失败：validate RangeVal fail",
    "下拉选项配置失败，已跳过：飞书 API 调用失败：validate RangeVal fail"
  ]);
});

test("new Feishu date batches are inserted before existing date rows", async () => {
  const calls = [];
  const client = {
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return [
        ["", "0518 投稿视频", "", "", "", "", "", "", "", "", "", "", ""],
        ["1", "2026-05-18", "old-link", "old-id", "投资号", "图文", "", "", "", "", "旧标题", "通过", ""]
      ];
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      return {
        updates: {
          updatedRange: "4z96Ou!A2:G3"
        }
      };
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "xhs",
    targetDate: "2026-05-19",
    items: [
      {
        link: "new-link",
        id: "new-id",
        accountName: "同花顺投资",
        contentType: "图文",
        tags: "#tag",
        publishedAt: "2026-05-19"
      }
    ],
    client
  });

  assert.equal(result.created, 2);
  assert.equal(calls[1][0], "prependRows");
  assert.equal(calls[1][1], "xhs");
  assert.equal(calls[1][3], 2);
  assert.equal(calls[1][2][0][1], "0519 投稿视频");
  assert.equal(calls[1][2][1][1], "2026-05-19");
  assert.deepEqual(calls[1][2][1][2], urlCell("new-link"));
  assert.equal(calls[1][2][1][11], "#tag");
  assert.equal(calls[1][2][1][5], "");
});

test("new Feishu date batches keep newest dates first on every platform", async () => {
  for (const platformId of ["douyin", "xhs", "bilibili"]) {
    await assertNewDateInsertRow({
      platformId,
      targetDate: "2026-05-18",
      existingDate: "2026-05-19",
      expectedStartRow: 4
    });

    await assertNewDateInsertRow({
      platformId,
      targetDate: "2026-05-20",
      existingDate: "2026-05-19",
      expectedStartRow: 2
    });
  }
});

test("Douyin daily write inserts today's date block under the current year separator and clears material highlights", async () => {
  const calls = [];
  const existingRows = [
    ["", "2026年投稿", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "0608 投稿视频", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-06-08", urlCell("old-link"), { type: "multipleValue", values: ["投资号"] }, { type: "multipleValue", values: ["资讯"] }, "", "", "", "", "old-id", "视频", "旧标题", "#old", "通过"],
    ["", "2025年投稿", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1231 投稿视频", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2025-12-31", urlCell("old-2025-link"), { type: "multipleValue", values: ["投资号"] }, { type: "multipleValue", values: ["资讯"] }, "", "", "", "", "old-2025-id", "视频", "旧标题", "#old", "通过"]
  ];
  const client = {
    dataStartRow(platformId) {
      assert.equal(platformId, "douyin");
      return 5;
    },
    sheetId(platformId) {
      assert.equal(platformId, "douyin");
      return "d0de52";
    },
    async sheetColumnCount(platformId) {
      calls.push(["sheetColumnCount", platformId]);
      return 17;
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return existingRows;
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      existingRows.splice(startRow - 5, 0, ...rows);
      return {
        updates: {
          updatedRange: `d0de52!A${startRow}:N${startRow + rows.length - 1}`
        }
      };
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async clearMaterialRowHighlights(platformId, ranges, options) {
      calls.push(["clearMaterialRowHighlights", platformId, ranges, options]);
    },
    async highlightSeparatorRows(platformId, rows, options) {
      calls.push(["highlightSeparatorRows", platformId, rows, options]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "douyin",
    targetDate: "2026-06-10",
    items: [
      {
        link: "https://www.douyin.com/video/7648943779767930131",
        accountName: "同花顺投资",
        contentType: "资讯",
        title: "今天的新素材",
        tags: "#同花顺资讯",
        publishedAt: "2026-06-10"
      }
    ],
    client
  });

  assert.equal(result.created, 2);
  const douyinPrepend = calls.find((call) => call[0] === "prependRows");
  assert.equal(douyinPrepend[3], 6);
  assert.equal(douyinPrepend[2][0][1], "0610 投稿视频");
  assert.equal(douyinPrepend[2][1][1], "2026-06-10");
  assert.equal(douyinPrepend[2][1][4].values[0], "资讯");
  assert.equal(douyinPrepend[2][1][13], "");
  assert.match(douyinPrepend[2][1][15], /^通过。因为/u);
  assert.deepEqual(calls.find((call) => call[0] === "clearMaterialRowHighlights"), [
    "clearMaterialRowHighlights",
    "douyin",
    [{ startRow: 7, endRow: 7 }],
    { columnCount: 17 }
  ]);
  assert.deepEqual(calls.find((call) => call[0] === "highlightSeparatorRows"), [
    "highlightSeparatorRows",
    "douyin",
    [5, 6, 8, 10, 11],
    { columnCount: 17 }
  ]);
});

test("Douyin daily write creates a new year separator before adding the first date block of a new year", async () => {
  const calls = [];
  const existingRows = [
    ["", "2026年投稿", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1231 投稿视频", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-12-31", urlCell("old-link"), { type: "multipleValue", values: ["投资号"] }, { type: "multipleValue", values: ["资讯"] }, "", "", "", "", "old-id", "视频", "旧标题", "#old", "通过"],
    ["", "2025年投稿", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1231 投稿视频", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2025-12-31", urlCell("old-2025-link"), { type: "multipleValue", values: ["投资号"] }, { type: "multipleValue", values: ["资讯"] }, "", "", "", "", "old-2025-id", "视频", "旧标题", "#old", "通过"]
  ];
  const client = {
    dataStartRow(platformId) {
      assert.equal(platformId, "douyin");
      return 5;
    },
    sheetId(platformId) {
      assert.equal(platformId, "douyin");
      return "d0de52";
    },
    async sheetColumnCount(platformId) {
      calls.push(["sheetColumnCount", platformId]);
      return 17;
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return existingRows;
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      existingRows.splice(startRow - 5, 0, ...rows);
      return {
        updates: {
          updatedRange: `d0de52!A${startRow}:N${startRow + rows.length - 1}`
        }
      };
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async clearMaterialRowHighlights(platformId, ranges, options) {
      calls.push(["clearMaterialRowHighlights", platformId, ranges, options]);
    },
    async highlightSeparatorRows(platformId, rows, options) {
      calls.push(["highlightSeparatorRows", platformId, rows, options]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "douyin",
    targetDate: "2027-01-02",
    items: [
      {
        link: "https://www.douyin.com/video/7777777777777777777",
        accountName: "同花顺投资",
        contentType: "资讯",
        title: "新年第一条素材",
        tags: "#同花顺资讯",
        publishedAt: "2027-01-02"
      }
    ],
    client
  });

  assert.equal(result.created, 3);
  assert.equal(result.skipped, 0);
  const newYearPrepend = calls.find((call) => call[0] === "prependRows");
  assert.equal(newYearPrepend[3], 5);
  assert.deepEqual(newYearPrepend[2].map((row) => row[1]), ["2027年投稿", "0102 投稿视频", "2027-01-02"]);
  assert.equal(newYearPrepend[2][2][4].values[0], "资讯");
  assert.equal(newYearPrepend[2][2][13], "");
  assert.match(newYearPrepend[2][2][15], /^通过。因为/u);
  assert.deepEqual(calls.find((call) => call[0] === "clearMaterialRowHighlights"), [
    "clearMaterialRowHighlights",
    "douyin",
    [{ startRow: 7, endRow: 7 }],
    { columnCount: 17 }
  ]);
  assert.deepEqual(calls.find((call) => call[0] === "highlightSeparatorRows"), [
    "highlightSeparatorRows",
    "douyin",
    [5, 6, 8, 9, 11, 12],
    { columnCount: 17 }
  ]);
});

test("new Feishu rows for an existing date append to that block and renumber legacy rows", async () => {
  const calls = [];
  const existingRows = [
    ["", "0519 投稿视频", "", "", "", "", "", "", "", "", "", "", ""],
    ["2026-05-19-1", "2026-05-19", "old-link", "old-id", "投资号", "图文", "", "", "", "", "旧标题", "通过", ""],
    ["", "0518 投稿视频", "", "", "", "", "", "", "", "", "", "", ""]
  ];
  const client = {
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return existingRows;
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      existingRows.splice(startRow - 2, 0, ...rows);
      return {
        updates: {
          updatedRange: "4z96Ou!A4:G4"
        }
      };
    },
    sheetId(platformId) {
      return platformId === "xhs" ? "4z96Ou" : platformId;
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async highlightSeparatorRows(platformId, rows) {
      calls.push(["highlightSeparatorRows", platformId, rows]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "xhs",
    targetDate: "2026-05-19",
    items: [
      {
        link: "old-link",
        id: "old-id",
        accountName: "同花顺投资",
        contentType: "图文",
        publishedAt: "2026-05-19"
      },
      {
        link: "new-link",
        id: "new-id",
        accountName: "同花顺投资",
        contentType: "图文",
        tags: "#tag",
        publishedAt: "2026-05-19"
      }
    ],
    client
  });

  assert.equal(result.created, 1);
  const appendPrepend = calls.find((call) => call[0] === "prependRows");
  assert.equal(appendPrepend[3], 4);
  assert.equal(appendPrepend[2][0][0], "2");
  assert.equal(appendPrepend[2][0][1], "2026-05-19");
  assert.deepEqual(appendPrepend[2][0][2], urlCell("new-link"));
  assert.equal(appendPrepend[2][0][11], "#tag");
  assert.equal(appendPrepend[2][0][5], "");
  assert.deepEqual(calls.find((call) => call[0] === "writeRows" && call[2] === "4z96Ou!A3:A4"), ["writeRows", "xhs", "4z96Ou!A3:A4", [["1"], ["2"]]]);
  assert.deepEqual(calls.find((call) => call[0] === "writeRows" && call[2] === "4z96Ou!L3:L3"), [
    "writeRows",
    "xhs",
    "4z96Ou!L3:L3",
    [["需审核。因为标题和tag线索不足，无法稳定判断内容类型。"]]
  ]);
  assert.deepEqual(calls.at(-1), ["highlightSeparatorRows", "xhs", [2, 5]]);
});

test("XHS daily writes insert today under the current year separator and keep material rows unhighlighted", async () => {
  const calls = [];
  const existingRows = [
    ["", "2026年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "0609 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-06-09", "old-link", "old-id", "投资号", "图文", "", "", "", "", "旧标题", "通过", "", "", "", "", ""],
    ["", "2025年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1215 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2025-12-15", "older-link", "older-id", "投资号", "图文", "", "", "", "", "旧标题", "通过", "", "", "", "", ""]
  ];
  let readCount = 0;
  const client = {
    dataStartRow() {
      return 3;
    },
    async sheetColumnCount(platformId) {
      calls.push(["sheetColumnCount", platformId]);
      return 17;
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      readCount += 1;
      return readCount === 1 ? existingRows : [
        ["", "2026年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["", "0610 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["1", "2026-06-10", "new-link", "new-id", "投资号", "图文", "", "", "", "", "新标题", "通过", "#tag", "", "", "", ""],
        ["", "0609 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["1", "2026-06-09", "old-link", "old-id", "投资号", "图文", "", "", "", "", "旧标题", "通过", "", "", "", "", ""],
        ["", "2025年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["", "1215 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["1", "2025-12-15", "older-link", "older-id", "投资号", "图文", "", "", "", "", "旧标题", "通过", "", "", "", "", ""]
      ];
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      return {
        updates: {
          updatedRange: "4z96Ou!A4:M5"
        }
      };
    },
    sheetId() {
      return "4z96Ou";
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async clearMaterialRowHighlights(platformId, ranges, options) {
      calls.push(["clearMaterialRowHighlights", platformId, ranges, options]);
    },
    async highlightSeparatorRows(platformId, rowNumbers, options) {
      calls.push(["highlightSeparatorRows", platformId, rowNumbers, options]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "xhs",
    targetDate: "2026-06-10",
    items: [{
      link: "new-link",
      id: "new-id",
      accountName: "同花顺投资",
      contentType: "图文",
      title: "新标题",
      tags: "#tag",
      publishedAt: "2026-06-10"
    }],
    client
  });

  assert.equal(result.created, 2);
  const prependCall = calls.find((call) => call[0] === "prependRows");
  assert.equal(prependCall[3], 4);
  assert.deepEqual(prependCall[2].map((row) => row[1]), ["0610 投稿视频", "2026-06-10"]);
  assert.deepEqual(calls.find((call) => call[0] === "clearMaterialRowHighlights"), [
    "clearMaterialRowHighlights",
    "xhs",
    [{ startRow: 5, endRow: 5 }],
    { columnCount: 17 }
  ]);
  assert.deepEqual(calls.at(-1), [
    "highlightSeparatorRows",
    "xhs",
    [3, 4, 6, 8, 9],
    { columnCount: 17 }
  ]);
});

test("XHS daily writes create a new year separator before today's separator when crossing years", async () => {
  const calls = [];
  const existingRows = [
    ["", "2026年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1231 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-12-31", "old-link", "old-id", "投资号", "图文", "", "", "", "", "旧标题", "通过", "", "", "", "", ""],
    ["", "2025年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1215 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2025-12-15", "older-link", "older-id", "投资号", "图文", "", "", "", "", "旧标题", "通过", "", "", "", "", ""]
  ];
  let rowsAfterWrite = existingRows;
  const client = {
    dataStartRow() {
      return 3;
    },
    async sheetColumnCount(platformId) {
      calls.push(["sheetColumnCount", platformId]);
      return 17;
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return rowsAfterWrite;
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      rowsAfterWrite = [
        ["", "2027年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["", "0102 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["1", "2027-01-02", "new-link", "new-id", "投资号", "图文", "", "", "", "", "新标题", "通过", "#tag", "", "", "", ""],
        ...existingRows
      ];
      return {
        updates: {
          updatedRange: "4z96Ou!A3:M5"
        }
      };
    },
    sheetId() {
      return "4z96Ou";
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async clearMaterialRowHighlights(platformId, ranges, options) {
      calls.push(["clearMaterialRowHighlights", platformId, ranges, options]);
    },
    async highlightSeparatorRows(platformId, rowNumbers, options) {
      calls.push(["highlightSeparatorRows", platformId, rowNumbers, options]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "xhs",
    targetDate: "2027-01-02",
    items: [{
      link: "new-link",
      id: "new-id",
      accountName: "同花顺投资",
      contentType: "图文",
      title: "新标题",
      tags: "#tag",
      publishedAt: "2027-01-02"
    }],
    client
  });

  assert.equal(result.created, 3);
  const prependCall = calls.find((call) => call[0] === "prependRows");
  assert.equal(prependCall[3], 3);
  assert.deepEqual(prependCall[2].map((row) => row[1]), ["2027年投稿", "0102 投稿视频", "2027-01-02"]);
  assert.deepEqual(calls.find((call) => call[0] === "clearMaterialRowHighlights"), [
    "clearMaterialRowHighlights",
    "xhs",
    [{ startRow: 5, endRow: 5 }],
    { columnCount: 17 }
  ]);
  assert.deepEqual(calls.at(-1), [
    "highlightSeparatorRows",
    "xhs",
    [3, 4, 6, 7, 9, 10],
    { columnCount: 17 }
  ]);
});

test("Bilibili daily writes insert today's separator under the current year and keep material rows unhighlighted", async () => {
  const calls = [];
  const existingRows = [
    ["", "2026年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "0609 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-06-09", urlCell("https://www.bilibili.com/video/BVold20260609/"), "BVold20260609", "", "", "", "", "投资号", "视频", "旧标题", "#old", "无", "需审核", "", "", ""],
    ["", "2025年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1215 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2025-12-15", urlCell("https://www.bilibili.com/video/BVold20251215/"), "BVold20251215", "", "", "", "", "投资号", "视频", "旧标题", "#old", "无", "需审核", "", "", ""]
  ];
  const client = {
    dataStartRow(platformId) {
      assert.equal(platformId, "bilibili");
      return 3;
    },
    sheetId(platformId) {
      assert.equal(platformId, "bilibili");
      return "1FOmKl";
    },
    async sheetColumnCount(platformId) {
      calls.push(["sheetColumnCount", platformId]);
      return 17;
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return existingRows;
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      existingRows.splice(startRow - 3, 0, ...rows);
      return {
        updates: {
          updatedRange: `1FOmKl!A${startRow}:N${startRow + rows.length - 1}`
        }
      };
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async clearMaterialRowHighlights(platformId, ranges, options) {
      calls.push(["clearMaterialRowHighlights", platformId, ranges, options]);
    },
    async highlightSeparatorRows(platformId, rowNumbers, options) {
      calls.push(["highlightSeparatorRows", platformId, rowNumbers, options]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "bilibili",
    targetDate: "2026-06-10",
    items: [{
      link: "https://www.bilibili.com/video/BVnew20260610/",
      id: "BVnew20260610",
      accountName: "同花顺投资",
      title: "今天的新素材",
      tags: "#tag",
      publishedAt: "2026-06-10"
    }],
    client
  });

  assert.equal(result.created, 2);
  const prependCall = calls.find((call) => call[0] === "prependRows");
  assert.equal(prependCall[3], 4);
  assert.equal(prependCall[2][0][1], "0610 投稿视频");
  assert.equal(prependCall[2][0].length, PLATFORM_HEADERS.bilibili.length);
  assert.equal(prependCall[2][1][1], "2026-06-10");
  assert.deepEqual(prependCall[2][1][2], urlCell("https://www.bilibili.com/video/BVnew20260610/"));
  assert.equal(prependCall[2][1][12].values[0], "无");
  assert.match(prependCall[2][1][13], /^需审核。因为/u);
  assert.deepEqual(calls.find((call) => call[0] === "clearMaterialRowHighlights"), [
    "clearMaterialRowHighlights",
    "bilibili",
    [{ startRow: 5, endRow: 5 }],
    { columnCount: 17 }
  ]);
  assert.deepEqual(calls.at(-1), [
    "highlightSeparatorRows",
    "bilibili",
    [3, 4, 6, 8, 9],
    { columnCount: 17 }
  ]);
});

test("Bilibili daily writes create a new year separator before the date separator across years", async () => {
  const calls = [];
  const existingRows = [
    ["", "2026年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1231 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-12-31", urlCell("https://www.bilibili.com/video/BVold20261231/"), "BVold20261231", "", "", "", "", "投资号", "视频", "旧标题", "#old", "无", "需审核", "", "", ""],
    ["", "2025年投稿", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "1215 投稿视频", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2025-12-15", urlCell("https://www.bilibili.com/video/BVold20251215/"), "BVold20251215", "", "", "", "", "投资号", "视频", "旧标题", "#old", "无", "需审核", "", "", ""]
  ];
  const client = {
    dataStartRow(platformId) {
      assert.equal(platformId, "bilibili");
      return 3;
    },
    sheetId(platformId) {
      assert.equal(platformId, "bilibili");
      return "1FOmKl";
    },
    async sheetColumnCount(platformId) {
      calls.push(["sheetColumnCount", platformId]);
      return 17;
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return existingRows;
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      existingRows.splice(startRow - 3, 0, ...rows);
      return {
        updates: {
          updatedRange: `1FOmKl!A${startRow}:N${startRow + rows.length - 1}`
        }
      };
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async clearMaterialRowHighlights(platformId, ranges, options) {
      calls.push(["clearMaterialRowHighlights", platformId, ranges, options]);
    },
    async highlightSeparatorRows(platformId, rowNumbers, options) {
      calls.push(["highlightSeparatorRows", platformId, rowNumbers, options]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "bilibili",
    targetDate: "2027-01-01",
    items: [{
      link: "https://www.bilibili.com/video/BVnew20270101/",
      id: "BVnew20270101",
      accountName: "同花顺投资",
      title: "新年第一条素材",
      tags: "#tag",
      publishedAt: "2027-01-01"
    }],
    client
  });

  assert.equal(result.created, 3);
  const prependCall = calls.find((call) => call[0] === "prependRows");
  assert.equal(prependCall[3], 3);
  assert.deepEqual(prependCall[2].map((row) => row[1]), ["2027年投稿", "0101 投稿视频", "2027-01-01"]);
  assert.deepEqual(calls.find((call) => call[0] === "clearMaterialRowHighlights"), [
    "clearMaterialRowHighlights",
    "bilibili",
    [{ startRow: 5, endRow: 5 }],
    { columnCount: 17 }
  ]);
  assert.deepEqual(calls.at(-1), [
    "highlightSeparatorRows",
    "bilibili",
    [3, 4, 6, 7, 9, 10],
    { columnCount: 17 }
  ]);
});

test("daily writes scope duplicate MMDD separator labels to the active year on every platform", async () => {
  for (const platformId of ["douyin", "xhs", "bilibili"]) {
    const calls = [];
    const dataStartRow = platformId === "douyin" ? 5 : 3;
    const existingRows = [
      separatorRow(platformId, "2026年投稿"),
      separatorRow(platformId, "0605 投稿视频"),
      existingMaterialRow(platformId, "2026-06-05"),
      separatorRow(platformId, "2025年投稿"),
      separatorRow(platformId, "0611 投稿视频"),
      existingMaterialRow(platformId, "2025-06-11")
    ];
    const client = {
      dataStartRow(readPlatformId) {
        assert.equal(readPlatformId, platformId);
        return dataStartRow;
      },
      sheetId(readPlatformId) {
        assert.equal(readPlatformId, platformId);
        return platformId;
      },
      async sheetColumnCount(readPlatformId) {
        assert.equal(readPlatformId, platformId);
        return PLATFORM_HEADERS[platformId].length;
      },
      async readRows(readPlatformId) {
        assert.equal(readPlatformId, platformId);
        return existingRows;
      },
      async prependRows(writePlatformId, rows, startRow) {
        calls.push(["prependRows", writePlatformId, rows, startRow]);
        existingRows.splice(startRow - dataStartRow, 0, ...rows);
        return {
          updates: {
            updatedRange: `${writePlatformId}!A${startRow}:Q${startRow + rows.length - 1}`
          }
        };
      },
      async writeRows(writePlatformId, range, rows) {
        calls.push(["writeRows", writePlatformId, range, rows]);
      },
      async clearMaterialRowHighlights(writePlatformId, ranges, options) {
        calls.push(["clearMaterialRowHighlights", writePlatformId, ranges, options]);
      },
      async highlightSeparatorRows(writePlatformId, rowNumbers, options) {
        calls.push(["highlightSeparatorRows", writePlatformId, rowNumbers, options]);
      }
    };

    const result = await writeDailyPlatformRecords({
      platformId,
      targetDate: "2026-06-11",
      items: [itemForPlatform(platformId, "2026-06-11")],
      client
    });

    assert.equal(result.created, 2, platformId);
    const prependCall = calls.find((call) => call[0] === "prependRows");
    assert.equal(prependCall[3], dataStartRow + 1, platformId);
    assert.deepEqual(prependCall[2].map((row) => row[1]), ["0611 投稿视频", "2026-06-11"], platformId);
  }
});

test("Bilibili daily write creates the missing 2026-06-11 block before older 2026 blocks", async () => {
  const calls = [];
  const existing20260605 = existingMaterialRow("bilibili", "2026-06-05");
  existing20260605[1] = "2026-06-05";
  const existing20250611 = existingMaterialRow("bilibili", "2025-06-11");
  existing20250611[1] = "2025-06-11";
  const existingRows = [
    separatorRow("bilibili", "2026年投稿"),
    separatorRow("bilibili", "0605 投稿视频"),
    existing20260605,
    separatorRow("bilibili", "2025年投稿"),
    separatorRow("bilibili", "0611 投稿视频"),
    existing20250611
  ];
  const items = [
    { id: "BV1a6Ev6qEz2", link: "https://www.bilibili.com/video/BV1a6Ev6qEz2/", accountName: "同花顺投资", title: "同花顺股民专属歌曲", tags: "#tag", publishedAt: "2026-06-11" },
    { id: "BV1X6Ev6qE5a", link: "https://www.bilibili.com/video/BV1X6Ev6qE5a/", accountName: "同花顺投资", title: "盘点科技圈的硬核名词", tags: "#tag", publishedAt: "2026-06-11" },
    { id: "BV1AdEY6SEAR", link: "https://www.bilibili.com/video/BV1AdEY6SEAR/", accountName: "同花顺投资", title: "同花顺给全体股民送祝福", tags: "#tag", publishedAt: "2026-06-11" },
    { id: "BV1WREY6JEic", link: "https://www.bilibili.com/video/BV1WREY6JEic/", accountName: "同花顺投资", title: "AI泡沫VS互联网泡沫", tags: "#tag", publishedAt: "2026-06-11" }
  ];
  const client = {
    dataStartRow(platformId) {
      assert.equal(platformId, "bilibili");
      return 3;
    },
    sheetId(platformId) {
      assert.equal(platformId, "bilibili");
      return "1FOmKl";
    },
    async sheetColumnCount(platformId) {
      assert.equal(platformId, "bilibili");
      return 17;
    },
    async readRows(platformId) {
      assert.equal(platformId, "bilibili");
      return existingRows;
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      existingRows.splice(startRow - 3, 0, ...rows);
      return {
        updates: {
          updatedRange: `1FOmKl!A${startRow}:Q${startRow + rows.length - 1}`
        }
      };
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async clearMaterialRowHighlights(platformId, ranges, options) {
      calls.push(["clearMaterialRowHighlights", platformId, ranges, options]);
    },
    async highlightSeparatorRows(platformId, rowNumbers, options) {
      calls.push(["highlightSeparatorRows", platformId, rowNumbers, options]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "bilibili",
    targetDate: "2026-06-11",
    items,
    client
  });

  assert.equal(result.created, 5);
  const prependCall = calls.find((call) => call[0] === "prependRows");
  assert.equal(prependCall[3], 4);
  assert.deepEqual(prependCall[2].map((row) => row[1]), [
    "0611 投稿视频",
    "2026-06-11",
    "2026-06-11",
    "2026-06-11",
    "2026-06-11"
  ]);
  assert.deepEqual(existingRows.slice(0, 8).map((row) => row[1]), [
    "2026年投稿",
    "0611 投稿视频",
    "2026-06-11",
    "2026-06-11",
    "2026-06-11",
    "2026-06-11",
    "0605 投稿视频",
    "2026-06-05"
  ]);
});

test("Douyin Feishu sync refreshes title and tags on existing duplicate material rows", async () => {
  const calls = [];
  const client = {
    dataStartRow(platformId) {
      assert.equal(platformId, "douyin");
      return 5;
    },
    sheetId(platformId) {
      assert.equal(platformId, "douyin");
      return "d0de52";
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      return [
        ["", "0525 投稿视频", "", "", "", "", "", "", "", "", ""],
        [
          "1",
          "2026-05-25",
          "https://www.douyin.com/note/7643770579069209897",
          "旧标题",
          "#同花顺AP",
          "",
          "",
          "投资号",
          "无",
          "需审核",
          ""
        ]
      ];
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    }
  };

  const result = await writeDailyPlatformRecords({
    platformId: "douyin",
    targetDate: "2026-05-25",
    items: [
      {
        link: "https://www.douyin.com/note/7643770579069209897",
        accountName: "同花顺投资",
        title: "3 万起步，25 岁破亿，游资小鳄鱼的财富曲线",
        tags: "#同花顺APP",
        contentType: "无",
        contentTypeReview: "需审核",
        publishedAt: "2026-05-25"
      }
    ],
    client
  });

  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(calls.some((call) => call[0] === "prependRows"), false);
  assert.deepEqual(
    calls.find((call) => call[0] === "writeRows" && call[2] === "d0de52!D6:E6"),
    [
      "writeRows",
      "douyin",
      "d0de52!D6:E6",
      [["3 万起步，25 岁破亿，游资小鳄鱼的财富曲线", "#同花顺APP"]]
    ]
  );
  assert.deepEqual(
    calls.find((call) => call[0] === "writeRows" && call[2] === "d0de52!J6:J6"),
    [
      "writeRows",
      "douyin",
      "d0de52!J6:J6",
      [["需审核。因为AI判断依据不足，建议复核内容类型。"]]
    ]
  );
});

test("Feishu append uses a range matching the appended row count", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { sheet_id: "4z96Ou", grid_properties: { row_count: 100 } },
                  { sheet_id: "1FOmKl", grid_properties: { row_count: 100 } }
                ]
              }
            });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.appendRows("douyin", [[
    "1",
    "2026-05-19",
    "link",
    "账号",
    "资讯",
    "",
    "",
    "",
    "",
    "",
    "视频",
    "标题",
    "#tag",
    "通过"
  ]]);
  await client.appendRows("xhs", [
    ["", "0519 投稿视频", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-05-19", "link-1", "id-1", "账号", "图文", "", "", "", "", "", "通过", "#tag"],
    ["2", "2026-05-19", "link-2", "id-2", "账号", "图文", "", "", "", "", "", "通过", "#tag"],
    ["3", "2026-05-19", "link-3", "id-3", "账号", "图文", "", "", "", "", "", "通过", "#tag"],
    ["4", "2026-05-19", "link-4", "id-4", "账号", "图文", "", "", "", "", "", "通过", "#tag"],
    ["5", "2026-05-19", "link-5", "id-5", "账号", "图文", "", "", "", "", "", "通过", "#tag"]
  ]);
  await client.appendRows("bilibili", [
    ["", "0519 投稿视频", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-05-19", "link", "BVxxx", "", "", "", "", "同花顺投资", "视频", "标题", "#tag", "无", "需审核"]
  ]);

  assert.equal(requests[0].body.valueRange.range, "d0de52!A1:Q1");
  assert.equal(requests[1].body.valueRange.range, "4z96Ou!A1:P6");
  assert.equal(requests[2].body.valueRange.range, "1FOmKl!A1:O2");
});

test("Feishu prepend inserts blank rows before writing data rows", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { sheet_id: "4z96Ou", grid_properties: { row_count: 100 } },
                  { sheet_id: "1FOmKl", grid_properties: { row_count: 100 } }
                ]
              }
            });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.prependRows("xhs", [
    ["", "0519 投稿视频", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-05-19", "link-1", "id-1", "账号", "图文", "", "", "", "", "", "通过", "#tag"]
  ], 2);
  await client.prependRows("bilibili", [
    ["2", "2026-05-19", "link", "BVxxx", "", "", "", "", "投资号", "视频", "标题", "#tag", "无", "需审核"]
  ], 5);

  const writeRequests = requests.filter((request) => request.method !== "GET");

  assert.match(writeRequests[0].url, /\/insert_dimension_range$/);
  assert.deepEqual(writeRequests[0].body, {
    dimension: {
      sheetId: "4z96Ou",
      majorDimension: "ROWS",
      startIndex: 1,
      endIndex: 3
    },
    inheritStyle: "BEFORE"
  });
  assert.match(writeRequests[1].url, /\/values$/);
  assert.equal(writeRequests[1].body.valueRange.range, "4z96Ou!A2:P3");
  assert.match(writeRequests[2].url, /\/insert_dimension_range$/);
  assert.deepEqual(writeRequests[2].body.dimension, {
    sheetId: "1FOmKl",
    majorDimension: "ROWS",
    startIndex: 4,
    endIndex: 5
  });
  assert.match(writeRequests[3].url, /\/values$/);
  assert.equal(writeRequests[3].body.valueRange.range, "1FOmKl!A5:O5");
});

test("Feishu replaceSheetDataRows chunks large rewrites to avoid RangeVal failures", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { sheet_id: "1FOmKl", grid_properties: { row_count: 5170 } }
                ]
              }
            });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.replaceSheetDataRows("bilibili", [
    ["", "2026年投稿", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["", "0605 投稿视频", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026-06-05", urlCell("https://www.bilibili.com/video/BVchunk/"), "BVchunk", "", "", "", "", "投资号", "视频", "标题", "#tag", "无", "需审核"]
  ], 14);

  const valueWrites = requests.filter((request) => request.url.endsWith("/values"));
  assert.equal(valueWrites.some((request) => request.body.valueRange.range === "1FOmKl!A3:O5170"), false);
  assert.equal(valueWrites[0].body.valueRange.range, "1FOmKl!A3:N1002");
  assert.equal(valueWrites.at(-1).body.valueRange.range, "1FOmKl!A5003:N5170");
  assert.equal(valueWrites.reduce((total, request) => total + request.body.valueRange.values.length, 0), 5168);
});

test("Feishu readRows reads the actual sheet rows in chunks past row 5000", async () => {
  const ranges = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url) {
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { sheet_id: "d0de52", grid_properties: { row_count: 6002 } }
                ]
              }
            });
          }
        };
      }

      if (url.includes("/values/")) {
        const range = decodeURIComponent(url.split("/values/")[1]);
        ranges.push(range);
        const values = range === "d0de52!A1:Q5000"
          ? [
              PLATFORM_DOUYIN_HEADER,
              ...Array.from({ length: 4999 }, (_, index) => [
                String(index + 1),
                "2026-05-19",
                `link-${index + 1}`,
                "投资号",
                "资讯",
                "",
                "",
                "",
                "",
                "",
                "视频",
                "标题",
                "#tag",
                "通过"
              ])
            ]
          : Array.from({ length: 1002 }, (_, index) => [
              String(5000 + index),
              "2026-05-19",
              `link-${5000 + index}`,
              "投资号",
              "资讯",
              "",
              "",
              "",
              "",
              "",
              "视频",
              "标题",
              "#tag",
              "通过"
            ]);
        return {
          ok: true,
          async text() {
            return JSON.stringify({ code: 0, data: { valueRange: { values } } });
          }
        };
      }

      throw new Error(`unexpected request: ${url}`);
    }
  });

  const rows = await client.readRows("douyin");

  assert.deepEqual(ranges, ["d0de52!A1:Q5000", "d0de52!A5001:Q6002"]);
  assert.equal(rows.length, 6001);
  assert.equal(rows.at(-1)[2], "link-6001");
});

test("Feishu readRows detects template header rows and preserves real data row numbers", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({ url, method: options.method || "GET" });
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { properties: { sheet_id: "d0de52", grid_properties: { row_count: 8 } } }
                ]
              }
            });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            code: 0,
            data: {
              valueRange: {
                values: [
                  ["2026目标  10个爆款/月", "", "", "过审核率监控"],
                  ["投稿规则", "1、明显不符合广告平台规则的内容不投"],
                  ["", "2、投稿账号连着2周过审率低于30%，停投2周(每周五观测一次)"],
                  PLATFORM_DOUYIN_HEADER,
                  ["", "0521 投稿视频", "", "", "", "", "", "", "", "", "", "", "", ""],
                  [
                    "1",
                    "2026-05-21",
                    urlCell("https://www.douyin.com/video/1"),
                    "投资号",
                    "资讯",
                    "",
                    "",
                    "",
                    "",
                    "1",
                    "视频",
                    "标题",
                    "#tag",
                    "通过"
                  ]
                ]
              }
            }
          });
        }
      };
    }
  });

  const rows = await client.readRows("douyin");

  assert.equal(PLATFORM_SHEET_LAYOUTS.douyin.headerRow, 4);
  assert.deepEqual(rows[0].slice(0, 2), ["", "0521 投稿视频"]);
  assert.equal(client.headerRow("douyin"), 4);
  assert.equal(client.dataStartRow("douyin"), 5);
  assert.match(decodeURIComponent(requests.find((request) => request.url.includes("/values/")).url), /A1:Q8/);
});

test("writeDailyPlatformRecords inserts template-backed platform rows at the real sheet row", async () => {
  const calls = [];
  let readCount = 0;
  const client = {
    dataStartRow() {
      return 5;
    },
    async readRows(platformId) {
      calls.push(["readRows", platformId]);
      readCount += 1;
      return readCount === 1 ? [
        ["", "0520 投稿视频", "", "", "", "", "", "", "", "", ""],
        ["1", "2026-05-20", urlCell("old-link"), "旧标题", "#old", "", "", "投资号", "资讯", "通过", ""]
      ] : [
        ["", "0521 投稿视频", "", "", "", "", "", "", "", "", ""],
        ["1", "2026-05-21", urlCell("new-link"), "新标题", "#new", "", "", "投资号", "资讯", "通过", ""],
        ["", "0520 投稿视频", "", "", "", "", "", "", "", "", ""],
        ["1", "2026-05-20", urlCell("old-link"), "旧标题", "#old", "", "", "投资号", "资讯", "通过", ""]
      ];
    },
    async prependRows(platformId, rows, startRow) {
      calls.push(["prependRows", platformId, rows, startRow]);
      return {
        updates: {
          updatedRange: "d0de52!A5:K6"
        }
      };
    },
    sheetId() {
      return "d0de52";
    },
    async writeRows(platformId, range, rows) {
      calls.push(["writeRows", platformId, range, rows]);
    },
    async highlightSeparatorRows(platformId, rowNumbers) {
      calls.push(["highlightSeparatorRows", platformId, rowNumbers]);
    },
    async clearMaterialRowHighlights(platformId, ranges) {
      calls.push(["clearMaterialRowHighlights", platformId, ranges]);
    }
  };

  await writeDailyPlatformRecords({
    platformId: "douyin",
    targetDate: "2026-05-21",
    items: [itemForPlatform("douyin", "2026-05-21")],
    client
  });

  const prependCall = calls.find((call) => call[0] === "prependRows");
  assert.equal(prependCall[3], 5);
  const highlightCall = calls.find((call) => call[0] === "highlightSeparatorRows");
  assert.deepEqual(highlightCall[2], [5, 7]);
});

test("applyFeishuSubmissionTemplate is idempotent and reuses the Step 1.5 sheet as Douyin filtered result", async () => {
  const calls = [];
  const rowsBySheet = {
    douyin: [
      PLATFORM_DOUYIN_HEADER,
      ["", "0521 投稿视频", "", "", "", "", "", "", "", "", "", ""]
    ],
    xhs: [
      PLATFORM_XHS_HEADER,
      ["", "0521 投稿视频", "", "", "", "", "", "", ""]
    ],
    bilibili: [
      PLATFORM_BILIBILI_HEADER,
      ["", "0521 投稿视频", "", "", "", "", ""]
    ],
    step15: [
      ["平台", "编号", "投稿时间", "内容链接", "账号", "内容类型", "标题", "tag词", "筛选状态", "命中规则", "简短理由", "本地素材目录"]
    ]
  };
  const step15ExpectedHeader = STEP15_FILTERED_HEADER;
  const client = {
    config: {
      sheets: {
        douyin: "d0de52",
        xhs: "4z96Ou",
        bilibili: "1FOmKl",
        step15: "VIw5q"
      }
    },
    sheetId(sheetKey) {
      return this.config.sheets[sheetKey];
    },
    async listSheets() {
      return [
        { properties: { sheet_id: "VIw5q", title: "Step 1.5 筛选结果" } },
        { properties: { sheet_id: "d0de52", title: "抖音渠道" } },
        { properties: { sheet_id: "4z96Ou", title: "小红书渠道" } },
        { properties: { sheet_id: "1FOmKl", title: "B站渠道" } }
      ];
    },
    async readSheetRows(sheetKey) {
      calls.push(["readSheetRows", sheetKey]);
      return rowsBySheet[sheetKey];
    },
    async insertRowsBefore(sheetKey, startRow, count) {
      calls.push(["insertRowsBefore", sheetKey, startRow, count]);
    },
    async writeRows(sheetKey, range, rows) {
      calls.push(["writeRows", sheetKey, range, rows]);
    },
    async renameSheet(sheetKey, title) {
      calls.push(["renameSheet", sheetKey, title]);
    },
    async mergeCells(sheetKey, range, mergeType) {
      calls.push(["mergeCells", sheetKey, range, mergeType]);
    },
    async setRangeStyle(range, style) {
      calls.push(["setRangeStyle", range, style]);
    },
    async freezeRows(sheetKey, frozenRowCount) {
      calls.push(["freezeRows", sheetKey, frozenRowCount]);
    }
  };

  const result = await applyFeishuSubmissionTemplate({ client });

  assert.equal(result.renamedStep15, true);
  assert.deepEqual(
    calls.filter((call) => call[0] === "insertRowsBefore").map((call) => call.slice(1)),
    [
      ["douyin", 1, 3],
      ["xhs", 1, 1],
      ["bilibili", 1, 1],
      ["step15", 1, 3]
    ]
  );
  assert.ok(calls.some((call) => call[0] === "writeRows" && call[2] === "d0de52!A4:Q4"));
  assert.ok(calls.some((call) => call[0] === "writeRows" && call[2] === "VIw5q!A4:J4"));
  const step15HeaderWrite = calls.find((call) => call[0] === "writeRows" && call[2] === "VIw5q!A4:J4");
  assert.deepEqual(step15HeaderWrite[3][0], step15ExpectedHeader);
  const douyinHeaderWrite = calls.find((call) => call[0] === "writeRows" && call[2] === "d0de52!A4:Q4");
  assert.deepEqual(douyinHeaderWrite[3][0], PLATFORM_DOUYIN_HEADER);
  assert.ok(calls.some((call) => call[0] === "renameSheet" && call[1] === "step15" && call[2] === "抖音筛选结果"));
  const douyinTopWrite = calls.find((call) => call[0] === "writeRows" && call[2] === "d0de52!A1:Q3");
  assert.equal(douyinTopWrite[3][1][8], "期货通");
  assert.match(douyinTopWrite[3][0][9], /内容类型公式/);

  calls.length = 0;
  rowsBySheet.douyin = [
    ["2026目标  10个爆款/月"],
    ["投稿规则"],
    [""],
    PLATFORM_DOUYIN_HEADER
  ];
  rowsBySheet.xhs = [["2026目标  5个爆款/月"], PLATFORM_XHS_HEADER];
  rowsBySheet.bilibili = [["2026目标  2个爆款/月"], PLATFORM_BILIBILI_HEADER];
  rowsBySheet.step15 = [["2026目标  10个爆款/月"], ["投稿规则"], [""], step15ExpectedHeader];

  await applyFeishuSubmissionTemplate({ client });

  assert.equal(calls.some((call) => call[0] === "insertRowsBefore"), false);
});

test("applyFeishuSubmissionTemplate remaps legacy Douyin data rows by header name", async () => {
  const calls = [];
  const legacyDouyinHeader = ["编号", "投稿时间", "内容链接", "账号", "内容类型", "内容类型标签审核", "标题", "tag词", "筛选状态", "命中规则", "简短理由", "本地素材目录"];
  const rowsBySheet = {
    douyin: [
      ["2026目标  10个爆款/月"],
      ["投稿规则"],
      [""],
      legacyDouyinHeader,
      ["1", "2026-05-18", urlCell("https://www.douyin.com/video/1"), "投资号", "资讯", "通过", "旧标题", "#old", "通过", "R1", "旧理由", "/tmp/asset"]
    ],
    xhs: [["2026目标  5个爆款/月"], PLATFORM_XHS_HEADER],
    bilibili: [["2026目标  2个爆款/月"], PLATFORM_BILIBILI_HEADER],
    step15: [["2026目标  10个爆款/月"], ["投稿规则"], [""], STEP15_FILTERED_HEADER]
  };
  const client = {
    config: {
      sheets: {
        douyin: "d0de52",
        xhs: "4z96Ou",
        bilibili: "1FOmKl",
        step15: "VIw5q"
      }
    },
    sheetId(sheetKey) {
      return this.config.sheets[sheetKey];
    },
    async listSheets() {
      return [
        { properties: { sheet_id: "d0de52", title: "抖音渠道" } },
        { properties: { sheet_id: "4z96Ou", title: "小红书渠道" } },
        { properties: { sheet_id: "1FOmKl", title: "B站渠道" } },
        { properties: { sheet_id: "VIw5q", title: "抖音筛选结果" } }
      ];
    },
    async readSheetRows(sheetKey) {
      return rowsBySheet[sheetKey];
    },
    async insertRowsBefore(sheetKey, startRow, count) {
      calls.push(["insertRowsBefore", sheetKey, startRow, count]);
    },
    async writeRows(sheetKey, range, rows) {
      calls.push(["writeRows", sheetKey, range, rows]);
    },
    async mergeCells() {},
    async setRangeStyle() {},
    async freezeRows() {}
  };

  await applyFeishuSubmissionTemplate({ client });

  const migrateCall = calls.find((call) => call[0] === "writeRows" && call[2] === "d0de52!A5:Q5");
  assert.ok(migrateCall, "expected legacy Douyin data rewrite into the new 14-column channel schema");
  assert.deepEqual(migrateCall[3][0], [
    "1",
    "2026-05-18",
    urlCell("https://www.douyin.com/video/1"),
    "投资号",
    "资讯",
    "",
    "",
    "",
    "",
    "",
    "",
    "旧标题",
    "#old",
    "",
    "",
    "通过",
    ""
  ]);
});

test("applyFeishuSubmissionTemplate remaps legacy Bilibili data rows by header name", async () => {
  const calls = [];
  const legacyBilibiliHeader = ["编号", "投稿时间", "内容链接", "短链id", "账号"];
  const rowsBySheet = {
    douyin: [["2026目标  10个爆款/月"], ["投稿规则"], [""], PLATFORM_DOUYIN_HEADER],
    xhs: [["2026目标  5个爆款/月"], PLATFORM_XHS_HEADER],
    bilibili: [
      ["2026目标  2个爆款/月"],
      legacyBilibiliHeader,
      ["1", "2026-05-18", urlCell("https://www.bilibili.com/video/BVlegacy/"), "BVlegacy", "投资号"]
    ],
    step15: [["2026目标  10个爆款/月"], ["投稿规则"], [""], STEP15_FILTERED_HEADER]
  };
  const client = {
    config: {
      sheets: {
        douyin: "d0de52",
        xhs: "4z96Ou",
        bilibili: "1FOmKl",
        step15: "VIw5q"
      }
    },
    sheetId(sheetKey) {
      return this.config.sheets[sheetKey];
    },
    async listSheets() {
      return [
        { properties: { sheet_id: "d0de52", title: "抖音渠道" } },
        { properties: { sheet_id: "4z96Ou", title: "小红书渠道" } },
        { properties: { sheet_id: "1FOmKl", title: "B站渠道" } },
        { properties: { sheet_id: "VIw5q", title: "抖音筛选结果" } }
      ];
    },
    async readSheetRows(sheetKey) {
      return rowsBySheet[sheetKey];
    },
    async insertRowsBefore() {},
    async writeRows(sheetKey, range, rows) {
      calls.push(["writeRows", sheetKey, range, rows]);
    },
    async mergeCells() {},
    async setRangeStyle() {},
    async freezeRows() {}
  };

  await applyFeishuSubmissionTemplate({ client });

  const migrateCall = calls.find((call) => call[0] === "writeRows" && call[2] === "1FOmKl!A3:O3");
  assert.ok(migrateCall, "expected legacy Bilibili data rewrite into the new 14-column channel schema");
  assert.deepEqual(migrateCall[3][0], [
    "1",
    "2026-05-18",
    urlCell("https://www.bilibili.com/video/BVlegacy/"),
    "BVlegacy",
    "",
    "",
    "",
    "",
    "投资号",
    "",
    "",
    "",
    "",
    "",
    ""
  ]);
});

test("Feishu duplicate filtering sees material rows beyond row 5000", async () => {
  const rows = Array.from({ length: 6001 }, (_, index) => [
    String(index + 1),
    "2026-05-19",
    `https://v.douyin.com/${index + 1}/`,
    "投资号",
    "资讯",
    "",
    "",
    "",
    "",
    "",
    "视频",
    "标题",
    "#tag",
    "通过"
  ]);
  rows[0] = ["", "0519 投稿视频", "", "", "", "", "", "", "", "", "", "", "", ""];
  rows[6000][2] = urlCell("https://v.douyin.com/existing-after-5000/");
  const records = buildDailySheetRecords("douyin", "2026-05-19", [
    {
      link: "https://v.douyin.com/existing-after-5000/",
      accountName: "投资号",
      contentType: "资讯",
      title: "旧视频",
      tags: "#tag",
      publishedAt: "2026-05-19"
    }
  ]);

  assert.deepEqual(filterNewDailySheetRecords("douyin", records, rows), []);
});

test("Feishu API errors include endpoint and range context", async () => {
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch() {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 999, msg: "validate RangeVal fail" });
        }
      };
    }
  });

  await assert.rejects(
    () => client.setDropdown("4z96Ou!E2:E200", ["投资号"]),
    /飞书 API 调用失败：validate RangeVal fail（接口：\/open-apis\/sheets\/v2\/spreadsheets\/<token>\/dataValidation；range: 4z96Ou!E2:E200）/
  );
});

test("Feishu dropdown setup configures account and content type columns", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { sheet_id: "4z96Ou", grid_properties: { row_count: 200 } }
                ]
              }
            });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.configurePlatformDropdowns("xhs");

  const dropdownRequests = requests.filter((request) => request.url.endsWith("/dataValidation"));
  assert.equal(dropdownRequests.length, 4);
  assert.equal(dropdownRequests[0].method, "POST");
  assert.equal(dropdownRequests[0].body.range, "4z96Ou!E3:E200");
  assert.equal(dropdownRequests[0].body.dataValidationType, "list");
  assert.deepEqual(dropdownRequests[0].body.dataValidation.conditionValues, XHS_ACCOUNT_DROPDOWN_VALUES);
  assert.equal(dropdownRequests[0].body.dataValidation.options.highlightValidData, true);
  assert.equal(dropdownRequests[0].body.dataValidation.options.multipleValues, false);
  assert.deepEqual(dropdownRequests[0].body.dataValidation.options.colors.slice(0, 3), ["#FFE0A3", "#DCE8FF", "#BFEAF5"]);
  assert.equal(dropdownRequests[1].body.range, "4z96Ou!F3:F200");
  assert.deepEqual(CONTENT_TYPE_DROPDOWN_VALUES, EXPECTED_XHS_CONTENT_TYPES);
  assert.deepEqual(dropdownRequests[1].body.dataValidation.conditionValues, EXPECTED_XHS_CONTENT_TYPES);
  assert.equal(
    dropdownRequests[1].body.dataValidation.options.colors.length,
    EXPECTED_XHS_CONTENT_TYPES.length
  );
  assert.equal(dropdownRequests[2].body.range, "4z96Ou!G3:G200");
  assert.deepEqual(dropdownRequests[2].body.dataValidation.conditionValues, ["是", "否"]);
  assert.equal(dropdownRequests[3].body.range, "4z96Ou!H3:H200");
  assert.deepEqual(dropdownRequests[3].body.dataValidation.conditionValues, ["是", "否"]);
});

test("Feishu dropdown setup caps ranges to avoid RangeVal failures on large sheets", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { sheet_id: "4z96Ou", grid_properties: { row_count: 5027 } }
                ]
              }
            });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.configurePlatformDropdowns("xhs");

  const dropdownRequests = requests.filter((request) => request.url.endsWith("/dataValidation"));
  assert.equal(dropdownRequests[0].body.range, "4z96Ou!E3:E5000");
  assert.equal(dropdownRequests[1].body.range, "4z96Ou!F3:F5000");
  assert.equal(dropdownRequests[2].body.range, "4z96Ou!G3:G5000");
  assert.equal(dropdownRequests[3].body.range, "4z96Ou!H3:H5000");
});

test("Douyin account dropdown options stay separate from XHS and Bilibili", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { sheet_id: "d0de52", grid_properties: { row_count: 200 } },
                  { sheet_id: "1FOmKl", grid_properties: { row_count: 200 } }
                ]
              }
            });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.configurePlatformDropdowns("douyin");
  await client.configurePlatformDropdowns("bilibili");

  const dropdownRequests = requests.filter((request) => request.url.endsWith("/dataValidation"));
  assert.equal(dropdownRequests[0].body.range, "d0de52!D5:D200");
  assert.deepEqual(dropdownRequests[0].body.dataValidation.conditionValues, DOUYIN_ACCOUNT_DROPDOWN_VALUES);
  assert.deepEqual(dropdownRequests[0].body.dataValidation.conditionValues, [
    "投资号",
    "问财",
    "财经号",
    "理财",
    "股民社区",
    "期货通",
    "达人内容",
    "福利官"
  ]);
  assert.equal(dropdownRequests[0].body.dataValidation.conditionValues.includes("喵懂投资"), false);
  assert.equal(dropdownRequests[1].body.range, "d0de52!E5:E200");
  assert.deepEqual(dropdownRequests[1].body.dataValidation.conditionValues, EXPECTED_DOUYIN_CONTENT_TYPES);
  assert.equal(
    dropdownRequests[1].body.dataValidation.options.colors.length,
    EXPECTED_DOUYIN_CONTENT_TYPES.length
  );
  assert.equal(dropdownRequests[2].body.range, "d0de52!F5:F200");
  assert.deepEqual(dropdownRequests[2].body.dataValidation.conditionValues, ["是", "否"]);
  assert.equal(dropdownRequests[3].body.range, "d0de52!G5:G200");
  assert.deepEqual(dropdownRequests[3].body.dataValidation.conditionValues, ["是", "否"]);
  assert.equal(dropdownRequests[4].body.range, "1FOmKl!E3:E200");
  assert.deepEqual(dropdownRequests[4].body.dataValidation.conditionValues, ["是", "否"]);
  assert.equal(dropdownRequests[5].body.range, "1FOmKl!F3:F200");
  assert.deepEqual(dropdownRequests[5].body.dataValidation.conditionValues, ["是", "否"]);
  assert.equal(dropdownRequests[6].body.range, "1FOmKl!I3:I200");
  assert.deepEqual(dropdownRequests[6].body.dataValidation.conditionValues, ["投资号"]);
  assert.equal(dropdownRequests[7].body.range, "1FOmKl!M3:M200");
  assert.deepEqual(BILIBILI_CONTENT_TYPE_DROPDOWN_VALUES, EXPECTED_BILIBILI_CONTENT_TYPES);
  assert.deepEqual(dropdownRequests[7].body.dataValidation.conditionValues, EXPECTED_BILIBILI_CONTENT_TYPES);
  assert.equal(
    dropdownRequests[7].body.dataValidation.options.colors.length,
    EXPECTED_BILIBILI_CONTENT_TYPES.length
  );
});

test("Step 1.5 filtered result dropdowns cover account, content type, and manual yes/no columns", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl",
      step15: "VIw5q"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      if (url.includes("/sheets/query")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                sheets: [
                  { sheet_id: "VIw5q", grid_properties: { row_count: 200 } }
                ]
              }
            });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.configurePlatformDropdowns("step15");

  const dropdownRequests = requests.filter((request) => request.url.endsWith("/dataValidation"));
  assert.equal(dropdownRequests.length, 4);
  assert.equal(dropdownRequests[0].body.range, "VIw5q!D5:D200");
  assert.deepEqual(dropdownRequests[0].body.dataValidation.conditionValues, DOUYIN_ACCOUNT_DROPDOWN_VALUES);
  assert.equal(dropdownRequests[1].body.range, "VIw5q!E5:E200");
  assert.deepEqual(dropdownRequests[1].body.dataValidation.conditionValues, EXPECTED_DOUYIN_CONTENT_TYPES);
  assert.equal(dropdownRequests[2].body.range, "VIw5q!G5:G200");
  assert.deepEqual(dropdownRequests[2].body.dataValidation.conditionValues, ["是", "否"]);
  assert.equal(dropdownRequests[3].body.range, "VIw5q!H5:H200");
  assert.deepEqual(dropdownRequests[3].body.dataValidation.conditionValues, ["是", "否"]);
});

test("Feishu write highlights daily separator rows with the configured color", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });

      if (url.includes("/values/")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({ code: 0, data: { valueRange: { values: [PLATFORM_XHS_HEADER] } } });
          }
        };
      }

      if (url.endsWith("/values")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                updates: {
                  updatedRange: "4z96Ou!A2:G7"
                }
              }
            });
          }
        };
      }

      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await writeDailyPlatformRecords({
    platformId: "xhs",
    targetDate: "2026-05-19",
    items: [
      { link: "link-1", id: "id-1", accountName: "账号", contentType: "图文", tags: "#tag", publishedAt: "2026-05-19" },
      { link: "link-2", id: "id-2", accountName: "账号", contentType: "图文", tags: "#tag", publishedAt: "2026-05-19" },
      { link: "link-3", id: "id-3", accountName: "账号", contentType: "图文", tags: "#tag", publishedAt: "2026-05-19" },
      { link: "link-4", id: "id-4", accountName: "账号", contentType: "图文", tags: "#tag", publishedAt: "2026-05-19" },
      { link: "link-5", id: "id-5", accountName: "账号", contentType: "图文", tags: "#tag", publishedAt: "2026-05-19" }
    ],
    client
  });

  const styleRequest = requests.find((request) => request.url.endsWith("/styles_batch_update"));
  assert.equal(styleRequest.method, "PUT");
  assert.deepEqual(styleRequest.body, {
    data: [
      {
        ranges: ["4z96Ou!A2:P2"],
        style: {
          backColor: "#FEF258"
        }
      }
    ]
  });
});

test("Feishu separator highlighting batches and coalesces row ranges", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.highlightSeparatorRows("bilibili", [3, 4, 10, 10, 12, 13, 14]);

  const batchRequest = requests.find((request) => request.url.endsWith("/styles_batch_update"));
  assert.equal(batchRequest.method, "PUT");
  assert.deepEqual(batchRequest.body, {
    data: [
      {
        ranges: ["1FOmKl!A3:O4", "1FOmKl!A10:O10", "1FOmKl!A12:O14"],
        style: {
          backColor: "#FEF258"
        }
      }
    ]
  });
  assert.equal(requests.some((request) => request.url.endsWith("/style")), false);
});

test("Feishu row highlight helpers can cover visible extension columns", async () => {
  const requests = [];
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await client.highlightSeparatorRows("douyin", [5], { columnCount: 17 });
  await client.clearMaterialRowHighlights("douyin", [{ startRow: 6, endRow: 7 }], { columnCount: 17 });

  const separatorRequest = requests.find((request) => request.url.endsWith("/styles_batch_update"));
  assert.deepEqual(separatorRequest.body.data[0].ranges, ["d0de52!A5:Q5"]);
  const materialRequest = requests.find((request) => request.url.endsWith("/style"));
  assert.equal(materialRequest.body.appendStyle.range, "d0de52!A6:Q7");
});

test("Bilibili Feishu writes keep material rows unhighlighted when inserting above highlighted separators", async () => {
  const requests = [];
  let readCount = 0;
  const client = new FeishuSheetsClient({
    appId: "cli_xxx",
    appSecret: "secret",
    spreadsheetToken: "sht_xxx",
    wikiToken: "",
    apiBaseUrl: "https://open.feishu.cn",
    sheets: {
      douyin: "d0de52",
      xhs: "4z96Ou",
      bilibili: "1FOmKl"
    }
  }, {
    tenantAccessToken: "tenant_token",
    async fetch(url, options = {}) {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });

      if (url.includes("/values/")) {
        readCount += 1;
        const values = readCount === 1
          ? [
              PLATFORM_BILIBILI_HEADER,
              ["", "0519 投稿视频", "", "", "", "", ""],
              ["1", "2026-05-19", "old-link", "BVold", "投资号", "旧标题", "#old"]
            ]
          : [
              PLATFORM_BILIBILI_HEADER,
              ["", "0520 投稿视频", "", "", "", "", ""],
              ["1", "2026-05-20", "new-link", "BVnew", "投资号", "新标题", "#new"],
              ["", "0519 投稿视频", "", "", "", "", ""],
              ["1", "2026-05-19", "old-link", "BVold", "投资号", "旧标题", "#old"]
            ];
        return {
          ok: true,
          async text() {
            return JSON.stringify({ code: 0, data: { valueRange: { values } } });
          }
        };
      }

      if (url.endsWith("/values")) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                updates: {
                  updatedRange: "1FOmKl!A2:G3"
                }
              }
            });
          }
        };
      }

      return {
        ok: true,
        async text() {
          return JSON.stringify({ code: 0, data: {} });
        }
      };
    }
  });

  await writeDailyPlatformRecords({
    platformId: "bilibili",
    targetDate: "2026-05-20",
    items: [
      {
        link: "new-link",
        id: "BVnew",
        accountName: "同花顺投资",
        title: "新标题",
        tags: "#new",
        publishedAt: "2026-05-20"
      }
    ],
    client
  });

  const insertRequest = requests.find((request) => request.url.endsWith("/insert_dimension_range"));
  assert.equal(insertRequest.body.inheritStyle, "BEFORE");

  const styleRequests = requests.filter((request) => request.url.endsWith("/style"));
  assert.deepEqual(styleRequests.map((request) => request.body.appendStyle), [
    {
      range: "1FOmKl!A3:O3",
      style: {
        backColor: "#FFFFFF"
      }
    }
  ]);
  const separatorStyleRequest = requests.find((request) => request.url.endsWith("/styles_batch_update"));
  assert.deepEqual(separatorStyleRequest.body, {
    data: [
      {
        ranges: ["1FOmKl!A2:O2", "1FOmKl!A4:O4"],
        style: {
          backColor: "#FEF258"
        }
      }
    ]
  });
});

test("login probe classifies valid, invalid, blocked, and unknown states", () => {
  assert.deepEqual(classifyLoginProbe("bilibili", {
    text: "同花顺投资的个人空间",
    cookies: [{ name: "SESSDATA" }]
  }), {
    status: "valid",
    valid: true,
    message: "登录有效，检测到关键登录 Cookie。"
  });

  assert.deepEqual(classifyLoginProbe("xhs", {
    text: "推荐 关注 热门",
    cookies: [{ name: "id_token" }]
  }), {
    status: "valid",
    valid: true,
    message: "登录有效，检测到关键登录 Cookie。"
  });

  assert.deepEqual(classifyLoginProbe("xhs", {
    title: "安全限制",
    url: "https://www.xiaohongshu.com/website-login/error?error_msg=IP%E5%AD%98%E5%9C%A8%E9%A3%8E%E9%99%A9",
    cookies: [{ name: "id_token" }]
  }), {
    status: "blocked",
    valid: false,
    message: "页面疑似触发风控或安全验证，当前登录态不可直接用于采集。"
  });

  assert.deepEqual(classifyLoginProbe("xhs", {
    text: "登录小红书 发现更多精彩内容",
    cookies: []
  }), {
    status: "invalid",
    valid: false,
    message: "登录已失效或未登录，页面出现登录提示。"
  });

  assert.deepEqual(classifyLoginProbe("douyin", {
    text: "安全验证 访问过于频繁",
    cookies: [{ name: "sessionid" }]
  }), {
    status: "blocked",
    valid: false,
    message: "页面疑似触发风控或安全验证，当前登录态不可直接用于采集。"
  });

  assert.deepEqual(classifyLoginProbe("xhs", {
    text: "推荐 关注 热门",
    cookies: []
  }), {
    status: "unknown",
    valid: null,
    message: "页面未出现登录提示，但没有检测到关键登录 Cookie，无法确认登录有效。"
  });
});

test("all-channel login gate requires every platform to be valid", () => {
  assert.deepEqual(summarizeLoginCheckResults([
    { label: "小红书", valid: true },
    { label: "抖音", valid: true },
    { label: "B站", valid: true }
  ]), {
    ok: true,
    failedLabels: [],
    message: "三个平台登录状态均正常。"
  });

  assert.deepEqual(summarizeLoginCheckResults([
    { label: "小红书", valid: true },
    { label: "抖音", valid: null },
    { label: "B站", valid: false }
  ]), {
    ok: false,
    failedLabels: ["抖音", "B站"],
    message: "全渠道启动已中止：抖音、B站登录状态未通过。"
  });
});
