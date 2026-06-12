import test from "node:test";
import assert from "node:assert/strict";
import { classifyContentType, parseDeepSeekClassification } from "../src/content-classifier.mjs";

test("content classifier uses tag rules before DeepSeek", async () => {
  let calls = 0;
  const result = await classifyContentType({
    platformId: "douyin",
    tags: "#同花顺资讯 #同花顺APP",
    fetch: async () => {
      calls += 1;
      throw new Error("DeepSeek should not be called");
    }
  });

  assert.deepEqual(result, {
    contentType: "资讯",
    contentTypeReview: "通过",
    source: "tag"
  });
  assert.equal(calls, 0);
});

test("content classifier does not call DeepSeek when tag rules do not match", async () => {
  let calls = 0;
  const result = await classifyContentType({
    platformId: "xhs",
    accountName: "同花顺投资",
    title: "一张图看懂今日市场机会",
    tags: "#投资",
    env: {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash"
    },
    fetch: async () => {
      calls += 1;
      throw new Error("DeepSeek should not be called for tag-only content type");
    }
  });

  assert.deepEqual(result, {
    contentType: "无",
    contentTypeReview: "需审核",
    source: "fallback"
  });
  assert.equal(calls, 0);
});

test("content classifier ignores invalid DeepSeek output because content type is tag-only", async () => {
  const result = await classifyContentType({
    platformId: "douyin",
    title: "今日市场机会",
    tags: "#投资",
    env: {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash"
    },
    fetch: async () => {
      throw new Error("DeepSeek should not be called");
    }
  });

  assert.deepEqual(result, {
    contentType: "无",
    contentTypeReview: "需审核",
    source: "fallback"
  });
});

test("content classifier keeps review required when tag evidence is insufficient", async () => {
  const result = await classifyContentType({
    platformId: "douyin",
    title: "今日市场机会",
    tags: "#投资",
    env: {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash"
    },
    fetch: async () => {
      throw new Error("DeepSeek should not be called");
    }
  });

  assert.deepEqual(result, {
    contentType: "无",
    contentTypeReview: "需审核",
    source: "fallback"
  });
});

test("parseDeepSeekClassification reads JSON text from chat response", () => {
  assert.deepEqual(parseDeepSeekClassification({
    choices: [
      {
        message: {
          content: '{"contentType":"盘点","review":"需审核"}'
        }
      }
    ]
  }), {
    contentType: "盘点",
    review: "需审核"
  });
});

function jsonResponse(data) {
  return {
    ok: true,
    async text() {
      return JSON.stringify(data);
    }
  };
}
