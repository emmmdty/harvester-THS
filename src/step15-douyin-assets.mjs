import crypto from "node:crypto";
import { exec, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const DOUYIN_PROFILE_DIR = ".douyin-profile";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export async function createDouyinAssetBundle({
  root = process.cwd(),
  targetDate,
  sourceRow,
  extractDouyinAsset = extractDouyinAssetFromPage,
  fetch = globalThis.fetch,
  env = process.env
} = {}) {
  let extracted = {};
  let extractError = "";
  try {
    extracted = await extractDouyinAsset({ root, targetDate, sourceRow });
  } catch (error) {
    extractError = error.message || String(error);
    extracted = {};
  }

  const awemeId = sanitizePathSegment(
    extracted.awemeId
      || extractDouyinAwemeId(sourceRow?.link)
      || hashText(sourceRow?.link || JSON.stringify(sourceRow || {}))
  );
  const assetDir = path.join(root, "output", "step15-assets", targetDate, "douyin", awemeId);
  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(path.join(assetDir, "source.json"), JSON.stringify(sourceRow || {}, null, 2), "utf8");

  const downloaded = await downloadExtractedMedia({ assetDir, extracted, fetch });
  const localArtifacts = await buildLocalArtifacts({
    assetDir,
    videoPath: downloaded.videoPath || extracted.videoPath || "",
    imagePaths: [...downloaded.imagePaths, ...(extracted.imagePaths || [])],
    env
  });
  const asrText = String(extracted.localTexts?.asr || extracted.asrText || localArtifacts.asrText || "");
  const ocrText = String(extracted.localTexts?.ocr || extracted.ocrText || localArtifacts.ocrText || "");
  await fs.writeFile(path.join(assetDir, "asr.txt"), asrText, "utf8");
  await fs.writeFile(path.join(assetDir, "ocr.txt"), ocrText, "utf8");
  const framePaths = uniqueStrings([...localArtifacts.framePaths, ...(extracted.framePaths || [])]);
  const imagePaths = uniqueStrings([...downloaded.imagePaths, ...(extracted.imagePaths || [])]);

  const manifest = {
    ok: !extractError,
    platform: "douyin",
    targetDate,
    sourceRowNumber: sourceRow?.sourceRowNumber || null,
    link: sourceRow?.link || "",
    awemeId,
    mediaType: extracted.mediaType || inferredMediaType(downloaded, extracted),
    title: extracted.title || sourceRow?.fields?.["标题"] || "",
    assetDir,
    videoPath: downloaded.videoPath || extracted.videoPath || "",
    imagePaths,
    framePaths,
    audioPath: localArtifacts.audioPath,
    asrPath: path.join(assetDir, "asr.txt"),
    ocrPath: path.join(assetDir, "ocr.txt"),
    artifactStatus: localArtifacts.status,
    error: extractError
  };
  await fs.writeFile(path.join(assetDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return {
    ...manifest,
    assetDir,
    asrText,
    ocrText,
    sourceText: [
      sourceRow?.fields?.["标题"] || "",
      sourceRow?.fields?.["tag词"] || sourceRow?.fields?.["TAG词"] || "",
      extracted.text || "",
      asrText,
      ocrText
    ].filter(Boolean).join("\n")
  };
}

export async function extractDouyinAssetFromPage({ root = process.cwd(), sourceRow } = {}) {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(path.join(root, DOUYIN_PROFILE_DIR), {
    headless: process.env.PLAYWRIGHT_HEADLESS === "1",
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  try {
    const awemeId = extractDouyinAwemeId(sourceRow?.link);
    const detailPromise = waitForAwemeDetail(page, awemeId);
    await page.goto(sourceRow.link, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1200);
    const detail = await detailPromise;
    const bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    return {
      ...extractDouyinAssetFromAwemeDetail(detail),
      awemeId: extractDouyinAssetFromAwemeDetail(detail).awemeId || awemeId,
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

export function extractDouyinAssetFromAwemeDetail(rawDetail = {}) {
  const detail = rawDetail?.aweme_detail || rawDetail?.awemeDetail || rawDetail || {};
  const awemeId = String(detail.aweme_id || detail.awemeId || detail.group_id || detail.groupId || "").trim();
  const videoUrls = uniqueStrings([
    ...(detail.video?.play_addr?.url_list || []),
    ...(detail.video?.playAddr?.urlList || []),
    ...(detail.video?.download_addr?.url_list || []),
    ...(detail.video?.bit_rate || []).flatMap((item) => item.play_addr?.url_list || item.playAddr?.urlList || [])
  ]);
  const imageUrls = uniqueStrings([
    ...(detail.images || []).flatMap((item) => item.url_list || item.urlList || item.download_url_list || []),
    ...(detail.image_post_info?.images || []).flatMap((item) => item.url_list || item.urlList || item.download_url_list || []),
    ...(detail.imagePostInfo?.images || []).flatMap((item) => item.url_list || item.urlList || item.downloadUrlList || [])
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

async function waitForAwemeDetail(page, awemeId) {
  return page.waitForResponse((response) => {
    try {
      const url = new URL(response.url());
      if (!url.pathname.includes("/aweme/v1/web/aweme/detail/")) return false;
      if (!awemeId) return response.status() === 200;
      return url.searchParams.get("aweme_id") === awemeId && response.status() === 200;
    } catch {
      return false;
    }
  }, { timeout: 15_000 })
    .then((response) => response.json())
    .catch(() => ({}));
}

async function downloadExtractedMedia({ assetDir, extracted, fetch }) {
  const imagePaths = [];
  let videoPath = "";
  if (typeof fetch !== "function") return { imagePaths, videoPath };

  const videoUrl = firstHttpUrl(extracted.videoUrls);
  if (videoUrl) {
    videoPath = path.join(assetDir, "video.mp4");
    await downloadFile(videoUrl, videoPath, fetch).catch(() => {
      videoPath = "";
    });
  }

  const imageUrls = uniqueStrings(extracted.imageUrls || []);
  if (imageUrls.length > 0) await fs.mkdir(path.join(assetDir, "images"), { recursive: true });
  for (let index = 0; index < imageUrls.length; index += 1) {
    const imagePath = path.join(assetDir, "images", `${String(index + 1).padStart(3, "0")}.jpg`);
    await downloadFile(imageUrls[index], imagePath, fetch).then(() => {
      imagePaths.push(imagePath);
    }).catch(() => {});
  }
  return { imagePaths, videoPath };
}

async function downloadFile(url, filePath, fetch) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);
}

async function buildLocalArtifacts({ assetDir, videoPath, imagePaths, env }) {
  const status = {
    frames: videoPath ? "pending" : "skipped_no_video",
    audio: videoPath ? "pending" : "skipped_no_video",
    asr: "skipped_not_configured",
    ocr: "skipped_not_configured",
    errors: []
  };
  let framePaths = [];
  let audioPath = "";
  let asrText = "";
  let ocrText = "";

  if (videoPath) {
    const frameResult = await extractVideoFrames({ assetDir, videoPath });
    framePaths = frameResult.framePaths;
    status.frames = frameResult.ok ? "done" : "failed";
    if (frameResult.error) status.errors.push(frameResult.error);

    const audioResult = await extractVideoAudio({ assetDir, videoPath });
    audioPath = audioResult.audioPath;
    status.audio = audioResult.ok ? "done" : "failed";
    if (audioResult.error) status.errors.push(audioResult.error);
  }

  const asrCommand = String(env.STEP15_ASR_COMMAND || "").trim();
  if (asrCommand && audioPath) {
    const outputPath = path.join(assetDir, "asr.txt");
    const result = await runTemplateCommand(asrCommand, { audio: audioPath, output: outputPath });
    status.asr = result.ok ? "done" : "failed";
    if (result.error) status.errors.push(result.error);
    asrText = await fs.readFile(outputPath, "utf8").catch(() => "");
  } else if (asrCommand && !audioPath) {
    status.asr = "skipped_no_audio";
  }

  const ocrCommand = String(env.STEP15_OCR_COMMAND || "").trim();
  if (ocrCommand) {
    const targets = uniqueStrings([...imagePaths, ...framePaths]).slice(0, 16);
    if (targets.length > 0) {
      const ocrResult = await runOcrCommand({ command: ocrCommand, assetDir, imagePaths: targets });
      status.ocr = ocrResult.ok ? "done" : "failed";
      if (ocrResult.error) status.errors.push(ocrResult.error);
      ocrText = ocrResult.text;
    } else {
      status.ocr = "skipped_no_images";
    }
  }

  return {
    framePaths,
    audioPath,
    asrText,
    ocrText,
    status
  };
}

async function extractVideoFrames({ assetDir, videoPath }) {
  const framesDir = path.join(assetDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  const outputPattern = path.join(framesDir, "%03d.jpg");
  try {
    await execFileAsync("ffmpeg", [
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
    return { ok: false, framePaths: [], error: `视频抽帧失败：${error.message || error}` };
  }
}

async function extractVideoAudio({ assetDir, videoPath }) {
  const audioPath = path.join(assetDir, "audio.wav");
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      audioPath
    ], { timeout: 120_000 });
    return { ok: true, audioPath };
  } catch (error) {
    return { ok: false, audioPath: "", error: `音频抽取失败：${error.message || error}` };
  }
}

async function runOcrCommand({ command, assetDir, imagePaths }) {
  const fragmentDir = path.join(assetDir, "ocr-fragments");
  await fs.mkdir(fragmentDir, { recursive: true });
  const texts = [];
  const errors = [];
  for (let index = 0; index < imagePaths.length; index += 1) {
    const outputPath = path.join(fragmentDir, `${String(index + 1).padStart(3, "0")}.txt`);
    const result = await runTemplateCommand(command, { image: imagePaths[index], output: outputPath });
    if (result.error) errors.push(result.error);
    const text = await fs.readFile(outputPath, "utf8").catch(() => "");
    if (text.trim()) texts.push(text.trim());
  }
  return {
    ok: errors.length === 0,
    text: texts.join("\n"),
    error: errors[0] ? `OCR 失败：${errors[0]}` : ""
  };
}

async function runTemplateCommand(command, replacements) {
  const rendered = Object.entries(replacements).reduce((current, [key, value]) => {
    return current.replaceAll(`{${key}}`, shellQuote(value));
  }, command);
  try {
    await execAsync(rendered, { timeout: 300_000 });
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
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

function firstHttpUrl(values = []) {
  return uniqueStrings(values).find((value) => /^https?:\/\//iu.test(value)) || "";
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

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}
