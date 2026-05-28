import fs from "node:fs/promises";
import path from "node:path";

const GENERATED_DIRECTORIES = [
  "output/feishu-backups",
  "output/step15-assets",
  "output/step15-eval",
  ".runtime/detail-cache"
];

const GENERATED_OUTPUT_FILE_PATTERNS = [
  /^step15-policy-eval-.+\.json$/u,
  /^logistic-policy-model-.+\.json$/u,
  /^excel_history_import_.+\.json$/u,
  /^step15_repair_(backup|report)_.+\.json$/u
];

export async function planRuntimeCleanup({
  root = process.cwd(),
  apply = false,
  log = () => {}
} = {}) {
  const candidates = [];
  for (const relativePath of GENERATED_DIRECTORIES) {
    await addCandidateIfExists(candidates, root, relativePath);
  }
  await addGeneratedOutputFiles(candidates, root);

  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const totalBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);

  if (apply) {
    for (const candidate of candidates) {
      await fs.rm(path.join(root, candidate.relativePath), { recursive: true, force: true });
      log(`已删除 ${candidate.relativePath}`);
    }
  }

  return {
    apply: Boolean(apply),
    totalBytes,
    candidates
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024 || unit === units.at(-1)) return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
    size /= 1024;
  }
  return `${value} B`;
}

async function addGeneratedOutputFiles(candidates, root) {
  const outputDir = path.join(root, "output");
  let entries = [];
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!GENERATED_OUTPUT_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
    await addCandidateIfExists(candidates, root, path.join("output", entry.name));
  }
}

async function addCandidateIfExists(candidates, root, relativePath) {
  const normalized = toPosixPath(relativePath);
  const fullPath = path.join(root, normalized);
  const stat = await fs.stat(fullPath).catch(() => null);
  if (!stat) return;
  candidates.push({
    relativePath: normalized,
    bytes: await pathSize(fullPath, stat),
    kind: stat.isDirectory() ? "directory" : "file"
  });
}

async function pathSize(fullPath, stat = null) {
  const current = stat || await fs.stat(fullPath);
  if (!current.isDirectory()) return current.size;
  const entries = await fs.readdir(fullPath, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    total += await pathSize(path.join(fullPath, entry.name));
  }
  return total;
}

function toPosixPath(value) {
  return String(value || "").split(path.sep).join("/");
}
