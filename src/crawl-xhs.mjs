import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, resolveHeadless } from "./browser-env.mjs";
import { classifyTags } from "./tag-rules.mjs";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "output");
const USER_DATA_DIR = path.join(ROOT, ".xhs-profile");
const OPTIONS = parseArgs(process.argv.slice(2));
const TODAY = parseDateInput(OPTIONS.until || process.env.UNTIL || formatDate(new Date()), "结束日期");
const SINCE = parseDateInput(OPTIONS.since || process.env.SINCE || "2026-04-15", "起始日期");
const MAX_SCROLLS_PER_ACCOUNT = Number(process.env.MAX_SCROLLS_PER_ACCOUNT || 18);
const MAX_DETAIL_PAGES = Number(process.env.MAX_DETAIL_PAGES || 120);
const OLD_NOTE_STOP_AFTER = Number(process.env.OLD_NOTE_STOP_AFTER || 4);
const MIN_CHECK_BEFORE_STOP = Number(process.env.MIN_CHECK_BEFORE_STOP || 8);
const DETAIL_READ_DELAY = parseDelayRange(process.env.XHS_DETAIL_READ_DELAY || "2000-5000");
const DETAIL_GAP_DELAY = parseDelayRange(process.env.XHS_DETAIL_GAP_DELAY || "1500-4000");
const SCROLL_DELAY = parseDelayRange(process.env.XHS_SCROLL_DELAY || "1800-3500");
const HEADLESS = resolveHeadless();

const DEFAULT_ACCOUNTS = [
  { name: "同花顺投资", url: "" },
  { name: "同花顺股民社区", url: "" },
  { name: "同顺财经", url: "" },
  { name: "同花顺新手福利官", url: "" },
  { name: "同花顺理财", url: "" },
  { name: "喵懂投资", url: "" }
];

async function main() {
  if (SINCE > TODAY) {
    throw new Error(`起始日期不能晚于结束日期：${formatDate(SINCE)} > ${formatDate(TODAY)}`);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`爬取时间范围：${formatDate(SINCE)} 至 ${formatDate(TODAY)}`);

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
    console.log(`\n==> 处理账号：${account.name}`);
    const profileUrl = account.url || (await findProfileUrl(listPage, account.name));

    if (!profileUrl) {
      console.warn(`未找到账号主页：${account.name}`);
      continue;
    }

    console.log(`账号主页：${profileUrl}`);
    const accountRows = await crawlAccountRecentFirst({
      listPage,
      detailPage,
      accountName: account.name,
      profileUrl
    });
    rows.push(...accountRows);
    console.log(`账号完成：${account.name}，命中 ${accountRows.length} 条`);
  }

  await context.close();
  await writeOutputs(rows);
  console.log(`\n完成：导出 ${rows.length} 条`);
}

async function loadAccounts() {
  const accountPath = path.join(ROOT, "accounts.json");
  try {
    const text = await fs.readFile(accountPath, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("accounts.json must be an array");
    }
    return parsed.map((item) => ({
      name: String(item.name || "").trim(),
      url: normalizeProfileUrl(String(item.url || "").trim())
    })).filter((item) => item.name);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return DEFAULT_ACCOUNTS;
  }
}

