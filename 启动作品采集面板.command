#!/bin/zsh
set -e

cd "$(dirname "$0")"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
NPM_REGISTRY="https://registry.npmmirror.com"
PLAYWRIGHT_DOWNLOAD_HOST="https://npmmirror.com/mirrors/playwright"
PANEL_PORT_START="${PANEL_PORT_START:-3000}"
PANEL_PORT_END="${PANEL_PORT_END:-3099}"

fail() {
  echo
  echo "$1"
  echo
  echo "按任意键退出..."
  read -r -k 1
  exit 1
}

step() {
  echo
  echo "==== $1 ===="
}

step "1/5 检查 Node.js 和 npm"
if ! command -v npm >/dev/null 2>&1; then
  fail "未找到 npm。请先安装 Node.js，并确认 npm 可以在终端中运行。"
fi
echo "npm 已就绪：$(npm --version)"

step "2/5 检查运行组件"
if [ ! -d node_modules ]; then
  echo "第一次启动需要安装运行组件，可能需要几分钟，请不要关闭窗口。"
  npm ci --registry="$NPM_REGISTRY" || fail "运行组件安装失败。请检查网络，或把这个窗口截图发给技术同事。"
else
  echo "运行组件已存在，跳过安装。"
fi

step "3/5 检查浏览器组件"
PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST" npx playwright install chromium || fail "浏览器组件安装失败。请检查网络，或把这个窗口截图发给技术同事。"

step "4/5 选择可用端口"
PORT="$(
  PANEL_PORT_START="$PANEL_PORT_START" PANEL_PORT_END="$PANEL_PORT_END" PANEL_HOST=0.0.0.0 node scripts/select-panel-port.mjs
)" || fail "$PANEL_PORT_START-$PANEL_PORT_END 端口都被占用，请先关闭其它面板或占用端口的程序。"
URL="http://127.0.0.1:$PORT/"
echo "已选择端口：$PORT"

step "5/5 启动作品采集面板"
echo "正在启动作品采集面板..."
echo "支持：小红书、抖音、B站、全渠道"
echo "默认按局域网模式启动，账号范围来自 platform-accounts.json。"
echo "定时采集按全渠道执行。"
echo "浏览器打开后，依次扫码登录小红书、抖音、B站，然后开始采集。"
echo "打开后请不要关闭这个终端窗口；关闭窗口或按 Ctrl+C 会停止面板。"
echo "本机访问地址：$URL"
if [ -n "$LAN_IP" ]; then
  echo "同事访问地址：http://$LAN_IP:$PORT/"
else
  echo "同事访问地址：http://<本机局域网IP>:$PORT/"
fi
echo

PORT="$PORT" HOST=0.0.0.0 npm run ui &
SERVER_PID=$!

sleep 2
open "$URL"

wait "$SERVER_PID"
