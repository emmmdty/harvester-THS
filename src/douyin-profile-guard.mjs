export function extractDouyinUserId(rawUrl = "") {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl, "https://www.douyin.com");
    const match = url.pathname.match(/^\/user\/([^/?#]+)/);
    const id = match?.[1] || "";
    return id === "self" ? "" : id;
  } catch {
    const match = String(rawUrl).match(/douyin\.com\/user\/([^/?#]+)/);
    const id = match?.[1] || "";
    return id === "self" ? "" : id;
  }
}

export function extractPrimaryDouyinAuthorProfileUrl(rawUrls = [], { preferredProfileUrl = "" } = {}) {
  const preferredId = extractDouyinUserId(preferredProfileUrl);
  let fallbackProfileUrl = "";

  for (const rawUrl of rawUrls || []) {
    const id = extractDouyinUserId(rawUrl);
    if (!id) continue;
    const url = new URL(rawUrl, "https://www.douyin.com");
    if (url.searchParams.has("author_id") || url.searchParams.has("group_id")) continue;
    const profileUrl = `https://www.douyin.com/user/${id}`;
    if (preferredId && id === preferredId) return profileUrl;
    if (!fallbackProfileUrl) fallbackProfileUrl = profileUrl;
  }

  return fallbackProfileUrl;
}

export function douyinProfileIdsMatch(expectedProfileUrl = "", actualProfileUrl = "") {
  const expectedId = extractDouyinUserId(expectedProfileUrl);
  const actualId = extractDouyinUserId(actualProfileUrl);
  return Boolean(expectedId && actualId && expectedId === actualId);
}
