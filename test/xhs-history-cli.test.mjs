import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("package scripts expose XHS history crawl command", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["history:crawl:xhs"], "node src/crawl-xhs-history.mjs");
  assert.equal(pkg.scripts["crawl:xhs-history"], undefined);
});

test(".env.example documents the optional XHS history sheet id", () => {
  const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(envExample, /^FEISHU_SHEET_XHS_HISTORY=$/m);
});

test("XHS account config includes canonical Yanxishe profile URL", () => {
  const accountConfig = JSON.parse(fs.readFileSync(new URL("../platform-accounts.json", import.meta.url), "utf8"));
  assert.ok(accountConfig.xhs.some((account) => (
    account.name === "同花顺研习社"
    && account.url === "https://www.xiaohongshu.com/user/profile/6881e282000000001d0222e7"
  )));
  assert.equal(
    accountConfig.xhs.some((account) => /xsec_token|xsec_source/.test(account.url)),
    false
  );
});

test("XHS history CLI seeds from Feishu, keeps a local ledger, and supports skip-Feishu smoke runs", () => {
  const source = fs.readFileSync(new URL("../src/crawl-xhs-history.mjs", import.meta.url), "utf8");

  assert.match(source, /readSheetRows\("xhs"/);
  assert.match(source, /\.runtime\/xhs-history\/ledger\.jsonl/);
  assert.match(source, /readPlatformAccounts\("xhs"/);
  assert.match(source, /crawlAccountHistory/);
  assert.match(source, /upsertXhsHistorySheet/);
  assert.match(source, /createPendingXhsHistoryItem/);
  assert.match(source, /详情补全达到上限/);
  assert.match(source, /--skip-feishu/);
  assert.match(source, /--max-scrolls-per-account/);
});
