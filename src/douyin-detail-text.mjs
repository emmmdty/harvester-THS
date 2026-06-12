import { dateStringToDate, parsePublishedDateText } from "./date-utils.mjs";

const TAG_PATTERN = /#[\p{Script=Han}\p{Letter}\p{Number}_-]+/gu;
const SPACED_TAG_PATTERN = /#\s+([\p{Script=Han}\p{Letter}\p{Number}_-]+)/gu;
const URL_PATTERN = /https?:\/\/\S+/giu;
const INCOMPLETE_TAG_NAMES = new Set(["-", "_", "同", "同花", "同顺", "玩", "玩转", "投", "理"]);
const RECOVERABLE_TAG_NAMES = new Map([
  ["同花顺A", "同花顺APP"],
  ["同花顺AP", "同花顺APP"],
  ["玩转同", "玩转同花顺"],
  ["玩转同花", "玩转同花顺"],
  ["同花顺投", "同花顺投资"],
  ["同花顺股民话", "同花顺股民话题"],
  ["同花顺钱", "同花顺钱包"],
  ["同顺图", "同顺图解"]
]);

export function extractDouyinTags(text) {
  return formatTagNames(rawTagNamesFromText(text));
}

export function extractDouyinTagsFromSources({ itemText = "", titleText = "", shareText = "" } = {}) {
  return extractDouyinTagDetailFromSources({ itemText, titleText, shareText }).tags;
}

export function extractDouyinTagDetailFromSources({ itemText = "", titleText = "", shareText = "" } = {}) {
  return mergeDouyinTagCandidates([
    tagCandidateFromText(shareText, { priority: 20 }),
    tagCandidateFromText(itemText, { priority: 10 }),
    tagCandidateFromText(titleText, { priority: 5 })
  ]);
}

export function mergeDouyinTagCandidates(candidates = []) {
  const normalizedCandidates = candidates
    .map((candidate = {}) => {
      const tags = extractDouyinTags(candidate.tags || candidate.text || "");
      return {
        tags,
        priority: Number(candidate.priority || 0),
        fallback: Boolean(candidate.fallback),
        lowConfidence: Boolean(candidate.lowConfidence) || isLowConfidenceDouyinTags(candidate.tags || candidate.text || "")
      };
    })
    .filter((candidate) => candidate.tags);

  const primaryCandidates = normalizedCandidates.filter((candidate) => !candidate.fallback);
  const selected = (primaryCandidates.length ? primaryCandidates : normalizedCandidates)
    .sort((a, b) => b.priority - a.priority);
  const tags = mergeFormattedTags(selected.map((candidate) => candidate.tags));

  return {
    tags,
    lowConfidence: !tags || selected.some((candidate) => candidate.lowConfidence)
  };
}

export function isLowConfidenceDouyinTags(text) {
  const rawNames = rawTagNamesFromText(text);
  if (!rawNames.length) return true;
  const validNames = rawNames.filter((name) => normalizeTagName(name));
  return validNames.length !== rawNames.length
    || validNames.length === 0
    || rawNames.some((name) => {
      const normalized = normalizeRawTagName(name);
      return Boolean(normalized && normalizeTagName(name) && normalizeTagName(name) !== normalized);
    })
    || rawNames.some((name) => isRecoverableTruncatedTagName(name));
}

export function extractDouyinApiDetail(rawDetail, { itemId = "" } = {}) {
  const detail = selectDouyinAwemeDetail(rawDetail, { itemId });
  const title = extractDouyinTitle({ itemText: detail.desc || detail.caption || "" });
  const tagDetail = extractTagsFromAwemeDetail(detail);
  const authorSecUid = String(detail.author?.sec_uid || "").trim();

  return {
    title,
    tags: tagDetail.tags,
    tagsFallback: tagDetail.fallback,
    tagsLowConfidence: tagDetail.lowConfidence,
    publishedAt: parseAwemeCreateTime(detail.create_time),
    authorProfileUrl: authorSecUid ? `https://www.douyin.com/user/${authorSecUid}` : "",
    authorName: String(detail.author?.nickname || "").trim()
  };
}

function selectDouyinAwemeDetail(rawDetail, { itemId = "" } = {}) {
  if (!rawDetail || typeof rawDetail !== "object") return {};
  if (rawDetail.aweme_detail) return rawDetail.aweme_detail;
  const list = Array.isArray(rawDetail.aweme_list) ? rawDetail.aweme_list : [];
  if (list.length) {
    const wanted = String(itemId || "").trim();
    if (wanted) return list.find((item) => String(item?.aweme_id || "") === wanted) || {};
    return list[0] || {};
  }
  return rawDetail;
}

