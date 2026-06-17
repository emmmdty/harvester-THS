import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { chromiumLaunchOptions, resolveCrawlerHeadless } from "./browser-env.mjs";
import { classifyContentType } from "./content-classifier.mjs";
import {
  DOUYIN_HISTORY_HEADERS,
  DOUYIN_HISTORY_SHEET_KEY,
  buildPostApiCursorUrl,
  createHistoryAccountAudit,
  cursorPaginationStopReason,
  extractHistoryItemsFromPostResponse,
  extractPostPageInfo,
  filterHistoryItemsForAccount,
  mergeHistoryLedgerItems,
  replaceHistorySheet,
  readHistoryLedger,
  updateHistoryAccountAudit,
  upsertHistorySheet,
  writeExcludedHistoryOutputs,
  writeHistoryLedger,
  writeHistoryOutputs,
  writeHistoryRunAudit
} from "./douyin-history.mjs";
import {
  extractDouyinApiDetail,
  isLowConfidenceDouyinTags,
  mergeDouyinTagCandidates
} from "./douyin-detail-text.mjs";
import { extractPrimaryDouyinAuthorProfileUrl } from "./douyin-profile-guard.mjs";
import { FeishuSheetsClient, loadFeishuConfig } from "./feishu-sheets.mjs";
import { extractDouyinItem, normalizeDouyinContentLink } from "./link-utils.mjs";
import { readPlatformAccounts } from "./platform-accounts.mjs";

const ROOT = process.cwd();
const USER_DATA_DIR = path.join(ROOT, ".douyin-profile");
const LEDGER_RELATIVE_PATH = ".runtime/douyin-history/ledger.jsonl";
const RUNTIME_DIR = path.join(ROOT, ".runtime/douyin-history");
const LEDGER_PATH = path.join(ROOT, LEDGER_RELATIVE_PATH);
const OUTPUT_DIR = path.join(RUNTIME_DIR, "exports");
const BACKUP_DIR = path.join(RUNTIME_DIR, "backups");
const POST_API_PATH = "/aweme/v1/web/aweme/post/";

const OPTIONS = parseArgs(process.argv.slice(2));
const MAX_ITEMS = numberOption(OPTIONS.maxItems, process.env.MAX_HISTORY_ITEMS, 0);
const MAX_SCROLLS_PER_ACCOUNT = numberOption(
  OPTIONS.maxScrolls,
  process.env.MAX_HISTORY_SCROLLS_PER_ACCOUNT,
  320
);
const MAX_PAGES_PER_ACCOUNT = numberOption(
  OPTIONS.maxPagesPerAccount,
  process.env.MAX_HISTORY_PAGES_PER_ACCOUNT,
  300
);
const EMPTY_PAGES_LIMIT = numberOption(
  OPTIONS.emptyPagesLimit,
  process.env.HISTORY_EMPTY_PAGES_LIMIT,
  3
);
const MAX_HISTORY_DETAIL_FALLBACK = numberOption(
  OPTIONS.maxDetailFallback,
  process.env.MAX_HISTORY_DETAIL_FALLBACK,
  800
);
const SCROLL_DELAY_MS = numberOption(OPTIONS.scrollDelayMs, process.env.HISTORY_SCROLL_DELAY_MS, 1800);
const PAGE_DELAY_MS = numberOption(OPTIONS.pageDelayMs, process.env.HISTORY_PAGE_DELAY_MS, 1200);
const STABLE_ROUNDS_LIMIT = numberOption(OPTIONS.stableRounds, process.env.HISTORY_STABLE_ROUNDS, 8);
const HEADLESS = resolveCrawlerHeadless();

