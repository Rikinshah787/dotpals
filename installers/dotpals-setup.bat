@echo off
setlocal
REM Double-click to install dotpals on Windows. It runs the one-line installer,
REM https://dotpals.vercel.app/install.ps1, which installs Node.js LTS
REM if you need it (from nodejs.org), then dotpals (from npm).
REM
REM This file isn't signed yet, so the first time Windows SmartScreen may say
REM "Windows protected your PC": click More info, then Run anyway.

powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $ErrorActionPreference = 'Stop'; irm https://dotpals.vercel.app/install.ps1 | iex; exit $LASTEXITCODE"
set DOTPALS_EXIT=%ERRORLEVEL%
echo.
pause
exit /b %DOTPALS_EXIT%
