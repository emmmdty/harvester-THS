import { randomBytes, timingSafeEqual } from "node:crypto";

export const PANEL_SESSION_COOKIE = "harvester_panel_session";
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function assertPanelPasswordConfig({ host, panelPassword }) {
  void host;
  void panelPassword;
}

export function isSharedHost(host) {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "0.0.0.0" || value === "::" || value === "::0";
}

export function createPanelAuth({
  panelPassword = process.env.PANEL_PASSWORD || "",
  cookieName = PANEL_SESSION_COOKIE,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  now = () => Date.now()
} = {}) {
  const password = String(panelPassword || "");
  const sessions = new Map();

  function isEnabled() {
    return password.trim().length > 0;
  }

  function login(inputPassword) {
    if (!isEnabled()) return { ok: true, status: 200, cookie: "" };
    if (!constantTimeEqual(String(inputPassword || ""), password)) {
      return { ok: false, status: 401, error: "口令错误。" };
    }

    const token = randomBytes(32).toString("base64url");
    sessions.set(token, now() + sessionTtlMs);
    return {
      ok: true,
      status: 200,
      token,
      cookie: buildSessionCookie(cookieName, token)
    };
  }

  function authenticateRequest(req) {
    if (!isEnabled()) return { ok: true, status: 200 };
    const token = parseCookies(req?.headers?.cookie || "")[cookieName] || "";
    if (!token) return authDenied();

    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt <= now()) {
      sessions.delete(token);
      return authDenied();
    }

    return { ok: true, status: 200, token };
  }

  function logout(req) {
    const token = parseCookies(req?.headers?.cookie || "")[cookieName] || "";
    if (token) sessions.delete(token);
    return {
      ok: true,
      status: 200,
      cookie: clearSessionCookie(cookieName)
    };
  }

  return {
    isEnabled,
    login,
    logout,
    authenticateRequest
  };
}

export function isProtectedPanelPath(pathname) {
  const path = String(pathname || "");
  if (path === "/api/auth/status" || path === "/api/auth/login" || path === "/api/auth/logout") {
    return false;
  }
  return path.startsWith("/api/") || path === "/api/events" || path.startsWith("/output/");
}

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

export function parseCookies(cookieHeader) {
  return Object.fromEntries(String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [part, ""];
      return [
        decodeURIComponent(part.slice(0, index).trim()),
        decodeURIComponent(part.slice(index + 1).trim())
      ];
    }));
}

function authDenied() {
  return { ok: false, status: 401, error: "请先登录采集面板。" };
}

function buildSessionCookie(cookieName, token) {
  return [
    `${encodeURIComponent(cookieName)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict"
  ].join("; ");
}

function clearSessionCookie(cookieName) {
  return [
    `${encodeURIComponent(cookieName)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0"
  ].join("; ");
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
