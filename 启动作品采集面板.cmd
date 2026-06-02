@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

rem 作品采集面板
rem 支持：小红书、抖音、B站、全渠道
rem 默认按局域网模式启动，账号范围来自 platform-accounts.json。
rem 定时采集按全渠道执行。

cd /d "%~dp0" || (
  echo Cannot enter the launcher directory.
  pause
  exit /b 1
)
set "HOST=0.0.0.0"
set "LAN_IP="
set "NPM_REGISTRY=https://registry.npmmirror.com"
set "PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright"

echo.
echo ==== 1/5 Check Node.js and npm ====
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please install Node.js first.
  goto :fail
)
for /f "delims=" %%V in ('npm --version 2^>nul') do set "NPM_VERSION=%%V"
if not defined NPM_VERSION (
  echo Failed to read npm version. Please check Node.js installation.
  goto :fail
)
echo npm is ready: %NPM_VERSION%

echo.
echo ==== 2/5 Check runtime packages ====
if not exist "node_modules" (
  echo First launch needs to install packages. This may take a few minutes.
  call npm ci --registry="%NPM_REGISTRY%"
  if errorlevel 1 (
    echo Package installation failed. Please check network and send this window screenshot.
    goto :fail
  )
) else (
  echo Runtime packages already exist. Skip install.
)

echo.
echo ==== 3/5 Check browser package ====
call npx playwright install chromium
if errorlevel 1 (
  echo Chromium installation failed. Please check network and send this window screenshot.
  goto :fail
)

echo.
echo ==== 4/5 Select panel port ====
set "PORT="
for /f "delims=" %%P in ('node -e "const s=String.fromCharCode;const net=require(s(110,111,100,101,58,110,101,116));const ports=[3000,3001,3002,3003,3004,3005,3006,3007,3008,3009,3010];function check(i){if(i>=ports.length)process.exit(1);const server=net.createServer();server.once(s(101,114,114,111,114),()=>check(i+1));server.listen(ports[i],s(48,46,48,46,48,46,48),()=>{console.log(ports[i]);server.close(()=>process.exit(0));});}check(0);"') do (
  set "PORT=%%P"
)
if not defined PORT (
  echo Ports 3000-3010 are already in use.
  goto :fail
)
set "URL=http://127.0.0.1:%PORT%/"
echo Selected port: %PORT%

for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4.*192\." /C:"IPv4.*10\." /C:"IPv4.*172\."') do (
  if not defined LAN_IP set "LAN_IP=%%A"
)
if defined LAN_IP set "LAN_IP=%LAN_IP: =%"

echo.
echo ==== 5/5 Start collection panel ====
echo Starting panel for XHS, Douyin, Bilibili, and all-channel collection.
echo Opened page: %URL%
if defined LAN_IP (
  echo LAN URL: http://%LAN_IP%:%PORT%/
) else (
  echo LAN URL: http://^<your-lan-ip^>:%PORT%/
)
echo Keep this window open. Closing it stops the panel.
echo.

start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
call npm run ui
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo Panel stopped.
) else (
  echo Panel failed or stopped with exit code: %EXIT_CODE%.
  echo Please send this window screenshot to the technical teammate.
)
pause
exit /b %EXIT_CODE%

:fail
echo.
echo Startup did not finish. Please send this window screenshot to the technical teammate.
pause
exit /b 1
