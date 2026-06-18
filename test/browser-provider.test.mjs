import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  activateChromiumWindow,
  resolveCrawlerHeadless,
  resolveMaterialFallbackHeadless
} from "../src/browser-env.mjs";

test("daily crawler entrypoints keep the original Playwright browser runtime", async () => {
  const root = process.cwd();
  const files = [
    "src/crawl-xhs.mjs",
    "src/crawl-xhs-history.mjs",
    "src/login-xhs.mjs",
    "src/materials/browser-fallback.mjs"
  ];

  for (const fileName of files) {
    const source = await fs.readFile(path.join(root, fileName), "utf8");
    assert.doesNotMatch(source, /browser-provider|loadChromiumForPlatform|patchright/iu, fileName);
  }

  const crawlXhs = await fs.readFile(path.join(root, "src", "crawl-xhs.mjs"), "utf8");
  const loginXhs = await fs.readFile(path.join(root, "src", "login-xhs.mjs"), "utf8");
  assert.match(crawlXhs, /import \{ chromium \} from "playwright"/u);
  assert.match(loginXhs, /import \{ chromium \} from "playwright"/u);
});

test("crawler browser sessions default to background mode while allowing explicit visible override", () => {
  assert.equal(resolveCrawlerHeadless({}), true);
  assert.equal(resolveCrawlerHeadless({ CRAWL_BROWSER_HEADLESS: "0" }), false);
  assert.equal(resolveCrawlerHeadless({ CRAWL_HEADLESS: "false" }), false);
  assert.equal(resolveCrawlerHeadless({ HEADLESS: "0" }), true);
  assert.equal(resolveCrawlerHeadless({ HEADLESS: "1" }), true);
});

test("material browser fallback defaults to background with explicit debug overrides", () => {
  assert.equal(resolveMaterialFallbackHeadless({}), true);
  assert.equal(resolveMaterialFallbackHeadless({ MATERIAL_BROWSER_FALLBACK_HEADLESS: "0", PLAYWRIGHT_HEADLESS: "1" }), false);
  assert.equal(resolveMaterialFallbackHeadless({ MATERIAL_FALLBACK_HEADLESS: "false" }), false);
  assert.equal(resolveMaterialFallbackHeadless({ PLAYWRIGHT_HEADLESS: "0" }), false);
  assert.equal(resolveMaterialFallbackHeadless({ PLAYWRIGHT_HEADLESS: "1" }), true);
  assert.equal(resolveMaterialFallbackHeadless({ CRAWL_BROWSER_HEADLESS: "0" }), false);
});

test("crawler entrypoints use crawler headless resolver but login entrypoints stay interactive", async () => {
  const root = process.cwd();
  const crawlXhs = await fs.readFile(path.join(root, "src", "crawl-xhs.mjs"), "utf8");
  const loginXhs = await fs.readFile(path.join(root, "src", "login-xhs.mjs"), "utf8");
  const fallback = await fs.readFile(path.join(root, "src", "materials", "browser-fallback.mjs"), "utf8");

  assert.match(crawlXhs, /resolveCrawlerHeadless/u);
  assert.match(fallback, /resolveMaterialFallbackHeadless/u);
  assert.doesNotMatch(fallback, /PLAYWRIGHT_HEADLESS/u);
  assert.match(loginXhs, /resolveHeadless/u);
  assert.match(loginXhs, /headless:\s*false/u);
  assert.match(loginXhs, /bringToFront/u);
  assert.match(loginXhs, /activateChromiumWindow/u);
});

test("douyin material fallback uses material headless policy instead of legacy Playwright flag", async () => {
  const root = process.cwd();
  const files = [
    "src/douyin-channel-type-classifier/assets.mjs",
    "src/step15-douyin-assets.mjs"
  ];

  for (const fileName of files) {
    const source = await fs.readFile(path.join(root, fileName), "utf8");
    assert.match(source, /resolveMaterialFallbackHeadless/u, fileName);
    assert.doesNotMatch(source, /PLAYWRIGHT_HEADLESS\s*===\s*"1"/u, fileName);
  }
});

test("login window OS activation can be disabled explicitly", () => {
  assert.equal(activateChromiumWindow({ LOGIN_WINDOW_ACTIVATE: "0" }), false);
});

test("double-click launchers only install Playwright runtime packages", async () => {
  const root = process.cwd();
  const macLauncher = await fs.readFile(path.join(root, "启动作品采集面板.command"), "utf8");
  const winLauncher = await fs.readFile(path.join(root, "启动作品采集面板.cmd"), "utf8");

  assert.doesNotMatch(macLauncher, /patchright/iu);
  assert.doesNotMatch(winLauncher, /patchright/iu);
  assert.match(macLauncher, /npm ci --registry=/u);
  assert.match(winLauncher, /npm ci --registry=/u);
  assert.match(macLauncher, /export npm_config_registry="\$NPM_REGISTRY"/u);
  assert.match(macLauncher, /export npm_config_disturl="https:\/\/npmmirror\.com\/mirrors\/node"/u);
  assert.match(macLauncher, /export PLAYWRIGHT_DOWNLOAD_HOST/u);
  assert.match(winLauncher, /set "npm_config_registry=%NPM_REGISTRY%"/u);
  assert.match(winLauncher, /set "npm_config_disturl=https:\/\/npmmirror\.com\/mirrors\/node"/u);
  assert.match(winLauncher, /set "PLAYWRIGHT_DOWNLOAD_HOST=https:\/\/npmmirror\.com\/mirrors\/playwright"/u);
  assert.match(macLauncher, /npx playwright install chromium/u);
  assert.match(winLauncher, /npx playwright install chromium/u);
  assert.match(macLauncher, /PLAYWRIGHT_DOWNLOAD_HOST= npx playwright install chromium/u);
  assert.match(winLauncher, /set "PLAYWRIGHT_DOWNLOAD_HOST="/u);
  assert.match(winLauncher, /call npx playwright install chromium/u);
});

test("daily browser crawlers close browser contexts from failure paths", async () => {
  const root = process.cwd();
  for (const fileName of ["crawl-douyin.mjs", "crawl-xhs.mjs", "crawl-bilibili.mjs"]) {
    const source = await fs.readFile(path.join(root, "src", fileName), "utf8");
    assert.match(source, /let context = null/u, `${fileName} should keep context nullable for finally cleanup`);
    assert.match(source, /finally\s*\{[\s\S]*await resourceBlocker\?\.close\(\)\.catch\(\(\) => \{\}\);[\s\S]*await context\?\.close\(\)\.catch\(\(\) => \{\}\);[\s\S]*\}/u, `${fileName} should close blocker and context in finally`);
  }
});
