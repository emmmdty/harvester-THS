import { formatDate, parsePublishedDateText } from "./date-utils.mjs";

export const XHS_DETAIL_CACHE_VERSION = 2;

export function resolveXhsPublishedAt({ detailPublishedAt, statePublishedAt, detailBlocked = false }) {
  return resolveXhsPublishedAtEntry({ detailPublishedAt, statePublishedAt, detailBlocked }).publishedAt;
}

export function resolveXhsPublishedAtEntry({
  detailPublishedAt,
  detailPublishedAtSource = "",
  statePublishedAt,
  statePublishedAtSource = "",
  detailBlocked = false
}) {
  if (detailBlocked) {
    return {
      publishedAt: null,
      source: ""
    };
  }
  if (detailPublishedAt) {
    return {
      publishedAt: detailPublishedAt,
      source: detailPublishedAtSource || "detail"
    };
  }
  if (statePublishedAt) {
    return {
      publishedAt: statePublishedAt,
      source: statePublishedAtSource || "state"
    };
  }
  return {
    publishedAt: null,
    source: ""
  };
}

export function parseXhsDetailPublishedAt({
  dateTexts = [],
  bodyText = "",
  referenceDateString = formatDate(new Date())
} = {}) {
  const candidates = [];

  for (const text of arrayify(dateTexts)) {
    const line = normalizeLine(text);
    if (!line) continue;
    candidates.push(line);
    const publishedAt = parseXhsPublishedLine(line, referenceDateString, { allowBarePlatformDate: true });
    if (publishedAt) {
      return {
        publishedAt,
        source: "detail-date",
        candidates
      };
    }
  }

  const bodyLines = String(bodyText || "")
    .split(/\n+/)
    .map(normalizeLine)
    .filter(Boolean);

  for (const line of bodyLines) {
    if (line.length > 50) continue;
    if (!looksLikeXhsPublishedDateLine(line)) continue;
    candidates.push(line);
    const publishedAt = parseXhsPublishedLine(line, referenceDateString, { allowBarePlatformDate: true });
    if (publishedAt) {
      return {
        publishedAt,
        source: "detail-body",
        candidates
      };
    }
  }

  return {
    publishedAt: null,
    source: "",
    candidates
  };
}

export function resolveXhsStatePublishedAt(fields = {}, {
  referenceDateString = formatDate(new Date())
} = {}) {
  const candidates = [
    "publishedAt",
    "published_at",
    "publishAt",
    "publish_at",
    "publishTime",
    "publish_time",
    "publishedTime",
    "published_time",
    "createTime",
    "create_time",
    "createdTime",
    "created_time"
  ];

  for (const key of candidates) {
    const value = fields?.[key];
    const publishedAt = parseXhsStateTimeValue(value, referenceDateString);
    if (publishedAt) {
      return {
        publishedAt,
        source: `state:${key}`,
        rawValue: value
      };
    }
  }

  return {
    publishedAt: null,
    source: "",
    rawValue: fields?.lastUpdateTime ?? fields?.last_update_time ?? ""
  };
}

export function restoreXhsDetailFromCache(cached) {
  if (!cached || cached.cacheVersion !== XHS_DETAIL_CACHE_VERSION) return null;
  return {
    tags: cached.tags || "",
    publishedAt: cached.publishedAt ? parseDateOnly(cached.publishedAt) : null,
    publishedAtSource: cached.publishedAtSource || "",
    noteUrl: cached.noteUrl || ""
  };
}

export function serializeXhsDetailForCache(detail) {
  return {
    cacheVersion: XHS_DETAIL_CACHE_VERSION,
    tags: detail.tags || "",
    publishedAt: detail.publishedAt ? formatLocalDate(detail.publishedAt) : "",
    publishedAtSource: detail.publishedAtSource || "",
    noteUrl: detail.noteUrl || ""
  };
}

export function createXhsDetailRiskGuard({ stopAfter = 2 } = {}) {
  const limit = Math.max(1, Number(stopAfter) || 1);
  let consecutiveBlocked = 0;

  return {
    record(detail) {
      if (detail?.blocked) {
        consecutiveBlocked += 1;
      } else {
        consecutiveBlocked = 0;
      }

      return {
        consecutiveBlocked,
        shouldStop: consecutiveBlocked >= limit
      };
    }
  };
}

function parseXhsStateTimeValue(value, referenceDateString) {
  if (!value) return null;
  if (typeof value === "number") {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return cloneDate(new Date(milliseconds));
  }

  const text = normalizeLine(value);
  if (/^\d+$/.test(text)) return parseXhsStateTimeValue(Number(text), referenceDateString);
  return parseXhsPublishedLine(text, referenceDateString, { allowBarePlatformDate: true });
}

function parseXhsPublishedLine(line, referenceDateString, { allowBarePlatformDate = false } = {}) {
  const text = normalizeLine(line);
  if (!text || /编辑于/u.test(text)) return null;

  const hasPublishPrefix = /^(?:发布时间|发布于|发表于)[:：]?\s*/u.test(text);
  if (!hasPublishPrefix && !(allowBarePlatformDate && isBarePlatformDateLine(text))) {
    return null;
  }

  const dateString = parsePublishedDateText(text, referenceDateString);
  return dateString ? parseDateOnly(dateString) : null;
}

function looksLikeXhsPublishedDateLine(line) {
  if (!line || /编辑于/u.test(line)) return false;
  if (/^(?:发布时间|发布于|发表于)[:：]?\s*/u.test(line)) return true;
  return isBarePlatformDateLine(line);
}

function isBarePlatformDateLine(line) {
  return /^(?:刚刚|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d+\s*周前|昨天|今天)(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/u.test(line)
    || /^20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/u.test(line)
    || /^20\d{2}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/u.test(line)
    || /^\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/u.test(line)
    || /^\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?(?:\s+\S{2,8})?$/u.test(line);
}

function parseDateOnly(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return new Date(year, month - 1, day);
}

function cloneDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatLocalDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function normalizeLine(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function arrayify(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}
