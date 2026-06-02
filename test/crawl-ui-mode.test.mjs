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
  assert.match(server, /const accountGate = await checkPlatformAccountConfig\(PLATFORMS\.daily\)/);
  assert.match(server, /if \(!accountGate\.ok\) \{/);
  assert.match(server, /const loginGate = await checkDailyPlatformLogins\(\)/);
  assert.match(server, /if \(!loginGate\.ok\) \{/);
  assert.match(server, /定时任务已中止/);
});

test("UI initializes directly without shared password auth", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");

  assert.doesNotMatch(html, /id="auth-panel"/);
  assert.doesNotMatch(html, /id="panel-password"/);
  assert.doesNotMatch(app, /initializeAuth/);
  assert.doesNotMatch(app, /\/api\/auth\//);
  assert.match(app, /await initializePanel\(\)/);
  assert.match(app, /new EventSource\("\/api\/events"\)/);
});

test("UI exposes simple platform account management and keeps crawl all-account by default", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");

  assert.match(html, /id="account-manager"/);
  assert.match(html, /id="account-name"/);
  assert.match(html, /id="account-url"/);
  assert.match(html, /id="save-account"/);
  assert.match(html, /id="account-list"/);
  assert.match(html, /<details class="account-manager" id="account-manager"/);
  assert.match(html, /<summary class="account-manager-title">/);
  assert.doesNotMatch(html, /<details class="account-manager" id="account-manager"[^>]*open/);
  assert.doesNotMatch(html, /id="account-field"/);
  assert.doesNotMatch(html, /id="account"/);

  assert.match(app, /loadAccounts\(currentPlatform\)/);
  assert.match(app, /postJson\("\/api\/accounts\/upsert"/);
  assert.match(app, /postJson\("\/api\/accounts\/delete"/);
  assert.doesNotMatch(app, /body\.account/);
  assert.doesNotMatch(app, /accountSelect/);
});

test("UI keeps scheduler in all-channel view, account config last, and output list scrollable", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  const css = await fs.readFile(path.join(ROOT, "public", "styles.css"), "utf8");

  assert.match(html, /<section class="schedulebar" id="schedulebar"/);

  const workspaceIndex = html.indexOf('<section class="workspace">');
  const accountManagerIndex = html.indexOf('<details class="account-manager"');
  assert.notEqual(workspaceIndex, -1);
  assert.notEqual(accountManagerIndex, -1);
  assert.ok(accountManagerIndex > workspaceIndex);

  assert.match(app, /const schedulebarEl = document\.querySelector\("#schedulebar"\)/);
  assert.match(app, /schedulebarEl\.hidden = currentPlatform !== "daily"/);

  assert.match(css, /--workspace-panel-body-height:\s*424px/);
  assert.match(css, /\[hidden\]\s*\{[\s\S]*display:\s*none\s*!important/);
  assert.match(css, /\.account-manager:not\(\[open\]\) \.account-manager-body\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /\.logs\s*\{[\s\S]*height:\s*var\(--workspace-panel-body-height\)/);
  assert.match(css, /\.outputs\s*\{[\s\S]*height:\s*var\(--workspace-panel-body-height\)[\s\S]*overflow-y:\s*auto/);
});
