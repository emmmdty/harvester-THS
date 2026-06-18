import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, resolveCrawlerHeadless } from "./browser-env.mjs";
import { dateStringToDate, formatDate as formatDateInTimeZone } from "./date-utils.mjs";
import { publishedDateFromXhsNoteId } from "./content-identity.mjs";
import { classifyContentType } from "./content-classifier.mjs";
import { buildXhsExploreUrl, extractXhsNoteId, normalizeXhsContentLink } from "./link-utils.mjs";
import { spreadsheetSafeText } from "./spreadsheet-safe.mjs";
import { readPlatformAccounts } from "./platform-accounts.mjs";
import { buildXhsOutputBaseName } from "./xhs-output-names.mjs";
import {
  XHS_DETAIL_CACHE_VERSION,
  createXhsDetailRiskGuard,
  parseXhsDetailPublishedAt,
  resolveXhsPublishedAtEntry,
  resolveXhsStatePublishedAt,
  restoreXhsDetailFromCache,
  serializeXhsDetailForCache
} from "./xhs-published-date.mjs";
import {
  DetailCache,
  createCrawlAudit,
  comparePublishedAtToDateRange,
  dateKey,
  installConservativeResourceBlocker,
  logAuditSummary,
  resolveCrawlMode,
  shouldInspectDetailByPublishedAt,
  shouldRefreshDetailCache,
  shouldUseDetailCache
} from "./crawl-runtime.mjs";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "output");
const USER_DATA_DIR = path.join(ROOT, ".xhs-profile");
const OPTIONS = parseArgs(process.argv.slice(2));
const CRAWL_MODE = resolveCrawlMode(OPTIONS);
const TODAY = parseDateInput(OPTIONS.until || process.env.UNTIL || formatDateInTimeZone(new Date()), "结束日期");
const SINCE = parseDateInput(OPTIONS.since || process.env.SINCE || "2026-04-15", "起始日期");
const REFERENCE_DATE = parseDateInput(OPTIONS.referenceDate || process.env.REFERENCE_DATE || formatDateInTimeZone(new Date()), "相对时间参考日期");
const MAX_SCROLLS_PER_ACCOUNT = Number(process.env.MAX_SCROLLS_PER_ACCOUNT || 18);
const MAX_DETAIL_PAGES = Number(process.env.MAX_DETAIL_PAGES || 120);
const OLD_NOTE_STOP_AFTER = Number(process.env.OLD_NOTE_STOP_AFTER || 4);
const MIN_CHECK_BEFORE_STOP = Number(process.env.MIN_CHECK_BEFORE_STOP || 8);
const DETAIL_READ_DELAY = parseDelayRange(process.env.XHS_DETAIL_READ_DELAY || "2000-5000");
const DETAIL_GAP_DELAY = parseDelayRange(process.env.XHS_DETAIL_GAP_DELAY || "1500-4000");
const BLOCKED_DETAIL_STOP_AFTER = Number(process.env.XHS_BLOCKED_DETAIL_STOP_AFTER || 2);
const SCROLL_DELAY = parseDelayRange(process.env.XHS_SCROLL_DELAY || "1800-3500");
const PROFILE_SWITCH_GAP_DELAY = parseDelayRange(process.env.XHS_PROFILE_SWITCH_GAP_DELAY || "12000-30000");
const HEADLESS = resolveCrawlerHeadless();
const XHS_RISK_PATTERN = /安全验证|安全限制|访问过于频繁|访问频繁|风控|滑块|系统繁忙|验证后继续|IP存在风险|存在风险|环境异常|当前操作异常|website-login\/(?:error|captcha)|\/login|login\?/iu;
const XHS_LOGIN_PATTERN = /登录后查看更多|扫码登录|验证码登录|手机号登录|登录小红书|请登录|登录后查看/iu;

