import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PLATFORM_HEADERS,
  buildDailySheetRecords,
  mapDailyRecordToFeishuFields,
  mapDailyRecordToSheetRow
} from "../src/daily-records.mjs";
import { collectDaily } from "../src/collect-daily-runner.mjs";
import { classifyPlatformItems } from "../src/daily/classify-platform.mjs";
import {
  DEFAULT_MINIMAX_BASE_URL,
  buildAiContentRemark,
  classifyContentWithFallback,
  fetchWithTimeout,
  formatContentTypeReview,
  loadMiniMaxConfig
} from "../src/ai/content-classification.mjs";
import { shouldBlockFeishuWriteback } from "../src/materials/failure-gate.mjs";
import { classifyBrowserFallbackError } from "../src/materials/browser-fallback.mjs";
import {
  buildYtDlpArgs,
  cachePlatformMaterials,
  downloadMaterialWithYtDlp,
  formatNetscapeCookies
} from "../src/materials/cache.mjs";
import { detectXhsMaterialKind } from "../src/platforms/xhs/material-kind.mjs";
import { checkMaterialCookies, defaultCommandExists } from "../src/config-checks.mjs";
import { downloadExtractedMedia } from "../src/douyin-channel-type-classifier/assets.mjs";

function urlCell(link) {
  return { type: "url", text: link, link };
}

test("MiniMax defaults to the China-region OpenAI-compatible base URL", () => {
  assert.equal(DEFAULT_MINIMAX_BASE_URL, "https://api.minimaxi.com/v1");
  assert.equal(loadMiniMaxConfig({ MINIMAX_API_KEY: "sk-test" }).baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(
    loadMiniMaxConfig({
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1/"
    }).baseUrl,
    "https://api.minimaxi.com/v1"
  );
});

test("AI fetch helper aborts stalled requests with a bounded timeout", async () => {
  let signalSeen = false;
  let abortSeen = false;

  await assert.rejects(
    () => fetchWithTimeout("https://api.example.test/chat/completions", {
      method: "POST"
    }, {
      label: "MiniMax 分类",
      timeoutMs: 10,
      fetch: async (url, options) => {
        assert.equal(url, "https://api.example.test/chat/completions");
        signalSeen = Boolean(options.signal);
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            abortSeen = true;
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }
    }),
    /MiniMax 分类请求超时：10ms/u
  );
  assert.equal(signalSeen, true);
  assert.equal(abortSeen, true);

  await assert.rejects(
    () => Promise.race([
      fetchWithTimeout("https://api.example.test/chat/completions", {
        method: "POST"
      }, {
        label: "MiniMax 分类",
        timeoutMs: 10,
        fetch: async () => new Promise(() => {})
      }),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("request did not time out")), 50))
    ]),
    /MiniMax 分类请求超时：10ms/u
  );

  const response = await fetchWithTimeout("https://api.example.test/chat/completions", {
    method: "POST"
  }, {
    label: "MiniMax 分类",
    timeoutMs: 10,
    fetch: async () => ({
      ok: true,
      status: 200,
      async text() {
        return new Promise(() => {});
      }
    })
  });
  await assert.rejects(
    () => Promise.race([
      response.text(),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("response body did not time out")), 50))
    ]),
    /MiniMax 分类响应读取超时：10ms/u
  );
});

test("XHS material kind normalizes explicit video, image note, and unknown fallback", () => {
  assert.equal(detectXhsMaterialKind({ itemType: "video" }), "视频");
  assert.equal(detectXhsMaterialKind({ mediaType: "image", imageUrls: ["https://p.example/a.jpg"] }), "图文");
  assert.equal(detectXhsMaterialKind({ title: "只有标题的未知素材" }), "图文");
});

test("material cache logs failures and retries the same material on later runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-material-retry-"));
  const logs = [];
  const item = {
    id: "retry-note-1",
    link: "https://www.xiaohongshu.com/discovery/item/retry-note-1",
    title: "可重抓素材",
    materialKind: "视频",
    publishedAt: "2026-03-09"
  };
  let attempts = 0;
  const download = async ({ itemDir }) => {
    attempts += 1;
    if (attempts === 1) return { ok: false, error: "mock download failed", assets: [] };
    const imagePath = path.join(itemDir, "cover.jpg");
    await fs.writeFile(imagePath, "image", "utf8");
    return { ok: true, error: "", assets: [{ kind: "image", path: imagePath }] };
  };

  const first = await cachePlatformMaterials({
    platformId: "xhs",
    items: [item],
    targetDate: "2026-03-09",
    root,
    download,
    captureFallbackMaterial: async ({ previousResult }) => previousResult,
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: (line) => logs.push(line)
  });
  const manifestPath = path.join(root, "output", "2026-03-09", "xhs", "retry-note-1", "manifest.json");
  const failedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  assert.equal(first.stats.failed, 1);
  assert.equal(failedManifest.ok, false);
  assert.match(failedManifest.error, /mock download failed/u);
  assert.equal(logs.some((line) => /小红书素材获取失败/u.test(line) && /mock download failed/u.test(line)), true);

  const second = await cachePlatformMaterials({
    platformId: "xhs",
    items: [item],
    targetDate: "2026-03-09",
    root,
    download,
    captureFallbackMaterial: async ({ previousResult }) => previousResult,
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: (line) => logs.push(line)
  });
  const retriedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  assert.equal(attempts, 2);
  assert.equal(second.stats.failed, 0);
  assert.equal(retriedManifest.ok, true);
  assert.equal(retriedManifest.assets.length, 1);
});

