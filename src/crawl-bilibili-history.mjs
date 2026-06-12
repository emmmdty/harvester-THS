import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { extractBilibiliTags, extractBilibiliTitle } from "./bilibili-detail-text.mjs";
import { resolveBilibiliPublishedAt } from "./bilibili-published-date.mjs";
import {
  BILIBILI_HISTORY_SHEET_KEY,
  BILIBILI_HISTORY_HEADERS,
  buildBilibiliHistoryVideoUrl,
  extractBilibiliHistoryItemsFromArcSearch,
  mergeBilibiliHistoryLedgerItems,
  readBilibiliHistoryLedger,
  replaceBilibiliHistorySheet,
  upsertBilibiliHistorySheet,
  writeBilibiliHistoryLedger,
  writeBilibiliHistoryOutputs
} from "./bilibili-history.mjs";
import { chromiumLaunchOptions, resolveHeadless } from "./browser-env.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { extractBilibiliBv } from "./link-utils.mjs";
import { readPlatformAccounts } from "./platform-accounts.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";

const ROOT = process.cwd();
const USER_DATA_DIR = path.join(ROOT, ".bilibili-profile");
const RUNTIME_DIR = path.join(ROOT, ".runtime/bilibili-history");
const LEDGER_PATH = path.join(RUNTIME_DIR, "ledger.jsonl");
const OUTPUT_DIR = path.join(RUNTIME_DIR, "exports");
const BACKUP_DIR = path.join(RUNTIME_DIR, "backups");
const ARC_SEARCH_PATH = "/x/space/wbi/arc/search";
const DEFAULT_PAGE_SIZE = 40;
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52
];

const OPTIONS = parseArgs(process.argv.slice(2));
const HEADLESS = resolveHeadless();
const MAX_PAGES = numberOption(OPTIONS.maxPages, process.env.BILIBILI_HISTORY_MAX_PAGES, 0);
const DETAIL_LIMIT = resolveDetailLimit(OPTIONS.detailLimit, process.env.BILIBILI_HISTORY_DETAIL_LIMIT);
const PAGE_DELAY_MS = numberOption(OPTIONS.pageDelayMs, process.env.BILIBILI_HISTORY_PAGE_DELAY_MS, 550);
const DETAIL_DELAY_MS = numberOption(OPTIONS.detailDelayMs, process.env.BILIBILI_HISTORY_DETAIL_DELAY_MS, 700);
const PAGE_DETAIL_FALLBACK_LIMIT = resolveDetailLimit(
  OPTIONS.pageDetailFallbackLimit,
  process.env.BILIBILI_HISTORY_PAGE_DETAIL_FALLBACK_LIMIT
);

