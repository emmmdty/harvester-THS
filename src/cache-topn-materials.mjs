import fs from "node:fs/promises";
import path from "node:path";

import { cachePlatformMaterials as defaultCachePlatformMaterials } from "./materials/cache.mjs";

const SUPPORTED_PLATFORMS = new Set(["douyin", "xhs", "bilibili"]);
const PLATFORM_ALIASES = new Map([
  ["抖音", "douyin"],
  ["douyin", "douyin"],
  ["小红书", "xhs"],
  ["xhs", "xhs"],
  ["B站", "bilibili"],
  ["b站", "bilibili"],
  ["哔哩哔哩", "bilibili"],
  ["bilibili", "bilibili"]
]);

export function normalizeTopnJobs(input) {
  const jobs = parseTopnInput(input);
  return jobs.map((job, index) => {
    const platformRaw = String(job.platform || job.channel || "").trim();
    const platform = normalizePlatform(platformRaw);
    const item = {
      id: String(job.content_id || job.id || job.item_id || job.itemId || ""),
      link: String(job.content_url || job.url || job.link || job.itemUrl || ""),
      title: String(job.title || ""),
      author: String(job.account || job.author || ""),
      publishedAt: String(job.period_end || job.target_date || ""),
      metrics: isPlainObject(job.metrics) ? job.metrics : {}
    };
    return {
      index,
      job_id: String(job.job_id || job.jobId || job.id || `job-${index + 1}`),
      platform,
      platformRaw,
      skipped: !SUPPORTED_PLATFORMS.has(platform),
      item,
      raw: job
    };
  });
}

