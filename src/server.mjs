import "dotenv/config";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import cron from "node-cron";
import { isDocker } from "./browser-env.mjs";
import { cleanupCacheStorage, summarizeCacheStorage } from "./cache-summary.mjs";
import { runConfigChecks } from "./config-checks.mjs";
import { addDaysToDateString, endExclusiveDateToInclusiveUntilDate, normalizeDateInput, previousDateString } from "./date-utils.mjs";
import { checkPlatformLogin, summarizeLoginCheckResults } from "./login-check.mjs";
import { deletePlatformAccount, readPlatformAccounts, upsertPlatformAccount } from "./platform-accounts.mjs";
import { loadPanelSettings, mergeSettingsPatch, panelSettingsEnv, publicEffectivePanelSettings, savePanelSettings } from "./panel-settings.mjs";
import { nextScheduledTargetDate, readSchedulerRunHistory, recordSchedulerRun, summarizeDailyRunForScheduler } from "./scheduler-run-history.mjs";
import { normalizeCrawlMode } from "./crawl-runtime.mjs";
import { parseProgressLogLine } from "./progress-events.mjs";
import {
  resolvePanelPlatform,
  validatePostOrigin
} from "./panel-security.mjs";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (isDocker() ? "0.0.0.0" : "127.0.0.1");
const DISPLAY_HOST = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
const PUBLIC_DIR = path.join(ROOT, "public");
const OUTPUT_DIR = path.join(ROOT, "output");
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const SCHEDULER_PATH = path.join(RUNTIME_DIR, "scheduler.json");
const NODE_BIN = process.execPath;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLATFORMS = {
  xhs: {
    id: "xhs",
    label: "小红书",
    profileDir: path.join(ROOT, ".xhs-profile"),
    loginScript: path.join(__dirname, "login-xhs.mjs"),
    crawlScript: path.join(__dirname, "crawl-xhs.mjs"),
    outputPrefix: "xhs_notes_"
  },
  douyin: {
    id: "douyin",
    label: "抖音",
    profileDir: path.join(ROOT, ".douyin-profile"),
    loginScript: path.join(__dirname, "login-douyin.mjs"),
    crawlScript: path.join(__dirname, "crawl-douyin.mjs"),
    outputPrefix: "douyin_notes_"
  },
  bilibili: {
    id: "bilibili",
    label: "B站",
    profileDir: path.join(ROOT, ".bilibili-profile"),
    loginScript: path.join(__dirname, "login-bilibili.mjs"),
    crawlScript: path.join(__dirname, "crawl-bilibili.mjs"),
    outputPrefix: "bilibili_videos_"
  },
  daily: {
    id: "daily",
    label: "全渠道",
    profileDir: null,
    loginScript: null,
    crawlScript: path.join(__dirname, "collect-daily.mjs"),
    outputPrefix: "daily_collect_"
  }
};
const DAILY_PIPELINE_PLATFORM_IDS = new Set(["xhs", "douyin", "bilibili"]);

