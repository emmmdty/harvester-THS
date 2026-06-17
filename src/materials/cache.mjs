import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { chromiumLaunchOptions } from "../browser-env.mjs";
import {
  captureDouyinPageScreenshots,
  downloadExtractedMedia,
  extractDouyinAssetFromPage
} from "../douyin-channel-type-classifier/assets.mjs";
import { getPlatformConfig, outputJsonPath } from "../platform-config.mjs";
import { normalizePlatformItems } from "../platforms/index.mjs";
import {
  captureBrowserVisualFallback,
  classifyBrowserFallbackError
} from "./browser-fallback.mjs";
import { shouldBlockFeishuWriteback } from "./failure-gate.mjs";
import { classifyTags } from "../tag-rules.mjs";

const DEFAULT_YTDLP_FORMAT = "worstvideo*+bestaudio/worst/best";
const DEFAULT_YTDLP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PLATFORM_COOKIE_URLS = {
  douyin: ["https://www.douyin.com"],
  xhs: ["https://www.xiaohongshu.com", "https://edith.xiaohongshu.com"],
  bilibili: ["https://www.bilibili.com", "https://bilibili.com", "https://api.bilibili.com"]
};
const PLATFORM_REFERERS = {
  douyin: "https://www.douyin.com/",
  xhs: "https://www.xiaohongshu.com/",
  bilibili: "https://www.bilibili.com/"
};