test("XHS current Feishu header omits the removed 图文/视频 Q column", () => {
  assert.equal(PLATFORM_HEADERS.xhs.includes("图文/视频"), false);
  assert.equal(PLATFORM_HEADERS.xhs.length, 16);

  const rows = buildDailySheetRecords("xhs", "2026-03-09", [
    {
      link: "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare",
      id: "6a0c4c5e000000003502a761",
      accountName: "同花顺投资",
      contentType: "不应采用",
      primaryType: "视频",
      secondaryType: "资讯",
      title: "主力资金盘点",
      tags: "#同顺盘点",
      materialKind: "视频",
      contentTypeReview: "通过。因为标题和tag均指向资金盘面盘点。",
      aiContentRemark: "使用minimax，使用多模态能力。",
      publishedAt: "2026-03-09"
    }
  ]);

  const fields = mapDailyRecordToFeishuFields("xhs", rows[1]);
  assert.equal(fields["投稿时间"], "2026-03-09");
  assert.equal(fields["内容类型"], "盘点");
  assert.equal(fields["一级类型"], "视频");
  assert.equal(fields["二级类型"], "资讯");
  assert.equal(Object.hasOwn(fields, "图文/视频"), false);
  assert.equal(fields["AI内容判断备注"], "使用minimax，使用多模态能力。");

  const row = mapDailyRecordToSheetRow("xhs", rows[1]);
  assert.deepEqual(row[2], urlCell("https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761?source=webshare&xhsshare=pc_web&xsec_source=pc_share"));
  assert.equal(row.length, 16);
  assert.equal(row[5].values[0], "盘点");
  assert.equal(row[12], "视频");
});

test("Douyin and Bilibili map upgraded classification fields to current Feishu headers", () => {
  assert.deepEqual(PLATFORM_HEADERS.douyin.slice(13), ["一级类型", "二级类型", "内容类型标签审核", "AI内容判断备注"]);
  assert.deepEqual(PLATFORM_HEADERS.bilibili.slice(12), ["内容类型", "内容类型标签审核", "AI内容判断备注"]);

  const douyinRows = buildDailySheetRecords("douyin", "2026-03-09", [
    {
      link: "https://www.douyin.com/video/7641910769218506003",
      accountName: "同花顺投资",
      contentType: "不应采用",
      primaryType: "盘点",
      secondaryType: "资金盘面盘点",
      title: "主力资金盘点",
      tags: "#同花顺资讯",
      contentTypeReview: "通过。因为标题和tag均指向资金盘面盘点。",
      aiContentRemark: "使用minimax，没有使用多模态能力。",
      publishedAt: "2026-03-09"
    }
  ]);
  assert.equal(mapDailyRecordToFeishuFields("douyin", douyinRows[1])["投稿时间"], "2026-03-09");
  assert.equal(mapDailyRecordToFeishuFields("douyin", douyinRows[1])["内容类型"], "资讯");
  assert.equal(mapDailyRecordToFeishuFields("douyin", douyinRows[1])["一级类型"], "盘点");
  assert.equal(mapDailyRecordToFeishuFields("douyin", douyinRows[1])["二级类型"], "资金盘面盘点");

  const bilibiliRows = buildDailySheetRecords("bilibili", "2026-03-09", [
    {
      link: "https://www.bilibili.com/video/BV1tNLA6hEQh/",
      id: "BV1tNLA6hEQh",
      accountName: "同花顺投资",
      contentType: "大佬生平",
      primaryType: "大佬生平",
      secondaryType: "不应写入",
      title: "黄仁勋的AI教父之路",
      tags: "#财经 #同顺AI剧场 #投资 #玩转同花顺 #影视",
      contentTypeReview: "通过。因为标题指向人物传记故事。",
      aiContentRemark: "使用deepseek，没有使用多模态能力。",
      publishedAt: "2026-03-09"
    }
  ]);
  const bilibiliFields = mapDailyRecordToFeishuFields("bilibili", bilibiliRows[1]);
  assert.equal(bilibiliFields["投稿时间"], "2026-03-09");
  assert.equal(bilibiliFields["内容类型"], "大佬生平");
  assert.equal(Object.hasOwn(bilibiliFields, "二级类型"), false);
});

test("AI fallback uses MiniMax multimodal first, MiniMax text without assets, then DeepSeek only when MiniMax fails", async () => {
  const multimodal = await classifyContentWithFallback({
    platformId: "douyin",
    item: { title: "主力资金盘点", tags: "#同顺盘点" },
    materialManifest: { assets: [{ kind: "image", path: "/tmp/frame.jpg" }] },
    minimaxClassify: async ({ hasMaterial }) => ({
      ok: true,
      primaryType: "盘点",
      secondaryType: "资金盘面盘点",
      confidence: 0.87,
      reason: hasMaterial ? "抽帧和标题都指向资金盘面盘点" : "标题指向资金盘面盘点"
    }),
    deepseekClassify: async () => {
      throw new Error("should not call DeepSeek");
    }
  });
  assert.equal(multimodal.provider, "minimax");
  assert.equal(multimodal.usedMultimodal, true);
  assert.match(multimodal.aiContentRemark, /使用minimax，使用多模态能力/u);

  const textOnly = await classifyContentWithFallback({
    platformId: "xhs",
    item: { title: "主力资金盘点", tags: "#同顺盘点" },
    materialManifest: { assets: [] },
    minimaxClassify: async ({ hasMaterial }) => ({
      ok: true,
      primaryType: "盘点",
      secondaryType: "资金盘面盘点",
      confidence: hasMaterial ? 0.9 : 0.76,
      reason: "标题和tag指向资金盘面盘点"
    })
  });
  assert.equal(textOnly.provider, "minimax");
  assert.equal(textOnly.usedMultimodal, false);
  assert.match(textOnly.aiContentRemark, /使用minimax，没有使用多模态能力/u);

  const fallback = await classifyContentWithFallback({
    platformId: "bilibili",
    item: { title: "市场资讯", tags: "#同花顺资讯" },
    materialManifest: { assets: [{ kind: "video", path: "/tmp/video.mp4" }] },
    minimaxClassify: async () => {
      throw new Error("MiniMax 503");
    },
    deepseekClassify: async () => ({
      ok: true,
      primaryType: "资讯",
      secondaryType: "忽略",
      confidence: 0.71,
      reason: "标题和tag指向资讯"
    })
  });
  assert.equal(fallback.provider, "deepseek");
  assert.equal(fallback.usedMultimodal, false);
  assert.equal(fallback.secondaryType, "");
  assert.equal(fallback.ok, false);
  assert.equal(fallback.contentType, "无");
  assert.notEqual(fallback.contentType, "资讯");
  assert.match(fallback.contentTypeReview, /^需审核。因为B站内容类型只能是/u);
  assert.match(fallback.aiContentRemark, /使用deepseek，没有使用多模态能力/u);
  assert.match(fallback.aiContentRemark, /MiniMax API失效/u);
});

