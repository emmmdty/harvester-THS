const PLATFORMS = {
  xhs: {
    eyebrow: "Xiaohongshu Crawler",
    title: "小红书作品采集",
    loginText: "打开小红书登录",
    accountHint: "https://www.xiaohongshu.com/user/profile/..."
  },
  douyin: {
    eyebrow: "Douyin Crawler",
    title: "抖音作品采集",
    loginText: "打开抖音登录",
    accountHint: "https://www.douyin.com/user/..."
  },
  bilibili: {
    eyebrow: "Bilibili Crawler",
    title: "B站作品采集",
    loginText: "打开B站登录",
    accountHint: "https://space.bilibili.com/..."
  },
  daily: {
    eyebrow: "Daily Collector",
    title: "全渠道每日采集",
    loginText: "无需登录",
    accountHint: ""
  },
  settings: {
    eyebrow: "System Settings",
    title: "系统设置与检测",
    loginText: "",
    accountHint: ""
  }
};

const sinceInput = document.querySelector("#since");
const untilInput = document.querySelector("#until");
const untilField = document.querySelector("#until-field");
const crawlerToolbarEl = document.querySelector("#crawler-toolbar");
const workspaceEl = document.querySelector("#workspace");
const crawlModeSelect = document.querySelector("#crawl-mode");
const targetDateInput = document.querySelector("#target-date");
const schedulebarEl = document.querySelector("#schedulebar");
const dateLabelEl = document.querySelector("#date-label");
const loginButton = document.querySelector("#login");
const loginCheckButton = document.querySelector("#login-check");
const loginCheckStatusEl = document.querySelector("#login-check-status");
const runButton = document.querySelector("#run");
const stopButton = document.querySelector("#stop");
const dailyRunButton = document.querySelector("#daily-run");
const clearButton = document.querySelector("#clear");
const refreshButton = document.querySelector("#refresh");
const scheduleTimeInput = document.querySelector("#schedule-time");
const scheduleEnabledInput = document.querySelector("#schedule-enabled");
const saveScheduleButton = document.querySelector("#save-schedule");
const scheduleStatusEl = document.querySelector("#schedule-status");
const logsEl = document.querySelector("#logs");
const progressPanelEl = document.querySelector("#progress-panel");
const progressStageEl = document.querySelector("#progress-stage");
const progressActionEl = document.querySelector("#progress-action");
const progressCountEl = document.querySelector("#progress-count");
const progressUpdatedEl = document.querySelector("#progress-updated");
const progressBarFillEl = document.querySelector("#progress-bar-fill");
const outputsEl = document.querySelector("#outputs");
const statusEl = document.querySelector("#status");
const eyebrowEl = document.querySelector("#eyebrow");
const titleEl = document.querySelector("#title");
const platformButtons = [...document.querySelectorAll(".platform-tab")];
const accountManagerEl = document.querySelector("#account-manager");
const accountNameInput = document.querySelector("#account-name");
const accountUrlInput = document.querySelector("#account-url");
const saveAccountButton = document.querySelector("#save-account");
const accountListEl = document.querySelector("#account-list");
const accountStatusEl = document.querySelector("#account-status");
const settingsPageEl = document.querySelector("#settings-page");
const runConfigChecksButton = document.querySelector("#run-config-checks");
const saveSettingsButton = document.querySelector("#save-settings");
const cleanupCacheButton = document.querySelector("#cleanup-cache");
const settingsStatusEl = document.querySelector("#settings-status");
const settingsCheckListEl = document.querySelector("#settings-check-list");
const settingInputs = {
  feishuAppId: document.querySelector("#setting-feishu-app-id"),
  feishuAppSecret: document.querySelector("#setting-feishu-app-secret"),
  feishuAppSecretSummary: document.querySelector("#setting-feishu-app-secret-summary"),
  feishuSpreadsheetToken: document.querySelector("#setting-feishu-spreadsheet-token"),
  feishuWikiToken: document.querySelector("#setting-feishu-wiki-token"),
  feishuSheetDouyin: document.querySelector("#setting-feishu-sheet-douyin"),
  feishuSheetXhs: document.querySelector("#setting-feishu-sheet-xhs"),
  feishuSheetBilibili: document.querySelector("#setting-feishu-sheet-bilibili"),
  minimaxApiKey: document.querySelector("#setting-minimax-api-key"),
  minimaxApiKeySummary: document.querySelector("#setting-minimax-api-key-summary"),
  minimaxBaseUrl: document.querySelector("#setting-minimax-base-url"),
  minimaxModel: document.querySelector("#setting-minimax-model"),
  deepseekApiKey: document.querySelector("#setting-deepseek-api-key"),
  deepseekApiKeySummary: document.querySelector("#setting-deepseek-api-key-summary"),
  deepseekConfigStatus: document.querySelector("#setting-deepseek-config-status"),
  deepseekBaseUrl: document.querySelector("#setting-deepseek-base-url"),
  deepseekModel: document.querySelector("#setting-deepseek-model")
};
const cachePathEl = document.querySelector("#cache-path");
const cacheSizeEl = document.querySelector("#cache-size");
const openCacheDirButton = document.querySelector("#open-cache-dir");

