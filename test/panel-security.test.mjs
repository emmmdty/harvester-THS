import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePanelPlatform,
  validatePostOrigin
} from "../src/panel-security.mjs";

test("POST origin and referer must match the request host when present", () => {
  assert.deepEqual(
    validatePostOrigin({
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }
    }),
    { ok: true }
  );
  assert.deepEqual(
    validatePostOrigin({
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://evil.example"
      }
    }),
    { ok: false, status: 403, error: "跨站请求已被拒绝。" }
  );
  assert.deepEqual(
    validatePostOrigin({
      method: "POST",
      headers: {
        host: "192.168.1.20:3000",
        referer: "http://192.168.1.20:3000/"
      }
    }),
    { ok: true }
  );
});

test("unknown platform is rejected instead of falling back to Xiaohongshu", () => {
  const platforms = { xhs: { id: "xhs" }, daily: { id: "daily" } };

  assert.deepEqual(resolvePanelPlatform("xhs", platforms), { id: "xhs" });
  assert.throws(
    () => resolvePanelPlatform("weibo", platforms),
    /不支持的平台：weibo/
  );
  try {
    resolvePanelPlatform("", platforms);
  } catch (error) {
    assert.equal(error.status, 400);
  }
});

test("server no longer exposes shared password auth routes", async () => {
  const server = await fs.readFile(path.join(process.cwd(), "src", "server.mjs"), "utf8");

  assert.doesNotMatch(server, /\/api\/auth\//);
  assert.doesNotMatch(server, /PANEL_PASSWORD/);
  assert.doesNotMatch(server, /panelAuth/);
  assert.doesNotMatch(server, /isProtectedPanelPath/);
  assert.match(server, /validatePostOrigin/);
});
