import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const APP_NAME = "作品采集器";
const STAGING_DIR = path.join(DIST_DIR, APP_NAME);

const REQUIRED_FILES = [
  ".env",
  ".env.example",
  "package.json",
  "package-lock.json",
  "platform-accounts.json",
  "README.md",
  "scripts/ensure-media-tools.mjs",
  "scripts/select-panel-port.mjs",
  "启动作品采集面板.command",
  "启动作品采集面板.cmd"
];

const REQUIRED_DIRS = [
  "src",
  "public",
  "docs",
  "tools"
];

const REQUIRED_PROMPT_DOCS = [
  "docs/xhs-content-type-taxonomy.md",
  "docs/douyin-channel-type-taxonomy.md",
  "docs/bilibili-content-type-taxonomy.md",
  "docs/developer-maintenance.md"
];

const REQUIRED_MEDIA_TOOL_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-x64"
];

const EXCLUDED_NAMES = new Set([
  ".DS_Store",
  "package-release.mjs"
]);

async function main() {
  await assertRequiredInputs();
  await fs.rm(STAGING_DIR, { recursive: true, force: true });
  await fs.mkdir(STAGING_DIR, { recursive: true });

  let copiedFiles = 0;
  for (const file of REQUIRED_FILES) {
    await copyFile(file);
    copiedFiles += 1;
  }
  for (const dir of REQUIRED_DIRS) {
    copiedFiles += await copyDir(dir);
  }

  await fs.chmod(path.join(STAGING_DIR, "启动作品采集面板.command"), 0o755);

  const zipPath = path.join(DIST_DIR, `${APP_NAME}-${timestamp()}.zip`);
  await removePreviousPackages();
  await createZipFromDirectory(STAGING_DIR, zipPath, APP_NAME);

  const checks = await verifyPackageTree(STAGING_DIR);
  console.log(`交付目录：${STAGING_DIR}`);
  console.log(`压缩包：${zipPath}`);
  console.log(`复制文件数：${copiedFiles}`);
  console.log(`包含 .env：${checks.hasEnv ? "是" : "否"}`);
  console.log(`包含启动脚本：${checks.hasLaunchers ? "是" : "否"}`);
  console.log(`包含端口选择脚本：${checks.hasPanelPortSelector ? "是" : "否"}`);
  console.log(`包含媒体工具准备脚本：${checks.hasMediaToolBootstrap ? "是" : "否"}`);
  console.log(`包含本地媒体工具：${checks.hasBundledMediaTools ? "是" : "否"}`);
  console.log(`包含 Prompt 维护文档：${checks.hasPromptDocs ? "是" : "否"}`);
  console.log(`排除运行产物：${checks.hasExcludedRuntime ? "失败" : "通过"}`);
  assertPackageChecks(checks);
}

async function assertRequiredInputs() {
  const missing = [];
  for (const item of [...REQUIRED_FILES, ...REQUIRED_DIRS]) {
    try {
      await fs.access(path.join(ROOT, item));
    } catch {
      missing.push(item);
    }
  }
  if (missing.length > 0) {
    throw new Error(`缺少打包必需文件：${missing.join("、")}`);
  }
}

async function copyFile(relativePath) {
  const source = path.join(ROOT, relativePath);
  const target = path.join(STAGING_DIR, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function copyDir(relativePath) {
  let count = 0;
  const sourceDir = path.join(ROOT, relativePath);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(child);
    } else if (entry.isFile()) {
      await copyFile(child);
      count += 1;
    }
  }
  return count;
}

