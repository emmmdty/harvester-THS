import fs from "node:fs/promises";
import path from "node:path";

export const CACHE_ROOTS = [
  path.join(".runtime", "detail-cache"),
  path.join(".runtime", "douyin-channel-type-classifier", "cache")
];

export async function summarizeCacheStorage(root = process.cwd()) {
  const roots = await discoverCacheRoots(root);
  let bytes = 0;
  const summaries = [];
  for (const relativePath of roots) {
    const absolutePath = path.join(root, relativePath);
    const size = await directorySize(absolutePath);
    bytes += size.bytes;
    summaries.push({
      path: absolutePath,
      relativePath,
      bytes: size.bytes,
      formattedSize: formatBytes(size.bytes),
      exists: size.exists
    });
  }
  return {
    path: path.join(root, ".runtime"),
    relativePath: ".runtime",
    bytes,
    formattedSize: formatBytes(bytes),
    roots: summaries
  };
}

export async function discoverCacheRoots(root = process.cwd()) {
  const roots = new Set(CACHE_ROOTS);
  const classifierRoot = path.join(root, ".runtime", "douyin-channel-type-classifier");
  const entries = await fs.readdir(classifierRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("cache")) continue;
    roots.add(path.join(".runtime", "douyin-channel-type-classifier", entry.name));
  }
  return [...roots].sort();
}

export async function cleanupCacheStorage(root = process.cwd()) {
  const roots = await discoverCacheRoots(root);
  const removed = [];
  for (const relativePath of roots) {
    const absolutePath = path.join(root, relativePath);
    const stat = await fs.stat(absolutePath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    await fs.rm(absolutePath, { recursive: true, force: true });
    removed.push(relativePath);
  }
  return { removed, cache: await summarizeCacheStorage(root) };
}

async function directorySize(targetPath) {
  const stat = await fs.stat(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return { exists: false, bytes: 0 };
  if (!stat.isDirectory()) return { exists: true, bytes: stat.size };

  let bytes = 0;
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      bytes += (await directorySize(entryPath)).bytes;
    } else if (entry.isFile()) {
      bytes += (await fs.stat(entryPath)).size;
    }
  }
  return { exists: true, bytes };
}

export function formatBytes(bytes = 0) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
