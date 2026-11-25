@echo off
rem Run by the setup wizard after it copies the app (and from the Start menu, "Finish Open Dialer setup"):
rem installs the app's packages, then scripts\setup.mjs installs PostgreSQL if it's missing, creates the database
rem and writes .env with its address and a fresh encryption key. Extra arguments go to setup.mjs (e.g. --docker).
cd /d "%~dp0.."
rem Programs installed a moment ago aren't on this window's PATH yet.
set "PATH=%PATH%;C:\Program Files\nodejs"
title Open Dialer setup
echo Installing Open Dialer's packages. This takes a minute or two...
call npm install --no-fund --no-audit || goto failed
node scripts\setup.mjs %* || goto failed
exit /b 0
:failed
echo.
echo Setup didn't finish. Read the message above, fix it, then run "Finish Open Dialer setup" from the Start menu.
pause
exit /b 1
