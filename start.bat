@echo off
title Aelora Launcher
cd /d "%~dp0"

echo Starting Aelora...
start "Aelora" cmd /c "npm run dev"

:: Wait for the web server to come up, then open the dashboard
timeout /t 5 /nobreak >nul
start http://localhost:3000/dashboard

echo.
echo Aelora launched.
echo   Dashboard: http://localhost:3000/dashboard
echo.
pause