test("AI fallback retries MiniMax text before DeepSeek when multimodal MiniMax rejects assets", async () => {
  const calls = [];
  const result = await classifyContentWithFallback({
    platformId: "bilibili",
    item: { title: "两分钟带你看懂，什么是做T？", tags: "#硬核财经知识必看" },
    materialManifest: { assets: [{ kind: "image", path: "/tmp/frame.jpg" }] },
    minimaxClassify: async ({ hasMaterial, mediaMode }) => {
      calls.push({ hasMaterial, mediaMode });
      if (hasMaterial) return { ok: false, reason: "MiniMax API 422: image is sensitive" };
      return {
        ok: true,
        primaryType: "新手教学指标教学",
        secondaryType: "",
        confidence: 0.86,
        reason: "标题指向交易方法教学。"
      };
    },
    deepseekClassify: async () => {
      throw new Error("should not call DeepSeek when MiniMax text succeeds");
    }
  });

  assert.deepEqual(calls, [
    { hasMaterial: true, mediaMode: "sampled-media" },
    { hasMaterial: false, mediaMode: "text-only" }
  ]);
  assert.equal(result.provider, "minimax");
  assert.equal(result.usedMultimodal, false);
  assert.equal(result.contentType, "新手教学指标教学");
  assert.match(result.aiContentRemark, /使用minimax，没有使用多模态能力/u);
});

test("Bilibili AI prompts and normalization enforce the local five-label taxonomy", async () => {
  let minimaxRequestBody = null;
  const minimaxResult = await classifyContentWithFallback({
    platformId: "bilibili",
    item: {
      title: "黄仁勋的AI教父之路",
      tags: "#财经 #同顺AI剧场 #投资 #玩转同花顺 #影视"
    },
    materialManifest: { assets: [] },
    env: {
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
      MINIMAX_MODEL: "MiniMax-M3"
    },
    fetch: async (url, options) => {
      assert.equal(url, "https://api.minimaxi.com/v1/chat/completions");
      minimaxRequestBody = JSON.parse(options.body);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  primaryType: "大佬生平",
                  secondaryType: "不应保留",
                  confidence: 0.88,
                  reason: "标题指向人物传记故事"
                })
              }
            }]
          });
        }
      };
    }
  });
  const minimaxPrompt = minimaxRequestBody.messages[1].content
    .map((entry) => entry.text || "")
    .join("\n");
  assert.match(minimaxPrompt, /primaryType 只能是：采访内容、大佬生平、新手教学指标教学、海外搬运、短视频/u);
  assert.match(minimaxPrompt, /secondaryType 必须是空字符串/u);
  assert.match(minimaxPrompt, /不允许输出 资讯/u);
  assert.equal(minimaxResult.ok, true);
  assert.equal(minimaxResult.contentType, "大佬生平");
  assert.equal(minimaxResult.secondaryType, "");

  let deepseekRequestBody = null;
  const deepseekResult = await classifyContentWithFallback({
    platformId: "bilibili",
    item: {
      title: "黄仁勋的AI教父之路",
      tags: "#财经 #同顺AI剧场 #投资 #玩转同花顺 #影视"
    },
    materialManifest: { assets: [] },
    env: {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-chat"
    },
    fetch: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      deepseekRequestBody = JSON.parse(options.body);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  primaryType: "大佬生平",
                  secondaryType: "",
                  confidence: 0.81,
                  reason: "标题指向人物传记故事"
                })
              }
            }]
          });
        }
      };
    }
  });
  const deepseekPrompt = deepseekRequestBody.messages.map((message) => message.content).join("\n");
  assert.equal(deepseekRequestBody.model, "deepseek-v4-flash");
  assert.match(deepseekPrompt, /primaryType 只能是：采访内容、大佬生平、新手教学指标教学、海外搬运、短视频/u);
  assert.match(deepseekPrompt, /secondaryType 必须是空字符串/u);
  assert.equal(deepseekResult.provider, "deepseek");
  assert.equal(deepseekResult.contentType, "大佬生平");
  assert.equal(deepseekResult.secondaryType, "");
});

