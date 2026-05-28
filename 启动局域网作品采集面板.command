#!/bin/zsh
set -e

cd "$(dirname "$0")"

URL="http://127.0.0.1:3000/"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"

if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 3000 >/dev/null 2>&1; then
  echo "面板已经在运行，正在打开浏览器..."
  open "$URL"
  exit 0
fi

echo "正在启动作品采集面板（局域网模式）..."
echo "打开后请不要关闭这个终端窗口；关闭窗口或按 Ctrl+C 会停止面板。"
echo "本机访问地址：$URL"
if [ -n "$LAN_IP" ]; then
  echo "同事访问地址：http://$LAN_IP:3000/"
else
  echo "同事访问地址：http://<本机局域网IP>:3000/"
fi
echo "如需共享口令，请在 .env 中填写 PANEL_PASSWORD 后重新启动。"
echo

HOST=0.0.0.0 npm run ui &
SERVER_PID=$!

sleep 2
open "$URL"

wait "$SERVER_PID"
