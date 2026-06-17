@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

rem Work collection panel.
rem Supports XHS, Douyin, Bilibili, and all-channel collection.
rem LAN mode is enabled by default. Account scope comes from platform-accounts.json.
rem Scheduled collection runs all channels.

cd /d "%~dp0" || (
  echo Cannot enter the launcher directory.
  pause
  exit /b 1
)
set "HOST=0.0.0.0"
set "PANEL_HOST=0.0.0.0"
set "PANEL_PORT_START=3000"
set "PANEL_PORT_END=3099"
set "LAN_IP="
set "NPM_REGISTRY=https://registry.npmmirror.com"
set "PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright"

echo.
echo ==== 1/6 Check Node.js and npm ====
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
echo ==== 2/6 Check runtime packages ====
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
echo ==== 3/6 Check media tools ====
call node scripts\ensure-media-tools.mjs
if errorlevel 1 (
  echo Media tool preparation failed. Please check network and send this window screenshot.
  goto :fail
)

echo.
echo ==== 4/6 Check browser package ====
call npx playwright install chromium
if errorlevel 1 (
  echo Chromium installation failed. Please check network and send this window screenshot.
  goto :fail
)

echo.
echo ==== 5/6 Select panel port ====
set "PORT="
for /f "delims=" %%P in ('node scripts\select-panel-port.mjs 2^>nul') do (
  set "PORT=%%P"
)
if not defined PORT (
  echo Ports %PANEL_PORT_START%-%PANEL_PORT_END% are already in use.
  goto :fail
)
set "URL=http://127.0.0.1:%PORT%/"
echo Selected port: %PORT%

for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4.*192\." /C:"IPv4.*10\." /C:"IPv4.*172\."') do (
  if not defined LAN_IP set "LAN_IP=%%A"
)
if defined LAN_IP set "LAN_IP=%LAN_IP: =%"

echo.
echo ==== 6/6 Start collection panel ====
echo Starting panel for XHS, Douyin, Bilibili, and all-channel collection.
echo LAN mode is enabled by default. Accounts come from platform-accounts.json.
echo Scheduled collection runs all channels.
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
