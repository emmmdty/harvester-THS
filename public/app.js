const PLATFORMS = {
  xhs: {
    eyebrow: "Xiaohongshu Crawler",
    title: "小红书作品采集",
    loginText: "打开小红书登录"
  },
  douyin: {
    eyebrow: "Douyin Crawler",
    title: "抖音作品采集",
    loginText: "打开抖音登录"
  },
  bilibili: {
    eyebrow: "Bilibili Crawler",
    title: "B站作品采集",
    loginText: "打开B站登录"
  },
  daily: {
    eyebrow: "Daily Collector",
    title: "全渠道每日采集",
    loginText: "无需登录"
  }
};

const sinceInput = document.querySelector("#since");
const untilInput = document.querySelector("#until");
const untilField = document.querySelector("#until-field");
const accountField = document.querySelector("#account-field");
const accountSelect = document.querySelector("#account");
const crawlModeSelect = document.querySelector("#crawl-mode");
const targetDateInput = document.querySelector("#target-date");
const dateLabelEl = document.querySelector("#date-label");
const loginButton = document.querySelector("#login");
const loginCheckButton = document.querySelector("#login-check");
const loginCheckStatusEl = document.querySelector("#login-check-status");
const runButton = document.querySelector("#run");
const feishuWriteButton = document.querySelector("#feishu-write");
const stopButton = document.querySelector("#stop");
const dailyRunButton = document.querySelector("#daily-run");
const clearButton = document.querySelector("#clear");
const refreshButton = document.querySelector("#refresh");
const scheduleTimeInput = document.querySelector("#schedule-time");
const scheduleEnabledInput = document.querySelector("#schedule-enabled");
const saveScheduleButton = document.querySelector("#save-schedule");
const scheduleStatusEl = document.querySelector("#schedule-status");
const logsEl = document.querySelector("#logs");
const outputsEl = document.querySelector("#outputs");
const statusEl = document.querySelector("#status");
const eyebrowEl = document.querySelector("#eyebrow");
const titleEl = document.querySelector("#title");
const platformButtons = [...document.querySelectorAll(".platform-tab")];
const authPanel = document.querySelector("#auth-panel");
const panelContent = document.querySelector("#panel-content");
const panelPasswordInput = document.querySelector("#panel-password");
const panelLoginButton = document.querySelector("#panel-login");
const panelAuthStatusEl = document.querySelector("#panel-auth-status");

let currentPlatform = "xhs";
let logs = [];
let loginCheckingPlatform = "";
let xhsAccountsLoaded = false;
let events = null;
let panelInitialized = false;
const loginCheckState = {};
const autoCheckedPlatforms = new Set();
let runState = {
  running: false,
  runningPlatform: "",
  loginRunning: false,
  loginPlatform: "",
  loginChecking: false
};

panelLoginButton.addEventListener("click", handlePanelLogin);
panelPasswordInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  await handlePanelLogin();
});

platformButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    currentPlatform = button.dataset.platform;
    renderPlatform();
    await loadStatus();
    await loadOutputs();
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

  const body = currentPlatform === "daily"
    ? { platform: currentPlatform, since, until, mode: crawlModeSelect.value }
    : { platform: currentPlatform, since, until, mode: crawlModeSelect.value };
  if (currentPlatform === "xhs" && accountSelect.value) {
    body.account = accountSelect.value;
  }

  const result = await postJson("/api/crawl", body);
  if (result?.error) appendLocalLog(result.error);
});