let currentPlatform = "xhs";
let logs = [];
let loginCheckingPlatform = "";
let events = null;
let panelInitialized = false;
let currentAccounts = [];
const loginCheckState = {};
const autoCheckedPlatforms = new Set();
let runState = {
  running: false,
  runningPlatform: "",
  loginRunning: false,
  loginPlatform: "",
  loginChecking: false
};

platformButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    currentPlatform = button.dataset.platform;
    renderPlatform();
    if (currentPlatform === "settings") {
      await loadSettings();
      return;
    }
    await loadStatus();
    await loadOutputs();
    await loadAccounts(currentPlatform);
  });
});

loginButton.addEventListener("click", async () => {
  await postJson("/api/login", { platform: currentPlatform });
});

loginCheckButton.addEventListener("click", async () => {
  await runLoginCheck(currentPlatform);
});

runButton.addEventListener("click", async () => {
  const since = sinceInput.value.trim();
  const until = untilInput.value.trim() || since;
  if (!since) {
    appendLocalLog(currentPlatform === "daily" ? "请选择目标日期。" : "请选择开始日期。");
    sinceInput.focus();
    return;
  }

  const result = await postJson("/api/crawl", {
    platform: currentPlatform,
    since,
    until,
    mode: crawlModeSelect.value
  });
  if (result?.error) appendLocalLog(result.error);
});

dailyRunButton.addEventListener("click", async () => {
  const since = sinceInput.value.trim() || targetDateInput.value.trim() || previousDateString();
  const until = untilInput.value.trim() || addDaysToDateString(since, 1);
  sinceInput.value = since;
  untilInput.value = until;
  targetDateInput.value = since;
  currentPlatform = "daily";
  renderPlatform();
  await loadStatus();
  const result = await postJson("/api/daily/run", { since, until, mode: crawlModeSelect.value });
  if (result?.error) appendLocalLog(result.error);
});

stopButton.addEventListener("click", async () => {
  await postJson("/api/stop", {});
});

clearButton.addEventListener("click", async () => {
  const result = await postJson("/api/logs/clear", { platform: currentPlatform });
  if (result && !result.error) {
    logs = [];
    renderLogs();
  }
});

refreshButton.addEventListener("click", loadOutputs);

saveScheduleButton.addEventListener("click", async () => {
  const data = await postJson("/api/scheduler", {
    enabled: scheduleEnabledInput.checked,
    time: scheduleTimeInput.value
  });
  if (data && !data.error) renderScheduler(data);
});

saveAccountButton.addEventListener("click", async () => {
  await saveAccount();
});

runConfigChecksButton.addEventListener("click", async () => {
  await runConfigChecks();
});

saveSettingsButton.addEventListener("click", async () => {
  await saveSettings();
});

cleanupCacheButton.addEventListener("click", async () => {
  await cleanupCache();
});

openCacheDirButton.addEventListener("click", async () => {
  await openCacheDir();
});

accountNameInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  accountUrlInput.focus();
});

accountUrlInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  await saveAccount();
});

sinceInput.addEventListener("change", () => {
  if (!untilInput.value || untilInput.value <= sinceInput.value) {
    untilInput.value = addDaysToDateString(sinceInput.value, 1);
  }
});

