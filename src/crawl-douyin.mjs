import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, resolveHeadless } from "./browser-env.mjs";
import { classifyTags } from "./tag-rules.mjs";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "output");
const USER_DATA_DIR = path.join(ROOT, ".douyin-profile");
const OPTIONS = parseArgs(process.argv.slice(2));
const TODAY = parseDateInput(OPTIONS.until || process.env.UNTIL || formatDate(new Date()), "结束日期");
const SINCE = parseDateInput(OPTIONS.since || process.env.SINCE || "2026-04-15", "起始日期");
const MAX_SCROLLS_PER_ACCOUNT = Number(process.env.MAX_SCROLLS_PER_ACCOUNT || 18);
const MAX_DETAIL_PAGES = Number(process.env.MAX_DETAIL_PAGES || 120);
const OLD_ITEM_STOP_AFTER = Number(process.env.OLD_ITEM_STOP_AFTER || 4);
const MIN_CHECK_BEFORE_STOP = Number(process.env.MIN_CHECK_BEFORE_STOP || 8);
const HEADLESS = resolveHeadless();

const DEFAULT_ACCOUNTS = [
  { name: "同花顺投资", url: "https://v.douyin.com/8pyAXT0mwsU/" },
  { name: "同花顺财富", url: "https://v.douyin.com/C0KAFfks1cQ/" },
  { name: "同花顺股民社区", url: "https://v.douyin.com/wZKpyaep7Fo/" },
  { name: "同花顺财经", url: "https://v.douyin.com/L527qFgwkX8/" },
  { name: "同花顺期货通", url: "https://v.douyin.com/WM8jW-w0xxo/" },
  { name: "同花顺问财", url: "https://v.douyin.com/mLRMq0EJ7fw/" },
  { name: "喵懂投资", url: "https://v.douyin.com/X4-iPYrm0QU/" }
];

async function main() {
  if (SINCE > TODAY) {
    throw new Error(`起始日期不能晚于结束日期：${formatDate(SINCE)} > ${formatDate(TODAY)}`);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`抖音爬取时间范围：${formatDate(SINCE)} 至 ${formatDate(TODAY)}`);

  const accounts = await loadAccounts();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    ...chromiumLaunchOptions(),
    headless: HEADLESS,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai"
  });

  const listPage = await context.newPage();
  const detailPage = await context.newPage();
  listPage.setDefaultTimeout(20_000);
  detailPage.setDefaultTimeout(20_000);

  const rows = [];
  for (const account of accounts) {
    console.log(`\n==> 处理抖音账号：${account.name}`);
    if (!account.url) {
      console.warn(`账号缺少主页链接：${account.name}`);
      continue;
    }

    const accountRows = await crawlAccountRecentFirst({
      listPage,
      detailPage,
      accountName: account.name,
      profileUrl: account.url
    });
    rows.push(...accountRows);
    console.log(`抖音账号完成：${account.name}，命中 ${accountRows.length} 条`);
  }

  await context.close();
  await writeOutputs(rows);
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

