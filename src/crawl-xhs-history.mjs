import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { chromiumLaunchOptions, resolveCrawlerHeadless } from "./browser-env.mjs";
import { classifyContentType } from "./content-classifier.mjs";
import { publishedDateFromXhsNoteId } from "./content-identity.mjs";
import { installConservativeResourceBlocker, resolveCrawlMode } from "./crawl-runtime.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { extractXhsNoteId } from "./link-utils.mjs";
import { readPlatformAccounts } from "./platform-accounts.mjs";
import {
  XHS_HISTORY_SHEET_KEY,
  canonicalXhsItemUrl,
  createPendingXhsHistoryItem,
  extractXhsHistoryItemsFromSeedRows,
  mergeXhsHistoryLedgerItems,
  readXhsHistoryLedger,
  replaceXhsHistorySheet,
  upsertXhsHistorySheet,
  writeXhsHistoryLedger,
  writeXhsHistoryOutputs
} from "./xhs-history.mjs";
import {
  XHS_DETAIL_CACHE_VERSION,
  createXhsDetailRiskGuard,
  parseXhsDetailPublishedAt,
  restoreXhsDetailFromCache,
  serializeXhsDetailForCache
} from "./xhs-published-date.mjs";
import { DetailCache, shouldRefreshDetailCache, shouldUseDetailCache } from "./crawl-runtime.mjs";

const ROOT = process.cwd();
const USER_DATA_DIR = path.join(ROOT, ".xhs-profile");
const LEDGER_RELATIVE_PATH = ".runtime/xhs-history/ledger.jsonl";
const RUNTIME_DIR = path.join(ROOT, ".runtime/xhs-history");
const LEDGER_PATH = path.join(ROOT, LEDGER_RELATIVE_PATH);
const OUTPUT_DIR = path.join(RUNTIME_DIR, "exports");
const BACKUP_DIR = path.join(RUNTIME_DIR, "backups");

const OPTIONS = parseArgs(process.argv.slice(2));
const CRAWL_MODE = resolveCrawlMode(OPTIONS);
const HEADLESS = resolveCrawlerHeadless();
const MAX_SCROLLS_PER_ACCOUNT = numberOption(OPTIONS.maxScrollsPerAccount, process.env.XHS_HISTORY_MAX_SCROLLS_PER_ACCOUNT, 260);
const MAX_DETAIL_PAGES = numberOption(OPTIONS.maxDetailPages, process.env.XHS_HISTORY_MAX_DETAIL_PAGES, 500);
const STABLE_ROUNDS_LIMIT = numberOption(OPTIONS.stableRounds, process.env.XHS_HISTORY_STABLE_ROUNDS, 6);
const BLOCKED_DETAIL_STOP_AFTER = numberOption(OPTIONS.blockedDetailStopAfter, process.env.XHS_HISTORY_BLOCKED_DETAIL_STOP_AFTER, 2);
const SCROLL_DELAY_MS = numberOption(OPTIONS.scrollDelayMs, process.env.XHS_HISTORY_SCROLL_DELAY_MS, 1600);
const DETAIL_DELAY_MS = numberOption(OPTIONS.detailDelayMs, process.env.XHS_HISTORY_DETAIL_DELAY_MS, 900);