async function removePreviousPackages() {
  const entries = await fs.readdir(DIST_DIR, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${APP_NAME}-`) && entry.name.endsWith(".zip"))
    .map((entry) => fs.rm(path.join(DIST_DIR, entry.name), { force: true })));
}

async function verifyPackageTree(packageDir) {
  const allPaths = await listRelativeFiles(packageDir);
  const pathSet = new Set(allPaths);
  const requiredPromptDocs = REQUIRED_PROMPT_DOCS.map((item) => item.split(path.sep).join(path.posix.sep));
  return {
    hasEnv: pathSet.has(".env"),
    hasLaunchers: pathSet.has("启动作品采集面板.command") && pathSet.has("启动作品采集面板.cmd"),
    hasPanelPortSelector: pathSet.has("scripts/select-panel-port.mjs"),
    hasMediaToolBootstrap: pathSet.has("scripts/ensure-media-tools.mjs"),
    hasBundledMediaTools: REQUIRED_MEDIA_TOOL_PLATFORMS.every((platform) => (
      pathSet.has(`tools/${platform}/${platform === "win32-x64" ? "yt-dlp.exe" : "yt-dlp"}`)
      && pathSet.has(`tools/${platform}/${platform === "win32-x64" ? "ffmpeg.exe" : "ffmpeg"}`)
      && pathSet.has(`tools/${platform}/${platform === "win32-x64" ? "ffprobe.exe" : "ffprobe"}`)
    )),
    hasPromptDocs: requiredPromptDocs.every((item) => pathSet.has(item)),
    hasExcludedRuntime: allPaths.some((item) => (
      item.startsWith(".git/")
      || item.startsWith("node_modules/")
      || item.startsWith("output/")
      || item.startsWith(".runtime/")
      || item.startsWith(".xhs-profile/")
      || item.startsWith(".douyin-profile/")
      || item.startsWith(".bilibili-profile/")
      || item.endsWith("/manifest.json")
      || item.includes("/.DS_Store")
      || item === ".DS_Store"
    ))
  };
}

function assertPackageChecks(checks) {
  const failures = [];
  if (!checks.hasEnv) failures.push("缺少 .env");
  if (!checks.hasLaunchers) failures.push("缺少双击启动脚本");
  if (!checks.hasPanelPortSelector) failures.push("缺少端口选择脚本");
  if (!checks.hasMediaToolBootstrap) failures.push("缺少媒体工具准备脚本");
  if (!checks.hasBundledMediaTools) failures.push("缺少本地 yt-dlp/ffmpeg/ffprobe");
  if (!checks.hasPromptDocs) failures.push("缺少 Prompt 维护文档");
  if (checks.hasExcludedRuntime) failures.push("混入运行产物");
  if (failures.length > 0) {
    throw new Error(`交付包校验失败：${failures.join("、")}`);
  }
}

async function listRelativeFiles(rootDir, current = "") {
  const absolute = path.join(rootDir, current);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(current.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(rootDir, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join("");
}

async function createZipFromDirectory(sourceDir, zipPath, rootName) {
  const files = await listRelativeFiles(sourceDir);
  const records = [];
  const chunks = [];
  let offset = 0;

  for (const relativePath of files) {
    const absolutePath = path.join(sourceDir, relativePath);
    const data = await fs.readFile(absolutePath);
    const stat = await fs.stat(absolutePath);
    const zipName = `${rootName}/${relativePath.split(path.sep).join("/")}`;
    const nameBytes = Buffer.from(zipName);
    const crc = crc32(data);
    const dos = dosDateTime(stat.mtime);
    const mode = relativePath.endsWith(".command") ? 0o100755 : 0o100644;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dos.time, 10);
    localHeader.writeUInt16LE(dos.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, nameBytes, data);
    records.push({ zipName, nameBytes, crc, size: data.length, offset, dos, mode });
    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  for (const record of records) {
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(record.dos.time, 12);
    centralHeader.writeUInt16LE(record.dos.date, 14);
    centralHeader.writeUInt32LE(record.crc, 16);
    centralHeader.writeUInt32LE(record.size, 20);
    centralHeader.writeUInt32LE(record.size, 24);
    centralHeader.writeUInt16LE(record.nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((record.mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(record.offset, 42);
    chunks.push(centralHeader, record.nameBytes);
    offset += centralHeader.length + record.nameBytes.length;
  }

  const centralSize = offset - centralStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.writeFile(zipPath, Buffer.concat(chunks));
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