async function crawlAccountRecentFirst({ listPage, detailPage, accountName, profileUrl }) {
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

  for (let i = 0; i < MAX_SCROLLS_PER_ACCOUNT; i += 1) {
    const links = await getPublishedItems(listPage);
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
      if (checked >= MAX_DETAIL_PAGES) {
        console.log(`已达到详情页检查上限：${MAX_DETAIL_PAGES}`);
        return rows;
      }

      seen.add(link.id);
      checked += 1;

      const detail = await scrapeItemDetail(detailPage, link.detailUrl).catch((error) => {
        console.warn(`打开抖音作品失败，跳过：${link.exportUrl}`);
        console.warn(error.message || String(error));
        return { tags: "", publishedAt: null, itemUrl: link.exportUrl, failed: true };
      });

      if (!detail.publishedAt) {
        console.warn(`未识别抖音发布时间：${detail.itemUrl || link.exportUrl}`);
        if (detail.dateCandidates) {
          console.warn(`时间候选文本：${detail.dateCandidates}`);
        }
        continue;
      }

      const publishedAt = formatDate(detail.publishedAt);
      if (detail.publishedAt < SINCE) {
        oldItemRounds += 1;
        console.log(`已到较早作品：${accountName} ${publishedAt} ${detail.itemUrl || link.exportUrl}`);
        if ((hasInRangeItem || checked >= MIN_CHECK_BEFORE_STOP) && oldItemRounds >= OLD_ITEM_STOP_AFTER) {
          console.log(`连续 ${OLD_ITEM_STOP_AFTER} 条早于起始日期，停止继续下翻：${accountName}`);
          return rows;
        }
        continue;
      }

      oldItemRounds = 0;

      if (detail.publishedAt > TODAY) {
        console.log(`跳过晚于结束日期作品：${accountName} ${publishedAt} ${detail.itemUrl || link.exportUrl}`);
        continue;
      }

      hasInRangeItem = true;
      rows.push({
        accountName,
        publishedAt,
        itemUrl: detail.itemUrl || link.exportUrl,
        tags: detail.tags,
        contentType: classifyTags(detail.tags)
      });
      console.log(`抖音命中：${accountName} ${publishedAt} ${detail.itemUrl || link.exportUrl}`);
    }

    if (stableRounds >= 4 && links.length > 0) break;

    await listPage.mouse.wheel(0, 1600);
    await listPage.waitForTimeout(1600);
  }

  return rows;
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
    for (const match of html.matchAll(/modal_id=([0-9A-Za-z_-]+)/g)) {
      values.add(`${location.origin}${location.pathname}?modal_id=${match[1]}`);
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

async function scrapeItemDetail(page, itemUrl) {
  await page.goto(itemUrl, { waitUntil: "domcontentloaded" });
  await waitForDetailDateText(page);
  const detail = await scrapeItemDetailFromPage(page);
  detail.itemUrl = normalizeClickedItemUrl(page.url()) || itemUrl;
  return detail;
}

async function scrapeItemDetailFromPage(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (/登录后查看更多|扫码登录|验证码登录|手机号登录|请登录|登录后查看/.test(bodyText)) {
    throw new Error("抖音详情页需要重新登录。");
  }

  const tags = extractTags(bodyText);
  const publishedAt = extractPublishedAtFromText(bodyText);
  return { tags, publishedAt, dateCandidates: extractDateCandidateLines(bodyText) };
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

function extractTags(text) {
  const matches = text.match(/#[\p{Script=Han}\p{Letter}\p{Number}_-]+/gu) || [];
  return [...new Set(matches)].join(" ");
}

function parsePublishedAt(text) {
  const normalized = String(text || "").replace(/\s+/g, " ");

  const fullDate = normalized.match(/(?:发布时间|发布于)?[:：]?\s*(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?:\s|$)/);
  if (fullDate) return parseDateOnly(`${fullDate[1]}-${pad(fullDate[2])}-${pad(fullDate[3])}`);

  const cnDate = normalized.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (cnDate) return parseDateOnly(`${cnDate[1]}-${pad(cnDate[2])}-${pad(cnDate[3])}`);

  const monthDate = normalized.match(/(?:发布时间|发布于)?[:：]?\s*(\d{1,2})[./-](\d{1,2})(?:\s+\d{1,2}:?\d{0,2})?(?:\s|$)/);
  if (monthDate) return parseDateOnly(`${TODAY.getFullYear()}-${pad(monthDate[1])}-${pad(monthDate[2])}`);

  if (/今天|刚刚|\d+\s*分钟前|\d+\s*小时前/.test(normalized)) {
    return cloneDate(TODAY);
  }

  if (/昨天/.test(normalized)) {
    const date = cloneDate(TODAY);
    date.setDate(date.getDate() - 1);
    return date;
  }

  const daysAgo = normalized.match(/(\d+)\s*天前/);
  if (daysAgo) {
    const date = cloneDate(TODAY);
    date.setDate(date.getDate() - Number(daysAgo[1]));
    return date;
  }

  const weeksAgo = normalized.match(/(\d+)\s*周前/);
  if (weeksAgo) {
    const date = cloneDate(TODAY);
    date.setDate(date.getDate() - Number(weeksAgo[1]) * 7);
    return date;
  }

  return null;
}

async function writeOutputs(rows) {
  const baseName = `douyin_notes_${formatDate(SINCE)}_to_${formatDate(TODAY)}`;
  const xlsPath = path.join(OUTPUT_DIR, `${baseName}.xls`);
  const csvPath = path.join(OUTPUT_DIR, `${baseName}.csv`);
  const headers = ["账号名称", "发布时间", "作品链接", "作品分类", "TAG词"];

  const sheetRows = rows.map((row) => ({
    "账号名称": row.accountName,
    "发布时间": row.publishedAt,
    "作品链接": row.itemUrl,
    "作品分类": row.contentType,
    "TAG词": row.tags || ""
  }));

  await fs.writeFile(xlsPath, buildExcelXml(headers, sheetRows), "utf8");

  const csv = [
    headers.map(csvEscape).join(","),
    ...sheetRows.map((row) => headers.map((header) => csvEscape(row[header] || "")).join(","))
  ].join("\n");
  await fs.writeFile(csvPath, csv, "utf8");

  console.log(`XLS ：${xlsPath}`);
  console.log(`CSV ：${csvPath}`);
}

function buildExcelXml(headers, rows) {
  const widths = [120, 90, 520, 100, 320];
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
  const pathMatch = url.pathname.match(/\/(?:video|note)\/([A-Za-z0-9_-]+)/);
  const modalId = url.searchParams.get("modal_id");
  const id = pathMatch?.[1] || modalId;
  if (!id) return null;
  if (!/^\d{8,}$/.test(id) && !/^[A-Za-z0-9_-]{12,}$/.test(id)) return null;

  const cleanUrl = pathMatch
    ? `https://www.douyin.com${url.pathname}${url.search}`
    : `https://www.douyin.com${url.pathname}?modal_id=${encodeURIComponent(id)}`;

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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