async function main() {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const accounts = await selectAccounts(await readPlatformAccounts("douyin", { root: ROOT }), OPTIONS.account);
  if (accounts.length === 0) {
    throw new Error(OPTIONS.account
      ? `未找到抖音账号：${OPTIONS.account}`
      : "请先在账号配置中添加抖音账号。");
  }

  const collectedAt = new Date().toISOString();
  const safeTimestamp = collectedAt.replace(/[:.]/g, "-");
  const backupPath = OPTIONS.rebuild ? await backupRuntimeInputs({ safeTimestamp }) : null;
  const ledgerBefore = await readHistoryLedger(LEDGER_PATH);
  let ledger = OPTIONS.rebuild ? [] : ledgerBefore;
  const failures = [];
  const excluded = [];
  const detailCandidates = [];
  const runAudit = [];
  let runItemCount = 0;

  console.log(`抖音历史采集：账号 ${accounts.length} 个，已有 ledger ${ledgerBefore.length} 条。`);
  if (OPTIONS.rebuild) console.log(`重建模式：已备份当前 ledger，备份目录 ${backupPath}，本次从空 ledger 采集。`);
  console.log(`inventory 优先：cursor 翻页 ${POST_API_PATH}；单账号页数上限：${MAX_PAGES_PER_ACCOUNT}；空页上限：${EMPTY_PAGES_LIMIT}；详情兜底上限：${MAX_HISTORY_DETAIL_FALLBACK}`);
  if (MAX_ITEMS > 0) console.log(`本次最多采集新增/更新 ${MAX_ITEMS} 条。`);

  let context = null;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...chromiumLaunchOptions(),
      headless: HEADLESS,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
    });

    const listPage = await context.newPage();
    listPage.setDefaultTimeout(20_000);
    const detailPage = await context.newPage();
    detailPage.setDefaultTimeout(20_000);

    for (const account of accounts) {
      const remainingCapacity = MAX_ITEMS > 0 ? MAX_ITEMS - runItemCount : 0;
      if (MAX_ITEMS > 0 && remainingCapacity <= 0) break;
      console.log(`\n==> inventory：${account.name}`);
      try {
        const accountInventory = await crawlAccountInventory({
          context,
          page: listPage,
          account,
          collectedAt,
          itemLimit: remainingCapacity
        });
        excluded.push(...accountInventory.excluded);
        detailCandidates.push(...accountInventory.detailCandidates);
        runAudit.push(accountInventory.audit);
        const accountItems = accountInventory.items;
        const limitedAccountItems = remainingCapacity > 0 ? accountItems.slice(0, remainingCapacity) : accountItems;
        ledger = mergeHistoryLedgerItems(ledger, limitedAccountItems);
        runItemCount += limitedAccountItems.length;
        await writeHistoryLedger(LEDGER_PATH, ledger);
        console.log(`账号 inventory 完成：${account.name}，本账号新增/更新 ${limitedAccountItems.length} 条，页数 ${accountInventory.audit.pages}，停止原因 ${accountInventory.audit.stopReason || "unknown"}，ledger ${ledger.length} 条。`);
      } catch (error) {
        const message = error.message || String(error);
        const audit = createHistoryAccountAudit({ account });
        audit.failureReason = message;
        audit.stopReason = "failed";
        audit.source = "account-inventory";
        runAudit.push(audit);
        failures.push({
          accountName: account.name,
          accountHomeUrl: account.url,
          collectStatus: "采集失败",
          collectedAt,
          failureReason: message,
          source: "account-inventory"
        });
        console.warn(`账号 inventory 失败：${account.name}，原因：${message}`);
        if (isLoginRequiredMessage(message)) throw error;
      }
    }

    const fallbackCandidates = selectDetailFallbackCandidates(ledger, detailCandidates, MAX_HISTORY_DETAIL_FALLBACK);
    if (fallbackCandidates.length > 0) {
      console.log(`\n==> 详情页兜底：${fallbackCandidates.length} 条`);
      const enriched = [];
      const excludedFallbackKeys = new Set();
      for (const item of fallbackCandidates) {
        try {
          const detail = await scrapeDetailFallback(detailPage, item);
          const account = accounts.find((entry) => entry.url === detail.accountHomeUrl) || {
            name: detail.accountName,
            url: detail.accountHomeUrl
          };
          const filtered = filterHistoryItemsForAccount([detail], account, { requireAuthor: true });
          enriched.push(...filtered.accepted);
          excluded.push(...filtered.excluded);
          for (const excludedItem of filtered.excluded) excludedFallbackKeys.add(historyItemKey(excludedItem));
          console.log(`详情兜底：${filtered.accepted.length ? filtered.accepted[0].collectStatus : "已排除"} ${detail.itemUrl}`);
          await detailPage.waitForTimeout(700);
        } catch (error) {
          const failed = {
            ...item,
            collectStatus: "待补全",
            collectedAt,
            failureReason: error.message || String(error),
            source: appendSource(item.source, "detail-fallback-failed")
          };
          if (failed.authorProfileUrl) {
            enriched.push(failed);
          } else {
            excluded.push(excludedHistoryCandidate(failed, {
              name: failed.accountName,
              url: failed.accountHomeUrl
            }, "详情验证失败，作者主页缺失"));
          }
          console.warn(`详情兜底失败：${item.itemUrl}，原因：${error.message || String(error)}`);
        }
      }
      ledger = mergeHistoryLedgerItems(ledger, enriched)
        .filter((item) => !excludedFallbackKeys.has(historyItemKey(item)));
      await writeHistoryLedger(LEDGER_PATH, ledger);
    }
  } finally {
    await context?.close().catch(() => {});
  }

  const finalItems = mergeHistoryLedgerItems(ledger, failures);
  await writeHistoryLedger(LEDGER_PATH, finalItems);
  const output = await writeHistoryOutputs({
    items: finalItems,
    outputDir: OUTPUT_DIR,
    generatedAt: collectedAt
  });
  const excludedOutput = await writeExcludedHistoryOutputs({
    items: excluded,
    outputDir: OUTPUT_DIR,
    generatedAt: collectedAt
  });
  const runAuditOutput = await writeHistoryRunAudit({
    audit: runAudit,
    outputDir: OUTPUT_DIR,
    generatedAt: collectedAt,
    summary: summarizeItems(finalItems)
  });
  console.log(`\n本地 ledger：${LEDGER_PATH}`);
  console.log(`JSON 审计：${output.jsonPath}`);
  console.log(`CSV 审计：${output.csvPath}`);
  console.log(`排除 JSON 审计：${excludedOutput.jsonPath}`);
  console.log(`排除 CSV 审计：${excludedOutput.csvPath}`);
  console.log(`运行审计 JSON：${runAuditOutput.jsonPath}`);
  console.log(`运行审计 CSV：${runAuditOutput.csvPath}`);

  if (OPTIONS.skipFeishu) {
    console.log("已跳过飞书写入（--skip-feishu）。");
  } else {
    const config = loadFeishuConfig();
    const client = new FeishuSheetsClient(config);
    if (OPTIONS.rebuild) {
      const feishuBackup = await backupFeishuHistory({ client, safeTimestamp });
      console.log(`飞书备份：${feishuBackup.jsonPath}`);
      console.log(`飞书备份 CSV：${feishuBackup.csvPath}`);
    }
    const writePayload = {
      client,
      sheetId: config.sheets[DOUYIN_HISTORY_SHEET_KEY] || "",
      items: finalItems,
      batchSize: 100
    };
    const result = OPTIONS.rebuild
      ? await replaceHistorySheet(writePayload)
      : await upsertHistorySheet(writePayload);
    if (result.createdSheetId) {
      console.log(`已新建 Sheet：抖音历史台账，sheet_id=${result.createdSheetId}`);
      console.log("可将该值写入 .env 的 FEISHU_SHEET_DOUYIN_HISTORY，后续运行会直接复用。");
    }
    console.log(`飞书写入：新增 ${result.created}，更新 ${result.updated || 0}，跳过 ${result.skipped}。`);
  }

  const summary = summarizeItems(finalItems);
  console.log(`\n抖音历史台账完成：总数 ${summary.total}，URL 空值 ${summary.emptyUrl}，标题空值 ${summary.emptyTitle}，tag 空值 ${summary.emptyTags}，作品ID重复 ${summary.duplicateIds}。`);
}