export function extractDouyinPublishedAtFromText(text, referenceDateString) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length > 100) continue;
    if (!looksLikeDouyinPublishedDateLine(line)) continue;
    const dateString = parsePublishedDateText(line, referenceDateString);
    if (dateString) return dateStringToDate(dateString);
  }

  if (looksLikeDouyinPublishedDateLine(normalized)) {
    const dateString = parsePublishedDateText(normalized, referenceDateString);
    if (dateString) return dateStringToDate(dateString);
  }

  return null;
}

export function extractDouyinTitle({ itemText = "", titleText = "", shareText = "" } = {}) {
  for (const source of [itemText, shareText, titleText]) {
    const title = extractTitleFromSource(source);
    if (title) return title;
  }
  return "";
}

export function extractDouyinTitleFromShareText(value) {
  return removeShareCodePrefix(cleanTitleLine(value));
}

function extractTitleFromSource(source) {
  const lines = normalizeText(source)
    .split(/\n+/)
    .map((line) => cleanTitleLine(line))
    .filter(Boolean);

  for (const line of lines) {
    if (isMetadataLine(line)) continue;
    const title = removeShareCodePrefix(line);
    if (title) return title;
  }

  return "";
}

function cleanTitleLine(line) {
  return normalizeText(line)
    .replace(/复制此链接.*$/u, "")
    .replace(/打开Dou音搜索.*$/iu, "")
    .replace(/打开抖音搜索.*$/u, "")
    .replace(/抖音，记录美好生活。?$/u, "")
    .replace(/-\s*抖音$/u, "")
    .replace(URL_PATTERN, "")
    .replace(SPACED_TAG_PATTERN, "#$1")
    .replace(TAG_PATTERN, "")
    .replace(/发布时间[:：]?.*$/u, "")
    .replace(/发布于[:：]?.*$/u, "")
    .replace(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b.*$/u, "")
    .replace(/\d{4}年\d{1,2}月\d{1,2}日.*$/u, "")
    .replace(/[ \t]+/g, " ")
    .replace(/^[\s:：,，.。;；!！?？/\\|_-]+|[\s:：,，;；/\\|_-]+$/g, "")
    .trim();
}

function removeShareCodePrefix(line) {
  return stripSharePrefixTokens(line)
    .replace(/^[\d.]+\s+[A-Za-z]@[A-Za-z0-9._-]+\s+\d{2}\/\d{2}\s+\S+\s+\S+\s+/u, "")
    .replace(/^[A-Za-z0-9._-]+\s+[A-Za-z]@[A-Za-z0-9._-]+\s+\d{2}\/\d{2}\s+\S+\s+\S+\s+/u, "")
    .replace(/^[\s:：,，.。;；!！?？/\\|_-]+|[\s:：,，;；/\\|_-]+$/g, "")
    .trim();
}

function stripSharePrefixTokens(line) {
  const tokens = String(line || "").split(/\s+/u);
  const firstContentIndex = tokens.findIndex((token) => /[\p{Script=Han}]/u.test(token));
  if (firstContentIndex <= 0) return String(line || "");

  const prefixTokens = tokens.slice(0, firstContentIndex);
  if (prefixTokens.every(isDouyinSharePrefixToken)) {
    let titleStartIndex = firstContentIndex;
    while (titleStartIndex > 0 && isNumericTitlePrefixToken(tokens[titleStartIndex - 1])) {
      titleStartIndex -= 1;
    }
    return tokens.slice(titleStartIndex).join(" ");
  }
  return String(line || "");
}

function isNumericTitlePrefixToken(token) {
  return /^\d+(?:\.\d+)?[%％]?$/u.test(String(token || ""));
}

function isDouyinSharePrefixToken(token) {
  return /^[\d.]+$/u.test(token)
    || /^[A-Za-z]@[A-Za-z0-9._-]+$/u.test(token)
    || /^[A-Za-z0-9._-]+:\/$/u.test(token)
    || /^:?\d+(?:am|pm)$/iu.test(token)
    || /^\d{1,2}\/\d{1,2}$/u.test(token)
    || /^[A-Za-z0-9._-]+$/u.test(token);
}