async function main() {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const collectedAt = new Date().toISOString();
  const safeTimestamp = collectedAt.replace(/[:.]/g, "-");
  const accounts = await readPlatformAccounts("xhs", { root: ROOT });
  if (accounts.length === 0) throw new Error("请先在账号配置中添加小红书账号。");

  console.log(`小红书历史采集：账号 ${accounts.length} 个。`);
  console.log(`采集模式：${CRAWL_MODE}；单账号滚动上限：${MAX_SCROLLS_PER_ACCOUNT}；详情上限：${MAX_DETAIL_PAGES}。`);

  const config = loadFeishuConfig();
  const client = new FeishuSheetsClient(config);
  const seedItems = await readFeishuSeedItems({ client, accounts, collectedAt });
  const ledgerBefore = await readXhsHistoryLedger(LEDGER_PATH);
  if (OPTIONS.rebuild) {
    const backupPath = path.join(BACKUP_DIR, `ledger-${safeTimestamp}.jsonl`);
    await fs.writeFile(backupPath, ledgerBefore.map((item) => JSON.stringify(item)).join("\n"), "utf8");
    console.log(`重建模式：已备份当前 ledger 至 ${backupPath}`);
  }
  let ledger = OPTIONS.rebuild ? [] : ledgerBefore;
  ledger = mergeXhsHistoryLedgerItems(ledger, seedItems);
  await writeXhsHistoryLedger(LEDGER_PATH, ledger);
  console.log(`飞书小红书渠道种子：${seedItems.length} 条；当前 ledger：${ledger.length} 条。`);

  const runAudit = [];
  let context = null;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...chromiumLaunchOptions(),
      headless: HEADLESS,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
    });
    const resourceBlocker = await installConservativeResourceBlocker(context, {
      mode: CRAWL_MODE,
      label: "小红书历史轻量页面模式"
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

    for (const account of accounts) {
      console.log(`\n==> 小红书历史 inventory：${account.name}`);
      try {
        const result = await crawlAccountHistory({
          listPage,
          detailPage,
          account,
          collectedAt,
          detailCache,
          resourceBlocker
        });
        runAudit.push(result.audit);
        ledger = mergeXhsHistoryLedgerItems(ledger, result.items);
        await writeXhsHistoryLedger(LEDGER_PATH, ledger);
        console.log(`账号完成：${account.name}，本次 ${result.items.length} 条，停止原因 ${result.audit.stopReason || "unknown"}，ledger ${ledger.length} 条。`);
      } catch (error) {
        const audit = createAccountAudit(account);
        audit.stopReason = "failed";
        audit.failureReason = error.message || String(error);
        runAudit.push(audit);
        console.warn(`账号失败：${account.name}，原因：${audit.failureReason}`);
      }
    }
    await resourceBlocker.close();
  } finally {
    await context?.close().catch(() => {});
  }

  await writeXhsHistoryLedger(LEDGER_PATH, ledger);
  const output = await writeXhsHistoryOutputs({
    items: ledger,
    outputDir: OUTPUT_DIR,
    generatedAt: collectedAt,
    audit: runAudit
  });
  console.log(`\n本地 ledger：${LEDGER_PATH}`);
  console.log(`JSON 审计：${output.jsonPath}`);
  console.log(`CSV 审计：${output.csvPath}`);

  if (OPTIONS.skipFeishu) {
    console.log("已跳过飞书历史台账写入（--skip-feishu）。");
  } else {
    const writePayload = {
      client,
      sheetId: config.sheets[XHS_HISTORY_SHEET_KEY] || "",
      items: ledger,
      batchSize: 100
    };
    const result = OPTIONS.rebuild
      ? await replaceXhsHistorySheet(writePayload)
      : await upsertXhsHistorySheet(writePayload);
    if (result.createdSheetId) {
      console.log(`已新建 Sheet：小红书历史台账，sheet_id=${result.createdSheetId}`);
      console.log("可将该值写入 .env 的 FEISHU_SHEET_XHS_HISTORY，后续运行会直接复用。");
    }
    console.log(`飞书写入：新增 ${result.created}，更新 ${result.updated || 0}，跳过 ${result.skipped}。`);
  }

  const summary = summarizeItems(ledger);
  console.log(`\n小红书历史台账完成：总数 ${summary.total}，URL 空值 ${summary.emptyUrl}，标题空值 ${summary.emptyTitle}，tag 空值 ${summary.emptyTags}，作品ID重复 ${summary.duplicateIds}。`);
  console.log(`账号覆盖：${summary.accounts.map((entry) => `${entry.name}:${entry.count}`).join("，")}`);
}