async function main() {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const accounts = await readPlatformAccounts("bilibili", { root: ROOT });
  const account = accounts[0];
  if (!account?.url) throw new Error("请先在账号配置中添加B站账号主页。");

  const collectedAt = new Date().toISOString();
  const safeTimestamp = collectedAt.replace(/[:.]/g, "-");
  const accountName = account.name || "B站账号";
  const accountHomeUrl = normalizeBilibiliAccountHomeUrl(account.url);
  const ledgerBefore = await readBilibiliHistoryLedger(LEDGER_PATH);
  let ledger = OPTIONS.rebuild ? [] : ledgerBefore.map((item) => withBilibiliHistoryAccount(item, { accountName, accountHomeUrl }));
  if (OPTIONS.rebuild) {
    const backupPath = path.join(BACKUP_DIR, `ledger-${safeTimestamp}.jsonl`);
    await fs.writeFile(backupPath, ledgerBefore.map((item) => JSON.stringify(item)).join("\n"), "utf8");
    console.log(`重建模式：已备份当前 ledger 至 ${backupPath}`);
  }

  console.log(`B站历史采集：${accountName} ${accountHomeUrl}`);
  console.log(`已有 ledger ${ledgerBefore.length} 条。`);

  let context = null;
  let items = [];
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...chromiumLaunchOptions(),
      headless: HEADLESS,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
    });

    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const initial = await loadInitialArcSearch(page, { accountName, accountHomeUrl, collectedAt });
    const expectedTotal = initial.totalCount;
    if (!expectedTotal) throw new Error("未从B站空间投稿接口读到视频总数。请确认登录态可用。");

    const pageSize = initial.pageSize || DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(expectedTotal / pageSize);
    const targetPages = MAX_PAGES > 0 ? Math.min(totalPages, MAX_PAGES) : totalPages;
    const byId = new Map();
    for (const item of initial.items) byId.set(item.itemId, item);
    console.log(`B站接口总数：${expectedTotal}，每页 ${pageSize}，计划读取 ${targetPages}/${totalPages} 页。`);

    const mixinKey = await getWbiMixinKeyFromPage(page);
    for (let pageNumber = 2; pageNumber <= targetPages; pageNumber += 1) {
      const payload = await requestArcSearchFromPage(page, initial.arcSearchUrl, {
        pn: pageNumber,
        ps: pageSize
      }, mixinKey);
      assertBilibiliPayloadOk(payload);
      const parsed = extractBilibiliHistoryItemsFromArcSearch(payload, { accountName, accountHomeUrl, collectedAt });
      for (const item of parsed.items) byId.set(item.itemId, item);
      console.log(`B站分页：${pageNumber}/${targetPages}，累计 ${byId.size}/${expectedTotal}`);
      if (PAGE_DELAY_MS > 0) await page.waitForTimeout(PAGE_DELAY_MS);
    }

    items = mergeBilibiliHistoryLedgerItems(ledger, [...byId.values()]);
    const detailCandidates = items.filter(shouldEnrichDetail);
    const needDetail = Number.isFinite(DETAIL_LIMIT)
      ? detailCandidates.slice(0, DETAIL_LIMIT)
      : detailCandidates;
    const pageFallbackCandidates = [];
    if (needDetail.length > 0) {
      console.log(`详情 API 补全：${needDetail.length} 条`);
      const enrichedById = new Map(items.map((item) => [item.itemId, item]));
      for (const item of needDetail) {
        try {
          const detail = withBilibiliHistoryAccount(
            await fetchBilibiliHistoryDetailFromApi(page, item.itemId),
            { accountName, accountHomeUrl }
          );
          const merged = mergeBilibiliHistoryLedgerItems([item], [detail])[0];
          enrichedById.set(item.itemId, merged);
          if (!merged.tags) pageFallbackCandidates.push(merged);
          console.log(`详情 API 补全：${item.itemId}`);
        } catch (error) {
          const failed = {
            ...item,
            collectStatus: "待补全",
            failureReason: error.message || String(error),
            source: appendSource(item.source, "detail-api-failed")
          };
          pageFallbackCandidates.push(failed);
          enrichedById.set(item.itemId, failed);
          console.warn(`详情 API 补全失败：${item.itemId}，原因：${error.message || String(error)}`);
        }
        if (DETAIL_DELAY_MS > 0) await page.waitForTimeout(DETAIL_DELAY_MS);
      }
      items = [...enrichedById.values()];
    }
    const pageFallbackItems = Number.isFinite(PAGE_DETAIL_FALLBACK_LIMIT)
      ? pageFallbackCandidates.slice(0, PAGE_DETAIL_FALLBACK_LIMIT)
      : pageFallbackCandidates;
    if (pageFallbackItems.length > 0) {
      console.log(`详情页 HTML 兜底：${pageFallbackItems.length} 条`);
      const enrichedById = new Map(items.map((item) => [item.itemId, item]));
      for (const item of pageFallbackItems) {
        try {
          const detail = withBilibiliHistoryAccount(
            await fetchBilibiliHistoryDetailFromHtml(page, item.itemUrl),
            { accountName, accountHomeUrl }
          );
          enrichedById.set(item.itemId, mergeBilibiliHistoryLedgerItems([item], [detail])[0]);
          console.log(`详情页 HTML 补全：${item.itemId}`);
        } catch (error) {
          enrichedById.set(item.itemId, {
            ...item,
            collectStatus: "待补全",
            failureReason: error.message || String(error),
            source: appendSource(item.source, "detail-page-failed")
          });
          console.warn(`详情页 HTML 补全失败：${item.itemId}，原因：${error.message || String(error)}`);
        }
        if (DETAIL_DELAY_MS > 0) await page.waitForTimeout(DETAIL_DELAY_MS);
      }
      items = [...enrichedById.values()];
    }
  } finally {
    await context?.close().catch(() => {});
  }

  ledger = mergeBilibiliHistoryLedgerItems(ledger, items);
  await writeBilibiliHistoryLedger(LEDGER_PATH, ledger);
  const output = await writeBilibiliHistoryOutputs({
    items: ledger,
    outputDir: OUTPUT_DIR,
    generatedAt: collectedAt
  });
  console.log(`\n本地 ledger：${LEDGER_PATH}`);
  console.log(`JSON 审计：${output.jsonPath}`);
  console.log(`CSV 审计：${output.csvPath}`);

  if (OPTIONS.skipFeishu) {
    console.log("已跳过飞书写入（--skip-feishu）。");
  } else {
    const config = loadFeishuConfig();
    const client = new FeishuSheetsClient(config);
    if (OPTIONS.rebuild) {
      const backup = await backupFeishuHistory({ client, safeTimestamp });
      console.log(`飞书备份：${backup.jsonPath}`);
      console.log(`飞书备份 CSV：${backup.csvPath}`);
    }
    const payload = {
      client,
      sheetId: config.sheets[BILIBILI_HISTORY_SHEET_KEY] || "",
      items: ledger,
      batchSize: 100
    };
    const result = OPTIONS.rebuild
      ? await replaceBilibiliHistorySheet(payload)
      : await upsertBilibiliHistorySheet(payload);
    if (result.createdSheetId) {
      console.log(`已新建 Sheet：B站历史台账，sheet_id=${result.createdSheetId}`);
      console.log("可将该值写入 .env 的 FEISHU_SHEET_BILIBILI_HISTORY，后续运行会直接复用。");
    }
    console.log(`飞书写入：新增 ${result.created}，更新 ${result.updated || 0}，跳过 ${result.skipped}。`);
  }

  const summary = summarizeItems(ledger);
  console.log(`\nB站历史台账完成：总数 ${summary.total}，URL 空值 ${summary.emptyUrl}，标题空值 ${summary.emptyTitle}，tag 空值 ${summary.emptyTags}，作品ID重复 ${summary.duplicateIds}。`);
}

