import fs from "node:fs/promises";
import path from "node:path";

export const PLATFORM_ACCOUNT_CONFIG = "platform-accounts.json";
export const ACCOUNT_PLATFORM_IDS = ["xhs", "douyin", "bilibili"];

export async function readAllPlatformAccounts({ root = process.cwd() } = {}) {
  const parsed = await readRawConfig(root);
  return normalizeAccountConfig(parsed);
}

export async function readPlatformAccounts(platformId, { root = process.cwd() } = {}) {
  assertAccountPlatform(platformId);
  const accounts = await readAllPlatformAccounts({ root });
  return accounts[platformId];
}

export async function upsertPlatformAccount({ root = process.cwd(), platformId, name, url }) {
  assertAccountPlatform(platformId);
  const config = await readAllPlatformAccounts({ root });
  const account = normalizePlatformAccount(platformId, { name, url });
  const existingIndex = config[platformId].findIndex((item) => item.name === account.name);
  if (existingIndex >= 0) {
    config[platformId][existingIndex] = account;
  } else {
    config[platformId].push(account);
  }
  await writeAllPlatformAccounts(config, { root });
  return account;
}

export async function deletePlatformAccount({ root = process.cwd(), platformId, name }) {
  assertAccountPlatform(platformId);
  const config = await readAllPlatformAccounts({ root });
  const targetName = String(name || "").trim();
  config[platformId] = config[platformId].filter((item) => item.name !== targetName);
  await writeAllPlatformAccounts(config, { root });
  return { ok: true, platform: platformId, name: targetName };
}

export async function writeAllPlatformAccounts(config, { root = process.cwd() } = {}) {
  const normalized = normalizeAccountConfig(config);
  await fs.writeFile(accountConfigPath(root), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function normalizeAccountConfig(config = {}) {
  const normalized = {};
  for (const platformId of ACCOUNT_PLATFORM_IDS) {
    const items = Array.isArray(config?.[platformId]) ? config[platformId] : [];
    normalized[platformId] = uniqueAccounts(items
      .map((item) => normalizePlatformAccount(platformId, item))
      .filter((item) => item.name));
  }
  return normalized;
}

export function normalizePlatformAccount(platformId, account) {
  assertAccountPlatform(platformId);
  const name = String(account?.name || "").trim();
  const url = normalizePlatformProfileUrl(platformId, String(account?.url || "").trim());
  if (!name) throw new Error("账号名称不能为空。");
  if (!url) throw new Error(`${platformLabel(platformId)}主页链接不能为空。`);
  return { name, url };
}

export function normalizePlatformProfileUrl(platformId, rawUrl) {
  assertAccountPlatform(platformId);
  if (!rawUrl) return "";
  if (platformId === "xhs") return normalizeXhsProfileUrl(rawUrl);
  if (platformId === "douyin") return normalizeDouyinProfileUrl(rawUrl);
  return normalizeBilibiliProfileUrl(rawUrl);
}

export function assertAccountPlatform(platformId) {
  if (!ACCOUNT_PLATFORM_IDS.includes(platformId)) {
    throw new Error(`不支持的平台：${platformId || "空"}`);
  }
}

async function readRawConfig(root) {
  try {
    const text = await fs.readFile(accountConfigPath(root), "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

function accountConfigPath(root) {
  return path.join(root, PLATFORM_ACCOUNT_CONFIG);
}

function normalizeXhsProfileUrl(rawUrl) {
  const url = new URL(rawUrl, "https://www.xiaohongshu.com");
  const match = url.pathname.match(/\/user\/profile\/([^/?#]+)/);
  if (!match || !/xiaohongshu\.com$/i.test(url.hostname)) {
    throw new Error("请输入有效的小红书主页链接。");
  }
  return `https://www.xiaohongshu.com/user/profile/${match[1]}`;
}

function normalizeDouyinProfileUrl(rawUrl) {
  const url = new URL(rawUrl, "https://www.douyin.com");
  const match = url.pathname.match(/^\/user\/([^/?#]+)/);
  if (!match || !/(^|\.)douyin\.com$/i.test(url.hostname)) {
    throw new Error("请输入有效的抖音主页链接。");
  }
  return `https://www.douyin.com/user/${match[1]}`;
}

function normalizeBilibiliProfileUrl(rawUrl) {
  const url = new URL(rawUrl, "https://space.bilibili.com");
  const match = url.pathname.match(/^\/(\d+)(?:\/video)?\/?$/);
  if (!match || url.hostname.toLowerCase() !== "space.bilibili.com") {
    throw new Error("请输入有效的B站主页链接。");
  }
  return `https://space.bilibili.com/${match[1]}/video`;
}

function uniqueAccounts(accounts) {
  const byName = new Map();
  for (const account of accounts) byName.set(account.name, account);
  return [...byName.values()];
}

function platformLabel(platformId) {
  return {
    xhs: "小红书",
    douyin: "抖音",
    bilibili: "B站"
  }[platformId];
}
