import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { validateFeishuConfig } from "./feishu-sheets.mjs";

const PROFILE_DIRS = [".xhs-profile", ".douyin-profile", ".bilibili-profile"];

export async function runProductionCheck({
  root = process.cwd(),
  env = process.env,
  checkPort = defaultCheckPort
} = {}) {
  const checks = [];
  checks.push(await checkEnvFile(root));
  checks.push(checkFeishu(env));
  checks.push(await checkProfiles(root));
  checks.push(await checkScheduler(root));
  checks.push(await checkPort({
    host: String(env.HOST || "127.0.0.1"),
    port: Number(env.PORT || 3000)
  }));

  const failed = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  return {
    ok: failed.length === 0,
    checks,
    summary: failed.length
      ? `生产检查未通过：${failed.length} 项失败，${warnings.length} 项提示。`
      : `生产检查通过：0 项失败，${warnings.length} 项提示。`
  };
}

export async function defaultCheckPort({ host, port }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return check("port", "fail", `端口无效：${port}`);
  }
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      resolve(check("port", "fail", `端口 ${port} 不可用：${error.code || error.message}`));
    });
    server.listen({ host, port }, () => {
      server.close(() => resolve(check("port", "ok", `端口 ${port} 可用。`)));
    });
  });
}

async function checkEnvFile(root) {
  const envPath = path.join(root, ".env");
  const exists = await pathExists(envPath);
  return exists
    ? check("env_file", "ok", "已找到 .env。")
    : check("env_file", "fail", "未找到 .env，请先复制 .env.example 并填入本地配置。");
}

function checkFeishu(env) {
  const result = validateFeishuConfig(env);
  return check("feishu_config", result.ok ? "ok" : "fail", result.message);
}

async function checkProfiles(root) {
  const missing = [];
  for (const dir of PROFILE_DIRS) {
    if (!await pathExists(path.join(root, dir))) missing.push(dir);
  }
  return missing.length
    ? check("profiles", "fail", `缺少浏览器登录态目录：${missing.join("、")}。请先在本机完成对应平台登录。`)
    : check("profiles", "ok", "三个平台浏览器登录态目录已存在。");
}

async function checkScheduler(root) {
  const schedulerPath = path.join(root, ".runtime", "scheduler.json");
  try {
    const parsed = JSON.parse(await fs.readFile(schedulerPath, "utf8"));
    const state = parsed.enabled ? `已启用，时间 ${parsed.time || "未设置"}` : "未启用";
    return check("scheduler", "ok", `定时配置存在：${state}。`);
  } catch {
    return check("scheduler", "warn", "未找到 .runtime/scheduler.json；面板首次保存定时后会生成。");
  }
}

function check(id, status, message) {
  return { id, status, message };
}

async function pathExists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => null));
}