async function readFeishuSeedItems({ client, accounts, collectedAt }) {
  const accountHomeUrlsByLabel = new Map();
  const accountNamesByLabel = new Map();
  for (const account of accounts) {
    const label = accountLabel(account.name);
    accountHomeUrlsByLabel.set(label, account.url);
    accountNamesByLabel.set(label, account.name);
  }
  const rows = await client.readSheetRows("xhs", 12);
  return extractXhsHistoryItemsFromSeedRows(rows, {
    collectedAt,
    accountHomeUrlsByLabel,
    accountNamesByLabel
  });
}

async function crawlAccountHistory({
  listPage,
  detailPage,
  account,
  collectedAt,
  detailCache,
  resourceBlocker
}) {
  const audit = createAccountAudit(account);
  await listPage.goto(account.url, { waitUntil: "domcontentloaded" });
  await waitForProfileNotes(listPage);
  if (await isLoginRequired(listPage)) {
    throw new Error("小红书登录状态已失效，请先在面板点击“打开登录”重新登录。");
  }

  const items = [];
  const seen = new Set();
  const detailRiskGuard = createXhsDetailRiskGuard({ stopAfter: BLOCKED_DETAIL_STOP_AFTER });
  let stableRounds = 0;
  let checked = 0;

  for (let scrollIndex = 0; scrollIndex < MAX_SCROLLS_PER_ACCOUNT; scrollIndex += 1) {
    const stateLinks = await getProfileStateLinks(listPage, { resourceBlocker });
    const newLinks = stateLinks.filter((link) => !seen.has(link.id));
    audit.pages += 1;
    if (newLinks.length === 0) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }
    console.log(`页面状态发布作品：${stateLinks.length} 条，新作品：${newLinks.length} 条`);

    for (const link of newLinks) {
      seen.add(link.id);
      if (checked >= MAX_DETAIL_PAGES) {
        audit.detailSkipped += 1;
        items.push(createPendingXhsHistoryItem({
          link,
          account,
          collectedAt,
          failureReason: "详情补全达到上限",
          source: "profile-state"
        }));
        audit.collected = items.length;
        continue;
      }
      checked += 1;
      audit.checked += 1;
      const item = await historyItemFromProfileLink({
        link,
        account,
        collectedAt,
        detailPage,
        detailCache,
        resourceBlocker,
        detailRiskGuard
      });
      if (item.blocked) {
        audit.blocked += 1;
        if (item.shouldStop) {
          audit.stopReason = "detail-blocked";
          return { items, audit };
        }
      }
      items.push(item);
      audit.collected = items.length;
    }

    if (stableRounds >= STABLE_ROUNDS_LIMIT && stateLinks.length > 0) {
      audit.stopReason = "stable-rounds";
      return { items, audit };
    }
    await listPage.mouse.wheel(0, 1600).catch(() => {});
    await listPage.waitForTimeout(SCROLL_DELAY_MS);
  }

  audit.stopReason = "scroll-limit";
  return { items, audit };
}