let currentRun = null;
let loginProcess = null;
let loginCheckRunning = false;
let schedulerJob = null;
let schedulerConfig = { enabled: false, time: "11:30" };
const logsByPlatform = new Map(Object.keys(PLATFORMS).map((id) => [id, []]));
const progressByPlatform = new Map();
const clients = new Set();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const originGate = validatePostOrigin(req);
    if (!originGate.ok) {
      sendJson(res, { error: originGate.error }, originGate.status);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      handleEvents(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      if (isSettingsPanelRequest(url)) {
        sendJson(res, statusPayload("settings"));
        return;
      }
      const platform = getPlatform(url.searchParams.get("platform"));
      sendJson(res, statusPayload(platform.id));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/outputs") {
      if (isSettingsPanelRequest(url)) {
        sendJson(res, { files: [] });
        return;
      }
      const platform = getPlatform(url.searchParams.get("platform"));
      sendJson(res, { files: await listOutputs(platform.id) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/accounts") {
      const platform = getPlatform(url.searchParams.get("platform"));
      await listAccounts(res, platform);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/accounts/upsert") {
      const body = await readJson(req);
      const platform = getPlatform(body?.platform);
      const account = await upsertPlatformAccount({
        root: ROOT,
        platformId: platform.id,
        name: body?.name,
        url: body?.url
      });
      sendJson(res, { ok: true, platform: platform.id, account, accounts: await readPlatformAccounts(platform.id, { root: ROOT }) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/accounts/delete") {
      const body = await readJson(req);
      const platform = getPlatform(body?.platform);
      await deletePlatformAccount({
        root: ROOT,
        platformId: platform.id,
        name: body?.name
      });
      sendJson(res, { ok: true, platform: platform.id, accounts: await readPlatformAccounts(platform.id, { root: ROOT }) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(req);
      await startLogin(res, getPlatform(body?.platform));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login/check") {
      const body = await readJson(req);
      await checkLogin(res, getPlatform(body?.platform));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/crawl") {
      const body = await readJson(req);
      await startCrawl(res, getPlatform(body?.platform), body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/daily/run") {
      const body = await readJson(req);
      await startCrawl(res, PLATFORMS.daily, body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/feishu/write") {
      writeFeishu(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      stopCrawl(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logs/clear") {
      const body = await readJson(req);
      clearLogs(res, getPlatform(body?.platform));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scheduler") {
      sendJson(res, schedulerPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      await getSettings(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await readJson(req);
      await updateSettings(res, body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings/checks") {
      const result = await runConfigChecks({ env: await effectiveEnv() });
      sendJson(res, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cache/cleanup") {
      await cleanupCache(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cache/open") {
      await openCacheDirectory(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scheduler") {
      const body = await readJson(req);
      await updateScheduler(res, body);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/output/")) {
      await serveOutput(url.pathname, res);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message || String(error) }, error.status || 500);
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`面板端口已被占用：${HOST}:${PORT}。请关闭占用该端口的程序，或设置 PORT 使用其它端口。`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`作品采集面板已启动：http://${DISPLAY_HOST}:${PORT}`);
});

loadSchedulerConfig().catch((error) => {
  appendLog("daily", `读取定时配置失败：${error.message || String(error)}`);
});

async function startLogin(res, platform) {
  if (!platform.loginScript || !platform.profileDir) {
    sendJson(res, { error: `${platform.label}没有单独登录入口。` }, 400);
    return;
  }

  if (loginProcess) {
    sendJson(res, { ok: true, message: `${loginProcess.platform.label}登录浏览器已经打开` });
    return;
  }

  if (currentRun || loginCheckRunning) {
    sendJson(res, { error: "当前有爬取任务或登录检测正在运行，请结束后再打开登录。" }, 409);
    return;
  }

  const profileReady = await ensureProfileReady(platform);
  if (!profileReady.ok) {
    appendLog(platform.id, profileReady.message);
    sendJson(res, { error: profileReady.message }, 409);
    return;
  }

  appendLog(platform.id, `打开${platform.label}登录浏览器...`);
  loginProcess = spawn(NODE_BIN, [platform.loginScript], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  loginProcess.platform = platform;

  loginProcess.stdout.on("data", (chunk) => appendLog(platform.id, chunk.toString()));
  loginProcess.stderr.on("data", (chunk) => appendLog(platform.id, chunk.toString()));
  loginProcess.on("error", (error) => {
    appendLog(platform.id, `${platform.label}登录浏览器启动失败：${error.message || String(error)}`);
    loginProcess = null;
    broadcastStatus();
  });
  loginProcess.on("close", (code) => {
    appendLog(platform.id, `${platform.label}登录浏览器已关闭，退出码：${code}`);
    loginProcess = null;
    broadcastStatus();
  });

  sendJson(res, { ok: true });
  broadcastStatus();
}

async function checkLogin(res, platform) {
  if (!platform.loginScript || !platform.profileDir) {
    sendJson(res, { error: `${platform.label}没有单独登录检测入口。` }, 400);
    return;
  }

  if (currentRun || loginProcess || loginCheckRunning) {
    sendJson(res, { error: "当前有爬取任务、登录浏览器或登录检测正在运行，请结束后再检测登录状态。" }, 409);
    return;
  }

  if (isProfileInUse(platform.profileDir)) {
    const message = `${platform.label}登录目录正在被浏览器占用，请先关闭登录或采集浏览器后再检测。`;
    appendLog(platform.id, message);
    sendJson(res, { error: message }, 409);
    return;
  }

  loginCheckRunning = true;
  broadcastStatus();
  try {
    appendLog(platform.id, `${platform.label}开始检测登录状态，检测时间：${formatTimestamp()}`);
    const result = await checkPlatformLogin({
      platformId: platform.id,
      profileDir: platform.profileDir
    });
    appendLog(platform.id, `${platform.label}登录检测结果：${result.message}`);
    sendJson(res, { ok: true, ...result });
  } finally {
    loginCheckRunning = false;
    broadcastStatus();
  }
}

async function startCrawl(res, platform, body) {
  if (currentRun) {
    sendJson(res, { error: `${currentRun.platform.label}爬取任务正在运行` }, 409);
    return;
  }

  if (loginProcess) {
    const message = `请先关闭${loginProcess.platform.label}登录浏览器窗口，再开始爬取。登录状态会保留，不需要重新登录。`;
    appendLog(platform.id, message);
    sendJson(res, { error: message }, 409);
    return;
  }

  if (loginCheckRunning) {
    const message = "正在检测登录状态，请稍后再启动爬取。";
    appendLog(platform.id, message);
    sendJson(res, { error: message }, 409);
    return;
  }

  const dateInput = String(body?.targetDate || body?.since || "").trim();
  let sinceDate;
  let endExclusiveDate;
  let crawlerUntilDate;
  try {
    sinceDate = normalizeDateInput(dateInput);
    if (platform.id === "daily" && !body?.until) {
      endExclusiveDate = addDaysToDateString(sinceDate, 1);
      crawlerUntilDate = sinceDate;
    } else {
      endExclusiveDate = normalizeDateInput(String(body?.until || sinceDate).trim());
      crawlerUntilDate = endExclusiveDateToInclusiveUntilDate(sinceDate, endExclusiveDate);
    }
  } catch {
    sendJson(res, { error: "请输入有效日期，且结束日期必须晚于开始日期，例如 2026-05-19 -> 2026-05-20" }, 400);
    return;
  }
  const crawlMode = normalizeCrawlMode(body?.mode);

  const accountGate = await checkPlatformAccountConfig(platform);
  if (!accountGate.ok) {
    sendJson(res, { error: accountGate.message }, 400);
    return;
  }

  if (platform.profileDir) {
    const profileReady = await ensureProfileReady(platform);
    if (!profileReady.ok) {
      appendLog(platform.id, profileReady.message);
      sendJson(res, { error: profileReady.message }, 409);
      return;
    }
  }

  logsByPlatform.set(platform.id, []);
  clearProgressForPlatform(platform.id);
  if (platform.id === "daily") {
    const loginGate = await checkDailyPlatformLogins();
    if (!loginGate.ok) {
      sendJson(res, { error: loginGate.message, results: loginGate.results }, 409);
      return;
    }
  }

  const rangeText = formatHalfOpenDateRange(sinceDate, endExclusiveDate);
  appendLog(platform.id, `启动${platform.label}任务，日期：${rangeText}，模式：${modeLabel(crawlMode)}，启动时间：${formatTimestamp()}`);

  const args = platformCrawlArgs(platform, sinceDate, endExclusiveDate, crawlerUntilDate, crawlMode);

  currentRun = spawn(NODE_BIN, args, {
    cwd: ROOT,
    env: panelRunEnv(await effectiveEnv()),
    stdio: ["ignore", "pipe", "pipe"]
  });
  currentRun.platform = platform;

  currentRun.stdout.on("data", (chunk) => appendLog(platform.id, chunk.toString()));
  currentRun.stderr.on("data", (chunk) => appendLog(platform.id, chunk.toString()));
  currentRun.on("error", (error) => {
    appendLog(platform.id, `${platform.label}爬取任务启动失败：${error.message || String(error)}`);
    currentRun = null;
    broadcastStatus();
  });
  currentRun.on("close", async (code) => {
    appendLog(platform.id, `${platform.label}任务结束，退出码：${code}，结束时间：${formatTimestamp()}`);
    currentRun = null;
    broadcastStatus();
    broadcast({ type: "outputs", platform: platform.id, files: await listOutputs(platform.id) });
  });

  sendJson(res, { ok: true });
  broadcastStatus();
}

async function getSettings(res) {
  const settings = await loadPanelSettings({ root: ROOT });
  sendJson(res, { ok: true, settings: publicEffectivePanelSettings(settings, process.env), cache: await summarizeCacheStorage(ROOT) });
}

async function updateSettings(res, body = {}) {
  const current = await loadPanelSettings({ root: ROOT });
  const merged = mergeSettingsPatch(current, body?.settings || body || {});
  await savePanelSettings({ root: ROOT, settings: merged });
  sendJson(res, { ok: true, settings: publicEffectivePanelSettings(merged, process.env), cache: await summarizeCacheStorage(ROOT) });
}

async function effectiveEnv() {
  const settings = await loadPanelSettings({ root: ROOT });
  return panelSettingsEnv(settings, process.env);
}

function platformCrawlArgs(platform, sinceDate, endExclusiveDate, crawlerUntilDate, crawlMode) {
  if (platform.id === "daily") {
    return [platform.crawlScript, "--since", sinceDate, "--until", endExclusiveDate, "--mode", crawlMode];
  }
  if (DAILY_PIPELINE_PLATFORM_IDS.has(platform.id)) {
    return [PLATFORMS.daily.crawlScript, "--platform", platform.id, "--since", sinceDate, "--until", endExclusiveDate, "--mode", crawlMode];
  }
  return [platform.crawlScript, "--since", sinceDate, "--until", crawlerUntilDate, "--mode", crawlMode];
}

async function checkPlatformAccountConfig(platform) {
  const platformIds = platform.id === "daily" ? ["xhs", "douyin", "bilibili"] : [platform.id];
  const missing = [];
  for (const platformId of platformIds) {
    const accounts = await readPlatformAccounts(platformId, { root: ROOT });
    if (accounts.length === 0) missing.push(PLATFORMS[platformId].label);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message: `请先在账号配置中添加${missing.join("、")}账号。`
    };
  }
  return { ok: true };
}

async function checkDailyPlatformLogins() {
  loginCheckRunning = true;
  broadcastStatus();
  try {
    appendLog("daily", `全渠道启动前检测三个平台登录状态，检测时间：${formatTimestamp()}`);
    const results = [];
    for (const platformId of ["xhs", "douyin", "bilibili"]) {
      const platform = PLATFORMS[platformId];
      let result;
      if (isProfileInUse(platform.profileDir)) {
        result = {
          platformId,
          status: "profile_in_use",
          valid: false,
          message: `${platform.label}登录目录正在被浏览器占用，请先关闭登录或采集浏览器。`
        };
      } else {
        result = await checkPlatformLogin({
          platformId,
          profileDir: platform.profileDir
        });
      }
      const labeledResult = { ...result, label: platform.label };
      results.push(labeledResult);
      appendLog("daily", `${platform.label}登录检测结果：${result.message}`);
    }

    const summary = summarizeLoginCheckResults(results);
    appendLog("daily", summary.message);
    return { ...summary, results };
  } finally {
    loginCheckRunning = false;
    broadcastStatus();
  }
}

function writeFeishu(res) {
  sendJson(res, { error: "写入飞书入口已合并到开始爬取，请直接点击开始爬取。" }, 410);
}

function stopCrawl(res) {
  if (!currentRun) {
    sendJson(res, { ok: true, message: "当前没有运行中的爬取任务" });
    return;
  }

  appendLog(currentRun.platform.id, `正在停止${currentRun.platform.label}爬取任务...`);
  currentRun.kill("SIGTERM");
  sendJson(res, { ok: true });
}

function clearLogs(res, platform) {
  logsByPlatform.set(platform.id, []);
  clearProgressForPlatform(platform.id);
  broadcast({ type: "logs-cleared", platform: platform.id });
  sendJson(res, { ok: true, platform: platform.id });
}

async function cleanupCache(res) {
  const result = await cleanupCacheStorage(ROOT);
  appendLog("daily", `缓存清理完成：删除 ${result.removed.length} 个缓存目录。`);
  sendJson(res, { ok: true, removed: result.removed, cache: result.cache });
}

async function openCacheDirectory(res) {
  const cacheSummary = await summarizeCacheStorage(ROOT);
  await fs.mkdir(cacheSummary.path, { recursive: true });
  const opener = cacheDirectoryOpener(cacheSummary.path);
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  child.on("error", (error) => {
    appendLog("daily", `打开缓存目录失败：${error.message || String(error)}；路径：${cacheSummary.path}`);
  });
  sendJson(res, {
    ok: true,
    path: cacheSummary.path,
    fileUrl: pathToFileUrl(cacheSummary.path),
    cache: cacheSummary
  });
}

function cacheDirectoryOpener(targetPath) {
  if (process.platform === "darwin") {
    return { command: "open", args: [targetPath] };
  }
  if (process.platform === "win32") {
    return { command: "explorer", args: [targetPath] };
  }
  return { command: "xdg-open", args: [targetPath] };
}

function pathToFileUrl(targetPath) {
  return pathToFileURL(targetPath).href;
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify({ type: "status", ...statusPayload("xhs") })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function appendLog(platformId, text) {
  const parts = String(text)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter(Boolean);

  const logs = logsByPlatform.get(platformId) || [];
  for (const part of parts) {
    const progress = parseProgressLogLine(part);
    if (progress) {
      const progressPlatformId = progress.platformId || platformId;
      progress.platformId = progressPlatformId;
      progressByPlatform.set(progressPlatformId, progress);
      if (platformId === "daily") progressByPlatform.set("daily", progress);
      broadcast({ type: "progress", platform: progress.platformId, progress });
      if (platformId === "daily" && progressPlatformId !== "daily") {
        broadcast({ type: "progress", platform: "daily", progress });
      }
      continue;
    }
    logs.push(part);
    if (logs.length > 600) logs.splice(0, logs.length - 600);
    broadcast({ type: "log", platform: platformId, line: part });
  }
  logsByPlatform.set(platformId, logs);
}

async function ensureProfileReady(platform) {
  if (!platform.profileDir) return { ok: true };
  await fs.mkdir(platform.profileDir, { recursive: true });

  if (isProfileInUse(platform.profileDir)) {
    return {
      ok: false,
      message: `${platform.label}登录浏览器还在运行，请先关闭它，再继续操作。`
    };
  }

  const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  let removed = 0;
  for (const filename of lockFiles) {
    const lockPath = path.join(platform.profileDir, filename);
    try {
      await fs.rm(lockPath, { force: true, recursive: true });
      removed += 1;
    } catch {
      // If Chrome owns it between checks, the next launch will report a clear error.
    }
  }

  if (removed > 0) appendLog(platform.id, `已清理${platform.label}上次异常退出留下的浏览器锁。`);
  return { ok: true };
}

function isProfileInUse(profileDir) {
  if (process.platform === "win32") return false;
  if (!existsSync(profileDir)) return false;

  const result = spawnSync("lsof", ["+D", profileDir], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) return false;
  return result.status === 0 && String(result.stdout || "").trim().length > 0;
}

function statusPayload(platformId) {
  return {
    platform: platformId,
    running: Boolean(currentRun),
    runningPlatform: currentRun?.platform.id || "",
    loginRunning: Boolean(loginProcess),
    loginPlatform: loginProcess?.platform.id || "",
    loginChecking: loginCheckRunning,
    progress: progressByPlatform.get(platformId) || null,
    logs: logsByPlatform.get(platformId) || []
  };
}

function broadcastStatus() {
  broadcast({
    type: "status",
    platform: currentRun?.platform.id || "",
    running: Boolean(currentRun),
    runningPlatform: currentRun?.platform.id || "",
    loginRunning: Boolean(loginProcess),
    loginPlatform: loginProcess?.platform.id || "",
    loginChecking: loginCheckRunning,
    progress: progressByPlatform.get(currentRun?.platform.id || "") || null
  });
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(data);
}

function clearProgressForPlatform(platformId) {
  progressByPlatform.delete(platformId);
  if (platformId === "daily") {
    for (const id of DAILY_PIPELINE_PLATFORM_IDS) progressByPlatform.delete(id);
  }
  broadcast({ type: "progress", platform: platformId, progress: null });
}

async function listOutputs(platformId = "xhs") {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const platform = getPlatform(platformId);
  const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .filter((entry) => /\.(csv|xls|json)$/i.test(entry.name))
    .filter((entry) => entry.name.startsWith(platform.outputPrefix))
    .map(async (entry) => {
      const filePath = path.join(OUTPUT_DIR, entry.name);
      const stat = await fs.stat(filePath);
      return {
        name: entry.name,
        href: `/output/${encodeURIComponent(entry.name)}`,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      };
    }));

  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function listAccounts(res, platform) {
  if (platform.id === "daily") {
    sendJson(res, { platform: platform.id, accounts: [] });
    return;
  }

  const accounts = await readPlatformAccounts(platform.id, { root: ROOT });
  sendJson(res, {
    platform: platform.id,
    accounts: accounts.map((account) => ({
      name: account.name,
      url: account.url || ""
    }))
  });
}

async function serveOutput(requestPath, res) {
  const filename = decodeURIComponent(requestPath.replace("/output/", ""));
  const filePath = path.resolve(OUTPUT_DIR, filename);
  if (!filePath.startsWith(path.resolve(OUTPUT_DIR) + path.sep)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  const content = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".csv"
    ? "text/csv; charset=utf-8"
    : ext === ".json"
      ? "application/json; charset=utf-8"
      : "application/vnd.ms-excel; charset=utf-8";

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`
  });
  res.end(content);
}

async function serveStatic(requestPath, res) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(cleanPath)}`);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  const content = await fs.readFile(filePath).catch(() => null);
  if (!content) {
    sendText(res, "Not found", 404);
    return;
  }

  res.writeHead(200, { "Content-Type": contentType(filePath) });
  res.end(content);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getPlatform(value) {
  return resolvePanelPlatform(value, PLATFORMS);
}

function isSettingsPanelRequest(url) {
  return String(url.searchParams.get("platform") || "").trim() === "settings";
}

async function loadSchedulerConfig() {
  try {
    const text = await fs.readFile(SCHEDULER_PATH, "utf8");
    const parsed = JSON.parse(text);
    schedulerConfig = normalizeSchedulerConfig(parsed);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  applyScheduler();
}

async function updateScheduler(res, body) {
  schedulerConfig = normalizeSchedulerConfig({
    enabled: Boolean(body?.enabled),
    time: body?.time || schedulerConfig.time
  });
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.writeFile(SCHEDULER_PATH, JSON.stringify(schedulerConfig, null, 2), "utf8");
  applyScheduler();
  appendLog("daily", `定时任务已${schedulerConfig.enabled ? "启用" : "停用"}，时间：${schedulerConfig.time}`);
  sendJson(res, schedulerPayload());
}

function normalizeSchedulerConfig(value) {
  const time = String(value?.time || "11:30").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`定时时间格式不正确：${time}，请使用 HH:mm`);
  }
  return { enabled: Boolean(value?.enabled), time };
}

function applyScheduler() {
  if (schedulerJob) {
    schedulerJob.stop();
    schedulerJob = null;
  }

  if (!schedulerConfig.enabled) {
    broadcast({ type: "scheduler", ...schedulerPayload() });
    return;
  }

  const [hour, minute] = schedulerConfig.time.split(":");
  schedulerJob = cron.schedule(`${Number(minute)} ${Number(hour)} * * *`, () => {
    startScheduledDailyRun().catch((error) => appendLog("daily", `定时任务启动失败：${error.message || String(error)}`));
  }, {
    timezone: "Asia/Shanghai"
  });
  broadcast({ type: "scheduler", ...schedulerPayload() });
}

async function startScheduledDailyRun() {
  const scheduledTargetDate = previousDateString(new Date());
  const history = await readSchedulerRunHistory({ root: ROOT });
  const target = nextScheduledTargetDate(history, scheduledTargetDate);
  const targetDate = target.targetDate;
  const triggeredAt = new Date().toISOString();
  if (currentRun || loginProcess || loginCheckRunning) {
    const reason = "当前有任务、登录浏览器或登录检测正在运行。";
    appendLog("daily", `定时任务触发，但${reason}本次跳过。`);
    await recordSchedulerEvent({ status: "skipped", targetDate, isBackfill: target.isBackfill, reason, triggeredAt });
    return;
  }

  logsByPlatform.set("daily", []);
  clearProgressForPlatform("daily");
  appendLog(
    "daily",
    target.isBackfill
      ? `定时补采中，全渠道目标日期：${targetDate}，剩余待补 ${Math.max(0, target.pendingBackfillDates.length - 1)} 天，启动时间：${formatTimestamp()}`
      : `定时任务触发，全渠道目标日期：${targetDate}，启动时间：${formatTimestamp()}`
  );
  const accountGate = await checkPlatformAccountConfig(PLATFORMS.daily);
  if (!accountGate.ok) {
    appendLog("daily", `定时任务已中止：${accountGate.message}`);
    await recordSchedulerEvent({ status: "skipped", targetDate, isBackfill: target.isBackfill, reason: accountGate.message, triggeredAt });
    return;
  }
  const loginGate = await checkDailyPlatformLogins();
  if (!loginGate.ok) {
    appendLog("daily", `定时任务已中止：${loginGate.message}`);
    await recordSchedulerEvent({ status: "skipped", targetDate, isBackfill: target.isBackfill, reason: loginGate.message, triggeredAt });
    return;
  }
  await recordSchedulerEvent({ status: "started", targetDate, isBackfill: target.isBackfill, triggeredAt });

  currentRun = spawn(NODE_BIN, [
    PLATFORMS.daily.crawlScript,
    "--target-date",
    targetDate
  ], {
    cwd: ROOT,
    env: panelRunEnv(await effectiveEnv()),
    stdio: ["ignore", "pipe", "pipe"]
  });
  currentRun.platform = PLATFORMS.daily;

  currentRun.stdout.on("data", (chunk) => appendLog("daily", chunk.toString()));
  currentRun.stderr.on("data", (chunk) => appendLog("daily", chunk.toString()));
  currentRun.on("error", async (error) => {
    appendLog("daily", `全渠道定时任务启动失败：${error.message || String(error)}`);
    await recordSchedulerEvent({
      status: "failed",
      targetDate,
      isBackfill: target.isBackfill,
      reason: error.message || String(error),
      triggeredAt,
      finishedAt: new Date().toISOString()
    });
    currentRun = null;
    broadcastStatus();
  });
  currentRun.on("close", async (code) => {
    const finishedAt = new Date();
    appendLog("daily", `全渠道定时任务结束，退出码：${code}，结束时间：${formatTimestamp(finishedAt)}`);
    const dailySummary = await summarizeDailyRunForScheduler({ root: ROOT, targetDate, exitCode: code });
    if (dailySummary.reason) appendLog("daily", dailySummary.reason);
    await recordSchedulerEvent({
      status: dailySummary.ok ? "finished" : "failed",
      targetDate,
      isBackfill: target.isBackfill,
      exitCode: code,
      reason: dailySummary.reason,
      dailySummary,
      triggeredAt,
      finishedAt: finishedAt.toISOString()
    });
    currentRun = null;
    broadcastStatus();
    broadcast({ type: "outputs", platform: "daily", files: await listOutputs("daily") });
  });

  broadcastStatus();
}

async function recordSchedulerEvent(event) {
  try {
    await recordSchedulerRun({ root: ROOT, event });
  } catch (error) {
    appendLog("daily", `记录定时状态失败：${error.message || String(error)}`);
  }
}

function schedulerPayload() {
  return {
    enabled: schedulerConfig.enabled,
    time: schedulerConfig.time,
    active: Boolean(schedulerJob)
  };
}

function sendJson(res, payload, status = 200, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

function panelRunEnv(env = process.env) {
  return {
    ...env,
    FORCE_COLOR: "0",
    HARVESTER_PROGRESS_LOGS: "1",
    CRAWL_BROWSER_HEADLESS: "1",
    MATERIAL_BROWSER_FALLBACK_HEADLESS: "1",
    PLAYWRIGHT_HEADLESS: "1",
    LOGIN_CHECK_HEADLESS: "1"
  };
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".html") return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function formatTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatHalfOpenDateRange(sinceDate, endExclusiveDate) {
  return `${sinceDate} 00:00 至 ${endExclusiveDate} 00:00（不含结束日）`;
}

function modeLabel(mode) {
  return mode === "legacy" ? "兼容旧模式" : "保守提速";
}
