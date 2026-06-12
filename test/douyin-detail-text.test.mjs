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

test("extractDouyinTags flags and repairs known truncated brand tags", () => {
  const text = "#同顺图解 #玩转同 #玩转同花 #同花顺投 #同花顺股民话 #同花顺钱 #投 #理 #期货通 #同顺图";

  assert.equal(extractDouyinTags(text), "#同顺图解 #玩转同花顺 #同花顺投资 #同花顺股民话题 #同花顺钱包 #期货通");
  assert.equal(isLowConfidenceDouyinTags(text), true);
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

test("extractDouyinApiDetail reads the target item from Douyin post-list responses", () => {
  const result = extractDouyinApiDetail({
    aweme_list: [
      {
        aweme_id: "7640000000000000000",
        desc: "推荐作品 #无关",
        text_extra: [
          { hashtag_name: "无关" }
        ]
      },
      {
        aweme_id: "7646703866871844139",
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
  }, { itemId: "7646703866871844139" });

  assert.equal(result.title, "前 5 月 A 股最赚钱和最亏钱的行业都在这了！你踩中了哪个");
  assert.equal(result.tags, "#同顺图解 #同顺盘点 #玩转同花顺");
  assert.equal(localDateKey(result.publishedAt), "2026-06-02");
  assert.equal(result.authorName, "同花顺投资");
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

test("extractDouyinTitle removes copied share prefix before the first tag", () => {
  const shareText = "5.35 H@v.sE gOK:/ :0pm 03/28 五月涨跌幅前十股票盘点 # 同顺盘点 # 玩转同花顺 # 投资 # 财经  https://v.douyin.com/X8b3pyLqBEY/ 复制此链接，打开Dou音搜索，直接观看视频！";

  assert.equal(extractDouyinTitle({ shareText }), "五月涨跌幅前十股票盘点");
  assert.equal(extractDouyinTagsFromSources({ shareText }), "#同顺盘点 #玩转同花顺 #投资 #财经");
});

test("extractDouyinTitle preserves numeric title prefixes after copied share codes", () => {
  const shareText = "3.84 Bgb:/ :9pm s@E.uF 06/03 520防渣指南！。你的自选有没有海王股？# 问财 # 问财问句 # 给同花顺的情书  https://v.douyin.com/ajyQHOgQ_yM/ 复制此链接，打开Dou音搜索，直接观看视频！";

  assert.equal(extractDouyinTitle({ shareText }), "520防渣指南！。你的自选有没有海王股？");
  assert.equal(extractDouyinTagsFromSources({ shareText }), "#问财 #问财问句 #给同花顺的情书");
});

test("extractDouyinTitle preserves separated numeric title prefixes", () => {
  const shareText = "5.35 H@v.sE gOK:/ :0pm 03/28 1234 存钱法 # 投资 https://v.douyin.com/example/ 复制此链接，打开Dou音搜索，直接观看视频！";

  assert.equal(extractDouyinTitle({ shareText }), "1234 存钱法");
});

test("extractDouyinTitle falls back to page title and removes Douyin suffixes", () => {
  assert.equal(
    extractDouyinTitle({ titleText: "一文看懂今日市场机会 - 抖音" }),
    "一文看懂今日市场机会"
  );
});
