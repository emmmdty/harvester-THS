import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("package scripts expose Bilibili history crawl command", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["history:crawl:bilibili"], "node src/crawl-bilibili-history.mjs");
  assert.equal(pkg.scripts["crawl:bilibili-history"], undefined);
});

test(".env.example documents the optional Bilibili history sheet id", () => {
  const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(envExample, /^FEISHU_SHEET_BILIBILI_HISTORY=$/m);
});
