@echo off
rem Double-click to run Open Dialer on this computer with calling working (builds, opens a Cloudflare tunnel, starts the server).
cd /d "%~dp0"
node scripts\start-local.mjs
pause