async function historyItemFromProfileLink({
  link,
  account,
  collectedAt,
  detailPage,
  detailCache,
  resourceBlocker,
  detailRiskGuard
}) {
  const itemId = link.id;
  const itemUrl = canonicalXhsItemUrl(link.exportUrl || itemId);
  const publishedAt = publishedDateFromXhsNoteId(itemId);
  let detail = restoreXhsDetailFromCache(await detailCache.get(itemId));
  if (!detail) {
    await detailPage.waitForTimeout(DETAIL_DELAY_MS);
    detail = await scrapeNoteDetail(detailPage, link.detailUrl, { resourceBlocker }).catch((error) => ({
      tags: "",
      noteUrl: link.exportUrl,
      blocked: false,
      failed: true,
      failureReason: error.message || String(error)
    }));
    if (!detail.blocked && !detail.failed) {
      detail.publishedAt = publishedAt ? parseDateOnly(publishedAt) : null;
      detail.publishedAtSource = publishedAt ? "note-id" : "";
    }
    if (!detail.blocked && !detail.failed) {
      await detailCache.set(itemId, serializeXhsDetailForCache(detail));
    }
  }
  const risk = detailRiskGuard.record(detail);
  const tags = detail.tags || "";
  const classification = await classifyContentType({
    platformId: "xhs",
    accountName: account.name,
    title: link.title || "",
    tags,
    text: link.title || ""
  });
  const failureReason = detail.blocked
    ? "详情页触发风控或不可浏览"
    : detail.failureReason || (!tags ? "tag缺失" : "");
  const collectStatus = detail.blocked || detail.failed || !tags ? "待补全" : "已采集";
  return {
    accountName: account.name,
    accountHomeUrl: account.url,
    publishedAt,
    itemType: "图文",
    itemId,
    itemUrl,
    title: link.title || "",
    tags,
    contentType: classification.contentType,
    contentTypeReview: classification.contentTypeReview,
    collectStatus,
    collectedAt,
    failureReason,
    source: detail.blocked ? "profile-state+detail-blocked" : "profile-state+detail",
    blocked: Boolean(detail.blocked),
    shouldStop: risk.shouldStop
  };
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

async function isLoginRequired(page) {
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const url = page.url();
  return /登录后查看更多|扫码登录|验证码登录|手机号登录|登录小红书|请登录|登录后查看/.test(text)
    || /安全验证|安全限制|访问过于频繁|风控|滑块|系统繁忙|验证后继续|IP存在风险|存在风险/.test(text)
    || /website-login\/(?:error|captcha)|\/login|login\?/.test(url);
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
        title: item.noteCard?.displayTitle || ""
      }));
  }).catch(() => []);

  const stateNotes = notes.map((note) => {
    const url = buildXhsExploreUrl(note.id, note.token);
    return {
      ...note,
      detailUrl: url,
      exportUrl: url
    };
  });
  if (stateNotes.length > 0) return stateNotes;

  const domLinks = await page.locator("a[href]").evaluateAll((anchors) => (
    anchors
      .map((anchor) => ({
        href: anchor.href,
        title: anchor.innerText || anchor.textContent || anchor.getAttribute("title") || ""
      }))
      .filter((entry) => /xiaohongshu\.com\/(explore|discovery\/item)\//.test(entry.href))
  )).catch(() => []);
  const byId = new Map();
  for (const entry of domLinks) {
    const id = extractXhsNoteId(entry.href);
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      title: String(entry.title || "").trim(),
      detailUrl: entry.href,
      exportUrl: entry.href
    });
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
  await page.waitForTimeout(900);
  const detail = await scrapeNoteDetailFromPage(page);
  detail.noteUrl = canonicalXhsItemUrl(page.url()) || canonicalXhsItemUrl(noteUrl);
  return detail;
}

async function scrapeNoteDetailFromPage(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (/当前笔记暂时无法浏览|请打开小红书App扫码查看|页面无法浏览/.test(bodyText)) {
    return { tags: "", publishedAt: null, blocked: true };
  }
  const tags = extractTags(bodyText);
  const dateTexts = await readDetailDateTexts(page);
  const publishedAtResult = parseXhsDetailPublishedAt({
    dateTexts,
    bodyText,
    referenceDateString: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())
  });
  return {
    tags,
    publishedAt: publishedAtResult.publishedAt,
    publishedAtSource: publishedAtResult.source,
    dateCandidates: publishedAtResult.candidates.join(" | ")
  };
}

async function readDetailDateTexts(page) {
  const selectors = [
    ".note-content .bottom-container .date",
    ".bottom-container .date",
    "span.date"
  ];
  const texts = [];
  for (const selector of selectors) {
    const values = await page.locator(selector).evaluateAll((elements) => (
      elements
        .map((element) => element.innerText || element.textContent || "")
        .map((text) => text.trim())
        .filter(Boolean)
    )).catch(() => []);
    texts.push(...values);
  }
  return [...new Set(texts)];
}