const today = todayDateString();
const defaultSinceDate = previousDateString();
sinceInput.value = sinceInput.value || defaultSinceDate;
untilInput.value = untilInput.value || today;
targetDateInput.value = targetDateInput.value || defaultSinceDate;
await initializePanel();

async function initializePanel() {
  if (panelInitialized) return;
  panelInitialized = true;
  openEvents();
  renderPlatform();
  await loadStatus();
  await loadOutputs();
  await loadScheduler();
  await loadAccounts(currentPlatform);
  await loadSettings();
  void autoCheckLogin(currentPlatform);
}

function openEvents() {
  if (events) return;
  events = new EventSource("/api/events");
  events.onmessage = (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "log") {
      if (payload.platform !== currentPlatform) return;
      logs.push(payload.line);
      logs = logs.slice(-600);
      renderLogs();
      return;
    }

    if (payload.type === "status") {
      runState = {
        running: Boolean(payload.running),
        runningPlatform: payload.runningPlatform || "",
        loginRunning: Boolean(payload.loginRunning),
        loginPlatform: payload.loginPlatform || "",
        loginChecking: Boolean(payload.loginChecking)
      };
      renderProgress(payload.progress || null);
      setRunning();
      return;
    }

    if (payload.type === "progress") {
      if (payload.platform !== currentPlatform) return;
      renderProgress(payload.progress || null);
      return;
    }

    if (payload.type === "outputs") {
      if (payload.platform !== currentPlatform) return;
      renderOutputs(payload.files || []);
      return;
    }

    if (payload.type === "logs-cleared") {
      if (payload.platform !== currentPlatform) return;
      logs = [];
      renderLogs();
      return;
    }

    if (payload.type === "scheduler") {
      renderScheduler(payload);
    }
  };
  events.onerror = () => {
    appendLocalLog("事件连接已断开，刷新页面可重新连接。");
  };
}

async function loadStatus() {
  const status = await fetchJson(`/api/status?platform=${encodeURIComponent(currentPlatform)}`);
  logs = status.logs || [];
  runState = {
    running: Boolean(status.running),
    runningPlatform: status.runningPlatform || "",
    loginRunning: Boolean(status.loginRunning),
    loginPlatform: status.loginPlatform || "",
    loginChecking: Boolean(status.loginChecking)
  };
  renderLogs();
  renderProgress(status.progress || null);
  setRunning();
}

async function loadOutputs() {
  if (currentPlatform === "settings") {
    outputsEl.innerHTML = `<div class="empty">暂无导出文件</div>`;
    return;
  }
  const data = await fetchJson(`/api/outputs?platform=${encodeURIComponent(currentPlatform)}`);
  renderOutputs(data.files || []);
}

async function loadAccounts(platformId) {
  if (platformId === "daily" || platformId === "settings") {
    currentAccounts = [];
    renderAccounts();
    return;
  }

  try {
    const data = await fetchJson(`/api/accounts?platform=${encodeURIComponent(platformId)}`);
    currentAccounts = data.accounts || [];
    renderAccounts();
  } catch (error) {
    accountStatusEl.textContent = `读取账号失败：${error.message || String(error)}`;
    accountStatusEl.classList.add("error");
  }
}

async function saveAccount() {
  if (currentPlatform === "daily" || currentPlatform === "settings") return;
  const name = accountNameInput.value.trim();
  const url = accountUrlInput.value.trim();
  if (!name) {
    accountNameInput.focus();
    accountStatusEl.textContent = "请输入账号名称。";
    accountStatusEl.classList.add("error");
    return;
  }
  if (!url) {
    accountUrlInput.focus();
    accountStatusEl.textContent = "请输入主页链接。";
    accountStatusEl.classList.add("error");
    return;
  }

  const result = await postJson("/api/accounts/upsert", {
    platform: currentPlatform,
    name,
    url
  });
  if (result?.error) {
    accountStatusEl.textContent = result.error;
    accountStatusEl.classList.add("error");
    return;
  }

  accountNameInput.value = "";
  accountUrlInput.value = "";
  currentAccounts = result.accounts || [];
  renderAccounts();
}

async function deleteAccount(name) {
  const result = await postJson("/api/accounts/delete", {
    platform: currentPlatform,
    name
  });
  if (result?.error) {
    accountStatusEl.textContent = result.error;
    accountStatusEl.classList.add("error");
    return;
  }
  currentAccounts = result.accounts || [];
  renderAccounts();
}

