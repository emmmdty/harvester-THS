import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { chromiumLaunchOptions, resolveCrawlerHeadless } from "./browser-env.mjs";
import { extractDouyinApiDetail, extractDouyinTagsFromSources, extractDouyinTitle } from "./douyin-detail-text.mjs";
import { readAllPlatformAccounts } from "./platform-accounts.mjs";
import {
  extractDouyinItem,
  extractFirstUrl,
  normalizeDouyinContentLink,
  resolveDouyinShortLinkViaRedirect
} from "./link-utils.mjs";

const ROOT = process.cwd();
const USER_DATA_DIR = path.join(ROOT, ".douyin-profile");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = String(options.input || "").trim();
  if (!input) throw new Error("Usage: node src/resolve-douyin-share.mjs --json --input <douyin share text or url>");

  const data = await resolveDouyinShare(input);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: Boolean(data?.id), data }, null, 2)}\n`);
    return;
  }
  console.log(data);
}

export async function resolveDouyinShare(input, { root = ROOT } = {}) {
  const sourceUrl = extractFirstUrl(input) || input;
  const resolvedUrl = await resolveDouyinShortLinkViaRedirect(sourceUrl).catch(() => "") || normalizeDouyinContentLink(sourceUrl);
  const item = extractDouyinItem(resolvedUrl);
  if (!item?.id) {
    return {
      id: "",
      link: resolvedUrl || sourceUrl,
      title: "",
      tags: extractDouyinTagsFromSources({ shareText: input }),
      published_at: "",
      account: "",
      source: "douyin_share_unresolved",
    };
  }

  const cachePayload = await readCachedDouyinDetail(root, item.id);
  if (cachePayload) {
    return withAccountFromConfig(cachePayload, await readDouyinAccounts(root));
  }

  const outputPayload = await readOutputDouyinDetail(root, item.id);
  if (outputPayload) {
    return withAccountFromConfig(outputPayload, await readDouyinAccounts(root));
  }

  const shareTitle = cleanResolvedTitle(extractDouyinTitle({ shareText: input }));
  const scraped = await scrapeDouyinDetail(resolvedUrl, item.id, { shareTitle }).catch(() => null);
  if (!scraped) {
    return {
      id: item.id,
      link: normalizeDouyinContentLink(resolvedUrl),
      title: shareTitle,
      tags: extractDouyinTagsFromSources({ shareText: input }),
      published_at: "",
      account: "",
      source: "douyin_share_redirect_only",
    };
  }
  return withAccountFromConfig(scraped, await readDouyinAccounts(root));
}

async function readCachedDouyinDetail(root, itemId) {
  const cachePath = path.join(root, ".runtime", "detail-cache", "douyin", `${itemId}.json`);
  const parsed = await readJson(cachePath);
  if (!parsed) return null;
  return {
    id: itemId,
    link: normalizeDouyinContentLink(parsed.itemUrl || itemId),
    title: String(parsed.title || "").trim(),
    tags: String(parsed.tags || "").trim(),
    published_at: String(parsed.publishedAt || "").trim(),
    account: String(parsed.accountName || parsed.authorName || "").trim(),
    authorProfileUrl: String(parsed.authorProfileUrl || "").trim(),
    contentType: String(parsed.contentType || "").trim(),
    source: "harvester_detail_cache",
    cache_hit: true,
  };
}

async function readOutputDouyinDetail(root, itemId) {
  const outputDir = path.join(root, "output");
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.includes("douyin") || !entry.name.endsWith(".json")) continue;
    const parsed = await readJson(path.join(outputDir, entry.name));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const found = items.find((item) => extractDouyinItem(item.itemUrl || item.link || item.content_url || "")?.id === itemId);
    if (!found) continue;
    return {
      id: itemId,
      link: normalizeDouyinContentLink(found.itemUrl || found.link || itemId),
      title: String(found.title || "").trim(),
      tags: String(found.tags || "").trim(),
      published_at: String(found.publishedAt || found.published_at || "").trim(),
      account: String(found.accountName || found.account || "").trim(),
      contentType: String(found.contentType || "").trim(),
      source: "harvester_output",
      cache_hit: true,
    };
  }
  return null;
}

async function scrapeDouyinDetail(itemUrl, itemId, { shareTitle = "" } = {}) {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    ...chromiumLaunchOptions(),
    headless: resolveCrawlerHeadless(),
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const apiPromise = waitForDouyinApiDetail(page, itemId);
    await page.goto(itemUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const apiDetail = await apiPromise;
    const pageDetail = await readPageDetail(page);
    const publishedAt = formatDateValue(apiDetail?.publishedAt);
    return {
      id: itemId,
      link: normalizeDouyinContentLink(page.url() || itemUrl),
      title: cleanResolvedTitle(apiDetail?.title) || pageDetail.title || shareTitle,
      tags: apiDetail?.tags || pageDetail.tags || "",
      published_at: publishedAt,
      account: apiDetail?.authorName || pageDetail.account || "",
      authorProfileUrl: apiDetail?.authorProfileUrl || pageDetail.authorProfileUrl || "",
      source: "harvester_detail_page",
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function waitForDouyinApiDetail(page, itemId) {
  return page.waitForResponse(async (response) => {
    try {
      const url = new URL(response.url());
      if (response.status() !== 200) return false;
      if (url.pathname.includes("/aweme/v1/web/aweme/detail/")) {
        return url.searchParams.get("aweme_id") === itemId;
      }
      if (url.pathname.includes("/aweme/v1/web/aweme/post/")) {
        const json = await response.json();
        return Array.isArray(json?.aweme_list)
          && json.aweme_list.some((item) => String(item?.aweme_id || "") === itemId);
      }
      return false;
    } catch {
      return false;
    }
  }, { timeout: 15_000 })
    .then((response) => response.json())
    .then((json) => extractDouyinApiDetail(json, { itemId }))
    .catch(() => null);
}

async function readPageDetail(page) {
  const payload = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const title = document.querySelector('meta[property="og:title"]')?.content
      || document.querySelector("title")?.textContent
      || "";
    const author = document.querySelector('meta[name="author"]')?.content || "";
    const links = [...document.querySelectorAll("a[href]")].map((anchor) => anchor.href || "");
    return { text, title, author, links };
  }).catch(() => ({ text: "", title: "", author: "", links: [] }));
  const title = extractDouyinTitle({ itemText: payload.text, titleText: payload.title });
  const tags = extractDouyinTagsFromSources({ itemText: payload.text, titleText: payload.title });
  const authorProfileUrl = (payload.links || []).find((link) => /douyin\.com\/user\//i.test(link)) || "";
  return {
    title: cleanResolvedTitle(title),
    tags,
    account: String(payload.author || "").trim(),
    authorProfileUrl,
  };
}

async function readDouyinAccounts(root) {
  const all = await readAllPlatformAccounts({ root }).catch(() => ({}));
  return Array.isArray(all.douyin) ? all.douyin : [];
}

function withAccountFromConfig(payload, accounts) {
  const normalized = payload.id
    ? { ...payload, link: normalizeDouyinContentLink(payload.id) }
    : payload;
  if (normalized.account || !normalized.authorProfileUrl) return normalized;
  const matched = accounts.find((account) => sameProfile(account.url, normalized.authorProfileUrl));
  return matched ? { ...normalized, account: matched.name } : normalized;
}

function cleanResolvedTitle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^(开启|关闭)?读屏|无障碍|分享|复制链接|登录|扫码登录|抖音$/u.test(text)) return "";
  if (text.length <= 4 && /读屏|按钮|标签/u.test(text)) return "";
  return text.replace(/\s+-\s*抖音$/u, "").trim();
}

function formatDateValue(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "").slice(0, 10);
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijing.toISOString().slice(0, 10);
}

function sameProfile(left, right) {
  const leftId = String(left || "").match(/\/user\/([^/?#]+)/)?.[1] || "";
  const rightId = String(right || "").match(/\/user\/([^/?#]+)/)?.[1] || "";
  return Boolean(leftId && rightId && leftId === rightId);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--input") {
      options.input = args[++index] || "";
    } else if (arg.startsWith("--input=")) {
      options.input = arg.slice("--input=".length);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === new URL(path.resolve(process.argv[1]), "file:").href) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