async function crawlAccountInventory({ context, page, account, collectedAt, itemLimit = 0 }) {
  const cursorResult = await crawlAccountCursorInventory({ context, page, account, collectedAt, itemLimit });
  if (cursorResult.items.length > 0 || cursorResult.audit.failureReason === "") return cursorResult;

  console.warn(`cursor inventory 失败，回落滚动兜底：${account.name}，原因：${cursorResult.audit.failureReason}`);
  const scrollResult = await crawlAccountScrollInventory({ page, account, collectedAt, itemLimit });
  return mergeInventoryResults(cursorResult, scrollResult);
}

async function crawlAccountCursorInventory({ context, page, account, collectedAt, itemLimit = 0 }) {
  const items = [];
  const excluded = [];
  const detailCandidates = [];
  const seenThisAccount = new Set();
  const seenDetailCandidates = new Set();
  const audit = createHistoryAccountAudit({ account });
  let seed = null;

  const onResponse = (response) => {
    if (seed || !response.url().includes(POST_API_PATH)) return;
    seed = capturePostSeed(response, account, collectedAt);
  };
  page.on("response", onResponse);

  try {
    await page.goto(account.url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2500);
    await assertLoggedIn(page);

    if (seed) await seed;
    let seedPayload = seed ? await seed : null;
    if (!seedPayload?.url) {
      seedPayload = await waitForPostSeed(page, account, collectedAt);
    }
    if (!seedPayload?.url) {
      throw new Error("未捕获抖音作品列表接口，请检查页面是否展示作品列表。");
    }

    let nextUrl = seedPayload.url;
    let lastCursor = "";
    let emptyPages = 0;
    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_ACCOUNT; pageIndex += 1) {
      const payload = pageIndex === 0
        ? seedPayload.payload
        : await fetchPostApiJson(context, nextUrl);
      const pageInfo = extractPostPageInfo(payload);
      const acceptedBefore = items.length;
      addPostPayloadItems({
        payload,
        account,
        collectedAt,
        items,
        excluded,
        seen: seenThisAccount,
        itemLimit
      });
      const visibleCandidates = pageIndex === 0 ? await readVisibleItemLinks(page, account, collectedAt) : [];
      queueVisibleCandidatesForDetail(visibleCandidates, detailCandidates, seenDetailCandidates, seenThisAccount, itemLimit);
      const added = items.length - acceptedBefore;
      emptyPages = added <= 0 ? emptyPages + 1 : 0;
      const stopReason = cursorPaginationStopReason({
        pageInfo,
        pages: pageIndex + 1,
        maxPages: MAX_PAGES_PER_ACCOUNT,
        emptyPages,
        emptyPagesLimit: EMPTY_PAGES_LIMIT,
        collected: items.length,
        itemLimit
      });
      updateHistoryAccountAudit(audit, {
        source: "cursor-api",
        pageInfo,
        added,
        collected: items.length,
        stopReason
      });
      console.log(`cursor ${pageIndex + 1}/${MAX_PAGES_PER_ACCOUNT}：${account.name} 本页新增 ${added}，累计 ${items.length}，预期 ${audit.expected ?? "未知"}，has_more=${pageInfo.hasMore}，空页 ${emptyPages}`);
      if (stopReason) break;
      if (pageInfo.maxCursor && pageInfo.maxCursor === lastCursor) {
        audit.stopReason = "repeated-cursor";
        break;
      }
      lastCursor = pageInfo.maxCursor;
      nextUrl = buildPostApiCursorUrl(seedPayload.url, { cursor: pageInfo.maxCursor, count: 30 });
      await page.waitForTimeout(PAGE_DELAY_MS);
    }

    if (!audit.stopReason) audit.stopReason = "unknown";
    removeAcceptedDetailCandidates(detailCandidates, seenThisAccount);
    return { items, excluded, detailCandidates, audit };
  } catch (error) {
    audit.failureReason = error.message || String(error);
    audit.stopReason = "cursor-failed";
    audit.source = appendSource(audit.source, "cursor-api");
    return { items, excluded, detailCandidates, audit };
  } finally {
    page.off("response", onResponse);
  }
}

