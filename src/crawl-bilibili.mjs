import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, resolveHeadless } from "./browser-env.mjs";
import { extractBilibiliTags, extractBilibiliTitle } from "./bilibili-detail-text.mjs";
import { compareDateStrings, formatDate, normalizeDateInput } from "./date-utils.mjs";
import { dateFromBilibiliEpoch, resolveBilibiliPublishedAt } from "./bilibili-published-date.mjs";
import { extractBilibiliBv, normalizeBilibiliVideoUrl } from "./link-utils.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";
import { readPlatformAccounts } from "./platform-accounts.mjs";
import {
  DetailCache,
  createCrawlAudit,
  installConservativeResourceBlocker,
  logAuditSummary,
  resolveCrawlMode,
  shouldInspectDetailByPublishedAt,
  shouldRefreshDetailCache,
  shouldUseDetailCache
} from "./crawl-runtime.mjs";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "output");
const USER_DATA_DIR = path.join(ROOT, ".bilibili-profile");
const OPTIONS = parseArgs(process.argv.slice(2));
const CRAWL_MODE = resolveCrawlMode(OPTIONS);
const TODAY = normalizeDateInput(OPTIONS.until || process.env.UNTIL || formatDate(new Date()));
const SINCE = normalizeDateInput(OPTIONS.since || process.env.SINCE || "2026-04-15");
const MAX_SCROLLS_PER_ACCOUNT = Number(process.env.BILIBILI_MAX_SCROLLS_PER_ACCOUNT || 12);
const MAX_DETAIL_PAGES = Number(process.env.BILIBILI_MAX_DETAIL_PAGES || 80);
const OLD_ITEM_STOP_AFTER = Number(process.env.BILIBILI_OLD_ITEM_STOP_AFTER || 4);
const SCROLL_DELAY = parseDelayRange(process.env.BILIBILI_SCROLL_DELAY || "1200-2500");
const DETAIL_GAP_DELAY = parseDelayRange(process.env.BILIBILI_DETAIL_GAP_DELAY || "800-1800");
const HEADLESS = resolveHeadless();
const BILIBILI_DETAIL_CACHE_VERSION = 3;

async function main() {
  if (compareDateStrings(SINCE, TODAY) > 0) {
    throw new Error(`起始日期不能晚于结束日期：${SINCE} > ${TODAY}`);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`B站爬取时间范围：${SINCE} 至 ${TODAY}`);
  console.log(`B站采集模式：${modeLabel(CRAWL_MODE)}`);
  const accounts = await readPlatformAccounts("bilibili", { root: ROOT });
  if (accounts.length === 0) {
    throw new Error("请先在账号配置中添加B站账号。");
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    ...chromiumLaunchOptions(),
    headless: HEADLESS,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
  });
  const resourceBlocker = await installConservativeResourceBlocker(context, {
    mode: CRAWL_MODE,
    label: "B站轻量页面模式"
  });

  const listPage = await context.newPage();
  const detailPage = await context.newPage();
  listPage.setDefaultTimeout(20_000);
  detailPage.setDefaultTimeout(20_000);

  const audit = createCrawlAudit("bilibili");
  const detailCache = new DetailCache({
    root: ROOT,
    platformId: "bilibili",
    enabled: shouldUseDetailCache({ mode: CRAWL_MODE }),
    refresh: shouldRefreshDetailCache()
  });

  const rows = [];
  for (const account of accounts) {
    const accountRows = await crawlAccountRecentFirst({
      listPage,
      detailPage,
      account,
      audit: audit.account(account.name),
      detailCache,
      resourceBlocker
    });
    rows.push(...accountRows);
    console.log(`B站账号完成：${account.name}，命中 ${accountRows.length} 条`);
  }
  logAuditSummary(audit);
  await resourceBlocker.close();
  await context.close();
  await writeOutputs(rows, { audit: audit.toJSON(), mode: CRAWL_MODE });
  console.log(`\nB站完成：导出 ${rows.length} 条`);
}

