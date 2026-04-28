@echo off
setlocal

cd /d "%~dp0"
set "URL=http://127.0.0.1:3000/"

powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', 3000); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo 面板已经在运行，正在打开浏览器...
  start "" "%URL%"
  exit /b 0
)

echo 正在启动小红书爬取面板...
echo 打开后请不要关闭这个窗口；关闭窗口或按 Ctrl+C 会停止面板。
echo.

start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
npm run ui
