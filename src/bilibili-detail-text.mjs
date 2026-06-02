const BILIBILI_NOISE_TAGS = new Set([
  "b站",
  "bilibili",
  "哔哩哔哩",
  "视频",
  "弹幕"
]);

export function extractBilibiliTitle({ videoData = {}, documentTitle = "" } = {}) {
  for (const source of [
    videoData?.title,
    videoData?.titleText,
    videoData?.name,
    documentTitle
  ]) {
    const title = cleanTitle(source);
    if (title) return title;
  }
  return "";
}

export function extractBilibiliTags({ videoData = {}, initialTags = [], metaKeywords = "", title = "" } = {}) {
  return formatTagNames([
    ...extractTagNames(videoData?.tag),
    ...extractTagNames(videoData?.tags),
    ...extractTagNames(videoData?.keywords),
    ...extractTagNames(initialTags),
    ...splitKeywordTags(metaKeywords)
  ], { title });
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/[_-]\s*哔哩哔哩\s*[_-]?\s*bilibili.*$/iu, "")
    .replace(/[_-]\s*bilibili.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagNames(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractTagNames(item));
  if (typeof value === "object") {
    for (const key of ["tag_name", "tagName", "name", "title", "tag"]) {
      const text = String(value[key] || "").trim();
      if (text) return [text];
    }
    return [];
  }
  return splitKeywordTags(value);
}

function splitKeywordTags(value) {
  return String(value || "")
    .split(/[,\n，、|/]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatTagNames(names, { title = "" } = {}) {
  const seen = new Set();
  const tags = [];
  const normalizedTitle = normalizeTagText(title);
  for (const name of names) {
    const normalized = normalizeTagText(name);
    if (!normalized || normalized.length > 40) continue;
    if (normalizedTitle && normalized === normalizedTitle) continue;
    if (/^发现《/u.test(normalized)) continue;
    if (normalizedTitle && normalized.length >= 5 && normalizedTitle.includes(normalized)) continue;
    if (BILIBILI_NOISE_TAGS.has(normalized.toLowerCase())) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(`#${normalized}`);
  }
  return tags.join(" ");
}

function normalizeTagText(value) {
  return String(value || "")
    .replace(/^#+/u, "")
    .replace(/\s+/g, "")
    .trim();
}
