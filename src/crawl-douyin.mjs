import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, resolveHeadless } from "./browser-env.mjs";
import { formatDate as formatDateInTimeZone, parsePublishedDateText } from "./date-utils.mjs";
import { extractDouyinApiDetail, extractDouyinTagsFromSources, extractDouyinTitle } from "./douyin-detail-text.mjs";
import { douyinProfileIdsMatch, extractPrimaryDouyinAuthorProfileUrl } from "./douyin-profile-guard.mjs";
import { classifyContentType } from "./content-classifier.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";
import {
  DetailCache,
  comparePublishedAtToDateRange,
  createCrawlAudit,
  dateKey,
  installConservativeResourceBlocker,
  logAuditSummary,
  resolveCrawlMode,
  shouldCopyDouyinShare,
  shouldInspectDetailByPublishedAt,
  shouldRefreshDetailCache,
  shouldUseDetailCache
} from "./crawl-runtime.mjs";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "output");
const USER_DATA_DIR = path.join(ROOT, ".douyin-profile");
const OPTIONS = parseArgs(process.argv.slice(2));
const CRAWL_MODE = resolveCrawlMode(OPTIONS);
const TODAY = parseDateInput(OPTIONS.until || process.env.UNTIL || formatDateInTimeZone(new Date()), "结束日期");
const SINCE = parseDateInput(OPTIONS.since || process.env.SINCE || "2026-04-15", "起始日期");
const REFERENCE_DATE = parseDateInput(OPTIONS.referenceDate || process.env.REFERENCE_DATE || formatDateInTimeZone(new Date()), "相对时间参考日期");
const MAX_SCROLLS_PER_ACCOUNT = Number(process.env.MAX_SCROLLS_PER_ACCOUNT || 18);
const MAX_DETAIL_PAGES = Number(process.env.MAX_DETAIL_PAGES || 120);
const OLD_ITEM_STOP_AFTER = Number(process.env.OLD_ITEM_STOP_AFTER || 4);
const MIN_CHECK_BEFORE_STOP = Number(process.env.MIN_CHECK_BEFORE_STOP || 8);
const DETAIL_READ_DELAY = parseDelayRange(process.env.DOUYIN_DETAIL_READ_DELAY || "3000-7000");
const DETAIL_GAP_DELAY = parseDelayRange(process.env.DOUYIN_DETAIL_GAP_DELAY || "2000-5000");
const SCROLL_DELAY = parseDelayRange(process.env.DOUYIN_SCROLL_DELAY || "2000-4000");
const HEADLESS = resolveHeadless();
const DOUYIN_DETAIL_CACHE_VERSION = 3;

const DEFAULT_ACCOUNTS = [
  { name: "同花顺投资", url: "https://www.douyin.com/user/MS4wLjABAAAArf6v6Z48Pma-bIrz00wVCu76ioePN0vKzHAM_w9DN8AOkLekEk13Ay8_L-74BBB8" },
  { name: "同花顺股民社区", url: "https://www.douyin.com/user/MS4wLjABAAAAzuAZbgu03QhyuhKxMJGwrG0pnvDNfstYkT5ZCNGD-0U" },
  { name: "同花顺财富", url: "https://www.douyin.com/user/MS4wLjABAAAAffWkqfj5JINgA9xCh5-FKaNW5qY2huDbccgDgQho8B8" },
  { name: "同花顺财经", url: "https://www.douyin.com/user/MS4wLjABAAAAUre0Jlqe0K5psIWsDhGc8A9TKiKgfYkI0uCnryZ-9U3SeKkyAM7hSqhohItj8okF" },
  { name: "同花顺问财", url: "https://www.douyin.com/user/MS4wLjABAAAA6JdBqgkVwTEgEeOHSWLxaDZ2II-eG3Jm1LpzZiqrRu7_kE2iDCZdYt1jqpVAawMa" },
  { name: "同花顺期货通", url: "https://www.douyin.com/user/MS4wLjABAAAAxr3bk2-4lsUB0XOErXDXFKIocqd2wOExCTAuRwQ19Vg" }
];