test("Bilibili short-video classification is accepted as single-layer content type", async () => {
  const result = await classifyContentWithFallback({
    platformId: "bilibili",
    item: {
      title: "同花顺股民专属歌曲——《牛蝶》送给牛市中的大家！",
      tags: "#财经 #股票 #同花顺 #股民 #知识"
    },
    materialManifest: { assets: [] },
    minimaxClassify: async () => ({
      ok: true,
      primaryType: "短视频",
      secondaryType: "不应保留",
      confidence: 0.83,
      reason: "标题指向轻量歌曲祝福类短视频。"
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.contentType, "短视频");
  assert.equal(result.primaryType, "短视频");
  assert.equal(result.secondaryType, "");
});

test("XHS AI normalization rejects labels outside the local primary and secondary taxonomy", async () => {
  const result = await classifyContentWithFallback({
    platformId: "xhs",
    item: { title: "主力资金盘点", tags: "#同顺盘点" },
    materialManifest: { assets: [] },
    minimaxClassify: async () => ({
      ok: true,
      primaryType: "盘点",
      secondaryType: "资金盘面盘点",
      confidence: 0.9,
      reason: "标题和tag指向盘点"
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.contentType, "无");
  assert.equal(result.primaryType, "");
  assert.match(result.contentTypeReview, /^需审核。因为小红书一级类型只能是图文或视频/u);
});

test("Douyin MiniMax normalization rejects labels outside the local primary and secondary taxonomy", async () => {
  const invalidPrimary = await classifyContentWithFallback({
    platformId: "douyin",
    item: { title: "市场热点", tags: "#财经" },
    materialManifest: { assets: [{ kind: "image", path: "/tmp/frame.jpg" }] },
    minimaxClassify: async () => ({
      ok: true,
      primaryType: "资讯",
      secondaryType: "",
      confidence: 0.9,
      reason: "模型返回了旧标签"
    })
  });
  assert.equal(invalidPrimary.ok, false);
  assert.equal(invalidPrimary.contentType, "无");
  assert.match(invalidPrimary.contentTypeReview, /^需审核。因为抖音一级类型只能是/u);

  const invalidSecondary = await classifyContentWithFallback({
    platformId: "douyin",
    item: { title: "主力资金盘点", tags: "#同顺盘点" },
    materialManifest: { assets: [{ kind: "image", path: "/tmp/frame.jpg" }] },
    minimaxClassify: async () => ({
      ok: true,
      primaryType: "盘点",
      secondaryType: "股民洞察",
      confidence: 0.9,
      reason: "二级类型不属于盘点"
    })
  });
  assert.equal(invalidSecondary.ok, false);
  assert.equal(invalidSecondary.contentType, "无");
  assert.match(invalidSecondary.contentTypeReview, /^需审核。因为抖音盘点二级类型只能是/u);
});

test("MiniMax multimodal request embeds readable local image assets and marks true multimodal usage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-minimax-assets-"));
  const imagePath = path.join(root, "frame.jpg");
  await fs.writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  let requestBody = null;

  const result = await classifyContentWithFallback({
    platformId: "xhs",
    item: { title: "主力资金盘点", tags: "#同顺盘点" },
    materialManifest: { assets: [{ kind: "image", path: imagePath }] },
    env: {
      MINIMAX_API_KEY: "sk-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
      MINIMAX_MODEL: "MiniMax-M3"
    },
    fetch: async (url, options) => {
      assert.equal(url, "https://api.minimaxi.com/v1/chat/completions");
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  primaryType: "盘点",
                  secondaryType: "资金盘面盘点",
                  confidence: 0.82,
                  reason: "标题、tag和图片均指向盘点"
                })
              }
            }]
          });
        }
      };
    }
  });

  const userContent = requestBody.messages[1].content;
  assert.equal(userContent.some((entry) => entry.type === "image_url" && entry.image_url.url.startsWith("data:image/jpeg;base64,")), true);
  assert.equal(result.provider, "minimax");
  assert.equal(result.usedMultimodal, true);
  assert.match(result.aiContentRemark, /使用minimax，使用多模态能力/u);
});

test("classification normalizes platform IDs before matching cached manifests", async () => {
  const items = [{
    link: "https://www.douyin.com/video/7641910769218506003",
    title: "主力资金盘点",
    tags: "#同花顺资讯",
    publishedAt: "2026-03-09"
  }];

  const classified = await classifyPlatformItems({
    platformId: "douyin",
    items,
    materialResult: {
      manifests: [{
        id: "7641910769218506003",
        assets: [{ kind: "image", path: "/tmp/frame.jpg" }]
      }]
    },
    classify: async ({ item, materialManifest }) => {
      assert.equal(item.id, "7641910769218506003");
      assert.equal(materialManifest.id, "7641910769218506003");
      return {
        ok: true,
        primaryType: "盘点",
        secondaryType: "资金盘面盘点",
        contentTypeReview: "通过。因为命中素材。",
        aiContentRemark: "使用minimax，使用多模态能力。"
      };
    }
  });

  assert.equal(classified[0].id, "7641910769218506003");
  assert.equal(classified[0].contentType, "资讯");
  assert.equal(classified[0].primaryType, "盘点");
});

test("XHS classification keeps tag content type separate from AI primary and secondary types", async () => {
  const [classified] = await classifyPlatformItems({
    platformId: "xhs",
    items: [{
      link: "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761",
      title: "主力资金盘点",
      tags: "#同顺盘点",
      publishedAt: "2026-03-09"
    }],
    materialResult: {
      manifests: [{
        id: "6a0c4c5e000000003502a761",
        assets: [{ kind: "image", path: "/tmp/frame.jpg" }]
      }]
    },
    classify: async () => ({
      ok: true,
      primaryType: "视频",
      secondaryType: "资讯",
      contentTypeReview: "通过。因为视频素材指向资讯。",
      aiContentRemark: "使用minimax，使用多模态能力。"
    })
  });

  assert.equal(classified.contentType, "盘点");
  assert.equal(classified.primaryType, "视频");
  assert.equal(classified.secondaryType, "资讯");
});

test("content review text always starts with pass or needs-review plus one-sentence reason", () => {
  assert.equal(
    formatContentTypeReview({ ok: true, confidence: 0.56, reason: "标题和tag同时指向资金盘面盘点。" }),
    "通过。因为标题和tag同时指向资金盘面盘点。"
  );
  assert.equal(
    formatContentTypeReview({ ok: true, confidence: 0.2, reason: "只有标题线索，置信度较低。" }),
    "需审核。因为只有标题线索，置信度较低。"
  );
  assert.equal(
    buildAiContentRemark({ provider: "minimax", usedMultimodal: false }),
    "使用minimax，没有使用多模态能力。"
  );
});

test("material failure gate blocks Feishu writeback at 30 percent or 10 consecutive failures", () => {
  assert.equal(shouldBlockFeishuWriteback({ total: 1, failed: 1, consecutiveFailures: 1 }).blocked, false);
  assert.equal(shouldBlockFeishuWriteback({ total: 100, failed: 29, consecutiveFailures: 0 }).blocked, false);
  assert.equal(shouldBlockFeishuWriteback({ total: 100, failed: 30, consecutiveFailures: 0 }).blocked, true);
  assert.equal(shouldBlockFeishuWriteback({ total: 50, failed: 1, consecutiveFailures: 10 }).blocked, true);
});

