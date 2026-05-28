import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 20;
const HISTORY_PATH = path.join(".runtime", "scheduler-runs.json");

export async function readSchedulerRunHistory({ root = process.cwd() } = {}) {
  const filePath = path.join(root, HISTORY_PATH);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    return {
      latest: parsed.latest || runs.at(-1) || null,
      runs
    };
  } catch {
    return { latest: null, runs: [] };
  }
}

export async function recordSchedulerRun({
  root = process.cwd(),
  event,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => new Date()
} = {}) {
  if (!event || typeof event !== "object") throw new Error("scheduler run event is required");
  const history = await readSchedulerRunHistory({ root });
  const normalized = normalizeSchedulerRunEvent(event, now);
  const runs = [...history.runs, normalized].slice(-Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES));
  const payload = {
    latest: normalized,
    runs
  };
  const filePath = path.join(root, HISTORY_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function normalizeSchedulerRunEvent(event, now) {
  const timestamp = now().toISOString();
  return {
    status: String(event.status || "unknown"),
    targetDate: String(event.targetDate || ""),
    triggeredAt: event.triggeredAt || timestamp,
    finishedAt: event.finishedAt || "",
    exitCode: event.exitCode !== undefined && event.exitCode !== null && Number.isFinite(Number(event.exitCode))
      ? Number(event.exitCode)
      : null,
    reason: String(event.reason || ""),
    recordedAt: timestamp
  };
}