async function findProfileUrl(page, accountName) {
  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(accountName)}&type=user`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const exactText = page.getByText(accountName, { exact: true }).first();
  try {
    await exactText.scrollIntoViewIfNeeded();
    await exactText.click({ timeout: 5000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);
    const url = page.url();
    if (isProfileUrl(url)) return url;
  } catch {
    // Fall through to DOM link scan.
  }

  const links = await page.locator("a[href]").evaluateAll((anchors, name) => {
    return anchors
      .map((a) => ({ href: a.href, text: a.textContent || "" }))
      .filter((a) => a.text.includes(name) || /\/user\/profile\//.test(a.href))
      .map((a) => a.href);
  }, accountName);

  return links.find(isProfileUrl) || "";
}

async function crawlAccountRecentFirst({ listPage, detailPage, accountName, profileUrl }) {
  await listPage.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await waitForProfileNotes(listPage);
  if (await isLoginRequired(listPage)) {
    throw new Error("小红书登录状态已失效，请先在面板点击“打开登录”重新登录，登录成功后关闭登录浏览器，再开始爬取。");
  }

  const rows = [];
  const seen = new Set();
  let stableRounds = 0;
  let oldNoteRounds = 0;
  let checked = 0;
  let hasInRangeNote = false;

  for (let i = 0; i < MAX_SCROLLS_PER_ACCOUNT; i += 1) {
    const stateLinks = await getPublishedNotesFromState(listPage);
    const newLinks = stateLinks.filter((link) => !seen.has(link.id));
    console.log(`页面状态发布作品：${stateLinks.length} 条，新作品：${newLinks.length} 条`);
    if (stateLinks.length === 0) {
      if (await isLoginRequired(listPage)) {
        throw new Error("小红书登录状态已失效，请先重新登录。");
      }
      const title = await listPage.title().catch(() => "");
      console.warn(`未读到账号作品状态：${accountName} title="${title}" url=${listPage.url()}`);
    }

    if (newLinks.length === 0) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    for (const link of newLinks) {
      if (checked >= MAX_DETAIL_PAGES) {
        console.log(`已达到详情页检查上限：${MAX_DETAIL_PAGES}`);
        return rows;
      }

      seen.add(link.id);
      checked += 1;

      await waitRandom(detailPage, DETAIL_GAP_DELAY, "详情页间隔");
      const detail = await scrapeNoteDetail(detailPage, link.detailUrl).catch((error) => {
        console.warn(`打开笔记失败，跳过：${link.exportUrl}`);
        console.warn(error.message || String(error));
        return { tags: "", publishedAt: null, noteUrl: link.exportUrl, failed: true };
      });
      const effectivePublishedAt = link.statePublishedAt || detail.publishedAt;
      if (!effectivePublishedAt) {
        console.warn(`未识别发布时间：${link.exportUrl} stateTime=${link.stateTimeValue ?? ""}`);
        continue;
      }

      const publishedAt = formatDate(effectivePublishedAt);
      if (effectivePublishedAt < SINCE) {
        oldNoteRounds += 1;
        console.log(`已到较早作品：${accountName} ${publishedAt} ${link.exportUrl}`);
        if ((hasInRangeNote || checked >= MIN_CHECK_BEFORE_STOP) && oldNoteRounds >= OLD_NOTE_STOP_AFTER) {
          console.log(`连续 ${OLD_NOTE_STOP_AFTER} 条早于起始日期，停止继续下翻：${accountName}`);
          return rows;
        }
        continue;
      }

      oldNoteRounds = 0;

      if (effectivePublishedAt > TODAY) {
        console.log(`跳过晚于结束日期作品：${accountName} ${publishedAt} ${link.exportUrl}`);
        continue;
      }

      hasInRangeNote = true;
      rows.push({
        accountName,
        publishedAt,
        noteUrl: detail.noteUrl || link.exportUrl,
        tags: detail.tags,
        contentType: classifyTags(detail.tags)
      });
      console.log(`命中：${accountName} ${publishedAt} ${detail.noteUrl || link.exportUrl}`);
    }

    if (stableRounds >= 4 && stateLinks.length > 0) break;

    await listPage.mouse.wheel(0, 1400);
    await waitRandom(listPage, SCROLL_DELAY, "下翻停留");
  }

  return rows;
}

async function waitForProfileNotes(page) {
  await page.waitForFunction(() => {
    const raw = window.__INITIAL_STATE__?.user?.notes?._rawValue?.[0];
    if (Array.isArray(raw) && raw.some((item) => item?.noteCard && item?.id)) return true;
    return document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]').length > 0;
  }, { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function isLoginRequired(page) {
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const url = page.url();
  if (/登录后查看更多|扫码登录|验证码登录|手机号登录|登录小红书|请登录|登录后查看/.test(text)) return true;
  if (/\/login|login\?/.test(url)) return true;
  return false;
}

async function getPublishedNotesFromState(page) {
  const notes = await page.evaluate(() => {
    const raw = window.__INITIAL_STATE__?.user?.notes?._rawValue?.[0] || [];
    return raw
      .filter((item) => item?.noteCard && item?.id)
      .map((item, index) => ({
        index,
        id: item.id,
        token: item.xsecToken || item.xsec_token || "",
        title: item.noteCard?.displayTitle || "",
        author: item.noteCard?.user?.nickName || "",
        cover: item.noteCard?.cover?.urlDefault || "",
        timeValue: item.noteCard?.time || item.noteCard?.lastUpdateTime || item.noteCard?.publishTime || item.noteCard?.createTime || item.time || item.timestamp || null
      }));
  }).catch(() => []);

  const stateNotes = notes.map((note) => {
    const tokenPart = note.token ? `&xsec_token=${encodeURIComponent(note.token)}` : "";
    const url = `https://www.xiaohongshu.com/discovery/item/${note.id}?source=webshare&xhsshare=pc_web${tokenPart}&xsec_source=pc_share`;
    return {
      ...note,
      detailUrl: url,
      exportUrl: url,
      statePublishedAt: parseStateTime(note.timeValue),
      stateTimeValue: note.timeValue
    };
  });

  if (stateNotes.length > 0) return stateNotes;

  const domLinks = await page.locator("a[href]").evaluateAll((anchors) => {
    return anchors
      .map((anchor) => anchor.href)
      .filter((href) => /xiaohongshu\.com\/(explore|discovery\/item)\//.test(href));
  }).catch(() => []);

  const byId = new Map();
  for (const href of domLinks) {
    const note = normalizeNoteUrl(href);
    if (note && !byId.has(note.id)) byId.set(note.id, note);
  }

  return [...byId.values()];
}