export async function cachePlatformMaterials({
  platformId,
  items = [],
  targetDate = "",
  sinceDate = targetDate,
  untilDate = targetDate || sinceDate,
  root = process.cwd(),
  sourceJsonPath = outputJsonPath(platformId, sinceDate, root, untilDate),
  download = downloadMaterialWithYtDlp,
  captureFallbackMaterial = captureMaterialFallback,
  env = process.env,
  fetch = globalThis.fetch,
  log = () => {}
} = {}) {
  const normalizedItems = normalizePlatformItems(platformId, items);
  const rawItems = Array.isArray(items) ? items : [];
  const itemDates = uniqueDatesForItems(normalizedItems, sinceDate || targetDate);
  for (const itemDate of itemDates) {
    const dateDir = path.join(root, "output", itemDate);
    await fs.mkdir(path.join(dateDir, platformId), { recursive: true });
    await preserveDailyCollectionFile({ sourceJsonPath, dateDir, platformId });
  }
  const manifests = [];
  let failed = 0;
  let consecutiveFailures = 0;
  let maxConsecutiveFailures = 0;
  const downloadContext = await prepareMaterialDownloadContext({ platformId, root, env, log });

  try {
    for (let itemIndex = 0; itemIndex < normalizedItems.length; itemIndex += 1) {
      const item = normalizedItems[itemIndex];
      const decisionItem = materialDecisionItem({ item, rawItem: rawItems[itemIndex] });
      const itemDate = item.publishedAt || sinceDate || targetDate;
      const platformDir = path.join(root, "output", itemDate, platformId);
      const id = safePathSegment(item.id || item.bvid || item.noteId || item.itemId || item.link || `item-${manifests.length + 1}`);
      const itemDir = path.join(platformDir, id);
      await fs.mkdir(itemDir, { recursive: true });
      let manifest = baseManifest({ platformId, item, itemDir });
      try {
        const prefersBrowserFallback = shouldPreferBrowserFallback({ platformId, item: decisionItem });
        const downloadResult = prefersBrowserFallback
          ? {
              ok: false,
              error: browserFirstFallbackReason({ platformId, item: decisionItem }),
              source: "browser-fallback",
              fallbackReason: browserFirstFallbackReason({ platformId, item: decisionItem }),
              assets: []
            }
          : (item.link
              ? await download({ platformId, item, itemDir, downloadContext, env, log })
              : { ok: false, error: "缺少素材链接，无法下载。" });
        if (prefersBrowserFallback) {
          log(`${getPlatformConfig(platformId).label}图文素材使用浏览器兜底：${item.id || item.link || item.title || "unknown"}`);
        }
        const materialResult = shouldTryBrowserFallbackAfterDownload({ platformId, item, result: downloadResult, browserFirst: prefersBrowserFallback })
          ? await captureFallbackMaterial({ platformId, item, itemDir, root, previousResult: downloadResult, env, log, fetch })
          : downloadResult;
        const assets = normalizeAssets(materialResult.assets, itemDir);
        const enriched = await enrichMediaAssets({ assets, itemDir, log });
        manifest = {
          ...manifest,
          ...materialResult,
          ok: Boolean(materialResult.ok),
          assets: enriched.assets,
          imagePaths: enriched.imagePaths,
          framePaths: enriched.framePaths,
          videoPath: enriched.videoPath
        };
      } catch (error) {
        log(`${getPlatformConfig(platformId).label}素材获取失败：${item.id || item.link || item.title || "unknown"}：${error.message || String(error)}`);
        manifest = {
          ...manifest,
          ok: false,
          error: error.message || String(error),
          assets: []
        };
      }
      if (!manifest.ok) {
        const errorText = manifest.error ? `：${manifest.error}` : "";
        log(`${getPlatformConfig(platformId).label}素材获取失败：${manifest.id || manifest.link || manifest.title || "unknown"}${errorText}，已写入失败 manifest，后续重跑可重新抓取。`);
      }
      if (!manifest.ok) {
        failed += 1;
        consecutiveFailures += 1;
        maxConsecutiveFailures = Math.max(maxConsecutiveFailures, consecutiveFailures);
      } else {
        consecutiveFailures = 0;
      }
      await fs.writeFile(path.join(itemDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      manifests.push(manifest);
    }
  } finally {
    await downloadContext.cleanup?.();
  }

  const stats = {
    total: normalizedItems.length,
    failed,
    consecutiveFailures: maxConsecutiveFailures
  };
  if (failed > 0) {
    log(`${getPlatformConfig(platformId).label}素材缓存完成，但有失败：${failed}/${stats.total}，连续失败 ${maxConsecutiveFailures}。后续可重新抓取同一素材。`);
  }
  return {
    manifests,
    stats,
    gate: shouldBlockFeishuWriteback(stats)
  };
}

function uniqueDatesForItems(items = [], fallbackDate = "") {
  const dates = new Set((items || []).map((item) => item.publishedAt || fallbackDate).filter(Boolean));
  if (dates.size === 0 && fallbackDate) dates.add(fallbackDate);
  return [...dates];
}

export async function downloadMaterialWithYtDlp({
  platformId = "",
  item = {},
  itemDir,
  downloadContext = {},
  env = process.env,
  run = runCommand,
  log = () => {}
} = {}) {
  if (!item.link) return { ok: false, error: "缺少素材链接，无法下载。" };
  const args = buildYtDlpArgs({
    platformId,
    item,
    itemDir,
    env,
    cookiePath: downloadContext.cookiePath || ""
  });
  const result = await run("yt-dlp", args, { cwd: itemDir });
  const assets = await collectDownloadedAssets(itemDir);
  if (result.code !== 0 && assets.length === 0) {
    log(`yt-dlp 下载失败：${item.link}：${result.stderr || result.stdout}`);
    return {
      ok: false,
      error: `yt-dlp 下载失败，退出码 ${result.code}`,
      stdout: result.stdout,
      stderr: result.stderr,
      assets: []
    };
  }
  return {
    ok: assets.length > 0,
    error: assets.length > 0
      ? (result.code === 0 ? "" : `yt-dlp 部分失败，已保留可分析素材；退出码 ${result.code}`)
      : "yt-dlp 未生成素材文件。",
    stdout: result.stdout,
    stderr: result.stderr,
    assets
  };
}

export function buildYtDlpArgs({
  platformId = "",
  item = {},
  itemDir = "",
  env = process.env,
  cookiePath = ""
} = {}) {
  const outputTemplate = path.join(itemDir, "%(id)s.%(ext)s");
  const format = env.MATERIAL_YTDLP_FORMAT || env.YTDLP_FORMAT || DEFAULT_YTDLP_FORMAT;
  const explicitCookiePath = platformEnv(env, "MATERIAL_YTDLP_COOKIES", platformId)
    || platformEnv(env, "YTDLP_COOKIES", platformId)
    || env.MATERIAL_YTDLP_COOKIES
    || env.YTDLP_COOKIES
    || "";
  const userAgent = env.MATERIAL_YTDLP_USER_AGENT || env.YTDLP_USER_AGENT || DEFAULT_YTDLP_USER_AGENT;
  const referer = platformEnv(env, "MATERIAL_YTDLP_REFERER", platformId)
    || platformEnv(env, "YTDLP_REFERER", platformId)
    || env.MATERIAL_YTDLP_REFERER
    || env.YTDLP_REFERER
    || PLATFORM_REFERERS[platformId]
    || "";
  const args = [
    "--no-playlist",
    "--ignore-errors",
    "--no-warnings",
    "--format",
    format,
    "--retries",
    String(env.MATERIAL_YTDLP_RETRIES || env.YTDLP_RETRIES || 5),
    "--fragment-retries",
    String(env.MATERIAL_YTDLP_FRAGMENT_RETRIES || env.YTDLP_FRAGMENT_RETRIES || 5),
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg"
  ];
  if (userAgent) args.push("--user-agent", userAgent);
  if (referer) args.push("--referer", referer);
  const resolvedCookiePath = explicitCookiePath || cookiePath;
  if (resolvedCookiePath) args.push("--cookies", resolvedCookiePath);
  args.push(...splitExtraArgs(env.MATERIAL_YTDLP_EXTRA_ARGS || env.YTDLP_EXTRA_ARGS || ""));
  args.push("-o", outputTemplate, item.link);
  return args;
}

export async function prepareMaterialDownloadContext({
  platformId,
  root = process.cwd(),
  env = process.env,
  log = () => {}
} = {}) {
  if (!shouldExportProfileCookies(env)) return { cookiePath: "", cleanup: async () => {} };
  if (platformEnv(env, "MATERIAL_YTDLP_COOKIES", platformId) || platformEnv(env, "YTDLP_COOKIES", platformId) || env.MATERIAL_YTDLP_COOKIES || env.YTDLP_COOKIES) {
    return { cookiePath: "", cleanup: async () => {} };
  }
  const profileDir = path.join(root, getPlatformConfig(platformId).profileDirName);
  if (!existsSync(profileDir)) return { cookiePath: "", cleanup: async () => {} };
  try {
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(profileDir, {
      ...chromiumLaunchOptions(),
      headless: true,
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
    });
    try {
      const cookies = await context.cookies(PLATFORM_COOKIE_URLS[platformId] || []);
      const authCookies = cookies.filter((cookie) => cookie.name && cookie.value);
      if (authCookies.length === 0) return { cookiePath: "", cleanup: async () => {} };
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `harvester-${platformId}-cookies-`));
      const cookiePath = path.join(tempDir, "cookies.txt");
      await fs.writeFile(cookiePath, formatNetscapeCookies(authCookies), { mode: 0o600 });
      log(`${getPlatformConfig(platformId).label} 素材下载已导出浏览器登录态 Cookie。`);
      return {
        cookiePath,
        cleanup: async () => {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      };
    } finally {
      await context.close().catch(() => {});
    }
  } catch (error) {
    log(`${getPlatformConfig(platformId).label} 素材下载未能导出浏览器 Cookie，将尝试无 Cookie 下载：${error.message || String(error)}`);
    return { cookiePath: "", cleanup: async () => {} };
  }
}

export function formatNetscapeCookies(cookies = []) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Generated by harvester-THS material downloader"
  ];
  for (const cookie of cookies) {
    if (!cookie?.name || cookie.value === undefined) continue;
    const domain = cookie.httpOnly ? `#HttpOnly_${cookie.domain}` : cookie.domain;
    const includeSubdomains = String(cookie.domain || "").startsWith(".") ? "TRUE" : "FALSE";
    const cookiePath = cookie.path || "/";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expires = cookie.expires && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
    lines.push([domain, includeSubdomains, cookiePath, secure, expires, cookie.name, cookie.value].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

async function enrichMediaAssets({ assets = [], itemDir, log = () => {} } = {}) {
  const normalizedAssets = [...assets];
  const imagePaths = normalizedAssets
    .filter((asset) => asset.kind === "image" && asset.path)
    .map((asset) => asset.path);
  const videoPath = normalizedAssets.find((asset) => asset.kind === "video" && asset.path)?.path || "";
  const framePaths = [];

  if (videoPath && imagePaths.length === 0) {
    const framePath = path.join(itemDir, "frame-0001.jpg");
    const frame = await extractVideoFrame({ videoPath, framePath, log });
    if (frame.ok) {
      framePaths.push(framePath);
      imagePaths.push(framePath);
      normalizedAssets.push({
        kind: "image",
        path: framePath,
        fileName: path.basename(framePath)
      });
    }
  }

  return {
    assets: normalizedAssets,
    imagePaths,
    framePaths,
    videoPath
  };
}

async function extractVideoFrame({ videoPath, framePath, log = () => {} } = {}) {
  if (!videoPath || !framePath) return { ok: false, error: "缺少视频或抽帧路径。" };
  const result = await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    "00:00:01",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    framePath
  ], { timeoutMs: 15000 });
  if (result.code === 0) return { ok: true, framePath };
  log(`ffmpeg 抽帧失败：${videoPath}：${result.stderr || result.stdout}`);
  return { ok: false, error: result.stderr || result.stdout || `退出码 ${result.code}` };
}

