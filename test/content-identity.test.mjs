import test from "node:test";
import assert from "node:assert/strict";

import {
  publishedDateFromBilibiliBv,
  publishedDateFromDouyinItemId,
  publishedDateFromXhsNoteId
} from "../src/content-identity.mjs";
import {
  canonicalizeContentLink,
  extractDouyinItemId,
  normalizeDouyinContentLink,
  resolveDouyinShortLinkViaRedirect
} from "../src/link-utils.mjs";

test("XHS note IDs encode the UTC publish timestamp in the first eight hex chars", () => {
  assert.equal(
    publishedDateFromXhsNoteId("6a198e0c0000000036000f68"),
    "2026-05-29"
  );
});

test("Douyin item IDs encode the UTC publish timestamp in the high 32 bits", () => {
  assert.equal(
    publishedDateFromDouyinItemId("7645299366600674602"),
    "2026-05-29"
  );
});

test("Bilibili BV IDs are not treated as publish-date IDs", () => {
  assert.equal(publishedDateFromBilibiliBv("BV1hhGd6kEVj"), "");
});

test("Douyin links are canonicalized to clean video or note URLs", () => {
  assert.equal(
    extractDouyinItemId("https://www.douyin.com/note/7645299366600674602?previous_page=app_code_link"),
    "7645299366600674602"
  );
  assert.equal(
    normalizeDouyinContentLink("https://www.douyin.com/note/7645299366600674602?previous_page=app_code_link"),
    "https://www.douyin.com/note/7645299366600674602"
  );
  assert.equal(
    canonicalizeContentLink("douyin", "https://www.douyin.com/video/7645246631935315243?modal_id=ignored"),
    "https://www.douyin.com/video/7645246631935315243"
  );
  assert.equal(
    normalizeDouyinContentLink("7645246631935315243"),
    "https://www.douyin.com/video/7645246631935315243"
  );
});

test("Douyin short links resolve to canonical clean item URLs", async () => {
  const result = await resolveDouyinShortLinkViaRedirect("https://v.douyin.com/example/", {
    fetchImpl: async (url) => {
      assert.equal(url, "https://v.douyin.com/example/");
      return {
        url,
        headers: {
          get(name) {
            return name === "location"
              ? "https://www.douyin.com/video/7645246631935315243?modal_id=ignored"
              : "";
          }
        }
      };
    }
  });

  assert.equal(result, "https://www.douyin.com/video/7645246631935315243");
});

test("Douyin short link resolver returns empty when redirect is unresolved", async () => {
  const result = await resolveDouyinShortLinkViaRedirect("https://v.douyin.com/example/", {
    fetchImpl: async (url) => ({
      url,
      headers: {
        get() {
          return "";
        }
      }
    })
  });

  assert.equal(result, "");
});