test("tool checks use the correct version flag for ffmpeg and ffprobe", async () => {
  const ffmpeg = await defaultCommandExists("ffmpeg", {
    spawn: (command, args) => fakeVersionProcess({ command, args, okArgs: ["-version"], output: "ffmpeg version 8.1.1" })
  });
  const ffprobe = await defaultCommandExists("ffprobe", {
    spawn: (command, args) => fakeVersionProcess({ command, args, okArgs: ["-version"], output: "ffprobe version 8.1.1" })
  });
  const ytdlp = await defaultCommandExists("yt-dlp", {
    spawn: (command, args) => fakeVersionProcess({ command, args, okArgs: ["--version"], output: "2026.06.09" })
  });

  assert.deepEqual(ffmpeg, { ok: true, version: "ffmpeg version 8.1.1" });
  assert.deepEqual(ffprobe, { ok: true, version: "ffprobe version 8.1.1" });
  assert.deepEqual(ytdlp, { ok: true, version: "2026.06.09" });
});

test("config checks explain material cookie strategy without exposing secrets", () => {
  assert.deepEqual(checkMaterialCookies({}).status, "ok");
  assert.match(checkMaterialCookies({}).message, /临时导出 Cookie/u);
  assert.equal(checkMaterialCookies({ MATERIAL_EXPORT_PROFILE_COOKIES: "0" }).status, "warn");
  assert.equal(checkMaterialCookies({ BILIBILI_MATERIAL_YTDLP_COOKIES: "/secret/cookies.txt" }).status, "ok");
  assert.doesNotMatch(checkMaterialCookies({ BILIBILI_MATERIAL_YTDLP_COOKIES: "/secret/cookies.txt" }).message, /secret|cookies\.txt/u);
});

test("material downloader passes cookies, low-resolution format, and platform referer to yt-dlp", () => {
  const args = buildYtDlpArgs({
    platformId: "bilibili",
    item: { link: "https://www.bilibili.com/video/BV1tNLA6hEQh/" },
    itemDir: "/tmp/material",
    cookiePath: "/tmp/cookies.txt",
    env: {}
  });

  assert.deepEqual(args.slice(0, 9), [
    "--no-playlist",
    "--ignore-errors",
    "--no-warnings",
    "--format",
    "worstvideo*+bestaudio/worst/best",
    "--retries",
    "5",
    "--fragment-retries",
    "5"
  ]);
  assert.equal(args.includes("--cookies"), true);
  assert.equal(args[args.indexOf("--cookies") + 1], "/tmp/cookies.txt");
  assert.equal(args[args.indexOf("--referer") + 1], "https://www.bilibili.com/");
  assert.equal(args.at(-1), "https://www.bilibili.com/video/BV1tNLA6hEQh/");
});

test("material downloader supports platform-specific yt-dlp cookie overrides", () => {
  const args = buildYtDlpArgs({
    platformId: "xhs",
    item: { link: "https://www.xiaohongshu.com/discovery/item/6a0c4c5e000000003502a761" },
    itemDir: "/tmp/material",
    cookiePath: "/tmp/exported.txt",
    env: {
      XHS_MATERIAL_YTDLP_COOKIES: "/tmp/xhs-cookies.txt",
      MATERIAL_YTDLP_EXTRA_ARGS: "--sleep-requests 1"
    }
  });

  assert.equal(args[args.indexOf("--cookies") + 1], "/tmp/xhs-cookies.txt");
  assert.equal(args.includes("--sleep-requests"), true);
  assert.equal(args[args.indexOf("--sleep-requests") + 1], "1");
});

test("Netscape cookie export keeps HttpOnly marker for yt-dlp cookies", () => {
  const text = formatNetscapeCookies([
    {
      domain: ".bilibili.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: 1780000000.8,
      name: "SESSDATA",
      value: "secret"
    }
  ]);

  assert.match(text, /^# Netscape HTTP Cookie File/m);
  assert.match(text, /^#HttpOnly_\.bilibili\.com\tTRUE\t\/\tTRUE\t1780000000\tSESSDATA\tsecret$/m);
});

test("material downloader keeps partial yt-dlp assets for multimodal fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-partial-material-"));
  await fs.writeFile(path.join(root, "cover.jpg"), "jpg", "utf8");

  const result = await downloadMaterialWithYtDlp({
    platformId: "bilibili",
    item: { link: "https://www.bilibili.com/video/BV1tNLA6hEQh/" },
    itemDir: root,
    downloadContext: { cookiePath: "/tmp/cookies.txt" },
    env: {},
    run: async () => ({ code: 1, stdout: "", stderr: "video stream failed" })
  });

  assert.equal(result.ok, true);
  assert.match(result.error, /部分失败/u);
  assert.deepEqual(result.assets.map((asset) => asset.fileName), ["cover.jpg"]);
});

test("material cache stores multi-day manifests under each publish date directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-material-cache-"));
  const sourceJsonPath = path.join(root, "output", "douyin_notes_2026-03-09_to_2026-03-10.json");
  await fs.mkdir(path.dirname(sourceJsonPath), { recursive: true });
  await fs.writeFile(sourceJsonPath, JSON.stringify({ items: [] }), "utf8");

  const result = await cachePlatformMaterials({
    platformId: "douyin",
    sinceDate: "2026-03-09",
    untilDate: "2026-03-10",
    root,
    sourceJsonPath,
    items: [
      { id: "7641910769218506003", link: "https://www.douyin.com/video/7641910769218506003", publishedAt: "2026-03-09" },
      { id: "7641910769218506004", link: "https://www.douyin.com/video/7641910769218506004", publishedAt: "2026-03-10" }
    ],
    download: async ({ itemDir }) => {
      const fileName = "cover.jpg";
      await fs.writeFile(path.join(itemDir, fileName), "jpg");
      return { ok: true, assets: [{ kind: "image", fileName }] };
    },
    log: () => {}
  });

  assert.equal(result.stats.total, 2);
  assert.equal(await fileExists(path.join(root, "output", "2026-03-09", "douyin", "7641910769218506003", "manifest.json")), true);
  assert.equal(await fileExists(path.join(root, "output", "2026-03-10", "douyin", "7641910769218506004", "manifest.json")), true);
  assert.equal(await fileExists(path.join(root, "output", "2026-03-09", path.basename(sourceJsonPath).replace(/^/, "douyin-"))), true);
  assert.equal(await fileExists(path.join(root, "output", "2026-03-10", path.basename(sourceJsonPath).replace(/^/, "douyin-"))), true);
});