function shouldRetryXhsDetailUnblocked(detail) {
  return detail && !detail.blocked && !detail.tags;
}

function extractTags(text) {
  const matches = String(text || "").match(/#[\p{Script=Han}\p{Letter}\p{Number}_-]+/gu) || [];
  return [...new Set(matches)].join(" ");
}

function buildXhsExploreUrl(noteId, token = "") {
  const id = String(noteId || "").trim();
  if (!id) return "";
  const params = new URLSearchParams();
  params.set("source", "webshare");
  params.set("xhsshare", "pc_web");
  if (token) params.set("xsec_token", String(token));
  params.set("xsec_source", "pc_share");
  return `https://www.xiaohongshu.com/discovery/item/${id}?${params.toString()}`;
}

function accountLabel(accountName) {
  return normalizeAccountLabelSafe(accountName);
}

function normalizeAccountLabelSafe(accountName) {
  if (/研习社/.test(accountName)) return "研习社";
  if (/同花顺投资|^投资号$/.test(accountName)) return "投资号";
  if (/(同花顺|同顺)股民社区|^股民社区$/.test(accountName)) return "股民社区";
  if (/同花顺财富|同花顺理财|^理财$/.test(accountName)) return "理财";
  if (/(同花顺|同顺)财经|^财经号$/.test(accountName)) return "财经号";
  if (/(同花顺|同顺)?问财/.test(accountName)) return "问财";
  if (/喵懂投资/.test(accountName)) return "喵懂投资";
  return String(accountName || "").trim();
}

function createAccountAudit(account = {}) {
  return {
    accountName: account.name || "",
    accountHomeUrl: account.url || "",
    pages: 0,
    checked: 0,
    detailSkipped: 0,
    collected: 0,
    blocked: 0,
    stopReason: "",
    failureReason: ""
  };
}

function summarizeItems(items = []) {
  const byAccount = new Map();
  const ids = new Map();
  let emptyUrl = 0;
  let emptyTitle = 0;
  let emptyTags = 0;
  for (const item of items || []) {
    const account = item.accountName || "(空)";
    byAccount.set(account, (byAccount.get(account) || 0) + 1);
    if (!item.itemUrl) emptyUrl += 1;
    if (!item.title) emptyTitle += 1;
    if (!item.tags) emptyTags += 1;
    if (item.itemId) ids.set(item.itemId, (ids.get(item.itemId) || 0) + 1);
  }
  return {
    total: items.length,
    emptyUrl,
    emptyTitle,
    emptyTags,
    duplicateIds: [...ids.values()].filter((count) => count > 1).length,
    accounts: [...byAccount.entries()].sort((left, right) => right[1] - left[1]).map(([name, count]) => ({ name, count }))
  };
}

function parseDateOnly(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return new Date(year, month - 1, day);
}

function numberOption(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, number);
  }
  return 0;
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
    if (arg === "--max-scrolls-per-account") {
      options.maxScrollsPerAccount = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-scrolls-per-account=")) {
      options.maxScrollsPerAccount = arg.slice("--max-scrolls-per-account=".length);
      continue;
    }
    if (arg === "--max-detail-pages") {
      options.maxDetailPages = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-detail-pages=")) {
      options.maxDetailPages = arg.slice("--max-detail-pages=".length);
      continue;
    }
    if (arg === "--scroll-delay-ms") {
      options.scrollDelayMs = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--scroll-delay-ms=")) {
      options.scrollDelayMs = arg.slice("--scroll-delay-ms=".length);
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
    if (arg === "--stable-rounds") {
      options.stableRounds = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--stable-rounds=")) {
      options.stableRounds = arg.slice("--stable-rounds=".length);
      continue;
    }
    if (arg === "--mode") {
      options.mode = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    }
  }
  return options;
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