async function main() {
  if (SINCE > TODAY) {
    throw new Error(`起始日期不能晚于结束日期：${formatDate(SINCE)} > ${formatDate(TODAY)}`);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`爬取时间范围：${formatDate(SINCE)} 至 ${formatDate(TODAY)}`);
  console.log(`相对时间解析基准：${formatDate(REFERENCE_DATE)}`);
  console.log(`采集模式：${modeLabel(CRAWL_MODE)}`);

  const accounts = await readPlatformAccounts("xhs", { root: ROOT });
  if (accounts.length === 0) {
    throw new Error("请先在账号配置中添加小红书账号。");
  }

  const rows = [];
  const audit = createCrawlAudit("xhs");
  let context = null;
  let resourceBlocker = null;
  let pendingRiskError = null;

  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...chromiumLaunchOptions(),
      headless: HEADLESS,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
    });
    resourceBlocker = await installConservativeResourceBlocker(context, {
      mode: CRAWL_MODE,
      label: "小红书轻量页面模式"
    });

    const listPage = await context.newPage();
    const detailPage = await context.newPage();
    listPage.setDefaultTimeout(20_000);
    detailPage.setDefaultTimeout(20_000);

    const detailCache = new DetailCache({
      root: ROOT,
      platformId: "xhs",
      enabled: shouldUseDetailCache({ mode: CRAWL_MODE }),
      refresh: shouldRefreshDetailCache()
    });

    for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
      const account = accounts[accountIndex];
      if (accountIndex > 0) await waitRandom(listPage, PROFILE_SWITCH_GAP_DELAY, "账号切换间隔");
      console.log(`\n==> 处理账号：${account.name}`);
      console.log(`账号主页：${account.url}`);
      const accountAudit = audit.account(account.name);
      try {
        const accountRows = await crawlAccountRecentFirst({
          listPage,
          detailPage,
          accountName: account.name,
          profileUrl: account.url,
          audit: accountAudit,
          detailCache,
          resourceBlocker
        });
        rows.push(...accountRows);
        console.log(`账号完成：${account.name}，命中 ${accountRows.length} 条`);
      } catch (error) {
        if (!isXhsRiskStopError(error)) throw error;
        accountAudit.stop("risk-stop");
        pendingRiskError = error;
        console.warn(`账号触发登录/安全验证，停止后续小红书后台采集并保留已采集结果：${error.message || String(error)}`);
        break;
      }
    }
  } finally {
    await resourceBlocker?.close().catch(() => {});
    await context?.close().catch(() => {});
  }

  logAuditSummary(audit);
  await writeOutputs(rows, {
    audit: audit.toJSON(),
    mode: CRAWL_MODE,
    risk: pendingRiskError ? {
      stopped: true,
      message: pendingRiskError.message || String(pendingRiskError)
    } : null
  });
  console.log(`\n完成：导出 ${rows.length} 条`);
  if (pendingRiskError) throw pendingRiskError;
}