export async function runCacheTopnCli({
  argv = process.argv.slice(2),
  cachePlatformMaterials = defaultCachePlatformMaterials,
  cwd = process.cwd(),
  writeFile = fs.writeFile,
  readFile = fs.readFile,
  mkdir = fs.mkdir
} = {}) {
  const options = parseArgs(argv, cwd);
  if (!options.input || !options.out) {
    throw new Error("Usage: materials:cache-topn --input <json/jsonl> --out <manifest.json> [--root <harvester_root>] [--target-date <YYYY-MM-DD>]");
  }

  const inputText = await readFile(options.input, "utf8");
  const jobs = normalizeTopnJobs(inputText);
  const outputItems = jobs.map((job) => unsupportedManifestItem(job));
  const groups = groupSupportedJobs(jobs);

  for (const [platformId, groupJobs] of groups) {
    try {
      const result = await cachePlatformMaterials({
        platformId,
        items: groupJobs.map((job) => job.item),
        root: options.root,
        targetDate: options.targetDate,
        sinceDate: options.targetDate,
        untilDate: options.targetDate
      });
      const manifests = Array.isArray(result?.manifests) ? result.manifests : [];
      groupJobs.forEach((job, itemIndex) => {
        outputItems[job.index] = normalizeCachedManifestItem({
          job,
          manifest: manifests[itemIndex] || { ok: false, error: "cachePlatformMaterials did not return a manifest for this job." }
        });
      });
    } catch (error) {
      const errorMessage = error?.message || String(error);
      groupJobs.forEach((job) => {
        outputItems[job.index] = failedManifestItem(job, errorMessage);
      });
    }
  }

  const manifest = { items: outputItems };
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function parseArgs(args = [], cwd = process.cwd()) {
  const options = {
    input: "",
    out: "",
    root: cwd,
    targetDate: todayIso()
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const nextValue = () => inlineValue ?? args[++index] ?? "";
    if (flag === "--input") options.input = path.resolve(cwd, nextValue());
    else if (flag === "--out") options.out = path.resolve(cwd, nextValue());
    else if (flag === "--root") options.root = path.resolve(cwd, nextValue());
    else if (flag === "--target-date") options.targetDate = nextValue();
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseTopnInput(input) {
  if (Array.isArray(input)) return input;
  if (isPlainObject(input)) return Array.isArray(input.items) ? input.items : [input];
  const text = String(input || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (isPlainObject(parsed)) return Array.isArray(parsed.items) ? parsed.items : [parsed];
    return [];
  } catch {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid JSONL on line ${index + 1}: ${error.message || String(error)}`);
        }
      });
  }
}

function normalizePlatform(value) {
  return PLATFORM_ALIASES.get(value) || PLATFORM_ALIASES.get(value.toLowerCase?.() || "") || value;
}

function groupSupportedJobs(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    if (job.skipped) continue;
    if (!groups.has(job.platform)) groups.set(job.platform, []);
    groups.get(job.platform).push(job);
  }
  return groups;
}

function normalizeCachedManifestItem({ job, manifest = {} }) {
  const invalidReason = invalidManifestReason({ job, manifest });
  const ok = Boolean(manifest.ok) && !invalidReason;
  const screenshots = uniquePaths([
    ...asArray(manifest.imagePaths),
    ...assetPaths(manifest.assets, ["image", "screenshot", "cover", "thumbnail"])
  ]);
  const frames = uniquePaths([
    ...asArray(manifest.framePaths),
    ...assetPaths(manifest.assets, ["frame"])
  ]);
  const videoPath = manifest.videoPath || firstAssetPath(manifest.assets, ["video"]) || "";
  return {
    job_id: job.job_id,
    status: ok ? "succeeded" : "failed",
    platform: job.platform,
    asset_dir: manifest.assetDir || manifest.itemDir || manifest.dir || "",
    cover_path: ok ? (manifest.coverPath || screenshots[0] || "") : "",
    video_path: ok ? videoPath : "",
    screenshots: ok ? screenshots : [],
    frames: ok ? frames : [],
    metadata: isPlainObject(manifest.metadata) ? manifest.metadata : {},
    error_message: ok ? "" : (invalidReason || errorText(manifest))
  };
}

function unsupportedManifestItem(job) {
  if (!job.skipped) {
    return failedManifestItem(job, "Pending cache result.");
  }
  return failedManifestItem(job, `Unsupported platform: ${job.platform || job.platformRaw || "unknown"}`);
}

function failedManifestItem(job, errorMessage) {
  return {
    job_id: job.job_id,
    status: "failed",
    platform: job.platform || job.platformRaw || "",
    asset_dir: "",
    cover_path: "",
    video_path: "",
    screenshots: [],
    frames: [],
    metadata: {},
    error_message: errorMessage
  };
}

function errorText(manifest = {}) {
  return String(manifest.error_message || manifest.errorMessage || manifest.error || manifest.stderr || "");
}

function invalidManifestReason({ job = {}, manifest = {} } = {}) {
  if (job.platform !== "douyin") return "";
  const fallback = isPlainObject(manifest.fallback) ? manifest.fallback : {};
  const fallbackKind = String(fallback.kind || "");
  const extractedMedia = Boolean(fallback.extractedMedia || fallback.extracted_media);
  const text = [
    manifest.error,
    manifest.error_message,
    manifest.errorMessage,
    manifest.fallbackReason,
    fallback.riskReason,
    fallback.extractError
  ].map((value) => String(value || "")).join("\n");
  if (/视频不存在|观看的视频不存在|内容不存在|页面不存在|404/iu.test(text)) {
    return "抖音页面不可访问，未取得真实素材。";
  }
  if (fallbackKind === "douyin-note-visual" && !extractedMedia && /yt-dlp|下载失败|未获取到素材/iu.test(text)) {
    return "抖音截图兜底未取得真实媒体，不能作为素材证据。";
  }
  return "";
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function assetPaths(assets, types) {
  return asArray(assets)
    .filter((asset) => {
      if (typeof asset === "string") return types.includes("image");
      return types.includes(String(asset?.type || "").toLowerCase());
    })
    .map((asset) => (typeof asset === "string" ? asset : (asset.path || asset.file || asset.url || "")))
    .filter(Boolean);
}

function firstAssetPath(assets, types) {
  return assetPaths(assets, types)[0] || "";
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: npm run materials:cache-topn -- --input <json/jsonl> --out <manifest.json> [--root <harvester_root>] [--target-date <YYYY-MM-DD>]");
      return;
    }
    await runCacheTopnCli();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(path.resolve(process.argv[1]), "file:").href) {
  await main();
}
