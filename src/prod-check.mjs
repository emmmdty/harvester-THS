#!/usr/bin/env node

import "dotenv/config";

import { runProductionCheck } from "./prod-checker.mjs";

const result = await runProductionCheck();

for (const item of result.checks) {
  console.log(`${item.status.toUpperCase()} ${item.id}: ${item.message}`);
}
console.log(result.summary);

if (!result.ok) process.exitCode = 1;
