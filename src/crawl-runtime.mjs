import fs from "node:fs/promises";
import path from "node:path";
import { formatDate as formatDateInTimeZone } from "./date-utils.mjs";

const VALID_MODES = new Set(["conservative", "legacy"]);
const HEAVY_RESOURCE_TYPES = new Set(["image", "media", "font"]);

export function normalizeCrawlMode(value = "") {
  const mode = String(value || "conservative").trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : "conservative";
}

export function resolveCrawlMode(options = {}, env = process.env) {
  return normalizeCrawlMode(options.mode || env.CRAWL_MODE || "conservative");
}

export function isConservativeMode(mode) {
  return normalizeCrawlMode(mode) === "conservative";
}

export function isTruthyFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function isFalseyFlag(value) {
  return /^(0|false|no|off)$/i.test(String(value || "").trim());
}

export function shouldUseDetailCache({ mode, env = process.env } = {}) {
  if (!isConservativeMode(mode)) return false;
  if (env.CRAWL_DETAIL_CACHE !== undefined) return !isFalseyFlag(env.CRAWL_DETAIL_CACHE);
  return true;
}

export function shouldRefreshDetailCache(env = process.env) {
  return isTruthyFlag(env.CRAWL_REFRESH_CACHE);
}

export function shouldCopyDouyinShare({ mode, env = process.env } = {}) {
  if (env.DOUYIN_COPY_SHARE !== undefined) return isTruthyFlag(env.DOUYIN_COPY_SHARE);
  return normalizeCrawlMode(mode) === "legacy";
}

export function shouldBlockResource({ mode, resourceType }) {
  return isConservativeMode(mode) && HEAVY_RESOURCE_TYPES.has(String(resourceType || ""));
}

export async function withTimeoutFallback(fn, { timeoutMs = 0, fallback = null, onTimeout = null } = {}) {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  if (timeout <= 0) return fn();

  let timeoutId = null;
  let didTimeout = false;
  const operation = Promise.resolve().then(fn);
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      if (typeof onTimeout === "function") onTimeout();
      resolve(typeof fallback === "function" ? fallback() : fallback);
    }, timeout);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (!didTimeout && timeoutId) clearTimeout(timeoutId);
  }
}

export async function installConservativeResourceBlocker(context, { mode, label = "轻量页面模式" } = {}) {
  if (!isConservativeMode(mode)) {
    return {
      enabled: false,
      async disableTemporarily(fn, options = {}) {
        return withTimeoutFallback(fn, options);
      },
      async close() {}
    };
  }

  const pattern = "**/*";
  const handler = async (route) => {
    const request = route.request();
    if (shouldBlockResource({ mode, resourceType: request.resourceType() })) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  };
  let active = false;

  async function enable() {
    if (active) return;
    await context.route(pattern, handler);
    active = true;
  }

  async function disable() {
    if (!active) return;
    await context.unroute(pattern, handler).catch(() => {});
    active = false;
  }

  await enable();
  console.log(`${label}：已拦截图片、视频和字体资源。`);

  return {
    enabled: true,
    async disableTemporarily(fn, options = {}) {
      await disable();
      try {
        return await withTimeoutFallback(fn, options);
      } finally {
        await enable();
      }
    },
    async close() {
      await disable();
    }
  };
}

export function shouldInspectDetailByPublishedAt({ publishedAt, since, until }) {
  const reason = comparePublishedAtToDateRange({ publishedAt, since, until });
  if (reason === "unknown-date") return { inspect: true, reason };
  if (reason === "before-since" || reason === "after-until") return { inspect: false, reason };
  return { inspect: true, reason: "in-range" };
}

export function comparePublishedAtToDateRange({ publishedAt, since, until }) {
  const published = dateKey(publishedAt);
  if (!published) return "unknown-date";

  const sinceKey = dateKey(since);
  const untilKey = dateKey(until);
  if (sinceKey && published < sinceKey) return "before-since";
  if (untilKey && published > untilKey) return "after-until";
  return "in-range";
}