async function scrapeNoteDetail(page, noteUrl) {
  await page.goto(noteUrl, { waitUntil: "domcontentloaded" });
  await waitRandom(page, DETAIL_READ_DELAY, "详情页停留");
  const detail = await scrapeNoteDetailFromPage(page);
  detail.noteUrl = normalizeClickedNoteUrl(page.url()) || noteUrl;
  return detail;
}

async function scrapeNoteDetailFromPage(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (/当前笔记暂时无法浏览|请打开小红书App扫码查看|页面无法浏览/.test(bodyText)) {
    return { tags: "", publishedAt: null, blocked: true };
  }

  const tags = extractTags(bodyText);
  const dateText = await readDetailDateText(page);
  const publishedAt = dateText ? parsePublishedAt(dateText) : extractPublishedAtFromDetailText(bodyText);

  return { tags, publishedAt };
}

async function readDetailDateText(page) {
  const selectors = [
    ".note-content .bottom-container .date",
    ".bottom-container .date",
    "span.date"
  ];

  for (const selector of selectors) {
    const text = await page.locator(selector).first().innerText({ timeout: 1200 }).catch(() => "");
    if (text.trim()) return text.trim();
  }

  return "";
}

function extractPublishedAtFromDetailText(text) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = lines.filter((line) => {
    if (line.length > 40) return false;
    if (/^(刚刚|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d+\s*周前|昨天|今天)(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/.test(line)) return true;
    if (/^(发布于|编辑于|发表于)\s*(刚刚|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d+\s*周前|昨天|今天)(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/.test(line)) return true;
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\S{2,8})?$/.test(line)) return true;
    if (/^(发布于|编辑于|发表于)\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\S{2,8})?$/.test(line)) return true;
    if (/^\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/.test(line)) return true;
    if (/^(发布于|编辑于|发表于)\s*\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/.test(line)) return true;
    return false;
  });

  for (const line of candidates) {
    const date = parsePublishedAt(line);
    if (date) return date;
  }

  return null;
}

