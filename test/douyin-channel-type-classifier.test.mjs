import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyDouyinChannelType,
  parseDeepSeekTypeResponse,
  validateClassification
} from "../src/douyin-channel-type-classifier/classifier.mjs";
import { buildClassificationMessages } from "../src/douyin-channel-type-classifier/prompt.mjs";
import {
  classifyDouyinChannelTypeWithMiniMax,
  detectPrimaryTypeCandidates
} from "../src/douyin-channel-type-classifier/multimodal.mjs";

test("prompt builder asks for strict JSON and includes title and tags", () => {
  const messages = buildClassificationMessages({
    title: "6月1日涨停股复盘！",
    tags: "#同顺盘点 #投资"
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /只返回 JSON/u);
  assert.match(messages[0].content, /primaryType/u);
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /6月1日涨停股复盘/u);
  assert.match(messages[1].content, /#同顺盘点/u);
});

test("parseDeepSeekTypeResponse extracts JSON from markdown fenced text", () => {
  const parsed = parseDeepSeekTypeResponse({
    choices: [
      {
        message: {
          content: "结果如下：```json\n{\"primaryType\":\"盘点\",\"secondaryType\":\"资金盘面盘点\",\"confidence\":0.86,\"reason\":\"标题包含资金去向\"}\n```"
        }
      }
    ]
  });

  assert.deepEqual(parsed, {
    primaryType: "盘点",
    secondaryType: "资金盘面盘点",
    confidence: 0.86,
    reason: "标题包含资金去向"
  });
});

test("validateClassification rejects invalid primary or secondary labels", () => {
  assert.deepEqual(validateClassification({
    primaryType: "资讯",
    secondaryType: "资金盘面盘点",
    confidence: 0.8,
    reason: "invalid"
  }), {
    ok: false,
    primaryType: "",
    secondaryType: "",
    confidence: 0,
    reason: "DeepSeek 返回了非法一级类型：资讯"
  });

  assert.deepEqual(validateClassification({
    primaryType: "盘点",
    secondaryType: "股民洞察",
    confidence: 0.8,
    reason: "invalid"
  }), {
    ok: false,
    primaryType: "",
    secondaryType: "",
    confidence: 0,
    reason: "DeepSeek 返回的二级类型不属于一级类型 盘点：股民洞察"
  });
});

test("validateClassification forces blank secondary for rap and long-video", () => {
  assert.deepEqual(validateClassification({
    primaryType: "说唱",
    secondaryType: "资金盘面盘点",
    confidence: 0.7,
    reason: "说唱标签"
  }), {
    ok: true,
    primaryType: "说唱",
    secondaryType: "",
    confidence: 0.7,
    reason: "说唱标签"
  });
});

test("classifyDouyinChannelType calls DeepSeek and normalizes valid output", async () => {
  const result = await classifyDouyinChannelType({
    title: "为什么不能和炒股的女人吵架？",
    tags: "#同花顺社区 #股友说",
    env: {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-chat"
    },
    fetch: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer sk-test");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "deepseek-v4-flash");
      assert.equal(body.response_format.type, "json_object");
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                primaryType: "股友说",
                secondaryType: "股民洞察",
                confidence: 0.91,
                reason: "标题是股民生活洞察"
              })
            }
          }
        ]
      });
    }
  });

  assert.deepEqual(result, {
    ok: true,
    primaryType: "股友说",
    secondaryType: "股民洞察",
    confidence: 0.91,
    reason: "标题是股民生活洞察",
    source: "deepseek"
  });
});

test("classifyDouyinChannelType passes an abort signal to DeepSeek requests", async () => {
  let signalSeen = false;
  const result = await classifyDouyinChannelType({
    title: "6月1日涨停股复盘！",
    tags: "#同顺盘点",
    timeoutMs: 5000,
    env: {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-chat"
    },
    fetch: async (url, options) => {
      signalSeen = Boolean(options.signal);
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                primaryType: "盘点",
                secondaryType: "资金盘面盘点",
                confidence: 0.9,
                reason: "盘点标签"
              })
            }
          }
        ]
      });
    }
  });

  assert.equal(signalSeen, true);
  assert.equal(result.ok, true);
});