async function loadInitialArcSearch(page, { accountName = "", accountHomeUrl = "", collectedAt = "" } = {}) {
  const pending = [];
  const onResponse = (response) => {
    if (!response.url().includes(ARC_SEARCH_PATH)) return;
    pending.push(parseArcSearchResponse(response, { accountName, accountHomeUrl, collectedAt }));
  };
  page.on("response", onResponse);
  try {
    await page.goto(accountHomeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    await assertLoggedIn(page);
    await page.mouse.wheel(0, 1200).catch(() => {});
    await page.waitForTimeout(1500);
    const parsed = (await Promise.all(pending)).filter(Boolean)
      .sort((left, right) => (right.totalCount || 0) - (left.totalCount || 0))[0];
    if (!parsed) throw new Error("未监听到B站空间投稿接口响应。");
    return parsed;
  } finally {
    page.off("response", onResponse);
  }
}

async function parseArcSearchResponse(response, { accountName = "", accountHomeUrl = "", collectedAt = "" } = {}) {
  const payload = await response.json().catch(() => null);
  if (!payload) return null;
  assertBilibiliPayloadOk(payload);
  return {
    ...extractBilibiliHistoryItemsFromArcSearch(payload, { accountName, accountHomeUrl, collectedAt }),
    arcSearchUrl: response.url()
  };
}

async function requestArcSearchFromPage(page, seedUrl, overrides = {}, mixinKey = "") {
  const signedUrl = mixinKey
    ? buildSignedWbiUrl(seedUrl, overrides, mixinKey)
    : seedUrl;
  return page.evaluate(async ({ seedUrl, overrides }) => {
    const url = new URL(seedUrl);
    for (const [key, value] of Object.entries(overrides || {})) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url.toString(), {
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*"
      }
    });
    return response.json();
  }, { seedUrl: signedUrl, overrides: mixinKey ? {} : overrides });
}

