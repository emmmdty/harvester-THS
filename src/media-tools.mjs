import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

export function resolveYtDlpCommand({
  root = process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
  allowMissingBundled = false
} = {}) {
  if (env.MATERIAL_YTDLP_BIN) return env.MATERIAL_YTDLP_BIN;
  if (env.YTDLP_BIN) return env.YTDLP_BIN;
  const bundled = bundledMediaToolPath({ root, platform, arch, tool: "yt-dlp" });
  if (allowMissingBundled || exists(bundled)) return bundled;
  return platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

export function resolveFfmpegCommand({
  root = process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync
} = {}) {
  if (env.FFMPEG_BIN) return env.FFMPEG_BIN;
  const bundled = bundledMediaToolPath({ root, platform, arch, tool: "ffmpeg" });
  if (exists(bundled)) return bundled;
  return resolvePackageBinary("@ffmpeg-installer/ffmpeg", "ffmpeg");
}

export function resolveFfprobeCommand({
  root = process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync
} = {}) {
  if (env.FFPROBE_BIN) return env.FFPROBE_BIN;
  const bundled = bundledMediaToolPath({ root, platform, arch, tool: "ffprobe" });
  if (exists(bundled)) return bundled;
  return resolvePackageBinary("@ffprobe-installer/ffprobe", "ffprobe");
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function bundledMediaToolPath({
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  tool
} = {}) {
  const extension = platform === "win32" ? ".exe" : "";
  return path.join(root, "tools", platformKey(platform, arch), `${tool}${extension}`);
}

export function resolvePackageBinary(packageName, fallbackCommand) {
  try {
    const loaded = require(packageName);
    if (typeof loaded === "string") return loaded;
    if (loaded?.path) return loaded.path;
  } catch {
    // Fall through to PATH command so development shells still work before npm ci.
  }
  return fallbackCommand;
}
