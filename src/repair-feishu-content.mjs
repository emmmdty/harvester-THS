import "dotenv/config";

import { repairExistingFeishuContent } from "./feishu-content-repair.mjs";
import { validateFeishuConfig } from "./feishu-sheets.mjs";

const PLATFORM_IDS = ["douyin", "xhs", "bilibili"];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const validation = validateFeishuConfig();
  if (!validation.ok) {
    console.error(validation.message);
    process.exitCode = 1;
    return;
  }

  const summary = await repairExistingFeishuContent({
    apply: options.apply,
    platforms: options.platforms,
    organizeDates: options.organizeDates
  });

  for (const [platformId, result] of Object.entries(summary.platforms)) {
    console.log([
      `${platformId}：`,
      `日期移动 ${result.moves.length}`,
      `URL ${result.changes.url}`,
      `标题 ${result.changes.title}`,
      `tag ${result.changes.tags}`,
      `未解析 ${result.unresolved.length}`
    ].join(" "));
    const samples = result.moves.slice(0, 8);
    for (const move of samples) {
      console.log(`  - 第 ${move.rowNumber} 行 ${move.id || "-"}：${move.from} -> ${move.to}`);
    }
    if (result.moves.length > samples.length) {
      console.log(`  - 其余 ${result.moves.length - samples.length} 条日期移动省略。`);
    }
  }

  console.log(`飞书内容修复${options.apply ? "已写回" : "预览完成"}：${summary.backupDir}`);
  if (!options.apply) {
    console.log("当前为 dry-run，未写入飞书。确认后运行：npm run repair:feishu-content -- --apply");
  }
}

function parseArgs(args) {
  const options = { apply: false, platforms: PLATFORM_IDS, organizeDates: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--no-date-move") {
      options.organizeDates = false;
      continue;
    }
    if (arg === "--platform" || arg === "-p") {
      options.platforms = parsePlatforms(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      options.platforms = parsePlatforms(arg.slice("--platform=".length));
      continue;
    }
  }
  return options;
}

function parsePlatforms(value) {
  if (!value || value === "all") return PLATFORM_IDS;
  const platforms = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const platformId of platforms) {
    if (!PLATFORM_IDS.includes(platformId)) {
      throw new Error(`不支持的平台：${platformId}，仅支持 ${PLATFORM_IDS.join(", ")}`);
    }
  }
  return platforms;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
