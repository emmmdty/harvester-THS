import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPanelPasswordConfig,
  createPanelAuth,
  isProtectedPanelPath,
  resolvePanelPlatform,
  validatePostOrigin
} from "../src/panel-auth.mjs";

test("shared LAN host can run without PANEL_PASSWORD", () => {
  assert.doesNotThrow(() => assertPanelPasswordConfig({ host: "127.0.0.1", panelPassword: "" }));
  assert.doesNotThrow(() => assertPanelPasswordConfig({ host: "0.0.0.0", panelPassword: "team-secret" }));
  assert.doesNotThrow(() => assertPanelPasswordConfig({ host: "0.0.0.0", panelPassword: "" }));
  assert.doesNotThrow(() => assertPanelPasswordConfig({ host: "::", panelPassword: "" }));
});

test("panel auth rejects missing and wrong passwords and returns an HttpOnly session cookie for the right password", () => {
  let now = 1000;
  const auth = createPanelAuth({
    panelPassword: "team-secret",
    now: () => now,
    sessionTtlMs: 5000
  });

  assert.equal(auth.isEnabled(), true);
  assert.equal(auth.authenticateRequest({ headers: {} }).ok, false);
  assert.equal(auth.authenticateRequest({ headers: {} }).status, 401);

  const badLogin = auth.login("wrong");
  assert.equal(badLogin.ok, false);
  assert.equal(badLogin.status, 401);

  const goodLogin = auth.login("team-secret");
  assert.equal(goodLogin.ok, true);
  assert.match(goodLogin.cookie, /harvester_panel_session=/);
  assert.match(goodLogin.cookie, /HttpOnly/);
  assert.match(goodLogin.cookie, /SameSite=Strict/);

  assert.equal(auth.authenticateRequest({ headers: { cookie: goodLogin.cookie } }).ok, true);
  now += 6000;
  assert.equal(auth.authenticateRequest({ headers: { cookie: goodLogin.cookie } }).ok, false);
});

test("panel auth is disabled for local mode without PANEL_PASSWORD", () => {
  const auth = createPanelAuth({ panelPassword: "" });

  assert.equal(auth.isEnabled(), false);
  assert.equal(auth.login("").ok, true);
  assert.equal(auth.authenticateRequest({ headers: {} }).ok, true);
});

test("sensitive API, event stream, and output download paths are protected", () => {
  assert.equal(isProtectedPanelPath("/api/status"), true);
  assert.equal(isProtectedPanelPath("/api/events"), true);
  assert.equal(isProtectedPanelPath("/output/xhs_notes.csv"), true);
  assert.equal(isProtectedPanelPath("/api/auth/status"), false);
  assert.equal(isProtectedPanelPath("/api/auth/login"), false);
  assert.equal(isProtectedPanelPath("/api/auth/logout"), false);
  assert.equal(isProtectedPanelPath("/app.js"), false);
});

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
