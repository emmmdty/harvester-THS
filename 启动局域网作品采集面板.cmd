@echo off
setlocal

cd /d "%~dp0"
set "URL=http://127.0.0.1:3000/"
set "HOST=0.0.0.0"
set "LAN_IP="

for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4.*192\." /C:"IPv4.*10\." /C:"IPv4.*172\."') do (
  if not defined LAN_IP set "LAN_IP=%%A"
)
if defined LAN_IP set "LAN_IP=%LAN_IP: =%"

powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', 3000); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo 面板已经在运行，正在打开浏览器...
  start "" "%URL%"
  exit /b 0
)

echo 正在启动作品采集面板（局域网模式）...
echo 打开后请不要关闭这个窗口；关闭窗口或按 Ctrl+C 会停止面板。
echo 本机访问地址：%URL%
if defined LAN_IP (
  echo 同事访问地址：http://%LAN_IP%:3000/
) else (
  echo 同事访问地址：http://^<本机局域网IP^>:3000/
)
echo 如需共享口令，请在 .env 中填写 PANEL_PASSWORD 后重新启动。
echo.

start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
npm run ui
