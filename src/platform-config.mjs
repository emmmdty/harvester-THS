import path from "node:path";
import { buildXhsOutputBaseName } from "./xhs-output-names.mjs";

export const DAILY_PLATFORM_IDS = ["douyin", "xhs", "bilibili"];

export const PLATFORM_CONFIGS = {
  xhs: {
    id: "xhs",
    label: "小红书",
    profileDirName: ".xhs-profile",
    loginScript: "login-xhs.mjs",
    crawlScript: "crawl-xhs.mjs",
    outputPrefix: "xhs_notes_",
    jsonField: "items"
  },
  douyin: {
    id: "douyin",
    label: "抖音",
    profileDirName: ".douyin-profile",
    loginScript: "login-douyin.mjs",
    crawlScript: "crawl-douyin.mjs",
    outputPrefix: "douyin_notes_",
    jsonField: "items"
  },
  bilibili: {
    id: "bilibili",
    label: "B站",
    profileDirName: ".bilibili-profile",
    loginScript: "login-bilibili.mjs",
    crawlScript: "crawl-bilibili.mjs",
    outputPrefix: "bilibili_videos_",
    jsonField: "items"
  }
};

export const DAILY_OUTPUT_PREFIX = "daily_collect_";

export function getPlatformConfig(platformId) {
  const config = PLATFORM_CONFIGS[platformId];
  if (!config) throw new Error(`不支持的平台：${platformId}`);
  return config;
}

export function resolvePlatformPaths(platformId, root = process.cwd()) {
  const config = getPlatformConfig(platformId);
  return {
    ...config,
    profileDir: path.join(root, config.profileDirName),
    loginScriptPath: path.join(root, "src", config.loginScript),
    crawlScriptPath: path.join(root, "src", config.crawlScript)
  };
}

export function outputBaseName(platformId, sinceDate, untilDate = sinceDate, { accountName = "" } = {}) {
  const config = getPlatformConfig(platformId);
  if (platformId === "xhs" && accountName) {
    return buildXhsOutputBaseName({
      since: sinceDate,
      until: untilDate,
      accountName
    });
  }
  return `${config.outputPrefix}${sinceDate}_to_${untilDate}`;
}

export function outputJsonPath(platformId, sinceDate, root = process.cwd(), untilDate = sinceDate, options = {}) {
  return path.join(root, "output", `${outputBaseName(platformId, sinceDate, untilDate, options)}.json`);
}

export function dailySummaryPath(sinceDate, root = process.cwd(), untilDate = sinceDate) {
  const datePart = untilDate && untilDate !== sinceDate
    ? `${sinceDate}_to_${untilDate}`
    : sinceDate;
  return path.join(root, "output", `${DAILY_OUTPUT_PREFIX}${datePart}.json`);
}
