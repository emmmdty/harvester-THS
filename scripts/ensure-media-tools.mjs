import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  bundledMediaToolPath,
  resolvePackageBinary
} from "../src/media-tools.mjs";

const ROOT = process.cwd();
const DEFAULT_YTDLP_BASE_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

async function main() {
  const ytdlpPath = bundledMediaToolPath({ root: ROOT, tool: "yt-dlp" });
  await ensureYtDlp({ ytdlpPath });
  const ffmpegPath = await ensurePackagedTool({
    label: "ffmpeg",
    bundledPath: bundledMediaToolPath({ root: ROOT, tool: "ffmpeg" }),
    dependencyPath: resolvePackageBinary("@ffmpeg-installer/ffmpeg", "ffmpeg")
  });
  const ffprobePath = await ensurePackagedTool({
    label: "ffprobe",
    bundledPath: bundledMediaToolPath({ root: ROOT, tool: "ffprobe" }),
    dependencyPath: resolvePackageBinary("@ffprobe-installer/ffprobe", "ffprobe")
  });
  await assertExecutablePath("ffmpeg", ffmpegPath);
  await assertExecutablePath("ffprobe", ffprobePath);
  console.log(`yt-dlp ready: ${ytdlpPath}`);
  console.log(`ffmpeg ready: ${ffmpegPath}`);
  console.log(`ffprobe ready: ${ffprobePath}`);
}

async function ensurePackagedTool({ label, bundledPath, dependencyPath }) {
  if (await isExecutableFile(bundledPath)) return bundledPath;
  if (!dependencyPath || dependencyPath === label || !await isExecutableFile(dependencyPath)) {
    throw new Error(`${label} dependency is not installed. Run npm ci first.`);
  }
  await fs.mkdir(path.dirname(bundledPath), { recursive: true });
  await fs.copyFile(dependencyPath, bundledPath);
  await fs.chmod(bundledPath, 0o755).catch(() => {});
  return bundledPath;
}

async function ensureYtDlp({ ytdlpPath }) {
  if (await isExecutableFile(ytdlpPath)) return;
  const url = ytdlpDownloadUrl();
  await fs.mkdir(path.dirname(ytdlpPath), { recursive: true });
  await downloadFile(url, ytdlpPath);
  await fs.chmod(ytdlpPath, 0o755).catch(() => {});
  const stat = await fs.stat(ytdlpPath);
  if (stat.size < 1024 * 1024) {
    throw new Error(`Downloaded yt-dlp is unexpectedly small: ${stat.size} bytes`);
  }
}

function ytdlpDownloadUrl({ platform = process.platform, env = process.env } = {}) {
  const baseUrl = (env.YTDLP_DOWNLOAD_BASE_URL || DEFAULT_YTDLP_BASE_URL).replace(/\/$/u, "");
  if (platform === "win32") return `${baseUrl}/yt-dlp.exe`;
  if (platform === "darwin") return `${baseUrl}/yt-dlp_macos`;
  if (platform === "linux") return `${baseUrl}/yt-dlp_linux`;
  return `${baseUrl}/yt-dlp`;
}

async function downloadFile(url, targetPath) {
  const errors = [];
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, data, { mode: 0o755 });
    return;
  } catch (error) {
    errors.push(`fetch: ${error.message || String(error)}`);
  }

  const curl = await runCommand("curl", [
    "-L",
    "--fail",
    "--connect-timeout",
    "20",
    "--max-time",
    "180",
    "--retry",
    "2",
    "--progress-bar",
    "-o",
    targetPath,
    url
  ]);
  if (curl.code === 0) return;
  errors.push(`curl: ${curl.stderr || curl.stdout || `exit ${curl.code}`}`);

  if (process.platform === "win32") {
    const ps = await runCommand("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${escapePowerShellSingleQuoted(url)}' -OutFile '${escapePowerShellSingleQuoted(targetPath)}'`
    ]);
    if (ps.code === 0) return;
    errors.push(`powershell: ${ps.stderr || ps.stdout || `exit ${ps.code}`}`);
  }

  throw new Error(`Failed to download yt-dlp from ${url}. ${errors.join(" | ")}`);
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: error.message || String(error) });
    });
    child.on("close", (code) => {
      resolve({ code: code === null ? 1 : Number(code), stdout, stderr });
    });
  });
}

function escapePowerShellSingleQuoted(value = "") {
  return String(value).replace(/'/gu, "''");
}

async function assertExecutablePath(label, commandPath) {
  if (!commandPath || commandPath === label) {
    throw new Error(`${label} dependency is not installed. Run npm ci first.`);
  }
  if (!await isExecutableFile(commandPath)) {
    throw new Error(`${label} binary is missing: ${commandPath}`);
  }
}

async function isExecutableFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
