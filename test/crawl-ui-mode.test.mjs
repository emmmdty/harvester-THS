import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

test("UI exposes conservative and legacy crawl modes and sends mode to crawl APIs", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  const server = await fs.readFile(path.join(ROOT, "src", "server.mjs"), "utf8");
  const daily = await fs.readFile(path.join(ROOT, "src", "collect-daily.mjs"), "utf8");
  const dailyRunner = await fs.readFile(path.join(ROOT, "src", "collect-daily-runner.mjs"), "utf8");

  assert.match(html, /<select id="crawl-mode"/);
  assert.match(html, /value="conservative"/);
  assert.match(html, /保守提速/);
  assert.match(html, /value="legacy"/);
  assert.match(html, /兼容旧模式/);

  assert.match(app, /const crawlModeSelect = document\.querySelector\("#crawl-mode"\)/);
  assert.match(app, /mode: crawlModeSelect\.value/);
  assert.match(app, /postJson\("\/api\/daily\/run", \{ since, until, mode: crawlModeSelect\.value \}\)/);

  assert.match(server, /const crawlMode = normalizeCrawlMode\(body\?\.mode\)/);
  assert.match(server, /args\.push\("--mode", crawlMode\)/);

  assert.match(daily, /const crawlMode = normalizeCrawlMode\(options\.mode \|\| process\.env\.CRAWL_MODE\)/);
  assert.match(dailyRunner, /"--mode",\s*crawlMode/);
});

test("scheduled all-channel runs reuse the same login gate as manual all-channel runs", async () => {
  const server = await fs.readFile(path.join(ROOT, "src", "server.mjs"), "utf8");

  assert.match(server, /async function startScheduledDailyRun\(\)/);
  assert.match(server, /const loginGate = await checkDailyPlatformLogins\(\)/);
  assert.match(server, /if \(!loginGate\.ok\) \{/);
  assert.match(server, /定时任务已中止/);
});

test("UI gates panel initialization behind auth status before opening the event stream", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");

  assert.match(html, /id="auth-panel"/);
  assert.match(html, /id="panel-password"/);
  assert.match(html, /id="panel-content" hidden/);
  assert.match(app, /await initializeAuth\(\)/);
  assert.match(app, /fetchJson\("\/api\/auth\/status"/);
  assert.match(app, /new EventSource\("\/api\/events"\)/);
});