async function crawlAccountScrollInventory({ page, account, collectedAt, itemLimit = 0 }) {
  const items = [];
  const excluded = [];
  const detailCandidates = [];
  const pendingResponses = new Set();
  const seenThisAccount = new Set();
  const seenDetailCandidates = new Set();
  const audit = createHistoryAccountAudit({ account });
  let lastSeenCount = 0;
  let stableRounds = 0;

  const onResponse = (response) => {
    if (!response.url().includes(POST_API_PATH)) return;
    pendingResponses.add(handlePostResponse(response, account, collectedAt, items, excluded, seenThisAccount, itemLimit));
  };
  page.on("response", onResponse);

  try {
    await page.goto(account.url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2500);
    await assertLoggedIn(page);

    for (let round = 0; round < MAX_SCROLLS_PER_ACCOUNT; round += 1) {
      await Promise.allSettled([...pendingResponses]);
      pendingResponses.clear();

      const visibleCandidates = await readVisibleItemLinks(page, account, collectedAt);
      queueVisibleCandidatesForDetail(visibleCandidates, detailCandidates, seenDetailCandidates, seenThisAccount, itemLimit);

      if (items.length === lastSeenCount) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        lastSeenCount = items.length;
      }

      console.log(`滚动 ${round + 1}/${MAX_SCROLLS_PER_ACCOUNT}：${account.name} 已见 ${items.length} 条，连续稳定 ${stableRounds}`);
      updateHistoryAccountAudit(audit, {
        source: "scroll-fallback",
        pageInfo: { hasMore: true, maxCursor: String(round + 1) },
        added: items.length - lastSeenCount,
        collected: items.length
      });
      if (itemLimit > 0 && items.length >= itemLimit) {
        audit.stopReason = "item-limit";
        break;
      }
      if (stableRounds >= STABLE_ROUNDS_LIMIT && items.length > 0) {
        audit.stopReason = "stable-scrolls";
        break;
      }

      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(SCROLL_DELAY_MS);
    }

    await Promise.allSettled([...pendingResponses]);
    removeAcceptedDetailCandidates(detailCandidates, seenThisAccount);
    if (!audit.stopReason) audit.stopReason = "max-scrolls";
    return { items, excluded, detailCandidates, audit };
  } finally {
    page.off("response", onResponse);
  }
}