async function getWbiMixinKeyFromPage(page) {
  const wbiImg = await page.evaluate(async () => {
    const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*"
      }
    });
    const payload = await response.json();
    return payload?.data?.wbi_img || {};
  });
  const imgKey = keyFromWbiUrl(wbiImg.img_url);
  const subKey = keyFromWbiUrl(wbiImg.sub_url);
  if (!imgKey || !subKey) throw new Error("未获取到B站 WBI 签名 key。");
  return WBI_MIXIN_KEY_ENC_TAB.map((index) => `${imgKey}${subKey}`[index]).join("").slice(0, 32);
}

function buildSignedWbiUrl(seedUrl, overrides = {}, mixinKey = "") {
  const url = new URL(seedUrl);
  url.searchParams.delete("w_rid");
  url.searchParams.delete("wts");
  for (const [key, value] of Object.entries(overrides || {})) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("wts", String(Math.floor(Date.now() / 1000)));
  const entries = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value).replace(/[!'()*]/g, ""))}`)
    .join("&");
  const wRid = crypto.createHash("md5").update(`${query}${mixinKey}`).digest("hex");
  url.search = `${query}&w_rid=${wRid}`;
  return url.toString();
}

function keyFromWbiUrl(value = "") {
  try {
    return new URL(value).pathname.split("/").pop()?.split(".")[0] || "";
  } catch {
    return "";
  }
}

async function assertLoggedIn(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (/扫描二维码登录|登录后你可以|立即登录|风控|出错啦|安全验证/.test(bodyText)) {
    throw new Error("B站登录状态不可用或页面触发风控，请先运行 npm run login:bilibili 完成登录。");
  }
}

function assertBilibiliPayloadOk(payload) {
  if (!payload || payload.code !== 0) {
    const message = payload?.message || payload?.msg || "未知错误";
    throw new Error(`B站空间投稿接口失败：${message}。请先运行 npm run login:bilibili 完成登录。`);
  }
}

function shouldEnrichDetail(item = {}) {
  return !item.title || !item.publishedAt || !item.tags;
}

async function scrapeBilibiliHistoryDetail(page, videoUrl) {
  await page.goto(videoUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const detail = await page.evaluate(() => {
    const initial = window.__INITIAL_STATE__ || {};
    const videoData = initial.videoData || initial.aidData || {};
    const metaKeywords = document.querySelector('meta[name="keywords"]')?.getAttribute("content") || "";
    return {
      pubdate: videoData.pubdate || videoData.ctime || 0,
      bvid: videoData.bvid || "",
      videoData: {
        title: videoData.title || "",
        titleText: videoData.titleText || "",
        tag: videoData.tag || [],
        tags: videoData.tags || [],
        keywords: videoData.keywords || ""
      },
      initialTags: initial.tags || [],
      metaKeywords,
      documentTitle: document.title || "",
      text: document.body?.innerText || ""
    };
  });
  const bvid = detail.bvid || extractBilibiliBv(page.url()) || extractBilibiliBv(videoUrl);
  const title = spreadsheetSafeText(extractBilibiliTitle({
    videoData: detail.videoData,
    documentTitle: detail.documentTitle
  }));
  const tags = extractBilibiliTags({
    videoData: detail.videoData,
    initialTags: detail.initialTags,
    metaKeywords: detail.metaKeywords,
    title
  });
  const publishedAt = resolveBilibiliPublishedAt({ pubdate: detail.pubdate, text: detail.text });
  return {
    itemId: bvid,
    itemUrl: buildBilibiliHistoryVideoUrl(bvid),
    title,
    tags,
    publishedAt,
    collectStatus: title && publishedAt ? "已采集" : "待补全",
    failureReason: "",
    source: "space-wbi-arc-search+detail"
  };
}

async function fetchBilibiliHistoryDetailFromHtml(page, videoUrl) {
  const html = await page.evaluate(async ({ videoUrl }) => {
    const response = await fetch(videoUrl, {
      credentials: "include",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) throw new Error(`B站视频页 HTTP ${response.status}`);
    return response.text();
  }, { videoUrl });
  const detail = parseBilibiliInitialStateFromHtml(html);
  const bvid = detail.bvid || extractBilibiliBv(videoUrl);
  const title = spreadsheetSafeText(extractBilibiliTitle({
    videoData: detail.videoData,
    documentTitle: detail.documentTitle
  }));
  const tags = extractBilibiliTags({
    videoData: detail.videoData,
    initialTags: detail.initialTags,
    metaKeywords: detail.metaKeywords,
    title
  });
  const publishedAt = resolveBilibiliPublishedAt({ pubdate: detail.pubdate, text: detail.text });
  return {
    itemId: bvid,
    itemUrl: buildBilibiliHistoryVideoUrl(bvid),
    title,
    tags,
    publishedAt,
    collectStatus: title && publishedAt ? "已采集" : "待补全",
    failureReason: "",
    source: "space-wbi-arc-search+detail"
  };
}

function parseBilibiliInitialStateFromHtml(html = "") {
  const stateMatch = String(html).match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});\s*\(function\(\)/s)
    || String(html).match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});\s*<\/script>/s);
  const initial = stateMatch ? JSON.parse(stateMatch[1]) : {};
  const videoData = initial.videoData || initial.aidData || {};
  const metaKeywords = html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']*)["']/i)?.[1] || "";
  const documentTitle = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] || "";
  return {
    pubdate: videoData.pubdate || videoData.ctime || 0,
    bvid: videoData.bvid || "",
    videoData: {
      title: videoData.title || "",
      titleText: videoData.titleText || "",
      tag: videoData.tag || [],
      tags: videoData.tags || [],
      keywords: videoData.keywords || ""
    },
    initialTags: initial.tags || [],
    metaKeywords: decodeHtmlEntities(metaKeywords),
    documentTitle: decodeHtmlEntities(documentTitle),
    text: stripHtmlText(html)
  };
}

