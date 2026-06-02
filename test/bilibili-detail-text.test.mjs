import test from "node:test";
import assert from "node:assert/strict";

import { extractBilibiliTags } from "../src/bilibili-detail-text.mjs";

test("Bilibili tags remove music discovery and title-fragment noise", () => {
  const tags = extractBilibiliTags({
    videoData: {
      tag: [
        { tag_name: "发现《朋友圈》" },
        { tag_name: "谁是理财王" },
        { tag_name: "财经" },
        { tag_name: "24岁的金融学霸" },
        { tag_name: "靠投资存款400万" },
        { tag_name: "年化收益36%！" }
      ]
    },
    title: "24岁的金融学霸，靠投资存款400万，年化收益36%！"
  });

  assert.equal(tags, "#谁是理财王 #财经");
});