async function capturePostSeed(response, account, collectedAt) {
  try {
    if (response.status() !== 200) return null;
    const payload = await response.json();
    const items = extractHistoryItemsFromPostResponse(payload, {
      accountName: account.name,
      accountHomeUrl: account.url,
      collectedAt
    });
    if (items.length === 0 && !Array.isArray(payload?.aweme_list)) return null;
    return { url: response.url(), payload };
  } catch {
    return null;
  }
}

async function waitForPostSeed(page, account, collectedAt) {
  return page.waitForResponse((response) => response.url().includes(POST_API_PATH) && response.status() === 200, { timeout: 10_000 })
    .then((response) => capturePostSeed(response, account, collectedAt))
    .catch(() => null);
}

async function fetchPostApiJson(context, url) {
  const response = await context.request.get(url, {
    headers: {
      "referer": "https://www.douyin.com/",
      "accept": "application/json, text/plain, */*"
    }
  });
  if (!response.ok()) {
    throw new Error(`作品列表接口失败：HTTP ${response.status()}`);
  }
  return response.json();
}

function addPostPayloadItems({ payload, account, collectedAt, items, excluded, seen, itemLimit = 0 }) {
  const extracted = extractHistoryItemsFromPostResponse(payload, {
    accountName: account.name,
    accountHomeUrl: account.url,
    collectedAt
  }).map((item) => normalizeInventoryItem(item, account));
  const filtered = filterHistoryItemsForAccount(extracted, account, { requireAuthor: true });
  excluded.push(...filtered.excluded);
  for (const item of filtered.accepted) {
    if (itemLimit > 0 && items.length >= itemLimit) break;
    addHistoryItem(items, seen, item);
  }
}

function mergeInventoryResults(primary, fallback) {
  const items = mergeHistoryLedgerItems(primary.items, fallback.items);
  const audit = {
    ...fallback.audit,
    collected: items.length,
    pages: Number(primary.audit?.pages || 0) + Number(fallback.audit?.pages || 0),
    emptyPages: Number(primary.audit?.emptyPages || 0) + Number(fallback.audit?.emptyPages || 0),
    source: appendSource(primary.audit?.source || "", fallback.audit?.source || ""),
    failureReason: [primary.audit?.failureReason, fallback.audit?.failureReason].filter(Boolean).join("；"),
    stopReason: fallback.audit?.stopReason || primary.audit?.stopReason || "",
    expected: primary.audit?.expected ?? fallback.audit?.expected ?? null,
    lastCursor: fallback.audit?.lastCursor || primary.audit?.lastCursor || "",
    hasMoreStopped: Boolean(primary.audit?.hasMoreStopped || fallback.audit?.hasMoreStopped)
  };
  return {
    items,
    excluded: [...(primary.excluded || []), ...(fallback.excluded || [])],
    detailCandidates: mergeHistoryLedgerItems(primary.detailCandidates, fallback.detailCandidates),
    audit
  };
}

