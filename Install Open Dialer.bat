@echo off
rem Double-click once to set up Open Dialer on Windows. Installs what's missing with winget (Node.js, Docker Desktop,
rem cloudflared), then the app's packages, a .env with fresh secrets and the local database. Safe to run again.
cd /d "%~dp0"
where winget >nul 2>nul || (
  echo winget is missing. Install "App Installer" from the Microsoft Store, then run this again.
  pause
  exit /b 1
)
where node >nul 2>nul || winget install -e --id OpenJS.NodeJS.LTS
where docker >nul 2>nul || winget install -e --id Docker.DockerDesktop
where cloudflared >nul 2>nul || if not exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" winget install -e --id Cloudflare.cloudflared
rem Programs installed a moment ago aren't on this window's PATH yet.
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files\Docker\Docker\resources\bin"
where node >nul 2>nul || (
  echo Node.js didn't install. Install it from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
call npm install || (
  echo npm install failed. Check your internet connection and run this again.
  pause
  exit /b 1
)
node scripts\setup.mjs
pause
