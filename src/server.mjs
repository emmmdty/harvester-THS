import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDocker } from "./browser-env.mjs";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (isDocker() ? "0.0.0.0" : "127.0.0.1");
const DISPLAY_HOST = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
const PUBLIC_DIR = path.join(ROOT, "public");
const OUTPUT_DIR = path.join(ROOT, "output");
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
  }
};

let currentRun = null;
let loginProcess = null;
const logsByPlatform = new Map(Object.keys(PLATFORMS).map((id) => [id, []]));
const clients = new Set();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/events") {
      handleEvents(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const platform = getPlatform(url.searchParams.get("platform"));
      sendJson(res, statusPayload(platform.id));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/outputs") {
      const platform = getPlatform(url.searchParams.get("platform"));
      sendJson(res, { files: await listOutputs(platform.id) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(req);
      await startLogin(res, getPlatform(body?.platform));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/crawl") {
      const body = await readJson(req);
      await startCrawl(res, getPlatform(body?.platform), body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      stopCrawl(res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/output/")) {
      await serveOutput(url.pathname, res);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message || String(error) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`作品采集面板已启动：http://${DISPLAY_HOST}:${PORT}`);
});

async function startLogin(res, platform) {
  if (loginProcess) {
    sendJson(res, { ok: true, message: `${loginProcess.platform.label}登录浏览器已经打开` });
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

  const profileReady = await ensureProfileReady(platform);
  if (!profileReady.ok) {
    appendLog(platform.id, profileReady.message);
    sendJson(res, { error: profileReady.message }, 409);
    return;
  }

  const since = String(body?.since || "").trim();
  if (!isDateInput(since)) {
    sendJson(res, { error: "请输入有效起始日期，例如 2026-04-15" }, 400);
    return;
  }

  logsByPlatform.set(platform.id, []);
  appendLog(platform.id, `启动${platform.label}爬取任务，起始日期：${since}`);

  currentRun = spawn(NODE_BIN, [
    platform.crawlScript,
    "--since",
    since
  ], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
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
    appendLog(platform.id, `${platform.label}任务结束，退出码：${code}`);
    currentRun = null;
    broadcastStatus();
    broadcast({ type: "outputs", platform: platform.id, files: await listOutputs(platform.id) });
  });

  sendJson(res, { ok: true });
  broadcastStatus();
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
    logs.push(part);
    if (logs.length > 600) logs.splice(0, logs.length - 600);
    broadcast({ type: "log", platform: platformId, line: part });
  }
  logsByPlatform.set(platformId, logs);
}

async function ensureProfileReady(platform) {
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
    logs: logsByPlatform.get(platformId) || []
  };
}

function broadcastStatus() {
  broadcast({
    type: "status",
    running: Boolean(currentRun),
    runningPlatform: currentRun?.platform.id || "",
    loginRunning: Boolean(loginProcess),
    loginPlatform: loginProcess?.platform.id || ""
  });
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(data);
}

async function listOutputs(platformId = "xhs") {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const platform = getPlatform(platformId);
  const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .filter((entry) => /\.(csv|xls)$/i.test(entry.name))
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
  return PLATFORMS[value] || PLATFORMS.xhs;
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
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

function isDateInput(value) {
  return /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2})$/.test(value);
}