test("Douyin note material cache uses visual fallback when yt-dlp does not support the URL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-douyin-note-fallback-"));
  const sourceJsonPath = path.join(root, "output", "douyin_notes_2026-03-09_to_2026-03-09.json");
  await fs.mkdir(path.dirname(sourceJsonPath), { recursive: true });
  await fs.writeFile(sourceJsonPath, JSON.stringify({ items: [] }), "utf8");

  const result = await cachePlatformMaterials({
    platformId: "douyin",
    sinceDate: "2026-03-09",
    untilDate: "2026-03-09",
    root,
    sourceJsonPath,
    items: [
      {
        id: "7641910769218506003",
        link: "https://www.douyin.com/note/7641910769218506003",
        title: "图文素材",
        publishedAt: "2026-03-09"
      }
    ],
    download: async () => ({
      ok: false,
      error: "yt-dlp 下载失败，退出码 1",
      stderr: "ERROR: Unsupported URL",
      assets: []
    }),
    captureFallbackMaterial: async ({ itemDir }) => {
      const fileName = "fallback.jpg";
      await fs.writeFile(path.join(itemDir, fileName), "jpg");
      return {
        ok: true,
        error: "yt-dlp 下载失败，退出码 1；已使用抖音图文视觉兜底素材。",
        assets: [{ kind: "image", fileName }]
      };
    },
    log: () => {}
  });

  assert.equal(result.stats.total, 1);
  assert.equal(result.stats.failed, 0);
  assert.equal(result.gate.blocked, false);
  assert.equal(result.manifests[0].ok, true);
  assert.match(result.manifests[0].error, /视觉兜底素材/u);
  assert.equal(result.manifests[0].assets[0].fileName, "fallback.jpg");
});

test("XHS image-note material cache uses browser fallback before yt-dlp", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-xhs-image-browser-first-"));
  const sourceJsonPath = path.join(root, "output", "xhs_notes_2026-03-09_to_2026-03-09.json");
  const logs = [];
  await fs.mkdir(path.dirname(sourceJsonPath), { recursive: true });
  await fs.writeFile(sourceJsonPath, JSON.stringify({ items: [] }), "utf8");

  let downloadCalled = false;
  let fallbackCalled = false;
  const result = await cachePlatformMaterials({
    platformId: "xhs",
    sinceDate: "2026-03-09",
    untilDate: "2026-03-09",
    root,
    sourceJsonPath,
    items: [
      {
        id: "6a2bcd2300000000220196b2",
        link: "https://www.xiaohongshu.com/discovery/item/6a2bcd2300000000220196b2",
        title: "小红书图文素材",
        materialKind: "图文",
        publishedAt: "2026-03-09"
      }
    ],
    download: async () => {
      downloadCalled = true;
      throw new Error("xhs image notes should not call yt-dlp first");
    },
    captureFallbackMaterial: async ({ platformId, itemDir, previousResult }) => {
      fallbackCalled = true;
      assert.equal(platformId, "xhs");
      assert.match(previousResult.error, /yt-dlp 不适用/u);
      const fileName = "browser-fallback.jpg";
      await fs.writeFile(path.join(itemDir, fileName), "jpg");
      return {
        ok: true,
        source: "browser-fallback",
        fallbackReason: "yt-dlp 不适用：小红书图文素材优先使用浏览器兜底。",
        error: "已使用小红书图文浏览器兜底素材。",
        assets: [{ kind: "image", fileName }]
      };
    },
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: (line) => logs.push(line)
  });

  const manifest = JSON.parse(await fs.readFile(
    path.join(root, "output", "2026-03-09", "xhs", "6a2bcd2300000000220196b2", "manifest.json"),
    "utf8"
  ));
  assert.equal(downloadCalled, false);
  assert.equal(fallbackCalled, true);
  assert.equal(result.stats.failed, 0);
  assert.equal(manifest.ok, true);
  assert.equal(manifest.source, "browser-fallback");
  assert.match(manifest.fallbackReason, /yt-dlp 不适用/u);
  assert.equal(manifest.assets[0].fileName, "browser-fallback.jpg");
  assert.equal(manifest.imagePaths.length, 1);
  assert.equal(logs.some((line) => /小红书图文素材使用浏览器兜底/u.test(line)), true);
});

test("XHS daily JSON contentType image notes use browser fallback before yt-dlp", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-xhs-content-type-browser-first-"));
  let downloadCalled = false;
  let fallbackCalled = false;

  const result = await cachePlatformMaterials({
    platformId: "xhs",
    items: [
      {
        platform: "xhs",
        accountName: "测试账号",
        publishedAt: "2026-03-09",
        link: "https://www.xiaohongshu.com/discovery/item/6a2bcd2300000000220196b2?xsec_token=test",
        id: "6a2bcd2300000000220196b2",
        title: "真实 daily JSON 图文素材",
        tags: "#股票",
        contentType: "图文",
        contentTypeReview: "通过。因为素材形态为图文。"
      }
    ],
    targetDate: "2026-03-09",
    root,
    download: async () => {
      downloadCalled = true;
      throw new Error("xhs contentType image notes should not call yt-dlp first");
    },
    captureFallbackMaterial: async ({ itemDir, previousResult }) => {
      fallbackCalled = true;
      assert.match(previousResult.error, /yt-dlp 不适用/u);
      const fileName = "content-type-browser.jpg";
      await fs.writeFile(path.join(itemDir, fileName), "jpg");
      return {
        ok: true,
        source: "browser-fallback",
        fallbackReason: previousResult.fallbackReason,
        assets: [{ kind: "image", fileName }]
      };
    },
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: () => {}
  });

  assert.equal(downloadCalled, false);
  assert.equal(fallbackCalled, true);
  assert.equal(result.stats.failed, 0);
  assert.equal(result.manifests[0].source, "browser-fallback");
  assert.equal(result.manifests[0].assets[0].fileName, "content-type-browser.jpg");
});