async function loadScheduler() {
  const data = await fetchJson("/api/scheduler");
  renderScheduler(data);
}

async function loadSettings() {
  try {
    const data = await fetchJson("/api/settings");
    renderSettings(data.settings || {});
    renderSettingsCacheSummary(data.cache || {});
  } catch (error) {
    settingsStatusEl.textContent = `读取设置失败：${error.message || String(error)}`;
    settingsStatusEl.className = "settings-status fail";
  }
}

async function saveSettings() {
  settingsStatusEl.textContent = "保存中...";
  settingsStatusEl.className = "settings-status checking";
  const result = await postJson("/api/settings", collectSettingsPayload());
  if (result?.error) {
    settingsStatusEl.textContent = result.error;
    settingsStatusEl.className = "settings-status fail";
    return;
  }
  renderSettings(result.settings || {});
  renderSettingsCacheSummary(result.cache || {});
  settingInputs.feishuAppSecret.value = "";
  settingInputs.minimaxApiKey.value = "";
  settingInputs.deepseekApiKey.value = "";
  settingsStatusEl.textContent = "设置已保存";
  settingsStatusEl.className = "settings-status ok";
}

async function runConfigChecks() {
  settingsStatusEl.textContent = "检测中...";
  settingsStatusEl.className = "settings-status checking";
  settingsCheckListEl.innerHTML = "";
  try {
    const data = await fetchJson("/api/settings/checks");
    renderConfigChecks(data);
  } catch (error) {
    settingsStatusEl.textContent = `检测失败：${error.message || String(error)}`;
    settingsStatusEl.className = "settings-status fail";
  }
}

function collectSettingsPayload() {
  return {
    settings: {
      feishu: {
        appId: settingInputs.feishuAppId.value.trim(),
        appSecret: settingInputs.feishuAppSecret.value.trim() || "__KEEP__",
        spreadsheetToken: settingInputs.feishuSpreadsheetToken.value.trim(),
        wikiToken: settingInputs.feishuWikiToken.value.trim(),
        sheets: {
          douyin: settingInputs.feishuSheetDouyin.value.trim(),
          xhs: settingInputs.feishuSheetXhs.value.trim(),
          bilibili: settingInputs.feishuSheetBilibili.value.trim()
        }
      },
      minimax: {
        apiKey: settingInputs.minimaxApiKey.value.trim() || "__KEEP__",
        baseUrl: settingInputs.minimaxBaseUrl.value.trim(),
        model: settingInputs.minimaxModel.value.trim()
      },
      deepseek: {
        apiKey: settingInputs.deepseekApiKey.value.trim() || "__KEEP__",
        baseUrl: settingInputs.deepseekBaseUrl.value.trim(),
        model: settingInputs.deepseekModel.value.trim()
      }
    }
  };
}

async function cleanupCache() {
  const result = await postJson("/api/cache/cleanup", {});
  if (result?.error) {
    settingsStatusEl.textContent = result.error;
    settingsStatusEl.className = "settings-status fail";
    return;
  }
  settingsStatusEl.textContent = `已清理 ${result.removed?.length || 0} 个缓存目录`;
  settingsStatusEl.className = "settings-status ok";
  renderSettingsCacheSummary(result.cache || {});
}

async function openCacheDir() {
  const result = await postJson("/api/cache/open", {});
  if (result?.error) {
    settingsStatusEl.textContent = result.error;
    settingsStatusEl.className = "settings-status fail";
    return;
  }
  settingsStatusEl.textContent = `已尝试打开缓存目录：${result.path || ""}`;
  settingsStatusEl.className = "settings-status ok";
  renderSettingsCacheSummary(result.cache || {});
}

async function autoCheckLogin(platformId) {
  if (platformId === "daily" || platformId === "settings" || autoCheckedPlatforms.has(platformId)) return;
  autoCheckedPlatforms.add(platformId);
  await runLoginCheck(platformId);
}

