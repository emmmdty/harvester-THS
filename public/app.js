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
  }
};

const sinceInput = document.querySelector("#since");
const untilInput = document.querySelector("#until");
const untilField = document.querySelector("#until-field");
const crawlModeSelect = document.querySelector("#crawl-mode");
const targetDateInput = document.querySelector("#target-date");
const schedulebarEl = document.querySelector("#schedulebar");
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
const accountManagerEl = document.querySelector("#account-manager");
const accountNameInput = document.querySelector("#account-name");
const accountUrlInput = document.querySelector("#account-url");
const saveAccountButton = document.querySelector("#save-account");
const accountListEl = document.querySelector("#account-list");
const accountStatusEl = document.querySelector("#account-status");

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

feishuWriteButton.addEventListener("click", async () => {
  if (currentPlatform === "daily") return;

  const since = sinceInput.value.trim();
  const until = untilInput.value.trim() || since;
  if (!since) {
    appendLocalLog("请选择要写入飞书的开始日期。");
    sinceInput.focus();
    return;
  }

  const result = await postJson("/api/feishu/write", {
    platform: currentPlatform,
    since,
    until
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
  setRunning();
}

async function loadOutputs() {
  const data = await fetchJson(`/api/outputs?platform=${encodeURIComponent(currentPlatform)}`);
  renderOutputs(data.files || []);
}

async function loadAccounts(platformId) {
  if (platformId === "daily") {
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
  if (currentPlatform === "daily") return;
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
  feishuWriteButton.hidden = currentPlatform === "daily";
  loginCheckButton.hidden = currentPlatform === "daily";
  loginCheckStatusEl.hidden = currentPlatform === "daily";
  schedulebarEl.hidden = currentPlatform !== "daily";
  accountManagerEl.hidden = currentPlatform === "daily";
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
  feishuWriteButton.disabled = currentPlatform === "daily" || busy;
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