async function main() {
  if (SINCE > TODAY) {
    throw new Error(`起始日期不能晚于结束日期：${formatDate(SINCE)} > ${formatDate(TODAY)}`);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`抖音爬取时间范围：${formatDate(SINCE)} 至 ${formatDate(TODAY)}`);
  console.log(`抖音相对时间解析基准：${formatDate(REFERENCE_DATE)}`);
  console.log(`抖音采集模式：${modeLabel(CRAWL_MODE)}`);

  const accounts = await loadAccounts();
  const rows = [];
  const audit = createCrawlAudit("douyin");
  const accountErrors = [];
  let context = null;
  let resourceBlocker = null;

  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...chromiumLaunchOptions(),
      headless: HEADLESS,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
        timezoneId: "Asia/Shanghai"
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://www.douyin.com" }).catch(() => {});
    resourceBlocker = await installConservativeResourceBlocker(context, {
      mode: CRAWL_MODE,
      label: "抖音轻量页面模式"
    });

    const listPage = await context.newPage();
    const detailPage = await context.newPage();
    listPage.setDefaultTimeout(20_000);
    detailPage.setDefaultTimeout(20_000);

    const detailCache = new DetailCache({
      root: ROOT,
      platformId: "douyin",
      enabled: shouldUseDetailCache({ mode: CRAWL_MODE }),
      refresh: shouldRefreshDetailCache()
    });
    const copyShare = shouldCopyDouyinShare({ mode: CRAWL_MODE });
    for (const account of accounts) {
      console.log(`\n==> 处理抖音账号：${account.name}`);
      if (!account.url) {
        console.warn(`账号缺少主页链接：${account.name}`);
        continue;
      }

      try {
        const accountRows = await crawlAccountRecentFirst({
          listPage,
          detailPage,
          accountName: account.name,
          profileUrl: account.url,
          audit: audit.account(account.name),
          detailCache,
          resourceBlocker,
          copyShare
        });
        rows.push(...accountRows);
        console.log(`抖音账号完成：${account.name}，命中 ${accountRows.length} 条`);
      } catch (error) {
        const message = error.message || String(error);
        audit.account(account.name).stop("account-error");
        accountErrors.push({ accountName: account.name, error: message });
        console.warn(`抖音账号失败，继续下一个账号：${account.name}，原因：${message}`);
        if (isFatalDouyinAccountError(error)) throw error;
      }
    }
  } finally {
    await resourceBlocker?.close().catch(() => {});
    await context?.close().catch(() => {});
  }

  logAuditSummary(audit);
  const auditSummary = {
    ...audit.toJSON(),
    accountErrors
  };
  await writeOutputs(rows, { audit: auditSummary, mode: CRAWL_MODE });
  console.log(`\n抖音完成：导出 ${rows.length} 条`);
}

async function loadAccounts() {
  const accountPath = path.join(ROOT, "douyin-accounts.json");
  try {
    const text = await fs.readFile(accountPath, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("douyin-accounts.json must be an array");
    }
    return parsed.map((item) => ({
      name: String(item.name || "").trim(),
      url: normalizeUrl(String(item.url || "").trim())
    })).filter((item) => item.name);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return DEFAULT_ACCOUNTS;
  }
}

