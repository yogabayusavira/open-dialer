@echo off
rem Run by the setup wizard after it copies the app (and from the Start menu to finish a Docker setup later):
rem installs the app's packages, then writes .env with a fresh encryption key and sets up the database.
rem   finish-setup.cmd          data kept in the data folder
rem   finish-setup.cmd docker   PostgreSQL in Docker
cd /d "%~dp0.."
rem Programs installed a moment ago aren't on this window's PATH yet.
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files\Docker\Docker\resources\bin"
title Open Dialer setup
echo Installing Open Dialer's packages. This takes a minute or two...
call npm install --no-fund --no-audit || exit /b 1
if /i "%~1"=="docker" (node scripts\setup.mjs --docker) else (node scripts\setup.mjs)
exit /b %errorlevel%
