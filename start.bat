@echo off
title Aelora Launcher
cd /d "%~dp0"

echo Starting Radicale CalDAV server...
start "Radicale" cmd /c "python -m radicale --config radicale-config"

:: Give Radicale a moment to bind its port
timeout /t 2 /nobreak >nul

echo Starting Aelora...
start "Aelora" cmd /c "npm run dev"

:: Wait for the web server to come up, then open the dashboard
timeout /t 5 /nobreak >nul
start http://localhost:3000/dashboard

echo.
echo Both services launched. You can close this window.
echo   Radicale: http://127.0.0.1:5232
echo   Dashboard: http://localhost:3000/dashboard
echo.
pause
