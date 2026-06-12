import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

test("package exposes the Douyin history crawl script", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));

  assert.equal(pkg.scripts["history:crawl:douyin"], "node src/crawl-douyin-history.mjs");
  assert.equal(pkg.scripts["crawl:douyin-history"], undefined);
});

test("Douyin history CLI uses post API inventory, local ledger, fallback cap, and Feishu upsert", async () => {
  const source = await fs.readFile(path.join(ROOT, "src/crawl-douyin-history.mjs"), "utf8");

  assert.match(source, /\/aweme\/v1\/web\/aweme\/post\//);
  assert.match(source, /MAX_PAGES_PER_ACCOUNT/);
  assert.match(source, /EMPTY_PAGES_LIMIT/);
  assert.match(source, /PAGE_DELAY_MS/);
  assert.match(source, /crawlAccountCursorInventory/);
  assert.match(source, /writeHistoryRunAudit/);
  assert.match(source, /MAX_HISTORY_DETAIL_FALLBACK/);
  assert.match(source, /\.runtime\/douyin-history\/ledger\.jsonl/);
  assert.match(source, /readPlatformAccounts\("douyin"/);
  assert.match(source, /--skip-feishu/);
  assert.match(source, /upsertHistorySheet/);
});

test("Douyin history rebuild backs up data, rewrites Feishu, and audits excluded candidates", async () => {
  const source = await fs.readFile(path.join(ROOT, "src/crawl-douyin-history.mjs"), "utf8");

  assert.match(source, /--rebuild/);
  assert.match(source, /--max-pages-per-account/);
  assert.match(source, /--empty-pages-limit/);
  assert.match(source, /--page-delay-ms/);
  assert.match(source, /backupRuntimeInputs/);
  assert.match(source, /backupFeishuHistory/);
  assert.match(source, /replaceHistorySheet/);
  assert.match(source, /writeExcludedHistoryOutputs/);
  assert.match(source, /filterHistoryItemsForAccount/);
});

test("Douyin history CLI does not add visible DOM links directly to the main ledger", async () => {
  const source = await fs.readFile(path.join(ROOT, "src/crawl-douyin-history.mjs"), "utf8");

  assert.match(source, /visibleCandidates/);
  assert.match(source, /detailCandidates/);
  assert.match(source, /queueVisibleCandidatesForDetail/);
  assert.doesNotMatch(source, /addHistoryItem\(items,\s*seenThisAccount,\s*item\);/);
});

test(".env.example documents the optional Douyin history sheet id", async () => {
  const envExample = await fs.readFile(path.join(ROOT, ".env.example"), "utf8");

  assert.match(envExample, /^FEISHU_SHEET_DOUYIN_HISTORY=$/m);
});
