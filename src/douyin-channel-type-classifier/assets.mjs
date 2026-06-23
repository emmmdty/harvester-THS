import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { fetchWithTimeout } from "../ai/content-classification.mjs";
import { chromiumLaunchOptions, resolveMaterialFallbackHeadless } from "../browser-env.mjs";
import { detectBrowserFallbackRisk } from "../materials/browser-fallback.mjs";
import {
  resolveFfmpegCommand,
  resolveFfprobeCommand
} from "../media-tools.mjs";

const DOUYIN_PROFILE_DIR = ".douyin-profile";
const execFileAsync = promisify(execFile);
const DOUYIN_MEDIA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Referer: "https://www.douyin.com/"
};

export async function createDouyinChannelTypeAssetBundle({
  root = process.cwd(),
  targetDate,
  sourceRow,
  assetBaseDir,
  extractDouyinAsset = extractDouyinAssetFromPage,
  captureFallbackScreenshots = captureDouyinPageScreenshots,
  fetch = globalThis.fetch,
  env = process.env
} = {}) {
  let extracted = {};
  let extractError = "";
  try {
    extracted = await extractDouyinAsset({ root, targetDate, sourceRow, env });
  } catch (error) {
    extractError = error.message || String(error);
    extracted = {};
  }

  const awemeId = sanitizePathSegment(
    extracted.awemeId
      || extractDouyinAwemeId(sourceRow?.link)
      || hashText(sourceRow?.link || JSON.stringify(sourceRow || {}))
  );
  const assetDir = path.join(assetBaseDir, sanitizePathSegment(targetDate || "unknown"), awemeId);
  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(path.join(assetDir, "source.json"), JSON.stringify(sourceRow || {}, null, 2), "utf8");

  const downloaded = await downloadExtractedMedia({ assetDir, extracted, fetch });
  const screenshotPaths = downloaded.hasVisualMedia
    ? []
    : await captureFallbackScreenshots({ root, sourceRow, assetDir, env }).catch(() => []);
  const localArtifacts = await buildChannelTypeMediaArtifacts({
    assetDir,
    videoPath: downloaded.videoPath || extracted.videoPath || "",
    imagePaths: [...downloaded.imagePaths, ...screenshotPaths, ...(extracted.imagePaths || [])]
  });
  const framePaths = uniqueStrings([...localArtifacts.framePaths, ...(extracted.framePaths || [])]);
  const imagePaths = uniqueStrings([...downloaded.imagePaths, ...screenshotPaths, ...(extracted.imagePaths || [])]);
  const mediaType = screenshotPaths.length
    ? "screenshot"
    : extracted.mediaType || inferredMediaType(downloaded, extracted);

  const manifest = {
    ok: !extractError,
    platform: "douyin",
    purpose: "douyin-channel-type-classifier",
    targetDate,
    sourceRowNumber: sourceRow?.sourceRowNumber || null,
    link: sourceRow?.link || "",
    awemeId,
    mediaType,
    title: extracted.title || sourceRow?.fields?.["标题"] || "",
    assetDir,
    videoPath: downloaded.videoPath || extracted.videoPath || "",
    imagePaths,
    framePaths,
    screenshotPaths,
    downloadAttempts: downloaded.downloadAttempts,
    artifactStatus: localArtifacts.status,
    error: extractError
  };
  await fs.writeFile(path.join(assetDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return {
    ...manifest,
    assetDir,
    asrText: "",
    ocrText: "",
    sourceText: [
      sourceRow?.fields?.["标题"] || "",
      sourceRow?.fields?.["tag词"] || sourceRow?.fields?.["TAG词"] || "",
      extracted.text || ""
    ].filter(Boolean).join("\n")
  };
}

export async function buildChannelTypeMediaArtifacts({ assetDir, videoPath, imagePaths = [] }) {
  const status = {
    frames: videoPath ? "pending" : "skipped_no_video",
    screenshot: imagePaths.length ? "done" : "skipped_no_images",
    errors: []
  };
  let framePaths = [];

  if (videoPath) {
    const frameResult = await extractVideoFrames({ assetDir, videoPath });
    framePaths = frameResult.framePaths;
    status.frames = frameResult.ok ? "done" : "failed";
    if (frameResult.error) status.errors.push(frameResult.error);
  }

  return {
    framePaths,
    status
  };
}

export async function extractDouyinAssetFromPage({ root = process.cwd(), sourceRow, env = process.env } = {}) {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(path.join(root, DOUYIN_PROFILE_DIR), {
    ...chromiumLaunchOptions(),
    headless: resolveMaterialFallbackHeadless(env),
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  try {
    const awemeId = extractDouyinAwemeId(sourceRow?.link);
    const payloads = collectDouyinAssetPayloads(page);
    await page.goto(sourceRow.link, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2500);
    const payloadList = await payloads.flush();
    const bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    const extracted = bestExtractedAssetFromPayloads(payloadList, awemeId);
    return {
      ...extracted,
      awemeId: extracted.awemeId || awemeId,
      text: bodyText
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export function extractDouyinAwemeId(value) {
  const text = String(value || "");
  const match = text.match(/douyin\.com\/(?:video|note)\/([A-Za-z0-9_-]+)/iu)
    || text.match(/\/(?:video|note)\/([A-Za-z0-9_-]+)/iu)
    || text.match(/\baweme_id=([A-Za-z0-9_-]+)/iu);
  return match?.[1] || "";
}

export function extractDouyinAssetFromAwemeDetail(rawDetail = {}, { itemId = "" } = {}) {
  const detail = selectAwemeDetail(rawDetail, { itemId });
  const awemeId = String(detail.aweme_id || detail.awemeId || detail.group_id || detail.groupId || "").trim();
  const videoUrls = uniqueStrings([
    ...(detail.video?.play_addr?.url_list || []),
    ...(detail.video?.playAddr?.urlList || []),
    ...(detail.video?.download_addr?.url_list || []),
    ...(detail.video?.bit_rate || []).flatMap((item) => item.play_addr?.url_list || item.playAddr?.urlList || [])
  ]);
  const imageUrls = uniqueStrings([
    ...(detail.images || []).flatMap(imageUrlsFromItem),
    ...(detail.image_infos || []).flatMap(imageUrlsFromItem),
    ...(detail.imageInfos || []).flatMap(imageUrlsFromItem),
    ...(detail.image_post_info?.images || []).flatMap(imageUrlsFromItem),
    ...(detail.imagePostInfo?.images || []).flatMap(imageUrlsFromItem)
  ]);
  return {
    awemeId,
    mediaType: imageUrls.length ? "image" : "video",
    title: String(detail.desc || detail.caption || "").trim(),
    text: String(detail.desc || detail.caption || "").trim(),
    videoUrls,
    imageUrls
  };
}

function collectDouyinAssetPayloads(page) {
  const payloads = [];
  const pending = [];
  page.on("response", (response) => {
    try {
      const url = new URL(response.url());
      if (response.status() !== 200) return;
      const isDetail = url.pathname.includes("/aweme/v1/web/aweme/detail/");
      const isPost = url.pathname.includes("/aweme/v1/web/aweme/post/");
      if (!isDetail && !isPost) return;
      pending.push(response.json()
        .then((json) => payloads.push({ kind: isDetail ? "detail" : "post", url: response.url(), json }))
        .catch(() => {}));
    } catch {
      // Ignore malformed tracking responses.
    }
  });
  return {
    async flush() {
      await Promise.allSettled(pending);
      return payloads;
    }
  };
}

function bestExtractedAssetFromPayloads(payloads = [], awemeId = "") {
  const extracted = payloads
    .map((payload) => extractDouyinAssetFromAwemeDetail(payload.json, { itemId: awemeId }))
    .filter((item) => item.awemeId || item.videoUrls.length || item.imageUrls.length);
  return extracted.sort(assetScore).at(0) || {};
}

function assetScore(left, right) {
  return scoreAsset(right) - scoreAsset(left);
}

function scoreAsset(asset = {}) {
  const idScore = asset.awemeId ? 100 : 0;
  return idScore + (asset.imageUrls || []).length * 3 + (asset.videoUrls || []).length;
}

export async function downloadExtractedMedia({ assetDir, extracted, fetch, timeoutMs = Number(process.env.DOUYIN_MEDIA_DOWNLOAD_TIMEOUT_MS || 30_000) }) {
  const imagePaths = [];
  let videoPath = "";
  const downloadAttempts = [];
  if (typeof fetch !== "function") return { imagePaths, videoPath, downloadAttempts, hasVisualMedia: false };

  const videoUrls = uniqueStrings(extracted.videoUrls || []).filter((url) => /^https?:\/\//iu.test(url));
  for (const videoUrl of videoUrls) {
    const targetPath = path.join(assetDir, "video.mp4");
    const result = await downloadFile({ url: videoUrl, filePath: targetPath, fetch, kind: "video", timeoutMs });
    downloadAttempts.push(result.attempt);
    if (result.ok) {
      videoPath = targetPath;
      break;
    }
  }

  const imageUrls = uniqueStrings(extracted.imageUrls || []);
  if (imageUrls.length > 0) await fs.mkdir(path.join(assetDir, "images"), { recursive: true });
  for (let index = 0; index < imageUrls.length; index += 1) {
    const imagePath = path.join(assetDir, "images", `${String(index + 1).padStart(3, "0")}${extensionFromUrl(imageUrls[index])}`);
    const result = await downloadFile({ url: imageUrls[index], filePath: imagePath, fetch, kind: "image", timeoutMs });
    downloadAttempts.push(result.attempt);
    if (result.ok) {
      imagePaths.push(imagePath);
    }
  }
  return {
    imagePaths,
    videoPath,
    downloadAttempts,
    hasVisualMedia: Boolean(videoPath || imagePaths.length)
  };
}

async function downloadFile({ url, filePath, fetch, kind, timeoutMs }) {
  const attempt = { kind, url, ok: false, status: 0, contentType: "", bytes: 0, error: "" };
  try {
    const response = await fetchWithTimeout(url, { headers: DOUYIN_MEDIA_HEADERS }, {
      fetch,
      timeoutMs,
      label: `抖音${kind === "video" ? "视频" : "图片"}媒体下载`
    });
    attempt.status = response.status || 0;
    attempt.contentType = response.headers?.get?.("content-type") || "";
    if (!response.ok) {
      attempt.error = await response.text().then((text) => text.slice(0, 200)).catch(() => `HTTP ${attempt.status}`);
      return { ok: false, attempt };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    attempt.bytes = buffer.length;
    await fs.writeFile(filePath, buffer);
    attempt.ok = true;
    return { ok: true, attempt };
  } catch (error) {
    attempt.error = error.message || String(error);
    return { ok: false, attempt };
  }
}

async function extractVideoFrames({ assetDir, videoPath }) {
  const framesDir = path.join(assetDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  const outputPattern = path.join(framesDir, "%03d.jpg");
  try {
    const hasVideo = await hasVideoStream(videoPath);
    if (!hasVideo) return { ok: false, framePaths: [], error: "内容分类视频抽帧失败：视频文件无画面流" };
    await execFileAsync(resolveFfmpegCommand(), [
      "-y",
      "-i",
      videoPath,
      "-vf",
      "fps=1/5,scale=1280:-2:force_original_aspect_ratio=decrease",
      "-frames:v",
      "8",
      outputPattern
    ], { timeout: 120_000 });
    return { ok: true, framePaths: await listMediaFiles(framesDir) };
  } catch (error) {
    return { ok: false, framePaths: [], error: `内容分类视频抽帧失败：${error.message || error}` };
  }
}

async function hasVideoStream(videoPath) {
  try {
    const { stdout } = await execFileAsync(resolveFfprobeCommand(), [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      videoPath
    ], { timeout: 30_000 });
    return stdout.trim() === "video";
  } catch {
    return false;
  }
}

export async function captureDouyinPageScreenshots({ root = process.cwd(), sourceRow = {}, assetDir, count = 6, env = process.env } = {}) {
  if (!sourceRow?.link) return [];
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(path.join(root, DOUYIN_PROFILE_DIR), {
    ...chromiumLaunchOptions(),
    headless: resolveMaterialFallbackHeadless(env),
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  const screenshotDir = path.join(assetDir, "screenshots");
  await fs.mkdir(screenshotDir, { recursive: true });
  const paths = [];
  try {
    await page.goto(sourceRow.link, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1500);
    const bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    if (detectBrowserFallbackRisk({ platformId: "douyin", pageUrl: page.url(), bodyText })) {
      return [];
    }
    for (let index = 0; index < count; index += 1) {
      const screenshotPath = path.join(screenshotDir, `${String(index + 1).padStart(3, "0")}.jpg`);
      await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 82, fullPage: false });
      paths.push(screenshotPath);
      await page.mouse.wheel(0, 450);
      await page.waitForTimeout(350);
    }
  } finally {
    await context.close().catch(() => {});
  }
  return paths;
}

async function listMediaFiles(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  return entries
    .filter((entry) => /\.(?:jpe?g|png|webp)$/iu.test(entry))
    .sort()
    .map((entry) => path.join(dir, entry));
}

function inferredMediaType(downloaded, extracted) {
  if (downloaded.imagePaths.length || extracted.imagePaths?.length) return "image";
  if (downloaded.videoPath || extracted.videoPath || extracted.videoUrls?.length) return "video";
  return "unknown";
}

function selectAwemeDetail(rawDetail = {}, { itemId = "" } = {}) {
  if (!rawDetail || typeof rawDetail !== "object") return {};
  if (rawDetail.aweme_detail || rawDetail.awemeDetail) return rawDetail.aweme_detail || rawDetail.awemeDetail;
  const list = Array.isArray(rawDetail.aweme_list) ? rawDetail.aweme_list : [];
  if (list.length) {
    const wanted = String(itemId || "").trim();
    if (wanted) return list.find((item) => String(item?.aweme_id || item?.awemeId || "") === wanted) || {};
    return list[0] || {};
  }
  return rawDetail;
}

function imageUrlsFromItem(item = {}) {
  if (!item || typeof item !== "object") return [];
  return [
    ...(item.url_list || []),
    ...(item.urlList || []),
    ...(item.download_url_list || []),
    ...(item.downloadUrlList || []),
    ...(item.watermark_free_download_url_list || []),
    ...(item.watermarkFreeDownloadUrlList || []),
    ...(item.label_large?.url_list || []),
    ...(item.labelLarge?.urlList || []),
    ...(item.label_thumb?.url_list || []),
    ...(item.labelThumb?.urlList || [])
  ];
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

function uniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function sanitizePathSegment(value) {
  const text = String(value || "").replace(/[^0-9A-Za-z_-]+/g, "_").replace(/^_+|_+$/g, "");
  return text || "unknown";
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}
