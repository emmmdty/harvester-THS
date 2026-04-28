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
const PROFILE_DIR = path.join(ROOT, ".xhs-profile");
const NODE_BIN = process.execPath;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let currentRun = null;
let loginProcess = null;
let logs = [];
const clients = new Set();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/events") {
      handleEvents(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, {
        running: Boolean(currentRun),
        loginRunning: Boolean(loginProcess),
        logs
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/outputs") {
      sendJson(res, { files: await listOutputs() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      await startLogin(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/crawl") {
      const body = await readJson(req);
      await startCrawl(res, body);
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
  console.log(`小红书爬取面板已启动：http://${DISPLAY_HOST}:${PORT}`);
});

async function startLogin(res) {
  if (loginProcess) {
    sendJson(res, { ok: true, message: "登录浏览器已经打开" });
    return;
  }

  const profileReady = await ensureProfileReady();
  if (!profileReady.ok) {
    appendLog(profileReady.message);
    sendJson(res, { error: profileReady.message }, 409);
    return;
  }

  appendLog("打开小红书登录浏览器...");
  loginProcess = spawn(NODE_BIN, [
    path.join(__dirname, "login-xhs.mjs")
  ], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  loginProcess.stdout.on("data", (chunk) => appendLog(chunk.toString()));
  loginProcess.stderr.on("data", (chunk) => appendLog(chunk.toString()));
  loginProcess.on("error", (error) => {
    appendLog(`登录浏览器启动失败：${error.message || String(error)}`);
    loginProcess = null;
    broadcastStatus();
  });
  loginProcess.on("close", (code) => {
    appendLog(`登录浏览器已关闭，退出码：${code}`);
    loginProcess = null;
    broadcastStatus();
  });

  sendJson(res, { ok: true });
  broadcastStatus();
}

async function startCrawl(res, body) {
  if (currentRun) {
    sendJson(res, { error: "已有爬取任务正在运行" }, 409);
    return;
  }

  if (loginProcess) {
    const message = "请先关闭登录浏览器窗口，再开始爬取。登录状态会保留，不需要重新登录。";
    appendLog(message);
    sendJson(res, { error: message }, 409);
    return;
  }

  const profileReady = await ensureProfileReady();
  if (!profileReady.ok) {
    appendLog(profileReady.message);
    sendJson(res, { error: profileReady.message }, 409);
    return;
  }

  const since = String(body?.since || "").trim();
  if (!isDateInput(since)) {
    sendJson(res, { error: "请输入有效起始日期，例如 2026-04-15" }, 400);
    return;
  }

  logs = [];
  appendLog(`启动爬取任务，起始日期：${since}`);

  currentRun = spawn(NODE_BIN, [
    path.join(__dirname, "crawl-xhs.mjs"),
    "--since",
    since
  ], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  currentRun.stdout.on("data", (chunk) => appendLog(chunk.toString()));
  currentRun.stderr.on("data", (chunk) => appendLog(chunk.toString()));
  currentRun.on("error", (error) => {
    appendLog(`爬取任务启动失败：${error.message || String(error)}`);
    currentRun = null;
    broadcastStatus();
  });
  currentRun.on("close", async (code) => {
    appendLog(`任务结束，退出码：${code}`);
    currentRun = null;
    broadcastStatus();
    broadcast({ type: "outputs", files: await listOutputs() });
  });

  sendJson(res, { ok: true });
  broadcastStatus();
}

function stopCrawl(res) {
  if (!currentRun) {
    sendJson(res, { ok: true, message: "当前没有运行中的爬取任务" });
    return;
  }

  appendLog("正在停止爬取任务...");
  currentRun.kill("SIGTERM");
  sendJson(res, { ok: true });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify({ type: "status", running: Boolean(currentRun), loginRunning: Boolean(loginProcess), logs })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function appendLog(text) {
  const parts = String(text)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter(Boolean);

  for (const part of parts) {
    logs.push(part);
    if (logs.length > 600) logs = logs.slice(-600);
    broadcast({ type: "log", line: part });
  }
}

async function ensureProfileReady() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  if (isProfileInUse()) {
    return {
      ok: false,
      message: "小红书登录浏览器还在运行，请先关闭它，再继续操作。"
    };
  }

  const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  let removed = 0;
  for (const filename of lockFiles) {
    const lockPath = path.join(PROFILE_DIR, filename);
    try {
      await fs.rm(lockPath, { force: true, recursive: true });
      removed += 1;
    } catch {
      // If Chrome owns it between checks, the next launch will report a clear error.
    }
  }

  if (removed > 0) {
    appendLog("已清理上次异常退出留下的浏览器锁。");
  }

  return { ok: true };
}

function isProfileInUse() {
  if (process.platform === "win32") return false;
  if (!existsSync(PROFILE_DIR)) return false;

  const result = spawnSync("lsof", ["+D", PROFILE_DIR], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) return false;
  return result.status === 0 && String(result.stdout || "").trim().length > 0;
}

function broadcastStatus() {
  broadcast({
    type: "status",
    running: Boolean(currentRun),
    loginRunning: Boolean(loginProcess),
    logs
  });
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

async function listOutputs() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .filter((entry) => /\.(csv|xls)$/i.test(entry.name))
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
