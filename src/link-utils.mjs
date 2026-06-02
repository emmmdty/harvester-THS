export function extractXhsNoteId(value) {
  const text = extractLinkValue(value);
  const match = text.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([^/?#\s]+)/)
    || text.match(/\/(?:explore|discovery\/item)\/([^/?#\s]+)/);
  return match?.[1] || "";
}

export function extractBilibiliBv(value) {
  const match = extractLinkValue(value).match(/\b(BV[0-9A-Za-z]{8,})\b/);
  return match?.[1] || "";
}

export function extractDouyinItem(value) {
  const text = extractLinkValue(value);
  const match = text.match(/douyin\.com\/(video|note)\/(\d+)/u)
    || text.match(/\/(video|note)\/(\d+)/u);
  return match ? { type: match[1], id: match[2] } : null;
}

export function extractDouyinItemId(value) {
  return extractDouyinItem(value)?.id || "";
}

export function normalizeDouyinContentLink(value) {
  const item = extractDouyinItem(value);
  if (item) return `https://www.douyin.com/${item.type}/${item.id}`;

  const text = extractLinkValue(value).trim();
  if (/^\d{8,}$/u.test(text)) return `https://www.douyin.com/video/${text}`;
  return text;
}

export function isDouyinShortLink(value) {
  return /^https?:\/\/(?:v\.douyin\.com|www\.iesdouyin\.com)\//iu.test(extractLinkValue(value).trim());
}

export async function resolveDouyinShortLinkViaRedirect(link, { fetchImpl = globalThis.fetch } = {}) {
  const text = extractLinkValue(link).trim();
  if (!text) return "";
  if (extractDouyinItem(text)) return normalizeDouyinContentLink(text);
  if (!isDouyinShortLink(text)) return "";
  if (typeof fetchImpl !== "function") return "";

  let current = text;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    }).catch(() => null);
    if (!response) return "";

    const location = response.headers?.get?.("location");
    if (location) {
      current = new URL(location, current).toString();
      const normalized = normalizeDouyinContentLink(current);
      if (extractDouyinItem(normalized)) return normalized;
      continue;
    }

    const normalized = normalizeDouyinContentLink(response.url || current);
    return extractDouyinItem(normalized) ? normalized : "";
  }
  return "";
}

export function normalizeBilibiliVideoUrl(value) {
  const bvid = extractBilibiliBv(value);
  return bvid ? `https://www.bilibili.com/video/${bvid}/` : "";
}

export function extractFirstUrl(value) {
  const match = extractLinkValue(value).match(/https?:\/\/[^\s]+/);
  return match?.[0]?.replace(/[，。,.;；]+$/, "") || "";
}

export function extractLinkValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => extractLinkValue(entry)).find(Boolean) || "";
  }
  if (value && typeof value === "object") {
    return String(value.link || value.url || value.text || "");
  }
  return String(value || "");
}

export function buildXhsExploreUrl(noteId, token = "") {
  const id = String(noteId || "").trim();
  if (!id) return "";
  const params = new URLSearchParams();
  params.set("source", "webshare");
  params.set("xhsshare", "pc_web");
  if (token) params.set("xsec_token", String(token));
  params.set("xsec_source", "pc_share");
  return `https://www.xiaohongshu.com/discovery/item/${id}?${params.toString()}`;
}

export function normalizeXhsContentLink(value) {
  const link = extractLinkValue(value).trim();
  if (!link) return "";
  if (/^https?:\/\//i.test(link) && !/xiaohongshu\.com\/(?:explore|discovery\/item)\//.test(link)) return link;
  if (!/^https?:\/\//i.test(link) && !link.startsWith("/") && !/^(?:explore|discovery\/item)\//.test(link)) return link;

  try {
    const url = new URL(link, "https://www.xiaohongshu.com");
    const noteId = extractXhsNoteId(url.toString());
    if (noteId && (url.pathname.includes("/explore/") || url.pathname.includes("/discovery/item/"))) {
      return buildXhsExploreUrl(noteId, url.searchParams.get("xsec_token") || "");
    }
    return url.toString();
  } catch {
    return link;
  }
}

export function canonicalizeContentLink(platformId, value) {
  const link = extractLinkValue(value).trim();
  if (!link) return "";

  if (platformId === "xhs") {
    return normalizeXhsContentLink(link);
  }

  if (platformId === "douyin") {
    return normalizeDouyinContentLink(link);
  }

  if (platformId === "bilibili") {
    return normalizeBilibiliVideoUrl(link) || link;
  }

  return link;
}