async function runLoginCheck(platformId) {
  if (platformId === "daily" || loginCheckingPlatform) return;

  loginCheckingPlatform = platformId;
  loginCheckState[platformId] = {
    status: "checking",
    message: "检测中..."
  };
  renderLoginCheckStatus();
  setRunning();

  const result = await postJson("/api/login/check", { platform: platformId });
  if (result?.error) {
    loginCheckState[platformId] = {
      status: "error",
      message: result.error
    };
  } else if (result) {
    loginCheckState[platformId] = result;
  }

  loginCheckingPlatform = "";
  renderLoginCheckStatus();
  setRunning();
}

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok && data.error) appendLocalLog(data.error);
    return data;
  } catch (error) {
    appendLocalLog(error.message || String(error));
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function renderPlatform() {
  const config = PLATFORMS[currentPlatform];
  eyebrowEl.textContent = config.eyebrow;
  titleEl.textContent = config.title;
  loginButton.textContent = config.loginText;
  dateLabelEl.textContent = "开始日期（含）";
  untilField.hidden = false;
  crawlerToolbarEl.hidden = currentPlatform === "settings";
  workspaceEl.hidden = currentPlatform === "settings";
  loginCheckButton.hidden = currentPlatform === "daily";
  loginCheckStatusEl.hidden = currentPlatform === "daily";
  schedulebarEl.hidden = currentPlatform !== "daily";
  settingsPageEl.hidden = currentPlatform !== "settings";
  accountManagerEl.hidden = currentPlatform === "daily" || currentPlatform === "settings";
  accountUrlInput.placeholder = config.accountHint || "";

  if (currentPlatform === "daily") {
    if (!sinceInput.value) sinceInput.value = targetDateInput.value || previousDateString();
    if (!untilInput.value || untilInput.value <= sinceInput.value) {
      untilInput.value = addDaysToDateString(sinceInput.value, 1);
    }
  } else if (!untilInput.value || untilInput.value <= sinceInput.value) {
    untilInput.value = addDaysToDateString(sinceInput.value || todayDateString(), 1);
  }
  platformButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.platform === currentPlatform);
  });
  renderLoginCheckStatus();
  setRunning();
  void autoCheckLogin(currentPlatform);
}

function setRunning() {
  const runningThisPlatform = runState.running && runState.runningPlatform === currentPlatform;
  const loginThisPlatform = runState.loginRunning && runState.loginPlatform === currentPlatform;
  const busyOtherPlatform = (runState.running && !runningThisPlatform) || (runState.loginRunning && !loginThisPlatform);
  const busy = runState.running || runState.loginRunning || runState.loginChecking;

  runButton.disabled = busy;
  stopButton.disabled = !runState.running;
  loginButton.disabled = currentPlatform === "daily" || busy;
  loginCheckButton.disabled = currentPlatform === "daily" || Boolean(loginCheckingPlatform) || busy;
  crawlModeSelect.disabled = busy;
  dailyRunButton.disabled = busy;
  saveScheduleButton.disabled = busy;
  saveAccountButton.disabled = currentPlatform === "daily" || busy;
  statusEl.classList.toggle("running", busy);

  if (runningThisPlatform) {
    statusEl.textContent = "爬取中";
  } else if (loginThisPlatform) {
    statusEl.textContent = "登录中";
  } else if (runState.loginChecking) {
    statusEl.textContent = "检测登录中";
  } else if (busyOtherPlatform) {
    statusEl.textContent = "其他平台运行中";
  } else {
    statusEl.textContent = "待命";
  }
}

function renderLoginCheckStatus() {
  const state = loginCheckState[currentPlatform] || {
    status: "idle",
    message: "未检测"
  };
  loginCheckStatusEl.textContent = state.message || "未检测";
  loginCheckStatusEl.className = `login-check-status ${state.status || "idle"}`;
}

function renderScheduler(data) {
  scheduleTimeInput.value = data.time || "11:30";
  scheduleEnabledInput.checked = Boolean(data.enabled);
  scheduleStatusEl.textContent = data.enabled ? `已启用 ${data.time}` : "未启用";
  scheduleStatusEl.classList.toggle("active", Boolean(data.enabled));
}

