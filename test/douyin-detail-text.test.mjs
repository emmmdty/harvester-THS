import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDouyinApiDetail,
  extractDouyinPublishedAtFromText,
  extractDouyinTags,
  extractDouyinTagsFromSources,
  extractDouyinTitle,
  isLowConfidenceDouyinTags
} from "../src/douyin-detail-text.mjs";

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

test("extractDouyinTags normalizes spaced tags and removes duplicates", () => {
  const text = "你会推荐哪一本呢？ # 同花顺APP #同花顺股民话题 # 同花顺APP # 投资";

  assert.equal(extractDouyinTags(text), "#同花顺APP #同花顺股民话题 #投资");
});

test("extractDouyinTags filters truncated Douyin tag tokens without removing valid short tags", () => {
  const text = "机会来了 # 同花顺AP # 同花顺A # 同花 # 同 # - # A股 # 问财 # 股市";

  assert.equal(extractDouyinTags(text), "#同花顺APP #A股 #问财 #股市");
});

test("extractDouyinTagsFromSources falls back to copied share text before page body", () => {
  const result = extractDouyinTagsFromSources({
    itemText: "三大运营商集体押注Token套餐！\n发布时间：2026-05-21 12:29",
    titleText: "三大运营商集体押注Token套餐！ - 抖音",
    shareText: "3.21 G@xY 三大运营商集体押注Token套餐！ # 同花顺资讯 # 投资 https://v.douyin.com/xxx/ 复制此链接，打开抖音搜索，直接观看视频！",
    bodyText: "推荐视频\n#英语\n#绘本阅读"
  });

  assert.equal(result, "#同花顺资讯 #投资");
});

test("extractDouyinTagsFromSources avoids unrelated recommendation tags from page body", () => {
  const result = extractDouyinTagsFromSources({
    itemText: "三大运营商集体押注Token套餐！\n发布时间：2026-05-21 12:29",
    titleText: "三大运营商集体押注Token套餐！ - 抖音",
    shareText: "",
    bodyText: "推荐视频\n海光信息正式发布机密Token技术 #海光信息 #人工智能\n热门：#英语 #绘本阅读"
  });

  assert.equal(result, "");
});

test("extractDouyinTagsFromSources uses share text when page tags are truncated", () => {
  const result = extractDouyinTagsFromSources({
    itemText: "2026 年科技行业，各赛道三巨头盘点 # 同顺图解 # -",
    titleText: "2026 年科技行业，各赛道三巨头盘点 # 同顺图解 # - - 抖音",
    shareText: "8.20 a@b 2026 年科技行业，各赛道三巨头盘点 # 同顺图解 # 同花顺APP # 投资 https://v.douyin.com/xxx/ 复制此链接，打开抖音搜索，直接观看视频！"
  });

  assert.equal(result, "#同顺图解 #同花顺APP #投资");
});

test("extractDouyinApiDetail falls back to current video category tags", () => {
  const result = extractDouyinApiDetail({
    aweme_id: "7642197548827970857",
    desc: "三大运营商集体押注Token套餐！",
    create_time: 1779337782,
    author: {
      sec_uid: "MS4wLjABAAAArf6v6Z48Pma-bIrz00wVCu76ioePN0vKzHAM_w9DN8AOkLekEk13Ay8_L-74BBB8",
      nickname: "同花顺投资"
    },
    text_extra: [],
    video_tag: [
      { tag_name: "财经" },
      { tag_name: "投资理财" },
      { tag_name: "股票" }
    ],
    share_info: {
      share_desc_info: "#在抖音，记录美好生活#三大运营商集体押注Token套餐！"
    }
  });

  assert.equal(result.title, "三大运营商集体押注Token套餐！");
  assert.equal(result.tags, "#财经 #投资理财 #股票");
  assert.equal(result.authorProfileUrl, "https://www.douyin.com/user/MS4wLjABAAAArf6v6Z48Pma-bIrz00wVCu76ioePN0vKzHAM_w9DN8AOkLekEk13Ay8_L-74BBB8");
  assert.equal(result.publishedAt.toISOString(), "2026-05-21T04:29:42.000Z");
});

test("extractDouyinApiDetail uses create_time even when title contains another date", () => {
  const result = extractDouyinApiDetail({
    desc: "5月22日涨停复盘！",
    create_time: Date.parse("2026-05-24T10:00:00+08:00") / 1000
  });

  assert.equal(localDateKey(result.publishedAt), "2026-05-24");
});

test("extractDouyinPublishedAtFromText ignores business dates without publish labels", () => {
  assert.equal(
    extractDouyinPublishedAtFromText("5月22日涨停复盘！\n点赞 100", "2026-05-24"),
    null
  );
});

test("extractDouyinPublishedAtFromText parses explicit publish labels", () => {
  const result = extractDouyinPublishedAtFromText("标题\n发布时间：2026-05-22 18:00", "2026-05-24");

  assert.equal(localDateKey(result), "2026-05-22");
});

test("extractDouyinApiDetail prefers explicit hashtag metadata over category tags", () => {
  const result = extractDouyinApiDetail({
    desc: "市场机会来了 # 同花顺资讯 #投资",
    text_extra: [
      { hashtag_name: "同花顺资讯" },
      { hashtag_name: "投资" }
    ],
    video_tag: [
      { tag_name: "财经" }
    ]
  });

  assert.equal(result.tags, "#同花顺资讯 #投资");
});

test("extractDouyinApiDetail replaces truncated desc tags with explicit hashtag metadata", () => {
  const result = extractDouyinApiDetail({
    desc: "3 万起步，25 岁破亿，游资小鳄鱼的财富曲线 # 同花顺AP",
    text_extra: [
      { hashtag_name: "同花顺APP" },
      { hashtag_name: "投资" }
    ],
    video_tag: [
      { tag_name: "财经" }
    ]
  });

  assert.equal(result.tags, "#同花顺APP #投资");
});

test("isLowConfidenceDouyinTags flags old cached truncated tags", () => {
  assert.equal(isLowConfidenceDouyinTags("#同花顺AP"), true);
  assert.equal(isLowConfidenceDouyinTags("#同顺图解 #-"), true);
  assert.equal(isLowConfidenceDouyinTags("#A股 #问财 #股市"), false);
});

test("extractDouyinTitle reads the first useful detail text line", () => {
  const itemText = [
    "你会推荐哪一本呢？ #同花顺APP #投资",
    "发布时间：2026-05-20 10:30",
    "点赞 12 评论 3"
  ].join("\n");

  assert.equal(extractDouyinTitle({ itemText }), "你会推荐哪一本呢？");
});

test("extractDouyinTitle falls back to copied share text without URL or copy prompt", () => {
  const shareText = "0.76 G@I.vf 07/17 EhO:/ :3pm 你会推荐哪一本呢？ # 同花顺APP # 同花顺股民话题 https://v.douyin.com/lSMXFkKpTGs/ 复制此链接，打开Dou音搜索，直接观看视频！";

  assert.equal(extractDouyinTitle({ shareText }), "你会推荐哪一本呢？");
});

test("extractDouyinTitle falls back to page title and removes Douyin suffixes", () => {
  assert.equal(
    extractDouyinTitle({ titleText: "一文看懂今日市场机会 - 抖音" }),
    "一文看懂今日市场机会"
  );
});