export async function preserveDailyCollectionFile({ sourceJsonPath, dateDir, platformId } = {}) {
  if (!sourceJsonPath) return "";
  const stat = await fs.stat(sourceJsonPath).catch(() => null);
  if (!stat?.isFile()) return "";
  await fs.mkdir(dateDir, { recursive: true });
  const targetPath = path.join(dateDir, `${platformId}-${path.basename(sourceJsonPath)}`);
  await fs.copyFile(sourceJsonPath, targetPath);
  return targetPath;
}

function baseManifest({ platformId, item, itemDir }) {
  return {
    platformId,
    id: item.id || item.bvid || item.noteId || item.itemId || "",
    link: item.link || "",
    title: item.title || "",
    tags: item.tags || "",
    publishedAt: item.publishedAt || "",
    itemType: item.itemType || item.type || "",
    materialKind: item.materialKind || "",
    dir: itemDir,
    ok: false,
    error: "",
    assets: []
  };
}

function shouldPreferBrowserFallback({ platformId = "", item = {} } = {}) {
  if (!item?.link) return false;
  if (platformId === "xhs") return hasExplicitXhsImageNoteSignal(item);
  if (platformId === "douyin") return isDouyinNoteLike(item);
  return false;
}

function shouldTryBrowserFallbackAfterDownload({ platformId = "", item = {}, result = {}, browserFirst = false } = {}) {
  if (!item?.link) return false;
  if (result?.ok || (result?.assets || []).length > 0) return false;
  if (browserFirst) return true;
  if (platformId === "douyin") return isDouyinNoteLike(item) || isVideoLike(item);
  if (platformId === "xhs") return isImageNoteLike(item) || isVideoLike(item);
  return isVideoLike(item);
}

