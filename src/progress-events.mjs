export const PROGRESS_LOG_PREFIX = "__HARVESTER_PROGRESS__";

export function formatProgressLogLine(event = {}) {
  return `${PROGRESS_LOG_PREFIX}${JSON.stringify(normalizeProgressEvent(event))}`;
}

export function parseProgressLogLine(line = "") {
  const text = String(line || "").trim();
  if (!text.startsWith(PROGRESS_LOG_PREFIX)) return null;
  try {
    return normalizeProgressEvent(JSON.parse(text.slice(PROGRESS_LOG_PREFIX.length)));
  } catch {
    return null;
  }
}

export function normalizeProgressEvent(event = {}) {
  const total = normalizeCount(event.total);
  const completed = Math.min(normalizeCount(event.completed), total || normalizeCount(event.completed));
  return {
    platformId: String(event.platformId || event.platform || ""),
    stage: String(event.stage || ""),
    phase: String(event.phase || ""),
    itemId: String(event.itemId || event.id || ""),
    completed,
    total,
    action: String(event.action || ""),
    updatedAt: normalizeTimestamp(event.updatedAt)
  };
}

export function emitProgress({ onProgress, log, logProgress = false, ...event } = {}) {
  const normalized = normalizeProgressEvent(event);
  if (typeof onProgress === "function") onProgress(normalized);
  if (logProgress && typeof log === "function") log(formatProgressLogLine(normalized));
  return normalized;
}

function normalizeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function normalizeTimestamp(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}
