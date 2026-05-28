#!/usr/bin/env node

import { formatBytes, planRuntimeCleanup } from "./runtime-cleanup.mjs";

const apply = process.argv.includes("--apply");
const plan = await planRuntimeCleanup({ apply, log: console.log });

if (plan.candidates.length === 0) {
  console.log("没有发现可清理的运行产物。");
} else {
  console.log(`${apply ? "已清理" : "清理预览"}：${plan.candidates.length} 项，合计 ${formatBytes(plan.totalBytes)}。`);
  for (const candidate of plan.candidates) {
    console.log(`${apply ? "DELETED" : "DRY-RUN"} ${candidate.relativePath} ${formatBytes(candidate.bytes)}`);
  }
}

if (!apply) {
  console.log("本次未删除任何文件。确认后可执行：node src/cleanup-runtime.mjs --apply");
}
