@echo off
rem Double-click to start the game server and open the game screen in Chrome.
rem Close this window to stop the server.
title Twitch Style Game - server (close this window to stop)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules\qrcode" (
  echo Installing dependencies, this only happens once...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=3000
set SCREEN_URL=http://localhost:%PORT%/screen.html

rem Opens the screen in Chrome as soon as the server answers.
start "" /b node scripts\open-screen.js %SCREEN_URL%

node server.js
echo.
echo The server has stopped.
pause