function isMetadataLine(line) {
  if (!line) return true;
  if (/^(发布时间|发布于|点赞|评论|收藏|分享)\b/u.test(line)) return true;
  if (/^(首页|推荐|关注|朋友|我的|登录|扫码登录)$/u.test(line)) return true;
  if (/^(刚刚|\d+\s*分钟前|\d+\s*小时前|昨天|今天)$/u.test(line)) return true;
  if (/^\d{4}[./-]\d{1,2}[./-]\d{1,2}/u.test(line)) return true;
  if (/^\d{4}年\d{1,2}月\d{1,2}日/u.test(line)) return true;
  return false;
}

function extractTagsFromAwemeDetail(detail) {
  const explicitTags = [
    ...extractNames(detail.text_extra, ["hashtag_name", "hashtagName", "cha_name", "tag_name"]),
    ...extractNames(detail.cha_list, ["cha_name", "hashtag_name", "tag_name"]),
    ...extractNames(detail.challenge_list, ["cha_name", "hashtag_name", "tag_name"])
  ];
  const descText = [detail.desc, detail.caption].filter(Boolean).join("\n");

  const categoryTags = extractNames(detail.video_tag, ["tag_name"]);
  return mergeDouyinTagCandidates([
    tagCandidateFromNames(explicitTags, { priority: 30 }),
    tagCandidateFromText(descText, { priority: 10 }),
    tagCandidateFromNames(categoryTags, { priority: 0, fallback: true })
  ]);
}

function extractNames(items, keys) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      for (const key of keys) {
        const value = String(item[key] || "").trim();
        if (value) return value;
      }
      return "";
    })
    .filter(Boolean);
}

function formatTagNames(names) {
  const seen = new Set();
  const tags = [];
  for (const name of names) {
    const normalized = normalizeTagName(name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(`#${normalized}`);
  }
  return tags.join(" ");
}

function tagCandidateFromText(text, { priority = 0, fallback = false } = {}) {
  return {
    tags: extractDouyinTags(text),
    priority,
    fallback,
    lowConfidence: hasRawTags(text) && isLowConfidenceDouyinTags(text)
  };
}

function tagCandidateFromNames(names, { priority = 0, fallback = false } = {}) {
  const rawNames = Array.isArray(names) ? names : [];
  return {
    tags: formatTagNames(rawNames),
    priority,
    fallback,
    lowConfidence: rawNames.length > 0 && rawNames.some((name) => !normalizeTagName(name))
  };
}

function mergeFormattedTags(tagGroups) {
  const names = [];
  for (const group of tagGroups) {
    names.push(...rawTagNamesFromText(group));
  }
  return formatTagNames(names);
}

function rawTagNamesFromText(text) {
  const normalized = normalizeText(text).replace(SPACED_TAG_PATTERN, "#$1");
  const matches = normalized.match(TAG_PATTERN) || [];
  return matches.map((tag) => tag.replace(/^#+/u, ""));
}

function hasRawTags(text) {
  return rawTagNamesFromText(text).length > 0;
}

function normalizeTagName(name) {
  const normalized = normalizeRawTagName(name);
  if (!normalized) return "";
  if (RECOVERABLE_TAG_NAMES.has(normalized)) return RECOVERABLE_TAG_NAMES.get(normalized);
  if (INCOMPLETE_TAG_NAMES.has(normalized)) return "";
  if (/^[-_]+$/u.test(normalized)) return "";
  return normalized;
}

function isRecoverableTruncatedTagName(name) {
  const normalized = normalizeRawTagName(name);
  return RECOVERABLE_TAG_NAMES.has(normalized);
}

function normalizeRawTagName(name) {
  return String(name || "")
    .replace(/^#+/u, "")
    .replace(/\s+/g, "")
    .trim();
}

function parseAwemeCreateTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const millis = timestamp > 1e12 ? timestamp : timestamp * 1000;
  return new Date(millis);
}

function looksLikeDouyinPublishedDateLine(line) {
  if (/^(?:发布时间|发布于)[:：]?\s*/u.test(line)) return true;
  return /^(?:刚刚|\d+\s*分钟前|\d+\s*小时前|昨天|今天)(?:\s+\d{1,2}:\d{2})?$/u.test(line)
    || /^20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:?\d{0,2})?$/u.test(line)
    || /^20\d{2}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:?\d{0,2})?$/u.test(line);
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/\r/g, "\n")
    .trim();
}