async function fetchBilibiliHistoryDetailFromApi(page, bvid) {
  const result = await page.evaluate(async ({ bvid }) => {
    const headers = { accept: "application/json, text/plain, */*" };
    const viewResponse = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      credentials: "include",
      headers
    });
    const tagResponse = await fetch(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, {
      credentials: "include",
      headers
    });
    return {
      view: await viewResponse.json().catch(() => null),
      tags: await tagResponse.json().catch(() => null)
    };
  }, { bvid });

  if (result.view?.code !== 0) {
    throw new Error(result.view?.message || result.view?.msg || "B站 view API 失败");
  }
  const view = result.view.data || {};
  const tagNames = result.tags?.code === 0 && Array.isArray(result.tags?.data)
    ? result.tags.data.map((tag) => tag.tag_name || tag.name || "").filter(Boolean)
    : [];
  const title = spreadsheetSafeText(view.title || "");
  const tags = extractBilibiliTags({
    videoData: {
      title,
      tag: tagNames,
      tags: tagNames
    },
    title
  });
  const publishedAt = resolveBilibiliPublishedAt({
    pubdate: view.pubdate || view.ctime || view.created,
    text: ""
  });
  return {
    itemId: view.bvid || bvid,
    itemUrl: buildBilibiliHistoryVideoUrl(view.bvid || bvid),
    title,
    tags,
    publishedAt,
    collectStatus: title && publishedAt ? "已采集" : "待补全",
    failureReason: "",
    source: "space-wbi-arc-search+detail"
  };
}