async function handlePostResponse(response, account, collectedAt, items, excluded, seen, itemLimit = 0) {
  try {
    if (response.status() !== 200) return;
    const json = await response.json();
    addPostPayloadItems({ payload: json, account, collectedAt, items, excluded, seen, itemLimit });
  } catch {
    // Non-JSON/aborted responses are expected while scrolling.
  }
}

function normalizeInventoryItem(item, account) {
  return {
    ...item,
    accountName: item.accountName || account.name,
    accountHomeUrl: item.accountHomeUrl || account.url,
    collectStatus: needsDetailFallback(item) ? "待补全" : "已采集",
    failureReason: needsDetailFallback(item) ? missingReason(item) : "",
    source: appendSource(item.source, "inventory")
  };
}

function queueVisibleCandidatesForDetail(candidates = [], detailCandidates = [], seen = new Set(), acceptedSeen = new Set(), itemLimit = 0) {
  const maxCandidates = itemLimit > 0 ? Math.max(itemLimit * 2, 20) : 400;
  for (const item of candidates || []) {
    if (detailCandidates.length >= maxCandidates) break;
    const key = historyItemKey(item);
    if (!key || seen.has(key) || acceptedSeen.has(key)) continue;
    seen.add(key);
    detailCandidates.push(item);
  }
}

function removeAcceptedDetailCandidates(detailCandidates = [], acceptedSeen = new Set()) {
  for (let index = detailCandidates.length - 1; index >= 0; index -= 1) {
    if (acceptedSeen.has(historyItemKey(detailCandidates[index]))) detailCandidates.splice(index, 1);
  }
}

