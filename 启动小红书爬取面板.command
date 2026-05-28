#!/bin/zsh
set -e

cd "$(dirname "$0")"

URL="http://127.0.0.1:3000/"

if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 3000 >/dev/null 2>&1; then
  echo "面板已经在运行，正在打开浏览器..."
  open "$URL"
  exit 0
fi

echo "正在启动作品采集面板（本机模式）..."
echo "打开后请不要关闭这个终端窗口；关闭窗口或按 Ctrl+C 会停止面板。"
echo "本机访问地址：$URL"
echo

npm run ui &
SERVER_PID=$!

sleep 2
open "$URL"

wait "$SERVER_PID"
