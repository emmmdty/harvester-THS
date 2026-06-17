import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./browser-env.mjs";

const PROFILE_LOCK_FILES = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"]);

const LOGIN_PROBES = {
  xhs: {
    label: "小红书",
    url: "https://www.xiaohongshu.com/explore",
    cookieUrl: "https://www.xiaohongshu.com",
    authCookieNames: ["web_session", "id_token"],
    loginPattern: /登录后查看更多|扫码登录|验证码登录|手机号登录|登录小红书|请登录|登录后查看/,
    blockedPattern: /安全验证|安全限制|访问过于频繁|风控|滑块|系统繁忙|验证后继续|IP存在风险|存在风险|website-login\/(?:error|captcha)/
  },
  douyin: {
    label: "抖音",
    url: "https://www.douyin.com/user/MS4wLjABAAAArf6v6Z48Pma-bIrz00wVCu76ioePN0vKzHAM_w9DN8AOkLekEk13Ay8_L-74BBB8",
    cookieUrl: "https://www.douyin.com",
    authCookieNames: ["sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt"],
    loginPattern: /登录后查看更多|扫码登录|验证码登录|手机号登录|请登录|登录后查看|打开抖音扫码登录/,
    blockedPattern: /安全验证|访问过于频繁|风控|滑块|系统繁忙|验证后继续/
  },
  bilibili: {
    label: "B站",
    url: "https://space.bilibili.com/1622777305/video",
    cookieUrl: "https://www.bilibili.com",
    authCookieNames: ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"],
    loginPattern: /扫描二维码登录|登录后你可以|立即登录|请先登录|登录失效/,
    blockedPattern: /安全验证|访问过于频繁|风控|滑块|系统繁忙|出错啦|验证后继续/
  }
};

export async function checkPlatformLogin({
  platformId,
  profileDir,
  headless = resolveLoginCheckHeadless(),
  timeoutMs = Number(process.env.LOGIN_CHECK_TIMEOUT_MS || 30_000)
}) {
  const config = getLoginProbeConfig(platformId);
  const profileState = await inspectProfileDir(profileDir);
  if (!profileState.ok) {
    return {
      platformId,
      checkedAt: new Date().toISOString(),
      checkUrl: config.url,
      status: profileState.status,
      valid: false,
      message: profileState.message
    };
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      ...chromiumLaunchOptions(),
      headless,
      viewport: { width: 1365, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
    });

    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(Number(process.env.LOGIN_CHECK_SETTLE_MS || 2500));

    const text = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    const title = await page.title().catch(() => "");
    const currentUrl = page.url();
    const cookies = await context.cookies(config.cookieUrl).catch(() => []);
    const result = classifyLoginProbe(platformId, { text, title, url: currentUrl, cookies });
    const authCookieNames = cookies
      .map((cookie) => cookie.name)
      .filter((name) => config.authCookieNames.includes(name));

    return {
      platformId,
      checkedAt: new Date().toISOString(),
      checkUrl: config.url,
      currentUrl,
      title,
      authCookieNames,
      ...result
    };
  } catch (error) {
    return {
      platformId,
      checkedAt: new Date().toISOString(),
      checkUrl: config.url,
      status: "error",
      valid: false,
      message: `登录检测失败：${error.message || String(error)}`
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

export function classifyLoginProbe(platformId, probe = {}) {
  const config = getLoginProbeConfig(platformId);
  const text = [probe.title, probe.url, decodeText(probe.url), probe.text].filter(Boolean).join("\n");
  if (config.blockedPattern.test(text)) {
    return {
      status: "blocked",
      valid: false,
      message: "页面疑似触发风控或安全验证，当前登录态不可直接用于采集。"
    };
  }

  if (config.loginPattern.test(text)) {
    return {
      status: "invalid",
      valid: false,
      message: "登录已失效或未登录，页面出现登录提示。"
    };
  }

  if (hasAuthCookie(config, probe.cookies || [])) {
    return {
      status: "valid",
      valid: true,
      message: "登录有效，检测到关键登录 Cookie。"
    };
  }

  return {
    status: "unknown",
    valid: null,
    message: "页面未出现登录提示，但没有检测到关键登录 Cookie，无法确认登录有效。"
  };
}

function decodeText(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

export function getLoginProbeConfig(platformId) {
  const config = LOGIN_PROBES[platformId];
  if (!config) throw new Error(`不支持登录检测的平台：${platformId}`);
  return config;
}

export function summarizeLoginCheckResults(results) {
  const failedLabels = results
    .filter((result) => result.valid !== true)
    .map((result) => result.label || result.platformId || "未知平台");
  return {
    ok: failedLabels.length === 0,
    failedLabels,
    message: failedLabels.length === 0
      ? "三个平台登录状态均正常。"
      : `全渠道启动已中止：${failedLabels.join("、")}登录状态未通过。`
  };
}

async function inspectProfileDir(profileDir) {
  if (!profileDir || !existsSync(profileDir)) {
    return {
      ok: false,
      status: "missing_profile",
      message: "未找到本地登录目录，请先打开登录并扫码完成登录。"
    };
  }

  const entries = await fs.readdir(profileDir).catch(() => []);
  const meaningfulEntries = entries.filter((entry) => !PROFILE_LOCK_FILES.has(entry));
  if (meaningfulEntries.length === 0) {
    return {
      ok: false,
      status: "empty_profile",
      message: "本地登录目录为空，请先打开登录并扫码完成登录。"
    };
  }

  return { ok: true };
}

function hasAuthCookie(config, cookies) {
  return cookies.some((cookie) => config.authCookieNames.includes(cookie.name));
}

function resolveLoginCheckHeadless() {
  const value = process.env.LOGIN_CHECK_HEADLESS;
  if (value === undefined) return true;
  return /^(1|true|yes)$/i.test(value);
}
