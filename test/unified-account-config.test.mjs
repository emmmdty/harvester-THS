import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

test("server and crawlers use the unified platform account config only", async () => {
  const files = {
    server: await fs.readFile(path.join(ROOT, "src", "server.mjs"), "utf8"),
    xhs: await fs.readFile(path.join(ROOT, "src", "crawl-xhs.mjs"), "utf8"),
    douyin: await fs.readFile(path.join(ROOT, "src", "crawl-douyin.mjs"), "utf8"),
    bilibili: await fs.readFile(path.join(ROOT, "src", "crawl-bilibili.mjs"), "utf8")
  };
  const combined = Object.values(files).join("\n");

  assert.match(files.server, /readPlatformAccounts/);
  assert.match(files.xhs, /readPlatformAccounts\("xhs"/);
  assert.match(files.douyin, /readPlatformAccounts\("douyin"/);
  assert.match(files.bilibili, /readPlatformAccounts\("bilibili"/);

  assert.doesNotMatch(combined, /loadXhsAccounts|selectXhsAccounts|xhs-accounts/);
  assert.doesNotMatch(combined, /accounts\.json|douyin-accounts\.json/);
  assert.doesNotMatch(combined, /DEFAULT_ACCOUNTS|const ACCOUNT/);
  assert.doesNotMatch(combined, /body\?\.account|accountFilter|--account|XHS_ACCOUNT/);
});

test("docs and deployment config expose only the unified account manager", async () => {
  const files = [
    "README.md",
    ".env.example",
    "docker-compose.yml",
    "启动作品采集面板.command",
    "启动作品采集面板.cmd"
  ];
  const combined = (await Promise.all(files.map((file) => fs.readFile(path.join(ROOT, file), "utf8")))).join("\n");

  assert.match(combined, /platform-accounts\.json/);
  assert.doesNotMatch(combined, /PANEL_PASSWORD|共享口令/);
  assert.doesNotMatch(combined, /(^|[^-\w])accounts\.json|douyin-accounts\.json/);
});

test("double-click launch docs and scripts describe the all-platform panel", async () => {
  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  const localCommand = await fs.readFile(path.join(ROOT, "启动作品采集面板.command"), "utf8");
  const localCmd = await fs.readFile(path.join(ROOT, "启动作品采集面板.cmd"), "utf8");
  const launchText = `${localCommand}\n${localCmd}`;
  const removedLaunchFiles = [
    "启动小红书爬取面板.command",
    "启动小红书爬取面板.cmd",
    "启动局域网作品采集面板.command",
    "启动局域网作品采集面板.cmd"
  ];

  assert.match(readme, /启动作品采集面板\.command/);
  assert.match(readme, /启动作品采集面板\.cmd/);
  assert.doesNotMatch(readme, /启动小红书爬取面板|启动局域网作品采集面板/);

  assert.match(launchText, /作品采集面板/);
  assert.match(launchText, /小红书、抖音、B站、全渠道/);
  assert.match(launchText, /platform-accounts\.json/);
  assert.match(launchText, /定时采集.*全渠道/);
  assert.match(readme, /默认按局域网模式启动/);
  assert.match(localCommand, /局域网模式/);
  assert.match(localCommand, /HOST=0\.0\.0\.0 npm run ui/);
  assert.match(localCmd, /局域网模式/);
  assert.match(localCmd, /set "HOST=0\.0\.0\.0"/);
  assert.match(localCmd, /chcp 65001 >nul/);

  await Promise.all(removedLaunchFiles.map(async (file) => {
    await assert.rejects(fs.stat(path.join(ROOT, file)), { code: "ENOENT" });
  }));
});
