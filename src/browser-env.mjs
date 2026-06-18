import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function isDocker() {
  return process.env.DOCKER === "1" || existsSync("/.dockerenv");
}

export function resolveHeadless() {
  const value = process.env.HEADLESS;
  if (value !== undefined) {
    return /^(1|true|yes)$/i.test(value);
  }

  if (process.env.CI || isDocker()) return true;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  return false;
}

export function resolveCrawlerHeadless(env = process.env) {
  const value = env.CRAWL_BROWSER_HEADLESS ?? env.CRAWL_HEADLESS;
  if (value !== undefined) {
    return /^(1|true|yes)$/i.test(String(value));
  }
  return true;
}

export function resolveMaterialFallbackHeadless(env = process.env) {
  const value = env.MATERIAL_BROWSER_FALLBACK_HEADLESS
    ?? env.MATERIAL_FALLBACK_HEADLESS
    ?? env.PLAYWRIGHT_HEADLESS;
  if (value !== undefined) {
    return /^(1|true|yes)$/i.test(String(value));
  }
  return resolveCrawlerHeadless(env);
}

export function chromiumLaunchOptions() {
  const args = [];

  if (process.platform === "linux" && (process.env.CI || isDocker() || !process.env.DISPLAY)) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  return { args };
}

export function activateChromiumWindow(env = process.env) {
  if (/^(0|false|no|off)$/iu.test(String(env.LOGIN_WINDOW_ACTIVATE ?? "").trim())) return false;
  try {
    if (process.platform === "darwin") {
      return spawnSync("osascript", ["-e", 'tell application "Chromium" to activate'], {
        stdio: "ignore"
      }).status === 0;
    }
    if (process.platform === "win32") {
      const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('Chromium') | Out-Null";
      return spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
        stdio: "ignore"
      }).status === 0;
    }
  } catch {
    return false;
  }
  return false;
}
