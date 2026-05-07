import path from "node:path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, resolveHeadless } from "./browser-env.mjs";

const ROOT = process.cwd();
const USER_DATA_DIR = path.join(ROOT, ".douyin-profile");
const DOUYIN_URL = "https://www.douyin.com";

async function main() {
  if (resolveHeadless()) {
    throw new Error("当前是无头模式，无法交互登录。请在有桌面环境的机器上运行登录，或挂载已有的 .douyin-profile 登录目录。");
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    ...chromiumLaunchOptions(),
    headless: false,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai"
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(DOUYIN_URL, { waitUntil: "domcontentloaded" });
  console.log("抖音登录浏览器已打开。登录完成后关闭这个浏览器窗口，再回到面板开始爬取。");

  await new Promise((resolve) => context.on("close", resolve));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
