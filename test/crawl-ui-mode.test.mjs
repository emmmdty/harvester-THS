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
  assert.match(server, /const args = platformCrawlArgs\(platform, sinceDate, endExclusiveDate, crawlerUntilDate, crawlMode\)/);
  assert.match(server, /"--mode", crawlMode/);

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

test("single daily-platform crawl tabs run the modular daily pipeline", async () => {
  const server = await fs.readFile(path.join(ROOT, "src", "server.mjs"), "utf8");

  assert.match(server, /const DAILY_PIPELINE_PLATFORM_IDS = new Set\(\["xhs", "douyin", "bilibili"\]\)/);
  assert.match(server, /function platformCrawlArgs\(platform, sinceDate, endExclusiveDate, crawlerUntilDate, crawlMode\)/);
  assert.match(server, /DAILY_PIPELINE_PLATFORM_IDS\.has\(platform\.id\)/);
  assert.match(server, /\[PLATFORMS\.daily\.crawlScript, "--platform", platform\.id, "--since", sinceDate, "--until", endExclusiveDate, "--mode", crawlMode\]/);
  assert.doesNotMatch(server, /\[platform\.crawlScript, "--since", sinceDate, "--until", crawlerUntilDate\]/);
});

test("single-platform crawl is the only panel action that writes Feishu", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  const server = await fs.readFile(path.join(ROOT, "src", "server.mjs"), "utf8");

  assert.doesNotMatch(html, /id="feishu-write"/);
  assert.doesNotMatch(app, /feishuWriteButton/);
  assert.doesNotMatch(app, /\/api\/feishu\/write/);
  assert.doesNotMatch(server, /import \{ writePlatformJsonToFeishu \} from "\.\/feishu-writer\.mjs"/);
  assert.match(server, /写入飞书入口已合并到开始爬取/);
  assert.match(server, /sendJson\(res, \{ error: "写入飞书入口已合并到开始爬取，请直接点击开始爬取。"\s*\}, 410\)/);
  assert.doesNotMatch(server, /return await startCrawl\(res, platform, body\)/);
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

test("UI renders all-channel progress from status and SSE updates", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  const css = await fs.readFile(path.join(ROOT, "public", "styles.css"), "utf8");
  const server = await fs.readFile(path.join(ROOT, "src", "server.mjs"), "utf8");

  assert.match(html, /id="progress-panel"/u);
  assert.match(html, /id="progress-stage"/u);
  assert.match(html, /id="progress-action"/u);
  assert.match(html, /id="progress-count"/u);
  assert.match(html, /id="progress-updated"/u);

  assert.match(app, /const progressPanelEl = document\.querySelector\("#progress-panel"\)/u);
  assert.match(app, /renderProgress\(status\.progress \|\| null\)/u);
  assert.match(app, /renderProgress\(payload\.progress \|\| null\)/u);
  assert.match(app, /payload\.type === "progress"/u);
  assert.match(app, /progress\.completed/u);
  assert.match(app, /progress\.total/u);
  assert.match(app, /progressActionText\(progress\)/u);
  assert.match(app, /progressDetailText\(progress\)/u);
  assert.match(app, /idleProgressText\(\)/u);
  assert.match(app, /正在检测登录/u);
  assert.match(app, /正在准备素材/u);
  assert.match(app, /正在识别内容/u);
  assert.match(app, /正在写入结果/u);
  assert.doesNotMatch(app, /provider/u);
  assert.doesNotMatch(html, />0\/0</u);
  assert.doesNotMatch(html, /最后更新：-/u);

  assert.match(css, /\.progress-panel/u);
  assert.match(css, /\.progress-bar-fill/u);
  assert.match(css, /\.panel-title h2\s*\{[\s\S]*white-space:\s*nowrap/u);
  assert.match(css, /\.panel-title \.ghost\s*\{[\s\S]*width:\s*auto/u);

  assert.match(server, /parseProgressLogLine/u);
  assert.match(server, /progressByPlatform/u);
  assert.match(server, /HARVESTER_PROGRESS_LOGS: "1"/u);
  assert.match(server, /broadcast\(\{ type: "progress", platform: progress\.platformId/u);
  assert.match(server, /progress: progressByPlatform\.get\(platformId\) \|\| null/u);
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

test("UI keeps scheduler in all-channel view, account config in crawl page, and output list scrollable", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  const css = await fs.readFile(path.join(ROOT, "public", "styles.css"), "utf8");

  assert.match(html, /<section class="schedulebar" id="schedulebar"/);

  const workspaceIndex = html.indexOf('<section class="workspace" id="workspace">');
  const accountManagerIndex = html.indexOf('<details class="account-manager"');
  const settingsPageIndex = html.indexOf('<section class="settings-manager settings-page" id="settings-page"');
  assert.notEqual(workspaceIndex, -1);
  assert.notEqual(accountManagerIndex, -1);
  assert.notEqual(settingsPageIndex, -1);
  assert.ok(accountManagerIndex > workspaceIndex);
  assert.ok(settingsPageIndex > accountManagerIndex);

  assert.match(app, /const schedulebarEl = document\.querySelector\("#schedulebar"\)/);
  assert.match(app, /schedulebarEl\.hidden = currentPlatform !== "daily"/);
  assert.match(app, /accountManagerEl\.hidden = currentPlatform === "daily" \|\| currentPlatform === "settings"/);

  assert.match(css, /--workspace-panel-body-height:\s*424px/);
  assert.match(css, /\[hidden\]\s*\{[\s\S]*display:\s*none\s*!important/);
  assert.match(css, /\.account-manager:not\(\[open\]\) \.account-manager-body\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /\.logs\s*\{[\s\S]*height:\s*var\(--workspace-panel-body-height\)/);
  assert.match(css, /\.outputs\s*\{[\s\S]*height:\s*var\(--workspace-panel-body-height\)[\s\S]*overflow-y:\s*auto/);
});

test("settings panel exposes editable Feishu, AI provider, and cache configuration without secret echo", async () => {
  const html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  const server = await fs.readFile(path.join(ROOT, "src", "server.mjs"), "utf8");
  const gitignore = await fs.readFile(path.join(ROOT, ".gitignore"), "utf8");

  for (const id of [
    "setting-feishu-app-id",
    "setting-feishu-app-secret",
    "setting-feishu-spreadsheet-token",
    "setting-feishu-sheet-douyin",
    "setting-feishu-sheet-xhs",
    "setting-feishu-sheet-bilibili",
    "setting-minimax-api-key",
    "setting-minimax-base-url",
    "setting-minimax-model",
    "setting-deepseek-api-key",
    "setting-deepseek-base-url",
    "setting-deepseek-model",
    "save-settings",
    "run-config-checks"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(app, /loadSettings\(\)/);
  assert.match(app, /postJson\("\/api\/settings", collectSettingsPayload\(\)\)/);
  assert.match(app, /renderSecretSummary/);
  assert.match(server, /url\.pathname === "\/api\/settings"/);
  assert.match(server, /publicEffectivePanelSettings/);
  assert.match(gitignore, /^\.runtime\/$/m);
});
