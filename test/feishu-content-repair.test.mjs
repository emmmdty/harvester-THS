import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildFeishuUrlCell } from "../src/daily-records.mjs";
import { buildLocalMetadataStore, repairPlatformRows } from "../src/feishu-content-repair.mjs";

function metadataStore(overrides = {}) {
  return {
    douyinById: new Map(),
    douyinByLink: new Map(),
    douyinByFingerprint: new Map(),
    xhsById: new Map(),
    xhsByLink: new Map(),
    bilibiliById: new Map(),
    bilibiliByLink: new Map(),
    ...overrides
  };
}

function cellLink(row, index) {
  const cell = row[index];
  return typeof cell === "object" ? cell.link : cell;
}

function cellText(row, index) {
  const cell = row[index];
  return typeof cell === "object" ? cell.text : cell;
}

test("repairPlatformRows moves XHS rows by note-ID publish date and keeps URL text equal to URL", async () => {
  const id = "6a198e0c0000000036000f68";
  const link = `https://www.xiaohongshu.com/discovery/item/${id}?xhsshare=pc_web&source=webshare&xsec_source=pc_share`;
  const store = metadataStore({
    xhsById: new Map([[id, { id, link, tags: "#投资 #理财", publishedAt: "2026-05-30" }]])
  });

  const result = await repairPlatformRows({
    platformId: "xhs",
    rows: [
      ["", "0530 投稿视频", "", "", "", "", "", ""],
      ["1", "05 30", { type: "url", text: "打开链接", link }, id, "投资号", "图文", "通过", ""],
      ["", "0529 投稿视频", "", "", "", "", "", ""]
    ],
    dataStartRow: 3,
    metadataStore: store
  });

  assert.deepEqual(result.moves, [
    { rowNumber: 4, from: "2026-05-30", to: "2026-05-29", id }
  ]);
  assert.equal(result.changes.url, 1);
  assert.equal(result.changes.tags, 1);

  const repairedRow = result.rows.find((row) => row[3] === id);
  assert.equal(repairedRow[1], "05 29");
  assert.equal(cellLink(repairedRow, 2), cellText(repairedRow, 2));
  assert.match(cellLink(repairedRow, 2), /^https:\/\/www\.xiaohongshu\.com\/discovery\/item\//);
  assert.equal(repairedRow[7], "#投资 #理财");
});

test("repairPlatformRows resolves Douyin short links, fills deterministic metadata, and moves by item ID date", async () => {
  const id = "7645299366600674602";
  const link = `https://www.douyin.com/note/${id}`;
  const store = metadataStore({
    douyinById: new Map([[id, {
      id,
      link,
      accountName: "投资号",
      title: "确定性标题",
      tags: "#同花顺 #理财",
      publishedAt: "2026-05-30"
    }]])
  });

  const result = await repairPlatformRows({
    platformId: "douyin",
    rows: [
      ["", "0530 投稿视频", "", "", "", "", "", "", "", "", ""],
      ["1", "05 30", { type: "url", text: "打开链接", link: "https://v.douyin.com/example/" }, "", "", "", "", "投资号", "图文", "通过", ""],
      ["", "0529 投稿视频", "", "", "", "", "", "", "", "", ""]
    ],
    dataStartRow: 5,
    metadataStore: store,
    resolveDouyinShortLink: async () => link
  });

  assert.deepEqual(result.moves, [
    { rowNumber: 6, from: "2026-05-30", to: "2026-05-29", id }
  ]);
  assert.equal(result.changes.url, 1);
  assert.equal(result.changes.title, 1);
  assert.equal(result.changes.tags, 1);

  const repairedRow = result.rows.find((row) => cellLink(row, 2) === link);
  assert.equal(repairedRow[1], "05 29");
  assert.equal(cellText(repairedRow, 2), link);
  assert.equal(repairedRow[3], "确定性标题");
  assert.equal(repairedRow[4], "#同花顺 #理财");
});

test("repairPlatformRows can resolve Douyin URLs without moving date blocks", async () => {
  const id = "7645299366600674602";
  const link = `https://www.douyin.com/note/${id}`;

  const result = await repairPlatformRows({
    platformId: "douyin",
    rows: [
      ["", "0530 投稿视频", "", "", "", "", "", "", "", "", ""],
      ["1", "05 30", { type: "url", text: "打开链接", link: "https://v.douyin.com/example/" }, "旧标题", "#tag", "", "", "投资号", "图文", "通过", ""]
    ],
    dataStartRow: 5,
    metadataStore: metadataStore(),
    resolveDouyinShortLink: async () => link,
    organizeDates: false
  });

  assert.deepEqual(result.moves, []);
  assert.equal(result.changes.url, 1);
  assert.equal(result.changes.date, 0);
  assert.equal(result.rows[1][1], "05 30");
  assert.equal(cellLink(result.rows[1], 2), link);
  assert.equal(cellText(result.rows[1], 2), link);
});

test("repairPlatformRows fills Bilibili title and tags from API metadata without deriving date from BV", async () => {
  const bvid = "BV1hhGd6kEVj";
  const link = `https://www.bilibili.com/video/${bvid}/`;

  const result = await repairPlatformRows({
    platformId: "bilibili",
    rows: [
      ["", "0530 投稿视频", "", "", "", "", ""],
      ["1", "05 30", buildFeishuUrlCell(`https://www.bilibili.com/video/${bvid}?spm_id_from=333`), bvid, "投资号", "", ""],
      ["", "0528 投稿视频", "", "", "", "", ""]
    ],
    dataStartRow: 3,
    metadataStore: metadataStore(),
    fetchBilibiliMetadata: async (requestedBvid) => {
      assert.equal(requestedBvid, bvid);
      return {
        id: bvid,
        link,
        title: "24岁的金融学霸，靠投资存款400万，年化收益36%！",
        tags: "#财经 #金融 #理财 #投资 #谁是理财王",
        publishedAt: "2026-05-28"
      };
    }
  });

  assert.deepEqual(result.moves, [
    { rowNumber: 4, from: "2026-05-30", to: "2026-05-28", id: bvid }
  ]);
  assert.equal(result.changes.url, 1);
  assert.equal(result.changes.title, 1);
  assert.equal(result.changes.tags, 1);

  const repairedRow = result.rows.find((row) => row[3] === bvid);
  assert.equal(repairedRow[1], "05 28");
  assert.equal(cellLink(repairedRow, 2), link);
  assert.equal(cellText(repairedRow, 2), link);
  assert.equal(repairedRow[5], "24岁的金融学霸，靠投资存款400万，年化收益36%！");
  assert.equal(repairedRow[6], "#财经 #金融 #理财 #投资 #谁是理财王");
});

test("buildLocalMetadataStore reuses previous repair snapshots for deterministic title and tag metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-content-repair-store-"));
  const snapshotDir = path.join(root, "output", "feishu-content-repair", "2026-06-01T00-00-00-000Z");
  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.writeFile(path.join(snapshotDir, "bilibili.after.json"), JSON.stringify([
    ["", "0525 投稿视频", "", "", "", "", ""],
    [
      "1",
      "05 25",
      buildFeishuUrlCell("https://www.bilibili.com/video/BV1xmGx6JEbA/"),
      "BV1xmGx6JEbA",
      "投资号",
      "离大谱！炒股能领“亏损补贴”？原来全是诈骗！",
      "#财经 #投资 #股票"
    ]
  ]), "utf8");

  const store = await buildLocalMetadataStore({ root });
  assert.equal(store.bilibiliById.get("BV1xmGx6JEbA")?.title, "离大谱！炒股能领“亏损补贴”？原来全是诈骗！");
  assert.equal(store.bilibiliById.get("BV1xmGx6JEbA")?.tags, "#财经 #投资 #股票");
  assert.equal(store.bilibiliById.get("BV1xmGx6JEbA")?.publishedAt, "");
});