function browserFirstFallbackReason({ platformId = "", item = {} } = {}) {
  if (platformId === "xhs" && hasExplicitXhsImageNoteSignal(item)) {
    return "yt-dlp 不适用：小红书图文素材优先使用浏览器兜底。";
  }
  if (platformId === "douyin" && isDouyinNoteLike(item)) {
    return "yt-dlp 不适用：抖音图文素材优先使用浏览器兜底。";
  }
  return "浏览器素材兜底优先。";
}

function materialDecisionItem({ item = {}, rawItem = {} } = {}) {
  const raw = rawItem && typeof rawItem === "object" ? rawItem : {};
  return {
    link: item.link || raw.link || raw.noteUrl || raw.itemUrl || "",
    tags: raw.tags ?? item.tags ?? "",
    itemType: raw.itemType ?? raw.type ?? "",
    type: raw.type ?? raw.itemType ?? "",
    materialKind: raw.materialKind ?? "",
    assetType: raw.assetType ?? item.assetType ?? "",
    mediaType: raw.mediaType ?? item.mediaType ?? "",
    noteType: raw.noteType ?? item.noteType ?? "",
    contentType: raw.contentType ?? item.contentType ?? ""
  };
}

function isImageNoteLike(item = {}) {
  return /图文|note|image|图片/iu.test(String(item.itemType || item.type || item.materialKind || item.assetType || item.mediaType || item.noteType || ""));
}