test("XHS notes without explicit image-note signals keep yt-dlp first before browser fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-xhs-unknown-ytdlp-first-"));
  let downloadCalled = false;
  let fallbackCalled = false;

  const result = await cachePlatformMaterials({
    platformId: "xhs",
    items: [
      {
        id: "unknown-kind",
        link: "https://www.xiaohongshu.com/discovery/item/unknown-kind",
        title: "未知素材形态",
        tags: "#股票",
        publishedAt: "2026-03-09"
      }
    ],
    targetDate: "2026-03-09",
    root,
    download: async ({ itemDir }) => {
      downloadCalled = true;
      const fileName = "thumbnail.jpg";
      await fs.writeFile(path.join(itemDir, fileName), "jpg");
      return { ok: true, assets: [{ kind: "image", fileName }] };
    },
    captureFallbackMaterial: async () => {
      fallbackCalled = true;
      return { ok: false, assets: [] };
    },
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: () => {}
  });

  assert.equal(downloadCalled, true);
  assert.equal(fallbackCalled, false);
  assert.equal(result.stats.failed, 0);
  assert.equal(result.manifests[0].assets[0].fileName, "thumbnail.jpg");
});

test("XHS tag-mapped image notes use browser fallback before yt-dlp even without materialKind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-xhs-tag-image-browser-first-"));
  let downloadCalled = false;
  let fallbackCalled = false;

  const result = await cachePlatformMaterials({
    platformId: "xhs",
    items: [
      {
        id: "tag-image-note",
        link: "https://www.xiaohongshu.com/discovery/item/tag-image-note",
        title: "图解素材",
        tags: "#同顺图解 #投资",
        publishedAt: "2026-03-09"
      }
    ],
    targetDate: "2026-03-09",
    root,
    download: async () => {
      downloadCalled = true;
      return { ok: false, assets: [] };
    },
    captureFallbackMaterial: async ({ itemDir, previousResult }) => {
      fallbackCalled = true;
      assert.match(previousResult.error, /yt-dlp 不适用/u);
      const fileName = "tag-browser.jpg";
      await fs.writeFile(path.join(itemDir, fileName), "jpg");
      return {
        ok: true,
        source: "browser-fallback",
        fallbackReason: previousResult.fallbackReason,
        assets: [{ kind: "image", fileName }]
      };
    },
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: () => {}
  });

  assert.equal(downloadCalled, false);
  assert.equal(fallbackCalled, true);
  assert.equal(result.stats.failed, 0);
  assert.equal(result.manifests[0].assets[0].fileName, "tag-browser.jpg");
});

test("XHS image-note browser fallback failure writes rerunnable failure manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-xhs-browser-fail-"));
  const logs = [];
  let downloadCalled = false;

  const result = await cachePlatformMaterials({
    platformId: "xhs",
    items: [
      {
        id: "6a2bbfd3000000002200b0cf",
        link: "https://www.xiaohongshu.com/discovery/item/6a2bbfd3000000002200b0cf",
        title: "兜底失败图文",
        materialKind: "图文",
        publishedAt: "2026-03-09"
      }
    ],
    targetDate: "2026-03-09",
    root,
    download: async () => {
      downloadCalled = true;
      return {
        ok: false,
        error: "yt-dlp 下载失败，退出码 1",
        stderr: "ERROR: [XiaoHongShu] No video formats found!",
        assets: []
      };
    },
    captureFallbackMaterial: async () => ({
      ok: false,
      source: "browser-fallback",
      fallbackReason: "yt-dlp 不适用：小红书图文素材优先使用浏览器兜底。",
      error: "小红书浏览器兜底失败：未找到图片资源。",
      assets: []
    }),
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: (line) => logs.push(line)
  });

  const manifestPath = path.join(root, "output", "2026-03-09", "xhs", "6a2bbfd3000000002200b0cf", "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(downloadCalled, false);
  assert.equal(result.stats.failed, 1);
  assert.equal(manifest.ok, false);
  assert.equal(manifest.source, "browser-fallback");
  assert.match(manifest.fallbackReason, /yt-dlp 不适用/u);
  assert.match(manifest.error, /小红书浏览器兜底失败/u);
  assert.match(manifest.error, /未找到图片资源/u);
  assert.equal(logs.some((line) => /小红书浏览器兜底失败/u.test(line)), true);
  assert.equal(logs.some((line) => /后续重跑可重新抓取/u.test(line)), true);
});

test("XHS browser fallback treats inaccessible note pages as login or risk failures", () => {
  assert.equal(
    classifyBrowserFallbackError(
      "xhs",
      "https://www.xiaohongshu.com/404?error_msg=%E5%BD%93%E5%89%8D%E7%AC%94%E8%AE%B0%E6%9A%82%E6%97%B6%E6%97%A0%E6%B3%95%E6%B5%8F%E8%A7%88"
    ),
    "页面风控/登录失效"
  );
  assert.equal(classifyBrowserFallbackError("xhs", "当前笔记暂时无法浏览"), "页面风控/登录失效");
});