async function crawlAccountRecentFirst({ listPage, detailPage, accountName, profileUrl, audit, detailCache, resourceBlocker, copyShare }) {
  await listPage.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await listPage.waitForLoadState("domcontentloaded").catch(() => {});
  await listPage.waitForTimeout(3500);

  if (await isLoginRequired(listPage)) {
    throw new Error("抖音登录状态已失效，请先在面板切到抖音后点击“打开登录”重新登录，登录成功后关闭登录浏览器，再开始爬取。");
  }

  console.log(`抖音账号主页：${listPage.url()}`);
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
    const links = await getPublishedItemsWithFallback(listPage, { resourceBlocker });
    const newLinks = links.filter((link) => !seen.has(link.id));
    console.log(`页面作品链接：${links.length} 条，新作品：${newLinks.length} 条`);

    if (links.length === 0) {
      if (await isLoginRequired(listPage)) {
        throw new Error("抖音登录状态已失效，请先重新登录。");
      }
      const title = await listPage.title().catch(() => "");
      console.warn(`未读到抖音账号作品：${accountName} title="${title}" url=${listPage.url()}`);
    }

    stableRounds = newLinks.length === 0 ? stableRounds + 1 : 0;

    for (const link of newLinks) {
      seen.add(link.id);
      const prefilter = shouldInspectDetailByPublishedAt({
        publishedAt: link.publishedAt,
        since: SINCE,
        until: TODAY
      });
      if (!prefilter.inspect) {
        audit?.recordSkipped(prefilter.reason);
        if (prefilter.reason === "before-since") {
          oldItemRounds += 1;
          console.log(`列表时间边界：早于开始日期，跳过详情页：${accountName} ${link.publishedAt} ${link.exportUrl}`);
          if ((hasInRangeItem || seen.size >= MIN_CHECK_BEFORE_STOP) && oldItemRounds >= OLD_ITEM_STOP_AFTER) {
            stop("old-boundary");
            console.log(`连续 ${OLD_ITEM_STOP_AFTER} 条早于起始日期，停止继续下翻：${accountName}`);
            return rows;
          }
        } else {
          console.log(`列表时间边界：晚于结束日期，跳过详情页：${accountName} ${link.publishedAt} ${link.exportUrl}`);
        }
        continue;
      }
      if (prefilter.reason === "unknown-date") audit?.recordUnknownDate();

      if (checked >= MAX_DETAIL_PAGES) {
        stop("detail-limit");
        console.log(`已达到详情页检查上限：${MAX_DETAIL_PAGES}`);
        return rows;
      }

      checked += 1;
      audit?.recordChecked();

      let detail = restoreDouyinDetailFromCache(await detailCache.get(link.id));
      if (detail) {
        audit?.recordCacheHit();
        console.log(`抖音详情缓存命中：${accountName} ${link.exportUrl}`);
      } else {
        await waitRandom(detailPage, DETAIL_GAP_DELAY, "详情页间隔");
        detail = await scrapeItemDetail(detailPage, link.detailUrl, { resourceBlocker, copyShare }).catch((error) => {
          console.warn(`打开抖音作品失败，跳过：${link.exportUrl}`);
          console.warn(error.message || String(error));
          return { tags: "", publishedAt: null, itemUrl: link.exportUrl, failed: true };
        });
        if (isCacheableDouyinDetail(detail)) {
          await detailCache.set(link.id, serializeDouyinDetailForCache(detail));
        }
      }

      if (detail.failed) {
        continue;
      }

      if (!douyinProfileIdsMatch(profileUrl, detail.authorProfileUrl)) {
        console.warn(`跳过非当前账号作品：${accountName} expected=${profileUrl} actual=${detail.authorProfileUrl || "未识别"} link=${detail.itemUrl || link.exportUrl}`);
        continue;
      }

      if (!detail.publishedAt) {
        console.warn(`未识别抖音发布时间：${detail.itemUrl || link.exportUrl}`);
        if (detail.dateCandidates) {
          console.warn(`时间候选文本：${detail.dateCandidates}`);
        }
        continue;
      }

      const publishedAt = dateKey(detail.publishedAt);
      const rangePosition = comparePublishedAtToDateRange({ publishedAt: detail.publishedAt, since: SINCE, until: TODAY });
      if (rangePosition === "before-since") {
        oldItemRounds += 1;
        console.log(`边界检查：发现早于开始日期的作品，不导出：${accountName} ${publishedAt} ${detail.itemUrl || link.exportUrl}`);
        if ((hasInRangeItem || checked >= MIN_CHECK_BEFORE_STOP) && oldItemRounds >= OLD_ITEM_STOP_AFTER) {
          stop("old-boundary");
          console.log(`连续 ${OLD_ITEM_STOP_AFTER} 条早于起始日期，停止继续下翻：${accountName}`);
          return rows;
        }
        continue;
      }

      oldItemRounds = 0;

      if (rangePosition === "after-until") {
        console.log(`跳过晚于结束日期作品：${accountName} ${publishedAt} ${detail.itemUrl || link.exportUrl}`);
        continue;
      }

      hasInRangeItem = true;
      audit?.recordHit();
      const classification = await classifyContentType({
        platformId: "douyin",
        accountName,
        title: detail.title || "",
        tags: detail.tags,
        text: detail.shareText || ""
      });
      rows.push({
        accountName,
        publishedAt,
        itemUrl: detail.itemUrl || link.exportUrl,
        shareText: detail.shareText || "",
        title: detail.title || "",
        tags: detail.tags,
        contentType: classification.contentType,
        contentTypeReview: classification.contentTypeReview
      });
      console.log(`抖音命中：${accountName} ${publishedAt} ${detail.itemUrl || link.exportUrl}`);
    }

    if (stableRounds >= 4 && links.length > 0) {
      stop("stable-rounds");
      break;
    }

    await listPage.mouse.wheel(0, 1600);
    await waitRandom(listPage, SCROLL_DELAY, "下翻停留");
  }

  stop("scroll-limit");
  return rows;
}