feishuWriteButton.addEventListener("click", async () => {
  if (currentPlatform === "daily") return;

  const since = sinceInput.value.trim();
  const until = untilInput.value.trim() || since;
  if (!since) {
    appendLocalLog("请选择要写入飞书的开始日期。");
    sinceInput.focus();
    return;
  }

  const body = {
    platform: currentPlatform,
    since,
    until
  };
  if (currentPlatform === "xhs" && accountSelect.value) {
    body.account = accountSelect.value;
  }

  const result = await postJson("/api/feishu/write", body);
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
await initializeAuth();

async function initializeAuth() {
  panelContent.hidden = true;
  authPanel.hidden = true;
  const auth = await fetchJson("/api/auth/status", { allowUnauthorized: true });
  if (auth?.authRequired && !auth.authenticated) {
    showAuth("请输入共享口令");
    return;
  }
  await initializePanel();
}

async function handlePanelLogin() {
  const password = panelPasswordInput.value;
  panelLoginButton.disabled = true;
  panelAuthStatusEl.textContent = "登录中...";
  panelAuthStatusEl.classList.remove("error");
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await response.json();
    if (!response.ok) {
      showAuth(data.error || "口令错误。");
      return;
    }
    panelPasswordInput.value = "";
    await initializePanel();
  } catch (error) {
    showAuth(error.message || String(error));
  } finally {
    panelLoginButton.disabled = false;
  }
}

async function initializePanel() {
  if (panelInitialized) {
    authPanel.hidden = true;
    panelContent.hidden = false;
    return;
  }
  panelInitialized = true;
  authPanel.hidden = true;
  panelContent.hidden = false;
  openEvents();
  renderPlatform();
  await loadStatus();
  await loadOutputs();
  await loadScheduler();
  void autoCheckLogin(currentPlatform);
}

function showAuth(message) {
  panelInitialized = false;
  if (events) {
    events.close();
    events = null;
  }
  panelContent.hidden = true;
  authPanel.hidden = false;
  panelAuthStatusEl.textContent = message || "请输入共享口令";
  panelAuthStatusEl.classList.toggle("error", Boolean(message && message !== "请输入共享口令"));
  statusEl.textContent = "需要口令";
  statusEl.classList.remove("running");
  panelPasswordInput.focus();
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
      setRunning();
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
    showAuth("面板会话已失效，请重新登录。");
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
  setRunning();
}

async function loadOutputs() {
  const data = await fetchJson(`/api/outputs?platform=${encodeURIComponent(currentPlatform)}`);
  renderOutputs(data.files || []);
}

async function loadAccounts() {
  if (xhsAccountsLoaded) return;

  try {
    const data = await fetchJson("/api/accounts?platform=xhs");
    const accounts = data.accounts || [];
    const previousValue = accountSelect.value;
    accountSelect.replaceChildren(
      new Option("全部账号", ""),
      ...accounts.map((account) => new Option(account.name, account.name))
    );
    if ([...accountSelect.options].some((option) => option.value === previousValue)) {
      accountSelect.value = previousValue;
    }
    xhsAccountsLoaded = true;
  } catch (error) {
    appendLocalLog(`读取小红书账号列表失败：${error.message || String(error)}`);
  }
}

async function loadScheduler() {
  const data = await fetchJson("/api/scheduler");
  renderScheduler(data);
}

async function autoCheckLogin(platformId) {
  if (platformId === "daily" || autoCheckedPlatforms.has(platformId)) return;
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
    if (response.status === 401) {
      showAuth(data.error || "面板会话已失效，请重新登录。");
      return data;
    }
    if (!response.ok && data.error) appendLocalLog(data.error);
    return data;
  } catch (error) {
    appendLocalLog(error.message || String(error));
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url);
  const data = await response.json();
  if (response.status === 401 && !options.allowUnauthorized) {
    showAuth(data.error || "面板会话已失效，请重新登录。");
    throw new Error(data.error || "未登录");
  }
  return data;
}

function renderPlatform() {
  const config = PLATFORMS[currentPlatform];
  eyebrowEl.textContent = config.eyebrow;
  titleEl.textContent = config.title;
  loginButton.textContent = config.loginText;
  dateLabelEl.textContent = "开始日期（含）";
  untilField.hidden = false;
  accountField.hidden = currentPlatform !== "xhs";
  feishuWriteButton.hidden = currentPlatform === "daily";
  loginCheckButton.hidden = currentPlatform === "daily";
  loginCheckStatusEl.hidden = currentPlatform === "daily";
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
  if (currentPlatform === "xhs") void loadAccounts();
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
  feishuWriteButton.disabled = currentPlatform === "daily" || busy;
  accountSelect.disabled = currentPlatform !== "xhs" || busy;
  crawlModeSelect.disabled = busy;
  dailyRunButton.disabled = busy;
  saveScheduleButton.disabled = busy;
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

function appendLocalLog(line) {
  logs.push(line);
  logs = logs.slice(-600);
  renderLogs();
}

function renderLogs() {
  logsEl.textContent = logs.join("\n");
  logsEl.scrollTop = logsEl.scrollHeight;
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