function renderAccounts() {
  accountStatusEl.classList.remove("error");
  accountStatusEl.textContent = currentPlatform === "daily"
    ? "全渠道使用各平台账号"
    : `已配置 ${currentAccounts.length} 个账号`;

  if (currentPlatform === "daily") {
    accountListEl.replaceChildren();
    return;
  }

  if (!currentAccounts.length) {
    accountListEl.innerHTML = `<div class="empty">暂无账号</div>`;
    return;
  }

  accountListEl.replaceChildren(...currentAccounts.map((account) => {
    const item = document.createElement("div");
    item.className = "account-item";

    const text = document.createElement("div");
    text.className = "account-text";

    const name = document.createElement("div");
    name.className = "account-name";
    name.textContent = account.name;

    const url = document.createElement("div");
    url.className = "account-url";
    url.textContent = account.url;

    const actions = document.createElement("div");
    actions.className = "account-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "ghost";
    editButton.textContent = "编辑";
    editButton.addEventListener("click", () => {
      accountNameInput.value = account.name;
      accountUrlInput.value = account.url;
      accountUrlInput.focus();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger";
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", () => {
      void deleteAccount(account.name);
    });

    text.append(name, url);
    actions.append(editButton, deleteButton);
    item.append(text, actions);
    return item;
  }));
}

function renderConfigChecks(data = {}) {
  const checks = data.checks || [];
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  settingsStatusEl.textContent = failed ? `${failed} 项失败` : warned ? `${warned} 项提示` : "检测通过";
  settingsStatusEl.className = `settings-status ${failed ? "fail" : warned ? "warn" : "ok"}`;
  settingsCheckListEl.innerHTML = "";
  for (const check of checks) {
    const item = document.createElement("div");
    item.className = `settings-check-item ${check.status}`;
    const name = document.createElement("div");
    name.className = "settings-check-name";
    name.textContent = check.id;
    const message = document.createElement("div");
    message.className = "settings-check-message";
    message.textContent = check.message || "";
    item.append(name, message);
    settingsCheckListEl.appendChild(item);
  }
}

function renderSettings(settings = {}) {
  const feishu = settings.feishu || {};
  const sheets = feishu.sheets || {};
  const minimax = settings.minimax || {};
  const deepseek = settings.deepseek || {};
  const cache = settings.cache || {};
  settingInputs.feishuAppId.value = feishu.appId?.value || "";
  settingInputs.feishuSpreadsheetToken.value = feishu.spreadsheetToken?.value || "";
  settingInputs.feishuWikiToken.value = feishu.wikiToken?.value || "";
  settingInputs.feishuSheetDouyin.value = sheets.douyin?.value || "";
  settingInputs.feishuSheetXhs.value = sheets.xhs?.value || "";
  settingInputs.feishuSheetBilibili.value = sheets.bilibili?.value || "";
  settingInputs.minimaxBaseUrl.value = minimax.baseUrl?.value || "https://api.minimaxi.com/v1";
  settingInputs.minimaxModel.value = minimax.model?.value || "MiniMax-M3";
  settingInputs.deepseekBaseUrl.value = deepseek.baseUrl?.value || "https://api.deepseek.com";
  settingInputs.deepseekModel.value = deepseek.model?.value || "deepseek-v4-flash";
  renderSecretSummary(settingInputs.feishuAppSecretSummary, feishu.appSecret);
  renderSecretSummary(settingInputs.minimaxApiKeySummary, minimax.apiKey);
  renderSecretSummary(settingInputs.deepseekApiKeySummary, deepseek.apiKey);
  renderConfigStatus(settingInputs.deepseekConfigStatus, deepseek.apiKey?.set);
}

function renderSecretSummary(element, summary = {}) {
  element.textContent = summary.set ? `已设置，尾号 ${summary.last4 || "****"}` : "未设置";
}

function renderConfigStatus(element, configured) {
  element.textContent = configured ? "已配置" : "未配置";
  element.className = configured ? "configured" : "missing";
}

function renderSettingsCacheSummary(cache = {}) {
  cachePathEl.textContent = cache.path || cache.relativePath || "未加载";
  cacheSizeEl.textContent = cache.formattedSize || "0 B";
}

function appendLocalLog(line) {
  logs.push(line);
  logs = logs.slice(-600);
  renderLogs();
}

function renderLogs() {
  logsEl.textContent = logs.join("\n");
  logsEl.scrollTop = logsEl.scrollHeight;
}