async function crawlAccountRecentFirst({ listPage, detailPage, accountName, profileUrl, audit, detailCache, resourceBlocker }) {
  await listPage.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await waitForProfileNotes(listPage);
  const profileRisk = await detectXhsPageRisk(listPage);
  if (profileRisk) {
    throw new Error(xhsRiskErrorMessage(profileRisk, accountName));
  }

  const rows = [];
  const seen = new Set();
  let stableRounds = 0;
  let oldNoteRounds = 0;
  let checked = 0;
  let hasInRangeNote = false;
  let stopped = false;
  const detailRiskGuard = createXhsDetailRiskGuard({ stopAfter: BLOCKED_DETAIL_STOP_AFTER });
  const stop = (reason) => {
    if (!stopped) {
      audit?.stop(reason);
      stopped = true;
    }
  };

  for (let i = 0; i < MAX_SCROLLS_PER_ACCOUNT; i += 1) {
    const stateLinks = await getProfileStateLinks(listPage, { resourceBlocker });
    const newLinks = stateLinks.filter((link) => !seen.has(link.id));
    console.log(`页面状态发布作品：${stateLinks.length} 条，新作品：${newLinks.length} 条`);
    if (stateLinks.length === 0) {
      const emptyListRisk = await detectXhsPageRisk(listPage);
      if (emptyListRisk) {
        throw new Error(xhsRiskErrorMessage(emptyListRisk, accountName));
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
      seen.add(link.id);
      const idPublishedAt = publishedDateFromXhsNoteId(link.id);
      const idPublishedAtDate = idPublishedAt ? dateStringToDate(idPublishedAt) : null;
      if (!idPublishedAtDate) {
        audit?.recordUnknownDate();
        console.warn(`未能从小红书笔记ID解析发布时间：${link.exportUrl}`);
        continue;
      }
      const prefilter = shouldInspectDetailByPublishedAt({
        publishedAt: idPublishedAtDate,
        since: SINCE,
        until: TODAY
      });
      if (!prefilter.inspect) {
        audit?.recordSkipped(prefilter.reason);
        if (prefilter.reason === "before-since") {
          oldNoteRounds += 1;
          console.log(`列表时间边界：早于开始日期，跳过详情页：${accountName} ${idPublishedAt} ${link.exportUrl}`);
          if ((hasInRangeNote || seen.size >= MIN_CHECK_BEFORE_STOP) && oldNoteRounds >= OLD_NOTE_STOP_AFTER) {
            stop("old-boundary");
            console.log(`连续 ${OLD_NOTE_STOP_AFTER} 条早于起始日期，停止继续下翻：${accountName}`);
            return rows;
          }
        } else {
          console.log(`列表时间边界：晚于结束日期，跳过详情页：${accountName} ${idPublishedAt} ${link.exportUrl}`);
        }
        continue;
      }
      if (checked >= MAX_DETAIL_PAGES) {
        stop("detail-limit");
        console.log(`已达到详情页检查上限：${MAX_DETAIL_PAGES}`);
        return rows;
      }

      checked += 1;
      audit?.recordChecked();

      let detail = restoreXhsDetailFromCache(await detailCache.get(link.id));
      if (detail) {
        audit?.recordCacheHit();
        console.log(`详情缓存命中：${accountName} ${link.exportUrl}`);
      } else {
        await waitRandom(detailPage, DETAIL_GAP_DELAY, "详情页间隔");
        detail = await scrapeNoteDetail(detailPage, link.detailUrl, { resourceBlocker }).catch((error) => {
          console.warn(`打开笔记失败，跳过：${link.exportUrl}`);
          console.warn(error.message || String(error));
          return { tags: "", publishedAt: null, noteUrl: link.exportUrl, failed: true };
        });
        if (detail && !detail.failed && !detail.blocked) {
          detail.publishedAt = idPublishedAtDate;
          detail.publishedAtSource = "note-id";
        }
        if (isCacheableXhsDetail(detail)) {
          await detailCache.set(link.id, serializeXhsDetailForCache(detail));
        }
      }
      const risk = detailRiskGuard.record(detail);
      if (detail.blocked) {
        audit?.recordSkipped("detail-blocked");
        const detailRiskReason = detail.riskReason || "详情页触发风控或不可浏览";
        console.warn(`${detailRiskReason}：${link.exportUrl} stateTime=${link.stateTimeValue ?? ""}`);
        if (detail.hardRisk || risk.shouldStop) {
          stop("detail-blocked");
          throw new Error(`小红书账号 ${accountName} ${detail.hardRisk ? detailRiskReason : `连续 ${risk.consecutiveBlocked} 次详情页触发风控`}，已停止该账号详情访问。`);
        }
        continue;
      }
      const effectivePublishedAt = resolveXhsPublishedAtEntry({
        noteId: link.id,
        detailPublishedAt: detail.publishedAt,
        detailPublishedAtSource: detail.publishedAtSource,
        statePublishedAt: link.statePublishedAt,
        statePublishedAtSource: link.statePublishedAtSource,
        detailBlocked: detail.blocked
      });
      if (!effectivePublishedAt.publishedAt) {
        audit?.recordUnknownDate();
        const reason = detail.blocked ? "详情页触发风控或不可浏览" : "未识别发布时间";
        console.warn(`${reason}：${link.exportUrl} stateTime=${link.stateTimeValue ?? ""} detailTime=${detail.dateCandidates ?? ""}`);
        continue;
      }

      const publishedAt = dateKey(effectivePublishedAt.publishedAt);
      const rangePosition = comparePublishedAtToDateRange({ publishedAt: effectivePublishedAt.publishedAt, since: SINCE, until: TODAY });
      if (rangePosition === "before-since") {
        audit?.recordSkipped(rangePosition);
        oldNoteRounds += 1;
        console.log(`边界检查：发现早于开始日期的作品，不导出：${accountName} ${publishedAt} ${link.exportUrl}`);
        if ((hasInRangeNote || checked >= MIN_CHECK_BEFORE_STOP) && oldNoteRounds >= OLD_NOTE_STOP_AFTER) {
          stop("old-boundary");
          console.log(`连续 ${OLD_NOTE_STOP_AFTER} 条早于起始日期，停止继续下翻：${accountName}`);
          return rows;
        }
        continue;
      }

      oldNoteRounds = 0;

      if (rangePosition === "after-until") {
        audit?.recordSkipped(rangePosition);
        console.log(`跳过晚于结束日期作品：${accountName} ${publishedAt} ${link.exportUrl}`);
        continue;
      }

      hasInRangeNote = true;
      audit?.recordHit();
      const classification = await classifyContentType({
        platformId: "xhs",
        accountName,
        title: link.title || "",
        tags: detail.tags,
        text: link.title || ""
      });
      rows.push({
        accountName,
        publishedAt,
        noteUrl: chooseXhsExportUrl(detail.noteUrl, link.exportUrl),
        title: link.title || "",
        tags: detail.tags,
        publishedAtSource: effectivePublishedAt.source,
        contentType: classification.contentType,
        contentTypeReview: classification.contentTypeReview
      });
      console.log(`命中：${accountName} ${publishedAt} ${chooseXhsExportUrl(detail.noteUrl, link.exportUrl)}`);
    }

    if (stableRounds >= 4 && stateLinks.length > 0) {
      stop("stable-rounds");
      break;
    }

    await listPage.mouse.wheel(0, 1400);
    await waitRandom(listPage, SCROLL_DELAY, "下翻停留");
  }

  stop("scroll-limit");
  return rows;
}

async function getProfileStateLinks(listPage, { resourceBlocker } = {}) {
  let links = await getPublishedNotesFromState(listPage);
  if (links.length > 0 || !resourceBlocker?.enabled) return links;

  console.log("列表页未读到作品，关闭轻量页面模式重试一次。");
  links = await resourceBlocker.disableTemporarily(async () => {
    await listPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await waitForProfileNotes(listPage);
    return getPublishedNotesFromState(listPage);
  });
  return links;
}

async function waitForProfileNotes(page) {
  await page.waitForFunction(() => {
    const raw = window.__INITIAL_STATE__?.user?.notes?._rawValue?.[0];
    if (Array.isArray(raw) && raw.some((item) => item?.noteCard && item?.id)) return true;
    return document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]').length > 0;
  }, { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function detectXhsPageRisk(page) {
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const url = page.url();
  const combined = `${url}\n${decodeUrlText(url)}\n${text}`;
  if (XHS_RISK_PATTERN.test(combined)) return "页面疑似触发安全验证或访问限制";
  if (XHS_LOGIN_PATTERN.test(combined)) return "小红书登录状态已失效";
  return "";
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
        timeFields: {
          publishedAt: item.noteCard?.publishedAt || item.noteCard?.published_at || item.publishedAt || item.published_at || null,
          publishAt: item.noteCard?.publishAt || item.noteCard?.publish_at || item.publishAt || item.publish_at || null,
          publishTime: item.noteCard?.publishTime || item.noteCard?.publish_time || item.publishTime || item.publish_time || null,
          publishedTime: item.noteCard?.publishedTime || item.noteCard?.published_time || item.publishedTime || item.published_time || null,
          createTime: item.noteCard?.createTime || item.noteCard?.create_time || item.createTime || item.create_time || null,
          createdTime: item.noteCard?.createdTime || item.noteCard?.created_time || item.createdTime || item.created_time || null,
          lastUpdateTime: item.noteCard?.lastUpdateTime || item.noteCard?.last_update_time || item.lastUpdateTime || item.last_update_time || null,
          time: item.noteCard?.time || item.time || null,
          timestamp: item.timestamp || null
        }
      }));
  }).catch(() => []);

  const stateNotes = notes.map((note) => {
    const url = buildXhsExploreUrl(note.id, note.token);
    const statePublishedAt = resolveXhsStatePublishedAt(note.timeFields, {
      referenceDateString: formatDate(REFERENCE_DATE)
    });
    return {
      ...note,
      detailUrl: url,
      exportUrl: url,
      statePublishedAt: statePublishedAt.publishedAt,
      statePublishedAtSource: statePublishedAt.source,
      stateTimeValue: statePublishedAt.rawValue
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

async function scrapeNoteDetail(page, noteUrl, { resourceBlocker } = {}) {
  const detail = await scrapeNoteDetailOnce(page, noteUrl);
  if (shouldRetryXhsDetailUnblocked(detail) && resourceBlocker?.enabled) {
    console.log("详情页关键字段未读到，关闭轻量页面模式重试一次。");
    return resourceBlocker.disableTemporarily(() => scrapeNoteDetailOnce(page, noteUrl));
  }
  return detail;
}

async function scrapeNoteDetailOnce(page, noteUrl) {
  await page.goto(noteUrl, { waitUntil: "domcontentloaded" });
  await waitRandom(page, DETAIL_READ_DELAY, "详情页停留");
  const detail = await scrapeNoteDetailFromPage(page);
  detail.noteUrl = normalizeClickedNoteUrl(page.url()) || noteUrl;
  return detail;
}

async function scrapeNoteDetailFromPage(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  const pageUrl = page.url();
  const riskText = `${pageUrl}\n${decodeUrlText(pageUrl)}\n${bodyText}`;
  if (XHS_RISK_PATTERN.test(riskText) || XHS_LOGIN_PATTERN.test(riskText)) {
    return {
      tags: "",
      publishedAt: null,
      blocked: true,
      hardRisk: true,
      riskReason: XHS_LOGIN_PATTERN.test(riskText) ? "小红书登录状态已失效" : "详情页触发安全验证或访问限制"
    };
  }
  if (/当前笔记暂时无法浏览|请打开小红书App扫码查看|页面无法浏览/.test(bodyText)) {
    return { tags: "", publishedAt: null, blocked: true, hardRisk: false, riskReason: "详情页不可浏览" };
  }

  const tags = extractTags(bodyText);
  const dateTexts = await readDetailDateTexts(page);
  const publishedAtResult = parseXhsDetailPublishedAt({
    dateTexts,
    bodyText,
    referenceDateString: formatDate(REFERENCE_DATE)
  });

  return {
    tags,
    publishedAt: publishedAtResult.publishedAt,
    publishedAtSource: publishedAtResult.source,
    dateCandidates: publishedAtResult.candidates.join(" | ")
  };
}

function xhsRiskErrorMessage(reason, accountName = "") {
  const accountText = accountName ? `（账号：${accountName}）` : "";
  return `${reason}${accountText}，请先在面板点击“打开登录”重新登录或完成安全验证，登录成功后关闭登录浏览器，再开始爬取。`;
}

function decodeUrlText(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function isXhsRiskStopError(error) {
  const message = error?.message || String(error || "");
  return XHS_RISK_PATTERN.test(message) || XHS_LOGIN_PATTERN.test(message);
}

async function readDetailDateTexts(page) {
  const selectors = [
    ".note-content .bottom-container .date",
    ".bottom-container .date",
    "span.date"
  ];

  const texts = [];
  for (const selector of selectors) {
    const values = await page.locator(selector).evaluateAll((elements) => {
      return elements
        .map((element) => element.innerText || element.textContent || "")
        .map((text) => text.trim())
        .filter(Boolean);
    }).catch(() => []);
    texts.push(...values);
  }

  return [...new Set(texts)];
}

function extractTags(text) {
  const matches = text.match(/#[\p{Script=Han}\p{Letter}\p{Number}_-]+/gu) || [];
  return [...new Set(matches)].join(" ");
}

async function writeOutputs(rows, { accountName = "", audit = null, mode = "conservative", risk = null } = {}) {
  const baseName = buildXhsOutputBaseName({
    since: formatDate(SINCE),
    until: formatDate(TODAY),
    accountName
  });
  const xlsPath = path.join(OUTPUT_DIR, `${baseName}.xls`);
  const csvPath = path.join(OUTPUT_DIR, `${baseName}.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `${baseName}.json`);
  const headers = ["账号名称", "发布时间", "作品链接", "笔记id", "TAG词", "内容类型", "内容类型标签审核"];

  const sheetRows = rows.map((row) => {
    const noteUrl = normalizeXhsContentLink(row.noteUrl);
    return {
      "账号名称": spreadsheetSafeText(row.accountName),
      "发布时间": row.publishedAt,
      "作品链接": noteUrl,
      "笔记id": extractXhsNoteId(noteUrl),
      "TAG词": spreadsheetSafeText(row.tags || ""),
      "内容类型": spreadsheetSafeText(row.contentType),
      "内容类型标签审核": spreadsheetSafeText(row.contentTypeReview || "")
    };
  });

  await fs.writeFile(xlsPath, buildExcelXml(headers, sheetRows), "utf8");

  const csv = [
    headers.map(csvEscape).join(","),
    ...sheetRows.map((row) => headers.map((header) => csvEscape(row[header] || "")).join(","))
  ].join("\n");
  await fs.writeFile(csvPath, csv, "utf8");
  await fs.writeFile(jsonPath, JSON.stringify({
    platform: "xhs",
    publishedAtVersion: XHS_DETAIL_CACHE_VERSION,
    mode,
    since: formatDate(SINCE),
    until: formatDate(TODAY),
    audit,
    risk,
    items: rows.map((row) => ({
      platform: "xhs",
      accountName: row.accountName,
      publishedAt: row.publishedAt,
      link: normalizeXhsContentLink(row.noteUrl),
      id: extractXhsNoteId(row.noteUrl),
      title: row.title || "",
      tags: row.tags || "",
      publishedAtSource: row.publishedAtSource || "",
      contentType: row.contentType || "无",
      contentTypeReview: row.contentTypeReview || "需审核"
    }))
  }, null, 2), "utf8");

  console.log(`XLS ：${xlsPath}`);
  console.log(`CSV ：${csvPath}`);
  console.log(`JSON：${jsonPath}`);
}

function buildExcelXml(headers, rows) {
  const widths = [120, 90, 520, 260, 320, 90, 120];
  const headerCells = headers
    .map((header) => `<Cell ss:StyleID="header"><Data ss:Type="String">${xmlEscape(header)}</Data></Cell>`)
    .join("");
  const bodyRows = rows.map((row) => {
    const cells = headers.map((header) => {
      const value = row[header] || "";
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
  const itemUrl = normalizeXhsContentLink(url.toString());

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

  return normalizeXhsContentLink(url.toString());
}

function chooseXhsExportUrl(detailUrl, listUrl) {
  const detail = normalizeXhsContentLink(detailUrl);
  const list = normalizeXhsContentLink(listUrl);
  if (list && hasXhsOpenParams(list) && !hasXhsOpenParams(detail)) return list;
  return detail || list || "";
}

function hasXhsOpenParams(rawUrl) {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl, "https://www.xiaohongshu.com");
    return Boolean(url.searchParams.get("xsec_token") || url.searchParams.get("xsec_source"));
  } catch {
    return /[?&]xsec_(?:token|source)=/.test(String(rawUrl));
  }
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

function isCacheableXhsDetail(detail) {
  return Boolean(detail && !detail.failed && !detail.blocked && detail.publishedAt);
}

function shouldRetryXhsDetailUnblocked(detail) {
  return Boolean(detail?.blocked || !detail?.publishedAt);
}

function modeLabel(mode) {
  return mode === "legacy" ? "兼容旧模式" : "保守提速";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
