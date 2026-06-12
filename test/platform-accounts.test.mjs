import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deletePlatformAccount,
  normalizePlatformAccount,
  readPlatformAccounts,
  upsertPlatformAccount
} from "../src/platform-accounts.mjs";

test("readPlatformAccounts loads and normalizes accounts from the unified config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "platform-accounts-"));
  await fs.writeFile(path.join(root, "platform-accounts.json"), JSON.stringify({
    xhs: [
      {
        name: "问财",
        url: "https://www.xiaohongshu.com/user/profile/65e93da0000000000500910e?channel_type=web_note_detail_r10"
      }
    ],
    douyin: [
      {
        name: "同花顺投资",
        url: "https://www.douyin.com/user/MS4wLjABAAAArf6v6Z48Pma-bIrz00wVCu76ioePN0vKzHAM_w9DN8AOkLekEk13Ay8_L-74BBB8?from_tab_name=main"
      }
    ],
    bilibili: [
      {
        name: "同花顺投资",
        url: "https://space.bilibili.com/1622777305"
      }
    ]
  }), "utf8");

  assert.deepEqual(await readPlatformAccounts("xhs", { root }), [
    {
      name: "问财",
      url: "https://www.xiaohongshu.com/user/profile/65e93da0000000000500910e"
    }
  ]);
  assert.deepEqual(await readPlatformAccounts("douyin", { root }), [
    {
      name: "同花顺投资",
      url: "https://www.douyin.com/user/MS4wLjABAAAArf6v6Z48Pma-bIrz00wVCu76ioePN0vKzHAM_w9DN8AOkLekEk13Ay8_L-74BBB8"
    }
  ]);
  assert.deepEqual(await readPlatformAccounts("bilibili", { root }), [
    {
      name: "同花顺投资",
      url: "https://space.bilibili.com/1622777305/video"
    }
  ]);
});

test("upsertPlatformAccount updates an existing account and persists sorted platform keys", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "platform-accounts-upsert-"));
  await fs.writeFile(path.join(root, "platform-accounts.json"), JSON.stringify({
    xhs: [],
    douyin: [{ name: "旧账号", url: "https://www.douyin.com/user/old-id" }],
    bilibili: []
  }), "utf8");

  await upsertPlatformAccount({
    root,
    platformId: "douyin",
    name: "旧账号",
    url: "https://www.douyin.com/user/new-id?modal_id=1"
  });

  const saved = JSON.parse(await fs.readFile(path.join(root, "platform-accounts.json"), "utf8"));
  assert.deepEqual(Object.keys(saved), ["xhs", "douyin", "bilibili"]);
  assert.deepEqual(saved.douyin, [
    { name: "旧账号", url: "https://www.douyin.com/user/new-id" }
  ]);
});

test("deletePlatformAccount removes the selected account without touching other platforms", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "platform-accounts-delete-"));
  await fs.writeFile(path.join(root, "platform-accounts.json"), JSON.stringify({
    xhs: [{ name: "问财", url: "https://www.xiaohongshu.com/user/profile/65e93da0000000000500910e" }],
    douyin: [{ name: "同花顺投资", url: "https://www.douyin.com/user/douyin-id" }],
    bilibili: [{ name: "同花顺投资", url: "https://space.bilibili.com/1622777305/video" }]
  }), "utf8");

  await deletePlatformAccount({ root, platformId: "xhs", name: "问财" });

  const saved = JSON.parse(await fs.readFile(path.join(root, "platform-accounts.json"), "utf8"));
  assert.deepEqual(saved.xhs, []);
  assert.equal(saved.douyin.length, 1);
  assert.equal(saved.bilibili.length, 1);
});

test("normalizePlatformAccount rejects unsupported platform urls", () => {
  assert.throws(
    () => normalizePlatformAccount("xhs", { name: "错平台", url: "https://www.douyin.com/user/abc" }),
    /小红书主页链接/
  );
  assert.throws(
    () => normalizePlatformAccount("douyin", { name: "错平台", url: "https://space.bilibili.com/1622777305" }),
    /抖音主页链接/
  );
  assert.throws(
    () => normalizePlatformAccount("bilibili", { name: "错平台", url: "https://www.xiaohongshu.com/user/profile/abc" }),
    /B站主页链接/
  );
});

test("repository XHS account config includes the welfare account for daily collection", async () => {
  const config = JSON.parse(await fs.readFile(path.join(process.cwd(), "platform-accounts.json"), "utf8"));

  assert.equal(
    config.xhs.some((account) => (
      account.name === "同花顺新手福利官"
      && account.url === "https://www.xiaohongshu.com/user/profile/64b74fc9000000000b0162c9"
    )),
    true
  );
});