async function getPublishedItemsWithFallback(listPage, { resourceBlocker } = {}) {
  let links = await getPublishedItems(listPage);
  if (links.length > 0 || !resourceBlocker?.enabled) return links;

  console.log("抖音列表页未读到作品，关闭轻量页面模式重试一次。");
  links = await resourceBlocker.disableTemporarily(async () => {
    await listPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await listPage.waitForLoadState("domcontentloaded").catch(() => {});
    await listPage.waitForTimeout(1200);
    return getPublishedItems(listPage);
  });
  return links;
}

async function getPublishedItems(page) {
  const rawLinks = await page.evaluate(() => {
    const values = new Set();
    for (const anchor of document.querySelectorAll("a[href]")) {
      values.add(anchor.href);
    }

    const html = document.documentElement?.innerHTML || "";
    for (const match of html.matchAll(/https?:\\\/\\\/www\.douyin\.com\\\/(?:video|note)\\\/[A-Za-z0-9_-]+[^"'\\<\s]*/g)) {
      values.add(match[0].replaceAll("\\/", "/"));
    }

    return [...values];
  }).catch(() => []);

  const byId = new Map();
  for (const href of rawLinks) {
    const item = normalizeItemUrl(href);
    if (item && !byId.has(item.id)) byId.set(item.id, item);
  }

  return [...byId.values()];
}

async function scrapeItemDetail(page, itemUrl, { resourceBlocker, copyShare = false } = {}) {
  const detail = await scrapeItemDetailOnce(page, itemUrl, { copyShare });
  if (shouldRetryDouyinDetailUnblocked(detail) && resourceBlocker?.enabled) {
    console.log("抖音详情页关键字段未读到，关闭轻量页面模式重试一次。");
    return resourceBlocker.disableTemporarily(() => scrapeItemDetailOnce(page, itemUrl, { copyShare }));
  }
  return detail;
}

async function scrapeItemDetailOnce(page, itemUrl, { copyShare = false } = {}) {
  const apiDetailPromise = waitForDouyinAwemeDetail(page, itemUrl);
  await page.goto(itemUrl, { waitUntil: "domcontentloaded" });
  await waitForDetailDateText(page);
  await waitRandom(page, DETAIL_READ_DELAY, "详情页停留");
  const detail = await scrapeItemDetailFromPage(page);
  const apiDetail = await apiDetailPromise;
  if (apiDetail) {
    detail.title = detail.title || apiDetail.title;
    detail.tags = detail.tags || apiDetail.tags;
    detail.publishedAt = apiDetail.publishedAt || detail.publishedAt;
    detail.authorProfileUrl = apiDetail.authorProfileUrl || detail.authorProfileUrl;
  }
  detail.itemUrl = normalizeClickedItemUrl(page.url()) || itemUrl;
  detail.shareText = (copyShare || !detail.tags) ? await tryReadShareText(page) : "";
  if (!detail.tags && detail.shareText) {
    detail.tags = extractDouyinTagsFromSources({
      itemText: detail.itemText,
      titleText: detail.titleText,
      shareText: detail.shareText
    });
  }
  detail.title = detail.title || extractDouyinTitle({
    itemText: detail.itemText,
    titleText: detail.titleText,
    shareText: detail.shareText
  });
  return detail;
}

function waitForDouyinAwemeDetail(page, itemUrl) {
  const itemId = normalizeItemUrl(itemUrl)?.id || "";
  if (!itemId) return Promise.resolve(null);

  return page.waitForResponse((response) => {
    try {
      const url = new URL(response.url());
      return url.pathname.includes("/aweme/v1/web/aweme/detail/")
        && url.searchParams.get("aweme_id") === itemId
        && response.status() === 200;
    } catch {
      return false;
    }
  }, { timeout: 15_000 })
    .then((response) => response.json())
    .then((json) => extractDouyinApiDetail(json))
    .catch(() => null);
}

async function scrapeItemDetailFromPage(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (/登录后查看更多|扫码登录|验证码登录|手机号登录|请登录|登录后查看/.test(bodyText)) {
    throw new Error("抖音详情页需要重新登录。");
  }

  const itemText = await readCurrentItemText(page);
  const titleText = await page.title().catch(() => "");
  const dateSourceText = itemText || bodyText;
  const tags = extractDouyinTagsFromSources({ itemText, titleText });
  const title = extractDouyinTitle({ itemText, titleText });
  const publishedAt = extractPublishedAtFromText(dateSourceText);
  const authorProfileUrl = await readPrimaryAuthorProfileUrl(page);
  return {
    title,
    tags,
    publishedAt,
    authorProfileUrl,
    itemText,
    titleText,
    dateCandidates: extractDateCandidateLines(dateSourceText)
  };
}

async function readPrimaryAuthorProfileUrl(page) {
  const hrefs = await page.locator("a[href]").evaluateAll((anchors) => {
    return anchors.map((anchor) => anchor.href || "").filter(Boolean);
  }).catch(() => []);
  return extractPrimaryDouyinAuthorProfileUrl(hrefs);
}

async function waitForDetailDateText(page) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return /发布时间[:：]?\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}/.test(text)
      || /发布于[:：]?\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}/.test(text)
      || /\d{4}年\d{1,2}月\d{1,2}日/.test(text)
      || /(刚刚|\d+\s*分钟前|\d+\s*小时前|昨天|今天)/.test(text);
  }, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function readCurrentItemText(page) {
  const selectors = [
    ".video-info-detail",
    ".xgplayer-video-info-wrap",
    ".douyin-player-video-info-wrap",
    ".player-position-box-bottom",
    ".title"
  ];

  for (const selector of selectors) {
    const texts = await page.locator(selector).evaluateAll((elements) => {
      return elements
        .map((element) => element.innerText || element.textContent || "")
        .map((text) => text.trim())
        .filter(Boolean);
    }).catch(() => []);

    const usable = texts.find((text) => {
      if (text.length > 2000) return false;
      return /#|发布|刚刚|分钟前|小时前|昨天|今天|\d{1,2}月\d{1,2}日|20\d{2}[./-]\d{1,2}[./-]\d{1,2}/.test(text);
    });

    if (usable) return usable;
  }

  return "";
}