export function isPublishedAtInDateRange({ publishedAt, since, until }) {
  return comparePublishedAtToDateRange({ publishedAt, since, until }) === "in-range";
}

export function dateKey(value) {
  if (!value) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return formatDateInTimeZone(value);
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

export class DetailCache {
  constructor({ root = process.cwd(), platformId, enabled = true, refresh = false } = {}) {
    this.root = root;
    this.platformId = platformId;
    this.enabled = Boolean(enabled && platformId);
    this.refresh = Boolean(refresh);
    this.dir = path.join(root, ".runtime", "detail-cache", String(platformId || "unknown"));
  }

  async get(id) {
    if (!this.enabled || this.refresh) return null;
    const cachePath = this.pathFor(id);
    try {
      return JSON.parse(await fs.readFile(cachePath, "utf8"));
    } catch {
      return null;
    }
  }

  async set(id, value) {
    if (!this.enabled || !id || !value) return;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.pathFor(id), JSON.stringify(value, null, 2), "utf8");
  }

  pathFor(id) {
    return path.join(this.dir, `${sanitizeCacheKey(id)}.json`);
  }
}

export function createCrawlAudit(platform) {
  const accounts = [];
  const byName = new Map();

  return {
    account(accountName) {
      const name = String(accountName || "").trim() || "未知账号";
      if (byName.has(name)) return byName.get(name);
      const stats = createAccountAudit(name);
      byName.set(name, stats);
      accounts.push(stats);
      return stats;
    },
    toJSON() {
      const accountSnapshots = accounts.map((account) => account.toJSON());
      return {
        platform,
        totals: {
          accounts: accountSnapshots.length,
          checked: sum(accountSnapshots, "checked"),
          hits: sum(accountSnapshots, "hits"),
          skippedBeforeSince: sum(accountSnapshots, "skippedBeforeSince"),
          skippedAfterUntil: sum(accountSnapshots, "skippedAfterUntil"),
          unknownDate: sum(accountSnapshots, "unknownDate"),
          cacheHits: sum(accountSnapshots, "cacheHits")
        },
        accounts: accountSnapshots
      };
    }
  };
}

function createAccountAudit(accountName) {
  const stats = {
    accountName,
    checked: 0,
    hits: 0,
    skippedBeforeSince: 0,
    skippedAfterUntil: 0,
    unknownDate: 0,
    cacheHits: 0,
    stopReason: ""
  };

  return {
    recordChecked() {
      stats.checked += 1;
    },
    recordHit() {
      stats.hits += 1;
    },
    recordSkipped(reason) {
      if (reason === "before-since") stats.skippedBeforeSince += 1;
      if (reason === "after-until") stats.skippedAfterUntil += 1;
    },
    recordUnknownDate() {
      stats.unknownDate += 1;
    },
    recordCacheHit() {
      stats.cacheHits += 1;
    },
    stop(reason) {
      stats.stopReason = reason;
    },
    toJSON() {
      return { ...stats };
    }
  };
}

export function logAuditSummary(audit) {
  const snapshot = audit.toJSON();
  console.log(
    `审计汇总：账号 ${snapshot.totals.accounts}，详情检查 ${snapshot.totals.checked}，命中 ${snapshot.totals.hits}，`
      + `早于范围跳过 ${snapshot.totals.skippedBeforeSince}，晚于范围跳过 ${snapshot.totals.skippedAfterUntil}，`
      + `未知时间 ${snapshot.totals.unknownDate}，缓存命中 ${snapshot.totals.cacheHits}`
  );
}

function sanitizeCacheKey(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 180);
}

function sum(items, field) {
  return items.reduce((total, item) => total + Number(item[field] || 0), 0);
}

function pad(value) {
  return String(value).padStart(2, "0");
}
