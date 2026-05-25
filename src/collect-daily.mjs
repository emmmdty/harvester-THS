import "dotenv/config";
import { endExclusiveDateToInclusiveUntilDate, normalizeDateInput, previousDateString } from "./date-utils.mjs";
import { DAILY_PLATFORM_IDS, getPlatformConfig } from "./platform-config.mjs";
import { normalizeCrawlMode } from "./crawl-runtime.mjs";
import { collectDaily } from "./collect-daily-runner.mjs";

const ROOT = process.cwd();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hasRangeInput = Boolean(options.since || process.env.SINCE || options.until || process.env.UNTIL);
  const targetDate = normalizeDateInput(options.targetDate || process.env.TARGET_DATE || (!hasRangeInput ? previousDateString() : options.since || process.env.SINCE));
  const sinceDate = normalizeDateInput(options.since || process.env.SINCE || targetDate);
  const untilDate = options.until || process.env.UNTIL
    ? endExclusiveDateToInclusiveUntilDate(sinceDate, normalizeDateInput(options.until || process.env.UNTIL))
    : targetDate;
  const platforms = parsePlatforms(options.platform || "all");
  const skipFeishu = Boolean(options.skipFeishu);
  const crawlMode = normalizeCrawlMode(options.mode || process.env.CRAWL_MODE);

  const result = await collectDaily({
    root: ROOT,
    targetDate,
    sinceDate,
    untilDate,
    platforms,
    skipFeishu,
    crawlMode
  });

  if (!result.ok) process.exitCode = 1;
}

function parsePlatforms(value) {
  if (!value || value === "all") return DAILY_PLATFORM_IDS;
  const platforms = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  for (const platformId of platforms) getPlatformConfig(platformId);
  return platforms;
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target-date" || arg === "-d") {
      options.targetDate = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--target-date=")) {
      options.targetDate = arg.slice("--target-date=".length);
      continue;
    }
    if (arg === "--since" || arg === "-s") {
      options.since = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--since=")) {
      options.since = arg.slice("--since=".length);
      continue;
    }
    if (arg === "--until" || arg === "-u") {
      options.until = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--until=")) {
      options.until = arg.slice("--until=".length);
      continue;
    }
    if (arg === "--platform" || arg === "-p") {
      options.platform = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      options.platform = arg.slice("--platform=".length);
      continue;
    }
    if (arg === "--skip-feishu") {
      options.skipFeishu = true;
      continue;
    }
    if (arg === "--mode") {
      options.mode = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
      continue;
    }
    if (!options.targetDate && !arg.startsWith("-")) {
      options.targetDate = arg;
    }
  }
  return options;
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