function hasExplicitXhsImageNoteSignal(item = {}) {
  if (isImageNoteLike(item)) return true;
  if (/图文|note|image|图片/iu.test(String(item.contentType || ""))) return true;
  const tagType = classifyTags(item.tags || "", { platformId: "xhs" });
  return tagType === "图文";
}

function isDouyinNoteLike(item = {}) {
  return /\/note\//iu.test(String(item.link || "")) || isImageNoteLike(item);
}

function isVideoLike(item = {}) {
  return /\/video\//iu.test(String(item.link || "")) || /视频|video|mp4|mov|m3u8/iu.test(String(item.itemType || item.type || item.materialKind || item.assetType || item.mediaType || item.contentType || ""));
}

async function captureMaterialFallback({
  platformId = "",
  item = {},
  itemDir,
  root = process.cwd(),
  previousResult = {},
  env = process.env,
  log = () => {},
  fetch = globalThis.fetch
} = {}) {
  if (!item?.link) return previousResult;
  if (platformId === "xhs") return captureXhsMaterialFallback({ item, itemDir, root, previousResult, env, log });
  if (platformId !== "douyin" && isVideoLike(item)) return captureGenericBrowserFallback({ platformId, item, itemDir, root, previousResult, env, log });
  if (platformId !== "douyin") return previousResult;
  const fallbackPrefix = previousResult.error || "yt-dlp 未获取到素材";
  let extracted = {};
  let extractError = "";
  try {
    extracted = await extractDouyinAssetFromPage({ root, sourceRow: item });
  } catch (error) {
    extractError = error.message || String(error);
  }

  const downloaded = await downloadExtractedMedia({ assetDir: itemDir, extracted, fetch });
  const screenshotPaths = downloaded.hasVisualMedia || isFallbackScreenshotDisabled(env)
    ? []
    : await captureDouyinPageScreenshots({
      root,
      sourceRow: item,
      assetDir: itemDir,
      count: Number(env.MATERIAL_FALLBACK_SCREENSHOTS || 3)
    }).catch((error) => {
      log(`抖音图文页面截图兜底失败：${item.link}：${error.message || String(error)}`);
      return [];
    });

  const assets = [
    ...(downloaded.videoPath ? [{ kind: "video", path: downloaded.videoPath }] : []),
    ...(downloaded.imagePaths || []).map((filePath) => ({ kind: "image", path: filePath })),
    ...screenshotPaths.map((filePath) => ({ kind: "image", path: filePath }))
  ];
  if (assets.length === 0) {
    return {
      ...previousResult,
      ok: false,
      error: [fallbackPrefix, extractError ? `抖音图文视觉兜底失败：${extractError}` : "抖音图文视觉兜底未获取到素材"].filter(Boolean).join("；"),
      source: previousResult.source || "browser-fallback",
      fallbackReason: previousResult.fallbackReason || fallbackPrefix,
      assets: []
    };
  }
  return {
    ...previousResult,
    ok: true,
    error: `${fallbackPrefix}；已使用抖音图文视觉兜底素材。`,
    source: "browser-fallback",
    fallbackReason: previousResult.fallbackReason || fallbackPrefix,
    assets,
    fallback: {
      kind: "douyin-note-visual",
      extractedMedia: Boolean(downloaded.hasVisualMedia),
      screenshots: screenshotPaths.length,
      extractError,
      downloadAttempts: downloaded.downloadAttempts || []
    }
  };
}