async function crawlAccountRecentFirst({ listPage, detailPage, account, audit, detailCache, resourceBlocker }) {
  const apiVideos = new Map();
  listPage.on("response", async (response) => {
    const url = response.url();
    if (!isVideoListResponse(url)) return;
    const payload = await response.json().catch(() => null);
    for (const video of extractVideosFromApiPayload(payload)) {
      if (!apiVideos.has(video.bvid)) apiVideos.set(video.bvid, video);
    }
  });

  console.log(`\n==> 处理B站账号：${account.name}`);
  await listPage.goto(account.url, { waitUntil: "domcontentloaded" });
  await listPage.waitForTimeout(5000);

  const rows = [];
  const seen = new Set();
  let stableRounds = 0;
  let oldItemRounds = 0;
  let checked = 0;
  let hasInRangeItem = false;
  let stopped = false;
  const stop = (reason) => {
    if (!stopped) {
      audit?.stop(reason);
      stopped = true;
    }
  };

  for (let i = 0; i < MAX_SCROLLS_PER_ACCOUNT; i += 1) {
    const links = await getVideoCandidatesWithFallback(listPage, apiVideos, { resourceBlocker });
    const newLinks = links.filter((link) => !seen.has(link.bvid));
    console.log(`B站页面视频：${links.length} 条，新视频：${newLinks.length} 条`);

    if (links.length === 0 && await isLoginRequired(listPage)) {
      throw new Error("B站登录状态不可用或页面触发风控，请先在面板切到B站后点击“打开登录”完成登录。");
    }

    stableRounds = newLinks.length === 0 ? stableRounds + 1 : 0;

    for (const link of newLinks) {
      seen.add(link.bvid);
      const prefilter = shouldInspectDetailByPublishedAt({
        publishedAt: link.publishedAt,
        since: SINCE,
        until: TODAY
      });
      if (!prefilter.inspect) {
        audit?.recordSkipped(prefilter.reason);
        if (prefilter.reason === "before-since") {
          oldItemRounds += 1;
          console.log(`B站列表时间边界：早于开始日期，跳过详情页：${account.name} ${link.publishedAt} ${link.videoUrl}`);
          if ((hasInRangeItem || seen.size >= 8) && oldItemRounds >= OLD_ITEM_STOP_AFTER) {
            stop("old-boundary");
            console.log(`连续 ${OLD_ITEM_STOP_AFTER} 条早于起始日期，停止继续下翻：${account.name}`);
            return rows;
          }
        } else {
          console.log(`B站列表时间边界：晚于结束日期，跳过详情页：${account.name} ${link.publishedAt} ${link.videoUrl}`);
        }
        continue;
      }
      if (checked >= MAX_DETAIL_PAGES) {
        stop("detail-limit");
        console.log(`已达到B站详情页检查上限：${MAX_DETAIL_PAGES}`);
        return rows;
      }

      checked += 1;
      audit?.recordChecked();

      let detail = restoreBilibiliDetailFromCache(await detailCache.get(link.bvid));
      if (detail) {
        audit?.recordCacheHit();
        console.log(`B站详情缓存命中：${account.name} ${link.videoUrl}`);
      }
      if (!detail && link.publishedAt && link.title && link.tags) detail = link;
      if (!detail) {
        await waitRandom(detailPage, DETAIL_GAP_DELAY, "B站详情页间隔");
        detail = await scrapeVideoDetail(detailPage, link.videoUrl, { resourceBlocker }).catch((error) => {
          console.warn(`打开B站视频失败，跳过：${link.videoUrl}`);
          console.warn(error.message || String(error));
          return { ...link, publishedAt: link.publishedAt || "" };
        });
        detail = mergeBilibiliDetail(link, detail);
        if (isCacheableBilibiliDetail(detail)) {
          await detailCache.set(link.bvid, serializeBilibiliDetailForCache(detail));
        }
      } else {
        detail = mergeBilibiliDetail(link, detail);
      }

      if (!detail.publishedAt) {
        audit?.recordUnknownDate();
        console.warn(`未识别B站发布时间：${detail.videoUrl || link.videoUrl}`);
        continue;
      }

      if (compareDateStrings(detail.publishedAt, SINCE) < 0) {
        audit?.recordSkipped("before-since");
        oldItemRounds += 1;
        console.log(`边界检查：发现早于开始日期的B站视频，不导出：${account.name} ${detail.publishedAt} ${detail.videoUrl || link.videoUrl}`);
        if ((hasInRangeItem || checked >= 8) && oldItemRounds >= OLD_ITEM_STOP_AFTER) {
          stop("old-boundary");
          console.log(`连续 ${OLD_ITEM_STOP_AFTER} 条早于起始日期，停止继续下翻：${account.name}`);
          return rows;
        }
        continue;
      }

      oldItemRounds = 0;

      if (compareDateStrings(detail.publishedAt, TODAY) > 0) {
        audit?.recordSkipped("after-until");
        console.log(`跳过晚于结束日期B站视频：${account.name} ${detail.publishedAt} ${detail.videoUrl || link.videoUrl}`);
        continue;
      }

      hasInRangeItem = true;
      audit?.recordHit();
      rows.push({
        accountName: account.name,
        publishedAt: detail.publishedAt,
        videoUrl: detail.videoUrl || link.videoUrl,
        bvid: detail.bvid || link.bvid,
        title: detail.title || "",
        tags: detail.tags || ""
      });
      console.log(`B站命中：${account.name} ${detail.publishedAt} ${detail.videoUrl || link.videoUrl}`);
    }

    if (stableRounds >= 4 && links.length > 0) {
      stop("stable-rounds");
      break;
    }

    await listPage.mouse.wheel(0, 1400);
    await waitRandom(listPage, SCROLL_DELAY, "B站下翻停留");
  }

  stop("scroll-limit");
  return rows;
}