function renderProgress(progress) {
  const hasProgress = progress && (progress.stage || progress.action || progress.total || progress.completed);
  progressPanelEl.classList.toggle("idle", !hasProgress);
  if (!hasProgress) {
    const idle = idleProgressText();
    progressStageEl.textContent = idle.stage;
    progressActionEl.textContent = idle.action;
    progressCountEl.textContent = idle.count;
    progressUpdatedEl.textContent = idle.detail;
    progressBarFillEl.style.width = "0%";
    return;
  }

  const total = Math.max(0, Number(progress.total || 0));
  const completed = Math.max(0, Number(progress.completed || 0));
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  progressStageEl.textContent = progressStageText(progress);
  progressActionEl.textContent = progressActionText(progress);
  progressCountEl.textContent = total > 0 ? `${percent}%` : "进行中";
  progressUpdatedEl.textContent = progressDetailText(progress);
  progressBarFillEl.style.width = `${percent}%`;
}

function idleProgressText() {
  const loginThisPlatform = runState.loginRunning && runState.loginPlatform === currentPlatform;
  const runningOtherPlatform = runState.running && runState.runningPlatform !== currentPlatform;
  const loginOtherPlatform = runState.loginRunning && runState.loginPlatform !== currentPlatform;
  if (runState.loginChecking) {
    return {
      stage: "正在检测登录",
      action: "正在确认浏览器登录状态",
      count: "检测中",
      detail: "完成后即可开始采集"
    };
  }
  if (loginThisPlatform) {
    return {
      stage: "等待登录完成",
      action: "请在打开的浏览器中完成登录",
      count: "登录中",
      detail: "登录完成后关闭浏览器窗口"
    };
  }
  if (runningOtherPlatform || loginOtherPlatform) {
    return {
      stage: "其他平台运行中",
      action: "当前页面会保留本平台日志",
      count: "等待",
      detail: "切换到运行平台可查看实时进度"
    };
  }
  return {
    stage: "等待开始",
    action: "暂无采集任务",
    count: "待命",
    detail: "未开始"
  };
}

function progressStageText(progress = {}) {
  if (progress.stage === "material") return "正在准备素材";
  if (progress.stage === "classify") return "正在识别内容";
  if (progress.stage === "feishu") return "正在写入结果";
  if (progress.phase === "failed") return "需要查看日志";
  return "正在运行";
}

function progressActionText(progress = {}) {
  if (progress.stage === "material") {
    if (progress.phase === "fallback" || progress.phase === "fallback-extract") return "正在从页面补充图片素材";
    if (progress.phase === "manifest" || progress.phase === "done") return "素材已保存，准备进入下一步";
    return "正在下载或提取作品素材";
  }
  if (progress.stage === "classify") {
    if (progress.phase === "failed") return "部分内容识别失败，已保留基础数据";
    if (/\b多模态\b/u.test(progress.action || "")) return "正在结合图片或视频理解内容";
    return "正在根据标题、标签和素材判断内容类型";
  }
  if (progress.stage === "feishu") {
    return progress.phase === "done" ? "飞书表格已更新" : "正在同步到飞书表格";
  }
  return "后台任务仍在执行";
}

function progressDetailText(progress = {}) {
  const parts = [];
  if (progress.itemId) parts.push(`作品 ${shortProgressItemId(progress.itemId)}`);
  if (progress.total > 0) parts.push(`${Number(progress.completed || 0)}/${Number(progress.total || 0)}`);
  parts.push(`更新 ${formatTime(progress.updatedAt || new Date().toISOString())}`);
  return parts.join(" · ");
}

function shortProgressItemId(value = "") {
  const text = String(value || "").trim();
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function renderOutputs(files) {
  if (!files.length) {
    outputsEl.innerHTML = `<div class="empty">暂无导出文件</div>`;
    return;
  }

  outputsEl.replaceChildren(...files.map((file) => {
    const link = document.createElement("a");
    link.className = "output-link";
    link.href = file.href;

    const name = document.createElement("div");
    name.className = "output-name";
    name.textContent = file.name;

    const meta = document.createElement("div");
    meta.className = "output-meta";
    meta.textContent = `${formatSize(file.size)} · ${formatTime(file.updatedAt)}`;

    link.append(name, meta);
    return link;
  }));
}

function formatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function todayDateString() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function previousDateString() {
  return addDaysToDateString(todayDateString(), -1);
}

function addDaysToDateString(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}