async function readVisibleItemLinks(page, account, collectedAt) {
  const links = await page.evaluate(() => {
    const values = new Set();
    for (const anchor of document.querySelectorAll("a[href]")) values.add(anchor.href);
    const html = document.documentElement?.innerHTML || "";
    for (const match of html.matchAll(/https?:\\\/\\\/www\.douyin\.com\\\/(?:video|note)\\\/\d+[^"'\\<\s]*/g)) {
      values.add(match[0].replaceAll("\\/", "/"));
    }
    return [...values];
  }).catch(() => []);

  const byId = new Map();
  for (const link of links) {
    const item = extractDouyinItem(link);
    if (!item?.id || byId.has(item.id)) continue;
    const itemType = item.type === "note" ? "图文" : "视频";
    byId.set(item.id, {
      accountName: account.name,
      accountHomeUrl: account.url,
      publishedAt: "",
      itemType,
      itemId: item.id,
      itemUrl: normalizeDouyinContentLink(link),
      title: "",
      tags: "",
      contentType: itemType === "图文" ? "图文" : "无",
      contentTypeReview: itemType === "图文" ? "通过" : "需审核",
      collectStatus: "待补全",
      collectedAt,
      failureReason: "列表 DOM 仅识别到作品链接，待详情页补全",
      source: "visible-link"
    });
  }
  return [...byId.values()];
}

async function scrapeDetailFallback(page, item) {
  if (!item.itemUrl) return item;
  const apiDetailPromise = waitForItemApiDetail(page, item.itemId);
  await page.goto(item.itemUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await assertLoggedIn(page);
  const apiDetail = await apiDetailPromise;
  const pageText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const pageAuthorProfileUrl = await readPrimaryAuthorProfileUrl(page, { expectedProfileUrl: item.accountHomeUrl });
  const apiTags = apiDetail?.tags || "";
  const pageTags = tagsFromText(pageText);
  const mergedTags = mergeDouyinTagCandidates([
    { tags: apiTags, priority: apiDetail?.tagsFallback ? 0 : 30, fallback: apiDetail?.tagsFallback, lowConfidence: apiDetail?.tagsLowConfidence },
    { tags: pageTags, priority: 10, lowConfidence: isLowConfidenceDouyinTags(pageTags) }
  ]);
  const next = {
    ...item,
    title: item.title || apiDetail?.title || "",
    tags: item.tags || mergedTags.tags || "",
    publishedAt: item.publishedAt || formatDate(apiDetail?.publishedAt) || "",
    actualAuthorName: item.actualAuthorName || apiDetail?.authorName || "",
    authorProfileUrl: item.authorProfileUrl || apiDetail?.authorProfileUrl || pageAuthorProfileUrl || "",
    collectStatus: "已采集",
    failureReason: "",
    source: appendSource(item.source, "detail-fallback")
  };
  const classification = await classifyContentType({
    platformId: "douyin",
    accountName: next.accountName,
    title: next.title,
    tags: next.tags,
    text: pageText
  });
  next.contentType = next.contentType && next.contentType !== "无" ? next.contentType : classification.contentType;
  next.contentTypeReview = classification.contentTypeReview || next.contentTypeReview;
  if (needsDetailFallback(next)) {
    next.collectStatus = "待补全";
    next.failureReason = missingReason(next);
  }
  return next;
}

function waitForItemApiDetail(page, itemId) {
  const wanted = String(itemId || "").trim();
  if (!wanted) return Promise.resolve(null);
  return page.waitForResponse(async (response) => {
    try {
      if (response.status() !== 200) return false;
      const url = new URL(response.url());
      if (url.pathname.includes("/aweme/v1/web/aweme/detail/")) {
        return url.searchParams.get("aweme_id") === wanted;
      }
      if (url.pathname.includes(POST_API_PATH)) {
        const json = await response.json();
        return Array.isArray(json?.aweme_list)
          && json.aweme_list.some((aweme) => String(aweme?.aweme_id || "") === wanted);
      }
      return false;
    } catch {
      return false;
    }
  }, { timeout: 12_000 })
    .then((response) => response.json())
    .then((json) => extractDouyinApiDetail(json, { itemId: wanted }))
    .catch(() => null);
}

async function readPrimaryAuthorProfileUrl(page, { expectedProfileUrl = "" } = {}) {
  const hrefs = await page.locator("a[href]").evaluateAll((anchors) => {
    return anchors.map((anchor) => anchor.href || "").filter(Boolean);
  }).catch(() => []);
  return extractPrimaryDouyinAuthorProfileUrl(hrefs, { preferredProfileUrl: expectedProfileUrl });
}

function addHistoryItem(items, seen, item) {
  const key = historyItemKey(item);
  if (!key || seen.has(key)) return;
  seen.add(key);
  items.push(item);
}

function selectDetailFallbackCandidates(ledger = [], detailCandidates = [], limit = 0) {
  const selected = [];
  const seen = new Set();
  const push = (item) => {
    const key = historyItemKey(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    selected.push(item);
  };
  for (const item of ledger.filter(needsDetailFallback)) push(item);
  for (const item of detailCandidates) push(item);
  return selected.slice(0, Math.max(0, Number(limit) || 0));
}

function needsDetailFallback(item = {}) {
  return !item.title
    || !item.tags
    || isLowConfidenceDouyinTags(item.tags || "")
    || !item.publishedAt
    || !item.itemType
    || !item.accountName
    || !item.itemUrl;
}

function missingReason(item = {}) {
  const reasons = [];
  if (!item.title) reasons.push("标题缺失");
  if (!item.tags) reasons.push("tag缺失");
  if (item.tags && isLowConfidenceDouyinTags(item.tags)) reasons.push("tag低置信");
  if (!item.publishedAt) reasons.push("发布时间缺失");
  if (!item.itemType) reasons.push("作品类型缺失");
  if (!item.accountName) reasons.push("账号缺失");
  if (!item.itemUrl) reasons.push("作品链接缺失");
  return reasons.join("；");
}

function tagsFromText(text) {
  const matches = String(text || "").match(/#[\p{Script=Han}\p{Letter}\p{Number}_-]+/gu) || [];
  return [...new Set(matches)].join(" ");
}

async function backupRuntimeInputs({ safeTimestamp }) {
  const backupPath = path.join(BACKUP_DIR, safeTimestamp);
  await fs.mkdir(backupPath, { recursive: true });
  await copyIfExists(LEDGER_PATH, path.join(backupPath, "ledger.jsonl"));
  return backupPath;
}

async function backupFeishuHistory({ client, safeTimestamp }) {
  const backupPath = path.join(BACKUP_DIR, safeTimestamp);
  await fs.mkdir(backupPath, { recursive: true });
  const rows = await client.readSheetRows(DOUYIN_HISTORY_SHEET_KEY, DOUYIN_HISTORY_HEADERS.length);
  const jsonPath = path.join(backupPath, "feishu-history.json");
  const csvPath = path.join(backupPath, "feishu-history.csv");
  await fs.writeFile(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    rows
  }, null, 2), "utf8");
  await fs.writeFile(csvPath, rowsToCsv(rows), "utf8");
  return { jsonPath, csvPath, rows };
}

async function copyIfExists(sourcePath, targetPath) {
  try {
    await fs.copyFile(sourcePath, targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function excludedHistoryCandidate(item = {}, account = {}, reason = "") {
  return {
    ...item,
    expectedAccountName: account.name || "",
    expectedAccountHomeUrl: account.url || "",
    exclusionReason: reason,
    source: appendSource(item.source, "excluded")
  };
}

async function assertLoggedIn(page) {
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  if (isLoginRequiredMessage(text) || /\/login|login\?/.test(page.url())) {
    throw new Error("抖音登录状态已失效，请先运行 npm run login:douyin 重新登录。");
  }
}

function isLoginRequiredMessage(text) {
  return /登录后查看更多|扫码登录|验证码登录|手机号登录|请登录|登录后查看|登录状态已失效|重新登录/.test(String(text || ""));
}

function historyItemKey(item = {}) {
  return String(item.itemId || item.itemUrl || "").trim();
}

function appendSource(current, next) {
  const values = String(current || "")
    .split(/[+,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (next && !values.includes(next)) values.push(next);
  return values.join("+");
}

function summarizeItems(items = []) {
  const ids = new Map();
  let duplicateIds = 0;
  for (const item of items) {
    if (!item.itemId) continue;
    ids.set(item.itemId, (ids.get(item.itemId) || 0) + 1);
  }
  for (const count of ids.values()) {
    if (count > 1) duplicateIds += count - 1;
  }
  return {
    total: items.length,
    emptyUrl: items.filter((item) => !item.itemUrl).length,
    emptyTitle: items.filter((item) => !item.title).length,
    emptyTags: items.filter((item) => !item.tags).length,
    duplicateIds
  };
}

function rowsToCsv(rows = []) {
  return (rows || [])
    .map((row) => (Array.isArray(row) ? row : [])
      .map((cell) => csvEscape(cellText(cell)))
      .join(","))
    .join("\n");
}

function cellText(value) {
  if (Array.isArray(value)) return value.map((entry) => cellText(entry)).find(Boolean) || "";
  if (value && typeof value === "object") return String(value.text || value.link || value.url || "");
  return String(value ?? "");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

async function selectAccounts(accounts, accountName) {
  const wanted = String(accountName || "").trim();
  if (!wanted) return accounts;
  return accounts.filter((account) => account.name === wanted || account.name.includes(wanted));
}

function parseArgs(args) {
  const options = { skipFeishu: false, rebuild: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--rebuild") {
      options.rebuild = true;
      continue;
    }
    if (arg === "--skip-feishu") {
      options.skipFeishu = true;
      continue;
    }
    if (arg === "--max-items") {
      options.maxItems = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-items=")) {
      options.maxItems = arg.slice("--max-items=".length);
      continue;
    }
    if (arg === "--account") {
      options.account = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--account=")) {
      options.account = arg.slice("--account=".length);
      continue;
    }
    if (arg === "--max-scrolls") {
      options.maxScrolls = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-scrolls=")) {
      options.maxScrolls = arg.slice("--max-scrolls=".length);
      continue;
    }
    if (arg === "--max-pages-per-account") {
      options.maxPagesPerAccount = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-pages-per-account=")) {
      options.maxPagesPerAccount = arg.slice("--max-pages-per-account=".length);
      continue;
    }
    if (arg === "--empty-pages-limit") {
      options.emptyPagesLimit = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--empty-pages-limit=")) {
      options.emptyPagesLimit = arg.slice("--empty-pages-limit=".length);
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
    if (arg === "--max-detail-fallback") {
      options.maxDetailFallback = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-detail-fallback=")) {
      options.maxDetailFallback = arg.slice("--max-detail-fallback=".length);
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
    if (arg === "--stable-rounds") {
      options.stableRounds = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--stable-rounds=")) {
      options.stableRounds = arg.slice("--stable-rounds=".length);
    }
  }
  return options;
}

function numberOption(...values) {
  const fallback = values.at(-1);
  for (const value of values.slice(0, -1)) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, number);
  }
  return Math.max(0, Number(fallback) || 0);
}

function formatDate(date) {
  if (!date) return "";
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
