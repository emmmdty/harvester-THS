import { existsSync } from "node:fs";

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

export function chromiumLaunchOptions() {
  const args = [];

  if (process.platform === "linux" && (process.env.CI || isDocker() || !process.env.DISPLAY)) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  return { args };
}