async function tryReadShareText(page) {
  const previousClipboard = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }).catch(() => "");

  const shareTriggers = [
    page.getByText(/^分享$/).first(),
    page.locator('[aria-label*="分享"]').first(),
    page.locator('button:has-text("分享")').first()
  ];

  for (const trigger of shareTriggers) {
    try {
      await trigger.click({ timeout: 1200 });
      await page.waitForTimeout(800);
      break;
    } catch {
      // Try the next visible share affordance.
    }
  }

  const copyTriggers = [
    page.getByText(/复制链接|复制口令|复制分享/).first(),
    page.locator('button:has-text("复制")').first()
  ];

  for (const trigger of copyTriggers) {
    try {
      await trigger.click({ timeout: 1200 });
      await page.waitForTimeout(500);
      const clipboard = await page.evaluate(async () => {
        try {
          return await navigator.clipboard.readText();
        } catch {
          return "";
        }
      });
      if (clipboard && clipboard !== previousClipboard && /douyin\.com|Dou音|抖音/i.test(clipboard)) {
        return clipboard.trim();
      }
    } catch {
      // Share text is best-effort; the caller falls back to the detail URL.
    }
  }

  return "";
}

async function isLoginRequired(page) {
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const url = page.url();
  if (/登录后查看更多|扫码登录|验证码登录|手机号登录|请登录|登录后查看/.test(text)) return true;
  if (/\/login|login\?/.test(url)) return true;
  return false;
}

