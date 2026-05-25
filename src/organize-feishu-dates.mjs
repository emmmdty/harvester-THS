import "dotenv/config";

import { organizeExistingFeishuDates } from "./feishu-date-organizer.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await organizeExistingFeishuDates({
    apply: Boolean(options.apply)
  });
  console.log(`飞书日期整理${options.apply ? "已写回" : "预览完成"}：${summary.backupDir}`);
  if (!options.apply) {
    console.log("未写回飞书；确认预览无误后使用 --apply。");
  }
}

function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    if (arg === "--apply") options.apply = true;
  }
  return options;
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