async function getVideoCandidatesWithFallback(listPage, apiVideos, { resourceBlocker } = {}) {
  let links = await getVideoCandidates(listPage, apiVideos);
  if (links.length > 0 || !resourceBlocker?.enabled) return links;

  console.log("B站列表页未读到作品，关闭轻量页面模式重试一次。");
  links = await resourceBlocker.disableTemporarily(async () => {
    await listPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await listPage.waitForTimeout(1800);
    return getVideoCandidates(listPage, apiVideos);
  });
  return links;
}

async function getVideoCandidates(page, apiVideos) {
  const domLinks = await page.locator('a[href*="/video/BV"]').evaluateAll((anchors) => {
    return anchors.map((anchor) => ({
      href: anchor.href,
      title: anchor.getAttribute("title") || anchor.getAttribute("aria-label") || anchor.textContent || ""
    }));
  }).catch(() => []);

  const byBvid = new Map(apiVideos);
  for (const item of domLinks) {
    const bvid = extractBilibiliBv(item.href);
    if (!bvid || byBvid.has(bvid)) continue;
    byBvid.set(bvid, {
      bvid,
      videoUrl: normalizeBilibiliVideoUrl(item.href),
      publishedAt: "",
      title: extractBilibiliTitle({ videoData: { title: item.title } }),
      tags: ""
    });
  }

  return [...byBvid.values()].map((video) => ({
    ...video,
    videoUrl: normalizeBilibiliVideoUrl(video.videoUrl || video.arcurl || video.bvid)
  })).filter((video) => video.bvid && video.videoUrl);
}

async function scrapeVideoDetail(page, videoUrl, { resourceBlocker } = {}) {
  const detail = await scrapeVideoDetailOnce(page, videoUrl);
  if (!detail.publishedAt && resourceBlocker?.enabled) {
    console.log("B站详情页关键字段未读到，关闭轻量页面模式重试一次。");
    return resourceBlocker.disableTemporarily(() => scrapeVideoDetailOnce(page, videoUrl));
  }
  return detail;
}

async function scrapeVideoDetailOnce(page, videoUrl) {
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
  }).catch(() => ({ pubdate: 0, bvid: "", videoData: {}, initialTags: [], metaKeywords: "", documentTitle: "", text: "" }));

  const bvid = detail.bvid || extractBilibiliBv(page.url()) || extractBilibiliBv(videoUrl);
  const publishedAt = resolveBilibiliPublishedAt({ pubdate: detail.pubdate, text: detail.text });
  const title = extractBilibiliTitle({
    videoData: detail.videoData,
    documentTitle: detail.documentTitle
  });
  const tags = extractBilibiliTags({
    videoData: detail.videoData,
    initialTags: detail.initialTags,
    metaKeywords: detail.metaKeywords,
    title
  });
  return {
    bvid,
    publishedAt,
    videoUrl: normalizeBilibiliVideoUrl(page.url()) || normalizeBilibiliVideoUrl(videoUrl),
    title,
    tags
  };
}

async function isLoginRequired(page) {
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  return /扫描二维码登录|登录后你可以|立即登录|风控|出错啦/.test(text);
}

function isVideoListResponse(url) {
  return /api\.bilibili\.com\/x\/space\/wbi\/arc\/search/.test(url)
    || /api\.bilibili\.com\/x\/polymer\/web-space/.test(url)
    || /api\.bilibili\.com\/x\/series\/archives/.test(url);
}

function extractVideosFromApiPayload(payload) {
  const candidates = [
    payload?.data?.list?.vlist,
    payload?.data?.archives,
    payload?.data?.items,
    payload?.data?.episodic_button?.archives
  ].filter(Array.isArray).flat();

  return candidates.map((item) => {
    const bvid = item.bvid || item.bv_id || extractBilibiliBv(item.uri || item.arcurl || item.url || "");
    return {
      bvid,
      videoUrl: normalizeBilibiliVideoUrl(item.arcurl || item.uri || item.url || bvid),
      publishedAt: dateFromBilibiliEpoch(item.created || item.pubdate || item.ctime),
      title: extractBilibiliTitle({ videoData: item }),
      tags: extractBilibiliTags({ videoData: item })
    };
  }).filter((item) => item.bvid);
}