test("video material cache keeps yt-dlp first and falls back to page screenshots after failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-video-screenshot-fallback-"));
  let downloadCalled = false;
  let fallbackCalled = false;

  const result = await cachePlatformMaterials({
    platformId: "xhs",
    items: [
      {
        id: "video-403",
        link: "https://www.xiaohongshu.com/discovery/item/video-403",
        title: "视频素材",
        materialKind: "视频",
        publishedAt: "2026-03-09"
      }
    ],
    targetDate: "2026-03-09",
    root,
    download: async () => {
      downloadCalled = true;
      return {
        ok: false,
        error: "yt-dlp 下载失败，退出码 1",
        stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden",
        assets: []
      };
    },
    captureFallbackMaterial: async ({ itemDir, previousResult }) => {
      fallbackCalled = true;
      assert.match(previousResult.stderr, /403/u);
      const fileName = "page-screenshot.jpg";
      await fs.writeFile(path.join(itemDir, fileName), "jpg");
      return {
        ok: true,
        source: "browser-fallback",
        fallbackReason: "视频 yt-dlp 失败后页面截图兜底。",
        error: "yt-dlp 下载失败，退出码 1；已使用页面截图兜底素材。",
        assets: [{ kind: "image", fileName }]
      };
    },
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: () => {}
  });

  assert.equal(downloadCalled, true);
  assert.equal(fallbackCalled, true);
  assert.equal(result.stats.failed, 0);
  assert.equal(result.manifests[0].ok, true);
  assert.equal(result.manifests[0].source, "browser-fallback");
  assert.equal(result.manifests[0].assets[0].fileName, "page-screenshot.jpg");
});

test("Bilibili video material cache also falls back to page screenshots after yt-dlp failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-bilibili-video-screenshot-fallback-"));
  let downloadCalled = false;
  let fallbackCalled = false;

  const result = await cachePlatformMaterials({
    platformId: "bilibili",
    items: [
      {
        id: "BV1tNLA6hEQh",
        bvid: "BV1tNLA6hEQh",
        link: "https://www.bilibili.com/video/BV1tNLA6hEQh/",
        title: "B站视频素材",
        materialKind: "视频",
        publishedAt: "2026-03-09"
      }
    ],
    targetDate: "2026-03-09",
    root,
    download: async () => {
      downloadCalled = true;
      return {
        ok: false,
        error: "yt-dlp 下载失败，退出码 1",
        stderr: "ERROR: unable to download video data",
        assets: []
      };
    },
    captureFallbackMaterial: async ({ itemDir, previousResult }) => {
      fallbackCalled = true;
      assert.match(previousResult.error, /yt-dlp/u);
      const fileName = "bilibili-page-screenshot.jpg";
      await fs.writeFile(path.join(itemDir, fileName), "jpg");
      return {
        ok: true,
        source: "browser-fallback",
        fallbackReason: "视频 yt-dlp 失败后页面截图兜底。",
        error: "yt-dlp 下载失败，退出码 1；已使用页面截图兜底素材。",
        assets: [{ kind: "image", fileName }]
      };
    },
    env: { MATERIAL_EXPORT_PROFILE_COOKIES: "0" },
    log: () => {}
  });

  assert.equal(downloadCalled, true);
  assert.equal(fallbackCalled, true);
  assert.equal(result.stats.failed, 0);
  assert.equal(result.manifests[0].ok, true);
  assert.equal(result.manifests[0].source, "browser-fallback");
  assert.equal(result.manifests[0].assets[0].fileName, "bilibili-page-screenshot.jpg");
});

test("Douyin extracted media fallback bounds stalled media downloads", async () => {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-douyin-media-timeout-"));

  const result = await Promise.race([
    downloadExtractedMedia({
      assetDir,
      extracted: { imageUrls: ["https://media.example.test/stall.jpg"] },
      timeoutMs: 10,
      fetch: async () => new Promise(() => {})
    }),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error("media download did not time out")), 50))
  ]);

  assert.equal(result.hasVisualMedia, false);
  assert.equal(result.imagePaths.length, 0);
  assert.equal(result.downloadAttempts.length, 1);
  assert.match(result.downloadAttempts[0].error, /抖音图片媒体下载请求超时：10ms/u);
});

async function fileExists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

function fakeVersionProcess({ command, args, okArgs, output }) {
  const listeners = {};
  const stdoutListeners = {};
  const stderrListeners = {};
  const matches = command && JSON.stringify(args) === JSON.stringify(okArgs);
  const child = {
    stdout: { on: (event, handler) => { stdoutListeners[event] = handler; } },
    stderr: { on: (event, handler) => { stderrListeners[event] = handler; } },
    on: (event, handler) => { listeners[event] = handler; }
  };
  queueMicrotask(() => {
    if (matches) {
      stdoutListeners.data?.(Buffer.from(`${output}\n`));
      listeners.close?.(0);
    } else {
      stderrListeners.data?.(Buffer.from(`${command}: unrecognized option ${args.join(" ")}\n`));
      listeners.close?.(1);
    }
  });
  return child;
}

test("collectDaily skips platform Feishu writeback when material acquisition failure gate trips", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harvester-daily-upgrade-"));
  const calls = [];

  const result = await collectDaily({
    root,
    targetDate: "2026-03-09",
    platforms: ["douyin"],
    skipFeishu: false,
    crawlMode: "conservative",
    createClient: () => ({ client: true }),
    runPlatformCrawler: async (platformId) => {
      calls.push(`crawl:${platformId}`);
    },
    readPlatformItems: async (platformId) => {
      calls.push(`read:${platformId}`);
      return Array.from({ length: 10 }, (_, index) => ({
        link: `https://www.douyin.com/video/${index + 1}`,
        id: String(index + 1),
        title: `素材${index + 1}`,
        tags: "#同顺盘点",
        publishedAt: "2026-03-09"
      }));
    },
    cachePlatformMaterials: async ({ platformId }) => {
      calls.push(`cache:${platformId}`);
      return {
        manifests: [],
        stats: {
          total: 10,
          failed: 3,
          consecutiveFailures: 0
        }
      };
    },
    classifyPlatformItems: async () => {
      calls.push("classify");
      return [];
    },
    writePlatformJsonToFeishu: async ({ platformId }) => {
      calls.push(`write:${platformId}`);
      return { collected: 10, feishu: { created: 10, skipped: 0 } };
    },
    log: () => {}
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["crawl:douyin", "read:douyin", "cache:douyin"]);
  assert.equal(result.summary.platforms.douyin.status, "asset_blocked");
  assert.match(result.summary.platforms.douyin.error, /素材获取失败率达到阈值/u);
});
