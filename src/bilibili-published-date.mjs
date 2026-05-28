import { formatDate, parsePublishedDateText } from "./date-utils.mjs";

export function dateFromBilibiliEpoch(value) {
  const epoch = Number(value || 0);
  if (!epoch) return "";
  const milliseconds = epoch > 10_000_000_000 ? epoch : epoch * 1000;
  return formatDate(new Date(milliseconds));
}

export function resolveBilibiliPublishedAt({
  pubdate = 0,
  ctime = 0,
  created = 0,
  text = "",
  referenceDateString = formatDate(new Date())
} = {}) {
  return dateFromBilibiliEpoch(pubdate || ctime || created)
    || extractBilibiliPublishedAtFromText(text, referenceDateString);
}

export function extractBilibiliPublishedAtFromText(text, referenceDateString = formatDate(new Date())) {
  const normalized = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const lines = String(text || "")
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length > 100) continue;
    if (!looksLikeBilibiliPublishedDateLine(line)) continue;
    const dateString = parsePublishedDateText(line, referenceDateString);
    if (dateString) return dateString;
  }

  if (looksLikeBilibiliPublishedDateLine(normalized)) {
    return parsePublishedDateText(normalized, referenceDateString);
  }

  return "";
}

function looksLikeBilibiliPublishedDateLine(line) {
  if (/^(?:发布时间|发布于|投稿时间|投稿于)[:：]?\s*/u.test(line)) return true;
  return /^20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:?\d{0,2})?$/u.test(line)
    || /^20\d{2}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:?\d{0,2})?$/u.test(line);
}
