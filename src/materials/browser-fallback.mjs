import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { chromiumLaunchOptions, resolveCrawlerHeadless } from "../browser-env.mjs";
import { getPlatformConfig } from "../platform-config.mjs";

const DEFAULT_BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PLATFORM_REFERERS = {
  douyin: "https://www.douyin.com/",
  xhs: "https://www.xiaohongshu.com/",
  bilibili: "https://www.bilibili.com/"
};

export async function captureBrowserVisualFallback({
  platformId = "",
  item = {},
  itemDir,
  root = process.cwd(),
  env = process.env,
  screenshotCount = 3,
  fetch = globalThis.fetch
} = {}) {
  const profileDir = path.join(root, getPlatformConfig(platformId).profileDirName);
  const context = await chromium.launchPersistentContext(profileDir, {
    ...chromiumLaunchOptions(),
    headless: resolveMaterialFallbackHeadless(env),
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai"
  });
  const page = await context.newPage();
  try {
    await page.goto(item.link, { waitUntil: "domcontentloaded", timeout: Number(env.MATERIAL_BROWSER_GOTO_TIMEOUT_MS || 45_000) });
    await page.waitForTimeout(Number(env.MATERIAL_BROWSER_SETTLE_MS || 1800));
    const bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    const pageUrl = page.url();
    const riskReason = detectBrowserFallbackRisk({ platformId, pageUrl, bodyText });
    if (riskReason) {
      return {
        pageUrl,
        bodyText,
        riskReason,
        imagePaths: [],
        screenshotPaths: [],
        downloadedImages: []
      };
    }

    const imageUrls = await collectVisibleImageUrls(page);
    const imagePaths = await downloadBrowserImageResources({
      platformId,
      urls: imageUrls,
      itemDir,
      fetch,
      referer: pageUrl,
      userAgent: DEFAULT_BROWSER_USER_AGENT,
      timeoutMs: Number(env.MATERIAL_BROWSER_IMAGE_TIMEOUT_MS || 15_000),
      maxImages: Number(env.MATERIAL_BROWSER_MAX_IMAGES || 8)
    });
    const screenshotPaths = isFallbackScreenshotDisabled(env)
      ? []
      : await capturePageScreenshots({
          page,
          itemDir,
          count: Math.max(1, Number(screenshotCount) || 1),
          prefix: "browser"
        });

    return {
      pageUrl,
      bodyText,
      riskReason: "",
      imagePaths: imagePaths.map((entry) => entry.path),
      screenshotPaths,
      downloadedImages: imagePaths
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export function classifyBrowserFallbackError(platformId = "", message = "") {
  const text = String(message || "");
  if (detectBrowserFallbackRisk({ platformId, pageUrl: text, bodyText: text })) return "页面风控/登录失效";
  if (/timeout|Timeout|超时/iu.test(text)) return `浏览器兜底失败：${text}`;
  return text || "浏览器兜底失败";
}

function resolveMaterialFallbackHeadless(env = process.env) {
  const explicit = env.MATERIAL_BROWSER_FALLBACK_HEADLESS ?? env.MATERIAL_FALLBACK_HEADLESS ?? env.PLAYWRIGHT_HEADLESS;
  if (explicit !== undefined) return /^(1|true|yes)$/iu.test(String(explicit));
  return resolveCrawlerHeadless(env);
}

function detectBrowserFallbackRisk({ platformId = "", pageUrl = "", bodyText = "" } = {}) {
  const text = `${pageUrl}\n${bodyText}`.slice(0, 20_000);
  if (platformId === "xhs") {
    if (/website-login\/(?:error|captcha)|\/404\?|IP存在风险|安全验证|验证码|滑块|环境异常|访问频繁|请稍后再试|当前笔记暂时无法浏览|页面无法访问|内容不存在|笔记不存在/iu.test(text)) {
      return "页面风控/登录失效";
    }
    if (/登录后可查看|请先登录|扫码登录|密码登录|手机号登录/iu.test(text)) {
      return "页面风控/登录失效";
    }
  }
  if (/安全验证|验证码|请先登录|登录后/iu.test(text)) return "页面风控/登录失效";
  return "";
}

async function collectVisibleImageUrls(page) {
  return page.evaluate(() => {
    const urls = new Set();
    const addUrl = (value) => {
      const text = String(value || "").trim();
      if (!text || text.startsWith("data:") || text.startsWith("blob:")) return;
      try {
        urls.add(new URL(text, location.href).href);
      } catch {
        // Ignore malformed browser URLs.
      }
    };
    for (const image of Array.from(document.images || [])) {
      const rect = image.getBoundingClientRect();
      const visible = rect.width > 80 && rect.height > 80 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
      if (!visible) continue;
      addUrl(image.currentSrc || image.src);
      addUrl(image.getAttribute("data-src"));
    }
    for (const element of Array.from(document.querySelectorAll("[style]"))) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 80 || rect.height <= 80 || rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) continue;
      const backgroundImage = getComputedStyle(element).backgroundImage || "";
      for (const match of backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        addUrl(match[1]);
      }
    }
    return [...urls];
  }).catch(() => []);
}

async function downloadBrowserImageResources({
  platformId = "",
  urls = [],
  itemDir,
  fetch = globalThis.fetch,
  referer = "",
  userAgent = DEFAULT_BROWSER_USER_AGENT,
  timeoutMs = 15_000,
  maxImages = 8
} = {}) {
  if (typeof fetch !== "function" || !itemDir) return [];
  const imageDir = path.join(itemDir, "images");
  const downloaded = [];
  const uniqueUrls = [...new Set((urls || []).filter((url) => /^https?:\/\//iu.test(String(url || ""))))].slice(0, Math.max(0, maxImages));
  if (uniqueUrls.length === 0) return downloaded;
  await fs.mkdir(imageDir, { recursive: true });
  for (let index = 0; index < uniqueUrls.length; index += 1) {
    const url = uniqueUrls[index];
    const targetPath = path.join(imageDir, `${String(index + 1).padStart(3, "0")}${extensionFromUrl(url)}`);
    try {
      const response = await fetchWithMaterialTimeout(fetch, url, {
        headers: {
          "User-Agent": userAgent,
          Referer: referer || PLATFORM_REFERERS[platformId] || ""
        }
      }, timeoutMs);
      if (!response?.ok) continue;
      const contentType = response.headers?.get?.("content-type") || "";
      if (contentType && !/^image\//iu.test(contentType)) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) continue;
      await fs.writeFile(targetPath, buffer);
      downloaded.push({ url, path: targetPath, bytes: buffer.length, contentType });
    } catch {
      // Resource URLs are best-effort; screenshots remain the stable fallback.
    }
  }
  return downloaded;
}

async function fetchWithMaterialTimeout(fetch, url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function capturePageScreenshots({ page, itemDir, count = 3, prefix = "browser" } = {}) {
  const screenshotDir = path.join(itemDir, "screenshots");
  await fs.mkdir(screenshotDir, { recursive: true });
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const screenshotPath = path.join(screenshotDir, `${prefix}-${String(index + 1).padStart(3, "0")}.jpg`);
    await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 82, fullPage: false });
    paths.push(screenshotPath);
    await page.mouse.wheel(0, 450).catch(() => {});
    await page.waitForTimeout(350).catch(() => {});
  }
  return paths;
}

function isFallbackScreenshotDisabled(env = process.env) {
  return /^(0|false|no)$/iu.test(String(env.MATERIAL_FALLBACK_SCREENSHOTS_ENABLED ?? "1"));
}

function extensionFromUrl(url) {
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  const ext = path.extname(pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext;
  if (/webp/iu.test(url)) return ".webp";
  if (/png/iu.test(url)) return ".png";
  return ".jpg";
}