async function captureXhsMaterialFallback({
  item = {},
  itemDir,
  root = process.cwd(),
  previousResult = {},
  env = process.env,
  log = () => {}
} = {}) {
  const fallbackPrefix = previousResult.error || "yt-dlp 未获取到素材";
  let capture = null;
  try {
    capture = await captureBrowserVisualFallback({
      platformId: "xhs",
      item,
      itemDir,
      root,
      env,
      screenshotCount: Number(env.MATERIAL_FALLBACK_SCREENSHOTS || 3)
    });
  } catch (error) {
    const reason = classifyBrowserFallbackError("xhs", error.message || String(error));
    log(`小红书浏览器兜底失败：${item.id || item.link || item.title || "unknown"}：${reason}`);
    return {
      ...previousResult,
      ok: false,
      source: "browser-fallback",
      fallbackReason: previousResult.fallbackReason || fallbackPrefix,
      error: [fallbackPrefix, `小红书浏览器兜底失败：${reason}`].filter(Boolean).join("；"),
      assets: []
    };
  }

  const assets = [
    ...(capture.imagePaths || []).map((filePath) => ({ kind: "image", path: filePath, source: "page-image" })),
    ...(capture.screenshotPaths || []).map((filePath) => ({ kind: "image", path: filePath, source: "page-screenshot" }))
  ];

  if (assets.length === 0) {
    const reason = capture?.riskReason || "未找到图片资源";
    log(`小红书浏览器兜底失败：${item.id || item.link || item.title || "unknown"}：${reason}`);
    return {
      ...previousResult,
      ok: false,
      source: "browser-fallback",
      fallbackReason: previousResult.fallbackReason || fallbackPrefix,
      error: [fallbackPrefix, `小红书浏览器兜底失败：${reason}`].filter(Boolean).join("；"),
      assets: [],
      fallback: {
        kind: "xhs-browser-visual",
        screenshots: 0,
        imageResources: 0,
        pageUrl: capture?.pageUrl || "",
        riskReason: reason
      }
    };
  }

  return {
    ...previousResult,
    ok: true,
    source: "browser-fallback",
    fallbackReason: previousResult.fallbackReason || fallbackPrefix,
    error: `${fallbackPrefix}；已使用小红书浏览器兜底素材。`,
    assets,
    fallback: {
      kind: "xhs-browser-visual",
      screenshots: (capture.screenshotPaths || []).length,
      imageResources: (capture.imagePaths || []).length,
      pageUrl: capture.pageUrl || "",
      downloadedImages: capture.downloadedImages || [],
      riskReason: capture.riskReason || ""
    }
  };
}