async function writeOutputs(rows, { audit = null, mode = "conservative" } = {}) {
  const baseName = `bilibili_videos_${SINCE}_to_${TODAY}`;
  const xlsPath = path.join(OUTPUT_DIR, `${baseName}.xls`);
  const csvPath = path.join(OUTPUT_DIR, `${baseName}.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `${baseName}.json`);
  const headers = ["账号名称", "发布时间", "作品链接", "短链id", "标题", "TAG词"];

  const sheetRows = rows.map((row) => ({
    "账号名称": spreadsheetSafeText(row.accountName),
    "发布时间": row.publishedAt,
    "作品链接": row.videoUrl,
    "短链id": row.bvid,
    "标题": spreadsheetSafeText(row.title || ""),
    "TAG词": spreadsheetSafeText(row.tags || "")
  }));

  await fs.writeFile(xlsPath, buildExcelXml(headers, sheetRows), "utf8");
  const csv = [
    headers.map(csvEscape).join(","),
    ...sheetRows.map((row) => headers.map((header) => csvEscape(row[header] || "")).join(","))
  ].join("\n");
  await fs.writeFile(csvPath, csv, "utf8");
  await fs.writeFile(jsonPath, JSON.stringify({
    platform: "bilibili",
    mode,
    since: SINCE,
    until: TODAY,
    audit,
    items: rows.map((row) => ({
      platform: "bilibili",
      accountName: row.accountName,
      publishedAt: row.publishedAt,
      link: row.videoUrl,
      id: row.bvid,
      title: row.title || "",
      tags: row.tags || ""
    }))
  }, null, 2), "utf8");

  console.log(`XLS ：${xlsPath}`);
  console.log(`CSV ：${csvPath}`);
  console.log(`JSON：${jsonPath}`);
}

function buildExcelXml(headers, rows) {
  const widths = [120, 90, 520, 160, 260, 220];
  const headerCells = headers
    .map((header) => `<Cell ss:StyleID="header"><Data ss:Type="String">${xmlEscape(header)}</Data></Cell>`)
    .join("");
  const bodyRows = rows.map((row) => {
    const cells = headers
      .map((header) => `<Cell><Data ss:Type="String">${xmlEscape(row[header] || "")}</Data></Cell>`)
      .join("");
    return `<Row>${cells}</Row>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="header"><Font ss:Bold="1"/></Style>
 </Styles>
 <Worksheet ss:Name="B站作品">
  <Table>
   ${widths.map((width) => `<Column ss:Width="${width}"/>`).join("\n   ")}
   <Row>${headerCells}</Row>
   ${bodyRows}
  </Table>
 </Worksheet>
</Workbook>`;
}

function csvEscape(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--since" || arg === "-s") {
      options.since = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--since=")) {
      options.since = arg.slice("--since=".length);
      continue;
    }
    if (arg === "--until" || arg === "-u") {
      options.until = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--until=")) {
      options.until = arg.slice("--until=".length);
      continue;
    }
    if (arg === "--mode") {
      options.mode = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
      continue;
    }
    if (!options.since && !arg.startsWith("-")) {
      options.since = arg;
    }
  }
  return options;
}

function parseDelayRange(value) {
  const text = String(value || "").trim();
  const range = text.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const min = Math.max(0, Number(range[1]));
    const max = Math.max(min, Number(range[2]));
    return { min, max };
  }

  const fixed = Math.max(0, Number(text) || 0);
  return { min: fixed, max: fixed };
}

async function waitRandom(page, range, label = "停留") {
  const duration = randomBetween(range.min, range.max);
  if (duration <= 0) return;
  console.log(`${label}：${(duration / 1000).toFixed(1)} 秒`);
  await page.waitForTimeout(duration);
}

function randomBetween(min, max) {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

function restoreBilibiliDetailFromCache(cached) {
  if (!cached) return null;
  if (cached.cacheVersion !== BILIBILI_DETAIL_CACHE_VERSION) return null;
  return {
    bvid: cached.bvid || "",
    publishedAt: cached.publishedAt || "",
    videoUrl: cached.videoUrl || "",
    title: cached.title || "",
    tags: cached.tags || ""
  };
}

function serializeBilibiliDetailForCache(detail) {
  return {
    cacheVersion: BILIBILI_DETAIL_CACHE_VERSION,
    bvid: detail.bvid || "",
    publishedAt: detail.publishedAt || "",
    videoUrl: detail.videoUrl || "",
    title: detail.title || "",
    tags: detail.tags || ""
  };
}

function isCacheableBilibiliDetail(detail) {
  return Boolean(detail && detail.bvid && detail.publishedAt);
}

function mergeBilibiliDetail(base, detail) {
  return {
    bvid: detail?.bvid || base?.bvid || "",
    publishedAt: detail?.publishedAt || base?.publishedAt || "",
    videoUrl: detail?.videoUrl || base?.videoUrl || "",
    title: detail?.title || base?.title || "",
    tags: detail?.tags || base?.tags || ""
  };
}

function modeLabel(mode) {
  return mode === "legacy" ? "兼容旧模式" : "保守提速";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
