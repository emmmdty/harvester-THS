import "dotenv/config";

import { cleanDailyStep15 } from "./step15-cleaner.mjs";
import { normalizeDateInput, previousDateString } from "./date-utils.mjs";

const ROOT = process.cwd();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetDate = normalizeDateInput(options.targetDate || process.env.TARGET_DATE || previousDateString());
  const result = await cleanDailyStep15({
    root: ROOT,
    targetDate,
    log: console.log
  });
  console.log(`Step 1.5 清洗完成：${result.summaryPath}`);
  console.log(`抖音：通过 ${result.summary.douyin.pass}，不投放 ${result.summary.douyin.reject}，需复核 ${result.summary.douyin.review}`);
  console.log(`小红书：${summaryText(result.summary.xhs)}，B站：${summaryText(result.summary.bilibili)}`);
}

function summaryText(summary = {}) {
  if (Number.isFinite(summary.total)) {
    return `通过 ${summary.pass || 0}，不投放 ${summary.reject || 0}，需复核 ${summary.review || 0}`;
  }
  return `保留 ${summary.kept || 0}`;
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