function extractTags(text) {
  const matches = text.match(/#[\p{Script=Han}\p{Letter}\p{Number}_-]+/gu) || [];
  return [...new Set(matches)].join(" ");
}

function parsePublishedAt(text) {
  const normalized = text.replace(/\s+/g, " ");

  const fullDate = normalized.match(/(?:发布于|编辑于|发表于)?\s*(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?:\s|$)/);
  if (fullDate) return parseDateOnly(`${fullDate[1]}-${pad(fullDate[2])}-${pad(fullDate[3])}`);

  const monthDate = normalized.match(/(?:发布于|编辑于|发表于)?\s*(\d{1,2})[./-](\d{1,2})(?:\s+\d{1,2}:\d{2})?(?:\s|$)/);
  if (monthDate) {
    return parseDateOnly(`${TODAY.getFullYear()}-${pad(monthDate[1])}-${pad(monthDate[2])}`);
  }

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

function parseStateTime(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return cloneDate(new Date(milliseconds));
  }

  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    return parseStateTime(Number(text));
  }

  return parsePublishedAt(text);
}

async function writeOutputs(rows) {
  const baseName = `xhs_notes_${formatDate(SINCE)}_to_${formatDate(TODAY)}`;
  const xlsPath = path.join(OUTPUT_DIR, `${baseName}.xls`);
  const csvPath = path.join(OUTPUT_DIR, `${baseName}.csv`);
  const headers = ["账号名称", "发布时间", "作品链接", "笔记id", "TAG词", "内容类型"];

  const sheetRows = rows.map((row, index) => {
    const excelRow = index + 2;
    return {
      "账号名称": row.accountName,
      "发布时间": row.publishedAt,
      "作品链接": row.noteUrl,
      "笔记id": `=TEXTBEFORE(TEXTAFTER(C${excelRow},"item/"),"?")`,
      "TAG词": row.tags || "",
      "内容类型": row.contentType
    };
  });

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
  const widths = [120, 90, 520, 260, 320, 90];
  const headerCells = headers
    .map((header) => `<Cell ss:StyleID="header"><Data ss:Type="String">${xmlEscape(header)}</Data></Cell>`)
    .join("");
  const bodyRows = rows.map((row) => {
    const cells = headers.map((header) => {
      const value = row[header] || "";
      if (header === "笔记id" && value.startsWith("=")) {
        return `<Cell ss:Formula="=TEXTBEFORE(TEXTAFTER(RC[-1],&quot;item/&quot;),&quot;?&quot;)"><Data ss:Type="String"></Data></Cell>`;
      }
      return `<Cell><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
    }).join("");
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
 <Worksheet ss:Name="小红书作品">
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
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeNoteUrl(rawUrl) {
  const url = new URL(rawUrl, "https://www.xiaohongshu.com");
  const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/);
  if (!match) return null;

  const noteId = match[1];
  const search = url.search || "?source=webshare";
  const itemUrl = `https://www.xiaohongshu.com/discovery/item/${noteId}${search}`;

  return {
    id: noteId,
    detailUrl: itemUrl,
    exportUrl: itemUrl
  };
}

function normalizeClickedNoteUrl(rawUrl, fallbackId = "") {
  const url = new URL(rawUrl, "https://www.xiaohongshu.com");
  const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/);
  const noteId = match?.[1] || fallbackId;
  if (!noteId) return "";

  const search = url.search || "?source=webshare";
  return `https://www.xiaohongshu.com/discovery/item/${noteId}${search}`;
}

function isProfileUrl(url) {
  return /xiaohongshu\.com\/user\/profile\//.test(url);
}

function normalizeProfileUrl(rawUrl) {
  if (!rawUrl) return "";
  const url = new URL(rawUrl, "https://www.xiaohongshu.com");
  const match = url.pathname.match(/\/user\/profile\/([^/?#]+)/);
  if (!match) return rawUrl;
  return `https://www.xiaohongshu.com/user/profile/${match[1]}`;
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
  if (!value) {
    throw new Error(`${label}不能为空，请使用 YYYY-MM-DD，例如：npm run crawl -- 2026-04-15`);
  }

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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