async function backupFeishuHistory({ client, safeTimestamp }) {
  const rows = await client.readSheetRows(BILIBILI_HISTORY_SHEET_KEY, BILIBILI_HISTORY_HEADERS.length).catch(() => []);
  const jsonPath = path.join(BACKUP_DIR, `feishu-${safeTimestamp}.json`);
  const csvPath = path.join(BACKUP_DIR, `feishu-${safeTimestamp}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify({ rows }, null, 2), "utf8");
  await fs.writeFile(csvPath, rows.map((row) => row.map(csvEscape).join(",")).join("\n"), "utf8");
  return { jsonPath, csvPath };
}

function withBilibiliHistoryAccount(item = {}, { accountName = "", accountHomeUrl = "" } = {}) {
  return {
    ...item,
    accountName: item.accountName || accountName,
    accountHomeUrl: item.accountHomeUrl || accountHomeUrl
  };
}

function normalizeBilibiliAccountHomeUrl(value) {
  const text = String(value || "").trim();
  const match = text.match(/space\.bilibili\.com\/(\d+)/);
  if (!match) return text;
  return `https://space.bilibili.com/${match[1]}/video`;
}

function summarizeItems(items = []) {
  const ids = new Set();
  let duplicateIds = 0;
  let emptyUrl = 0;
  let emptyTitle = 0;
  let emptyTags = 0;
  for (const item of items) {
    if (!item.itemUrl) emptyUrl += 1;
    if (!item.title) emptyTitle += 1;
    if (!item.tags) emptyTags += 1;
    const id = item.itemId || "";
    if (!id) continue;
    if (ids.has(id)) duplicateIds += 1;
    ids.add(id);
  }
  return { total: items.length, emptyUrl, emptyTitle, emptyTags, duplicateIds };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function appendSource(current, next) {
  const values = String(current || "")
    .split(/[+,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (next && !values.includes(next)) values.push(next);
  return values.join("+");
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function stripHtmlText(html = "") {
  return decodeHtmlEntities(String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--skip-feishu") {
      options.skipFeishu = true;
      continue;
    }
    if (arg === "--rebuild") {
      options.rebuild = true;
      continue;
    }
    if (arg === "--max-pages") {
      options.maxPages = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-pages=")) {
      options.maxPages = arg.slice("--max-pages=".length);
      continue;
    }
    if (arg === "--detail-limit") {
      options.detailLimit = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--detail-limit=")) {
      options.detailLimit = arg.slice("--detail-limit=".length);
      continue;
    }
    if (arg === "--page-delay-ms") {
      options.pageDelayMs = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--page-delay-ms=")) {
      options.pageDelayMs = arg.slice("--page-delay-ms=".length);
      continue;
    }
    if (arg === "--detail-delay-ms") {
      options.detailDelayMs = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--detail-delay-ms=")) {
      options.detailDelayMs = arg.slice("--detail-delay-ms=".length);
      continue;
    }
    if (arg === "--page-detail-fallback-limit") {
      options.pageDetailFallbackLimit = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--page-detail-fallback-limit=")) {
      options.pageDetailFallbackLimit = arg.slice("--page-detail-fallback-limit=".length);
    }
  }
  return options;
}

function numberOption(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, Math.floor(number));
  }
  return 0;
}

function resolveDetailLimit(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, Math.floor(number));
  }
  return Number.POSITIVE_INFINITY;
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