function extractPublishedAtFromText(text) {
  const normalized = text.replace(/\u00a0/g, " ");
  const directPatterns = [
    /发布时间[:：]?\s*(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/,
    /发布于[:：]?\s*(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/,
    /(\d{4})年(\d{1,2})月(\d{1,2})日/
  ];

  for (const pattern of directPatterns) {
    const match = normalized.match(pattern);
    if (match) return parseDateOnly(`${match[1]}-${pad(match[2])}-${pad(match[3])}`);
  }

  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length > 80) continue;
    const date = parsePublishedAt(line);
    if (date) return date;
  }

  return parsePublishedAt(normalized);
}

function extractDateCandidateLines(text) {
  const lines = String(text || "")
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (line.length > 100) return false;
      return /发布|时间|刚刚|分钟前|小时前|天前|周前|昨天|今天|\d{4}[./年-]|\d{1,2}[./月-]\d{1,2}/.test(line);
    });

  return lines.slice(0, 8).join(" | ");
}

function parsePublishedAt(text) {
  const dateString = parsePublishedDateText(text, formatDate(REFERENCE_DATE));
  return dateString ? parseDateOnly(dateString) : null;
}

async function writeOutputs(rows, { audit = null, mode = "conservative" } = {}) {
  const baseName = `douyin_notes_${formatDate(SINCE)}_to_${formatDate(TODAY)}`;
  const xlsPath = path.join(OUTPUT_DIR, `${baseName}.xls`);
  const csvPath = path.join(OUTPUT_DIR, `${baseName}.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `${baseName}.json`);
  const headers = ["账号名称", "发布时间", "作品链接", "标题", "作品分类", "内容类型标签审核", "TAG词"];

  const sheetRows = rows.map((row) => ({
    "账号名称": spreadsheetSafeText(row.accountName),
    "发布时间": row.publishedAt,
    "作品链接": row.itemUrl,
    "标题": spreadsheetSafeText(row.title || ""),
    "作品分类": spreadsheetSafeText(row.contentType),
    "内容类型标签审核": spreadsheetSafeText(row.contentTypeReview || ""),
    "TAG词": spreadsheetSafeText(row.tags || "")
  }));

  await fs.writeFile(xlsPath, buildExcelXml(headers, sheetRows), "utf8");

  const csv = [
    headers.map(csvEscape).join(","),
    ...sheetRows.map((row) => headers.map((header) => csvEscape(row[header] || "")).join(","))
  ].join("\n");
  await fs.writeFile(csvPath, csv, "utf8");
  await fs.writeFile(jsonPath, JSON.stringify({
    platform: "douyin",
    mode,
    since: formatDate(SINCE),
    until: formatDate(TODAY),
    audit,
    items: rows.map((row) => ({
      platform: "douyin",
      accountName: row.accountName,
      publishedAt: row.publishedAt,
      link: row.itemUrl,
      itemUrl: row.itemUrl,
      shareText: row.shareText || "",
      title: row.title || "",
      tags: row.tags || "",
      contentType: row.contentType || "无",
      contentTypeReview: row.contentTypeReview || "需审核"
    }))
  }, null, 2), "utf8");

  console.log(`XLS ：${xlsPath}`);
  console.log(`CSV ：${csvPath}`);
  console.log(`JSON：${jsonPath}`);
}

function buildExcelXml(headers, rows) {
  const widths = [120, 90, 520, 360, 100, 120, 320];
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
 <Worksheet ss:Name="抖音作品">
  <Table>
   ${widths.map((width) => `<Column ss:Width="${width}"/>`).join("\n   ")}
   <Row>${headerCells}</Row>
   ${bodyRows}
  </Table>
 </Worksheet>
</Workbook>`;
}

function normalizeItemUrl(rawUrl) {
  if (!rawUrl || !/douyin\.com/.test(rawUrl)) return null;
  const url = new URL(rawUrl, "https://www.douyin.com");
  const source = url.searchParams.get("source") || "";
  if (/Baiduspider/i.test(source)) return null;

  const pathMatch = url.pathname.match(/\/(?:video|note)\/([A-Za-z0-9_-]+)/);
  const modalId = url.searchParams.get("modal_id");
  if (modalId) return null;

  const id = pathMatch?.[1] || "";
  if (!id) return null;
  if (!/^\d{8,}$/.test(id) && !/^[A-Za-z0-9_-]{12,}$/.test(id)) return null;

  const cleanUrl = `https://www.douyin.com${url.pathname}${url.search}`;

  return {
    id,
    detailUrl: cleanUrl,
    exportUrl: cleanUrl
  };
}

function normalizeClickedItemUrl(rawUrl) {
  const item = normalizeItemUrl(rawUrl);
  if (item) return item.exportUrl;
  return normalizeUrl(rawUrl);
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return "";
  return new URL(rawUrl, "https://www.douyin.com").toString();
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
    if (arg === "--reference-date") {
      options.referenceDate = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--reference-date=")) {
      options.referenceDate = arg.slice("--reference-date=".length);
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

function parseDateInput(value, label) {
  if (!value) throw new Error(`${label}不能为空，请使用 YYYY-MM-DD，例如：npm run crawl:douyin -- 2026-04-15`);

  const trimmed = String(value).trim();
  const fullDate = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  const monthDate = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})$/);

  let year;
  let month;
  let day;
  if (fullDate) {
    year = Number(fullDate[1]);
    month = Number(fullDate[2]);
    day = Number(fullDate[3]);
  } else if (monthDate) {
    year = new Date().getFullYear();
    month = Number(monthDate[1]);
    day = Number(monthDate[2]);
  } else {
    throw new Error(`${label}格式不正确：${value}。请使用 YYYY-MM-DD，例如 2026-04-15`);
  }

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`${label}不是有效日期：${value}`);
  }

  return date;
}

