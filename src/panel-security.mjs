export function validatePostOrigin(req) {
  const method = String(req?.method || "").toUpperCase();
  if (method !== "POST") return { ok: true };

  const headers = req?.headers || {};
  const host = String(headers.host || "").toLowerCase();
  const origin = String(headers.origin || "").trim();
  const referer = String(headers.referer || headers.referrer || "").trim();
  const source = origin || referer;
  if (!source) return { ok: true };

  try {
    const sourceUrl = new URL(source);
    if (sourceUrl.host.toLowerCase() === host) return { ok: true };
  } catch {
    return { ok: false, status: 403, error: "跨站请求已被拒绝。" };
  }

  return { ok: false, status: 403, error: "跨站请求已被拒绝。" };
}

export function resolvePanelPlatform(value, platforms) {
  const platformId = String(value || "").trim();
  const platform = platforms?.[platformId];
  if (platform) return platform;
  const error = new Error(`不支持的平台：${platformId || "空"}`);
  error.status = 400;
  throw error;
}