test("classifyDouyinChannelType returns a failure result when API config is missing", async () => {
  const result = await classifyDouyinChannelType({
    title: "今日复盘",
    tags: "#投资",
    env: {},
    fetch: async () => {
      throw new Error("should not call fetch");
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.primaryType, "");
  assert.equal(result.secondaryType, "");
  assert.match(result.reason, /缺少 DeepSeek 配置/u);
});

test("detectPrimaryTypeCandidates narrows strong local routing signals", () => {
  assert.deepEqual(detectPrimaryTypeCandidates({
    title: "主力资金都去哪儿了？",
    tags: "#同顺盘点 #龙头强度"
  }), ["盘点"]);

  assert.deepEqual(detectPrimaryTypeCandidates({
    title: "节奏押韵说股市",
    tags: "#说唱 #Rap"
  }), ["说唱"]);

  assert.deepEqual(detectPrimaryTypeCandidates({
    title: "为什么炒股的女人更容易瘦下来？",
    tags: "#同花顺社区 #股民交流 #股友说"
  }), ["社区话题", "股友说"]);
});

test("classifyDouyinChannelTypeWithMiniMax sends local taxonomy, media evidence, and parses audit fields", async () => {
  const calls = [];
  const result = await classifyDouyinChannelTypeWithMiniMax({
    sourceRow: {
      rowNumber: 9,
      title: "6月8日，主力资金都去哪儿了？",
      tags: "#同顺盘点 #龙头强度",
      link: "https://www.douyin.com/video/7645299366600674602",
      itemId: "7645299366600674602",
      itemType: "视频",
      account: "投资号",
      contentType: "盘点"
    },
    assetBundle: {
      assetStatus: "视频抽帧",
      sourceText: "主力资金都去哪儿了？",
      imageDataUrls: ["data:image/jpeg;base64,AAAA"]
    },
    mediaMode: "sampled-media",
    env: {
      MINIMAX_API_KEY: "sk-mm",
      MINIMAX_BASE_URL: "https://api.minimax.io/v1",
      MINIMAX_MODEL: "MiniMax-M3"
    },
    fetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body), options.headers.Authorization]);
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                primaryType: "盘点",
                secondaryType: "资金盘面盘点",
                confidence: 0.92,
                reason: "标题和抽帧画面都指向资金盘面盘点。",
                evidence: ["主力资金", "龙头强度"],
                assetSignals: ["抽帧画面为盘点页", "画面出现龙头强度"]
              })
            }
          }
        ]
      });
    }
  });

  assert.equal(calls[0][0], "https://api.minimax.io/v1/chat/completions");
  assert.equal(calls[0][2], "Bearer sk-mm");
  assert.equal(calls[0][1].model, "MiniMax-M3");
  assert.equal(calls[0][1].response_format.type, "json_object");
  assert.match(calls[0][1].messages[0].content, /抖音渠道内容分级分类助手/u);
  const userContent = calls[0][1].messages[1].content;
  assert.equal(userContent[0].type, "text");
  assert.match(userContent[0].text, /主力资金都去哪儿了/u);
  assert.doesNotMatch(userContent[0].text, /ASR：|OCR：/u);
  assert.equal(userContent[1].type, "image_url");
  assert.deepEqual(result, {
    ok: true,
    primaryType: "盘点",
    secondaryType: "资金盘面盘点",
    confidence: 0.92,
    reason: "标题和抽帧画面都指向资金盘面盘点。",
    evidence: ["主力资金", "龙头强度"],
    assetSignals: ["抽帧画面为盘点页", "画面出现龙头强度"],
    source: "minimax",
    model: "MiniMax-M3",
    mediaMode: "sampled-media"
  });
});

test("classifyDouyinChannelTypeWithMiniMax retries transient MiniMax server errors", async () => {
  let calls = 0;
  const result = await classifyDouyinChannelTypeWithMiniMax({
    sourceRow: {
      title: "6月8日，主力资金都去哪儿了？",
      tags: "#同顺盘点"
    },
    assetBundle: {
      assetStatus: "文本分类",
      sourceText: "6月8日，主力资金都去哪儿了？"
    },
    mediaMode: "text-only",
    env: {
      MINIMAX_API_KEY: "sk-mm",
      MINIMAX_BASE_URL: "https://api.minimax.io/v1",
      MINIMAX_MODEL: "MiniMax-M3"
    },
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 500,
          async text() {
            return "{\"type\":\"error\"}";
          }
        };
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                primaryType: "盘点",
                secondaryType: "资金盘面盘点",
                confidence: 0.9,
                reason: "重试后成功",
                evidence: ["主力资金"],
                assetSignals: []
              })
            }
          }
        ]
      });
    },
    retryDelayMs: 0
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.secondaryType, "资金盘面盘点");
});

test("classifyDouyinChannelTypeWithMiniMax retries malformed JSON responses", async () => {
  let calls = 0;
  const result = await classifyDouyinChannelTypeWithMiniMax({
    sourceRow: {
      title: "6月8日，主力资金都去哪儿了？",
      tags: "#同顺盘点"
    },
    assetBundle: {
      assetStatus: "视频抽帧",
      sourceText: "6月8日，主力资金都去哪儿了？",
      imageDataUrls: ["data:image/jpeg;base64,AAAA"]
    },
    mediaMode: "sampled-media",
    env: {
      MINIMAX_API_KEY: "sk-mm",
      MINIMAX_BASE_URL: "https://api.minimax.io/v1",
      MINIMAX_MODEL: "MiniMax-M3"
    },
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          choices: [
            { message: { content: "{\"primaryType\":\"盘点\"" } }
          ]
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                primaryType: "盘点",
                secondaryType: "资金盘面盘点",
                confidence: 0.9,
                reason: "重试后返回合法 JSON。",
                evidence: ["主力资金"],
                assetSignals: ["视频抽帧"]
              })
            }
          }
        ]
      });
    },
    retryDelayMs: 0
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.secondaryType, "资金盘面盘点");
});

function jsonResponse(data) {
  return {
    ok: true,
    async text() {
      return JSON.stringify(data);
    }
  };
}