function parseDateOnly(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function cloneDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
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

function restoreDouyinDetailFromCache(cached) {
  if (!cached) return null;
  if (cached.cacheVersion !== DOUYIN_DETAIL_CACHE_VERSION) return null;
  return {
    tags: cached.tags || "",
    publishedAt: cached.publishedAt ? parseDateOnly(cached.publishedAt) : null,
    itemUrl: cached.itemUrl || "",
    shareText: cached.shareText || "",
    title: cached.title || "",
    authorProfileUrl: cached.authorProfileUrl || "",
    contentType: cached.contentType || "",
    contentTypeReview: cached.contentTypeReview || ""
  };
}

function serializeDouyinDetailForCache(detail) {
  return {
    cacheVersion: DOUYIN_DETAIL_CACHE_VERSION,
    tags: detail.tags || "",
    publishedAt: detail.publishedAt ? formatDate(detail.publishedAt) : "",
    itemUrl: detail.itemUrl || "",
    shareText: detail.shareText || "",
    title: detail.title || "",
    authorProfileUrl: detail.authorProfileUrl || "",
    contentType: detail.contentType || "",
    contentTypeReview: detail.contentTypeReview || ""
  };
}

function isCacheableDouyinDetail(detail) {
  return Boolean(detail && !detail.failed && detail.publishedAt && detail.authorProfileUrl);
}

function shouldRetryDouyinDetailUnblocked(detail) {
  return Boolean(!detail?.publishedAt || !detail?.authorProfileUrl);
}

function isFatalDouyinAccountError(error) {
  const message = error.message || String(error);
  return /登录状态|重新登录|需要重新登录|登录后查看更多|扫码登录|验证码登录|手机号登录|请登录|登录后查看/.test(message);
}

function modeLabel(mode) {
  return mode === "legacy" ? "兼容旧模式" : "保守提速";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