async function captureGenericBrowserFallback({
  platformId = "",
  item = {},
  itemDir,
  root = process.cwd(),
  previousResult = {},
  env = process.env,
  log = () => {}
} = {}) {
  const label = getPlatformConfig(platformId).label;
  const fallbackPrefix = previousResult.error || "yt-dlp 未获取到素材";
  let capture = null;
  try {
    capture = await captureBrowserVisualFallback({
      platformId,
      item,
      itemDir,
      root,
      env,
      screenshotCount: Number(env.MATERIAL_FALLBACK_SCREENSHOTS || 3)
    });
  } catch (error) {
    const reason = classifyBrowserFallbackError(platformId, error.message || String(error));
    log(`${label}浏览器兜底失败：${item.id || item.link || item.title || "unknown"}：${reason}`);
    return {
      ...previousResult,
      ok: false,
      source: "browser-fallback",
      fallbackReason: previousResult.fallbackReason || fallbackPrefix,
      error: [fallbackPrefix, `${label}浏览器兜底失败：${reason}`].filter(Boolean).join("；"),
      assets: []
    };
  }

  const assets = [
    ...(capture.imagePaths || []).map((filePath) => ({ kind: "image", path: filePath, source: "page-image" })),
    ...(capture.screenshotPaths || []).map((filePath) => ({ kind: "image", path: filePath, source: "page-screenshot" }))
  ];

  if (assets.length === 0) {
    const reason = capture?.riskReason || "未找到图片资源";
    log(`${label}浏览器兜底失败：${item.id || item.link || item.title || "unknown"}：${reason}`);
    return {
      ...previousResult,
      ok: false,
      source: "browser-fallback",
      fallbackReason: previousResult.fallbackReason || fallbackPrefix,
      error: [fallbackPrefix, `${label}浏览器兜底失败：${reason}`].filter(Boolean).join("；"),
      assets: [],
      fallback: {
        kind: `${platformId}-browser-visual`,
        screenshots: 0,
        imageResources: 0,
        pageUrl: capture?.pageUrl || "",
        riskReason: reason
      }
    };
  }

  return {
    ...previousResult,
    ok: true,
    source: "browser-fallback",
    fallbackReason: previousResult.fallbackReason || fallbackPrefix,
    error: `${fallbackPrefix}；已使用页面截图兜底素材。`,
    assets,
    fallback: {
      kind: `${platformId}-browser-visual`,
      screenshots: (capture.screenshotPaths || []).length,
      imageResources: (capture.imagePaths || []).length,
      pageUrl: capture.pageUrl || "",
      downloadedImages: capture.downloadedImages || [],
      riskReason: capture.riskReason || ""
    }
  };
}

function isFallbackScreenshotDisabled(env = process.env) {
  return /^(0|false|no)$/iu.test(String(env.MATERIAL_FALLBACK_SCREENSHOTS_ENABLED ?? "1"));
}

function normalizeAssets(assets = [], itemDir = "") {
  return (assets || []).map((asset) => ({
    kind: asset.kind || assetKindFromFileName(asset.path || asset.fileName || ""),
    path: asset.path || (asset.fileName ? path.join(itemDir, asset.fileName) : ""),
    url: asset.url || "",
    fileName: asset.fileName || (asset.path ? path.basename(asset.path) : "")
  }));
}

async function collectDownloadedAssets(itemDir) {
  const entries = await fs.readdir(itemDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name !== "manifest.json" && entry.name !== "cookies.txt")
    .map((entry) => {
      const filePath = path.join(itemDir, entry.name);
      return {
        kind: assetKindFromFileName(entry.name),
        path: filePath,
        fileName: entry.name
      };
    });
}

function assetKindFromFileName(fileName = "") {
  const lower = String(fileName || "").toLowerCase();
  if (/\.(mp4|mov|m4v|webm|mkv)$/u.test(lower)) return "video";
  if (/\.(jpg|jpeg|png|webp|gif)$/u.test(lower)) return "image";
  return "file";
}

function shouldExportProfileCookies(env = process.env) {
  const value = env.MATERIAL_EXPORT_PROFILE_COOKIES || env.YTDLP_EXPORT_PROFILE_COOKIES;
  if (value === undefined) return true;
  return /^(1|true|yes)$/iu.test(String(value));
}

function platformEnv(env = process.env, name = "", platformId = "") {
  if (!platformId || !name) return "";
  const key = `${platformId.toUpperCase()}_${name}`;
  return env[key] || "";
}

function splitExtraArgs(value = "") {
  const args = [];
  const text = String(value || "").trim();
  if (!text) return args;
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function safePathSegment(value = "") {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//u, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "unknown";
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const { timeoutMs = 0, ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let timedOut = false;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs)
      : null;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: error.message || String(error) });
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        code: timedOut ? 124 : (code === null ? 1 : Number(code)),
        stdout,
        stderr: timedOut ? `${stderr}\n命令超时。`.trim() : stderr
      });
    });
  });
}
