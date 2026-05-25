import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  douyinProfileIdsMatch,
  extractDouyinUserId,
  extractPrimaryDouyinAuthorProfileUrl
} from "../src/douyin-profile-guard.mjs";

const ROOT = process.cwd();

test("extractDouyinUserId normalizes profile ids from Douyin URLs", () => {
  assert.equal(
    extractDouyinUserId("https://www.douyin.com/user/MS4wLjABAAAAxr3bk2-4lsUB0XOErXDXFKIocqd2wOExCTAuRwQ19Vg?from=detail"),
    "MS4wLjABAAAAxr3bk2-4lsUB0XOErXDXFKIocqd2wOExCTAuRwQ19Vg"
  );
  assert.equal(extractDouyinUserId("https://www.douyin.com/video/7642217352771655497"), "");
});

test("extractPrimaryDouyinAuthorProfileUrl picks the detail page author before recommendations", () => {
  const authorProfile = "https://www.douyin.com/user/MS4wLjABAAAAc9QKN60AuFgH9jNHD6m_Ufnw2CWZ_rnb9TkmLhEzKdY";
  const recommendationProfile = "https://www.douyin.com/user/MS4wLjABAAAAJT7STV16yzOFem0IM_Rwqe8XkA7jRAva-G8JIKB-43E?author_id=102461821694&group_id=7642217352771655497";

  assert.equal(extractPrimaryDouyinAuthorProfileUrl([
    "https://www.douyin.com/user/self?from_nav=1",
    authorProfile,
    recommendationProfile
  ]), authorProfile);
});

test("douyinProfileIdsMatch rejects a video owned by a different account", () => {
  const expected = "https://www.douyin.com/user/MS4wLjABAAAAxr3bk2-4lsUB0XOErXDXFKIocqd2wOExCTAuRwQ19Vg";
  const actual = "https://www.douyin.com/user/MS4wLjABAAAAc9QKN60AuFgH9jNHD6m_Ufnw2CWZ_rnb9TkmLhEzKdY";

  assert.equal(douyinProfileIdsMatch(expected, actual), false);
  assert.equal(douyinProfileIdsMatch(expected, expected), true);
});

test("douyin crawler isolates account failures and closes browser state on errors", async () => {
  const source = await fs.readFile(path.join(ROOT, "src", "crawl-douyin.mjs"), "utf8");

  assert.match(source, /const accountErrors = \[\]/);
  assert.match(source, /catch \(error\) \{[\s\S]*accountErrors\.push/);
  assert.match(source, /if \(isFatalDouyinAccountError\(error\)\) throw error/);
  assert.match(source, /finally \{[\s\S]*resourceBlocker\?\.close\(\)[\s\S]*context\?\.close\(\)/);
});
