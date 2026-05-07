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
  }
};

const sinceInput = document.querySelector("#since");
const loginButton = document.querySelector("#login");
const runButton = document.querySelector("#run");
const stopButton = document.querySelector("#stop");
const clearButton = document.querySelector("#clear");
const refreshButton = document.querySelector("#refresh");
const logsEl = document.querySelector("#logs");
const outputsEl = document.querySelector("#outputs");
const statusEl = document.querySelector("#status");
const eyebrowEl = document.querySelector("#eyebrow");
const titleEl = document.querySelector("#title");
const platformButtons = [...document.querySelectorAll(".platform-tab")];

let currentPlatform = "xhs";
let logs = [];
let runState = {
  running: false,
  runningPlatform: "",
  loginRunning: false,
  loginPlatform: ""
};

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

runButton.addEventListener("click", async () => {
  const since = sinceInput.value.trim();
  if (!since) {
    appendLocalLog("请输入起始日期。");
    sinceInput.focus();
    return;
  }

  const result = await postJson("/api/crawl", { platform: currentPlatform, since });
  if (result?.error) appendLocalLog(result.error);
});

stopButton.addEventListener("click", async () => {
  await postJson("/api/stop", {});
});

clearButton.addEventListener("click", () => {
  logs = [];
  renderLogs();
});

refreshButton.addEventListener("click", loadOutputs);

const events = new EventSource("/api/events");
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
      loginPlatform: payload.loginPlatform || ""
    };
    setRunning();
    return;
  }

  if (payload.type === "outputs") {
    if (payload.platform !== currentPlatform) return;
    renderOutputs(payload.files || []);
  }
};

renderPlatform();
await loadStatus();
await loadOutputs();

async function loadStatus() {
  const status = await fetchJson(`/api/status?platform=${encodeURIComponent(currentPlatform)}`);
  logs = status.logs || [];
  runState = {
    running: Boolean(status.running),
    runningPlatform: status.runningPlatform || "",
    loginRunning: Boolean(status.loginRunning),
    loginPlatform: status.loginPlatform || ""
  };
  renderLogs();
  setRunning();
}

async function loadOutputs() {
  const data = await fetchJson(`/api/outputs?platform=${encodeURIComponent(currentPlatform)}`);
  renderOutputs(data.files || []);
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
  return response.json();
}

function renderPlatform() {
  const config = PLATFORMS[currentPlatform];
  eyebrowEl.textContent = config.eyebrow;
  titleEl.textContent = config.title;
  loginButton.textContent = config.loginText;
  platformButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.platform === currentPlatform);
  });
  setRunning();
}

function setRunning() {
  const runningThisPlatform = runState.running && runState.runningPlatform === currentPlatform;
  const loginThisPlatform = runState.loginRunning && runState.loginPlatform === currentPlatform;
  const busyOtherPlatform = (runState.running && !runningThisPlatform) || (runState.loginRunning && !loginThisPlatform);

  runButton.disabled = runState.running || runState.loginRunning;
  stopButton.disabled = !runState.running;
  loginButton.disabled = runState.loginRunning || runState.running;
  statusEl.classList.toggle("running", runState.running || runState.loginRunning);

  if (runningThisPlatform) {
    statusEl.textContent = "爬取中";
  } else if (loginThisPlatform) {
    statusEl.textContent = "登录中";
  } else if (busyOtherPlatform) {
    statusEl.textContent = "其他平台运行中";
  } else {
    statusEl.textContent = "待命";
  }
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
