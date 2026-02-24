@echo off
title Aelora Launcher
cd /d "%~dp0"

echo Starting Radicale CalDAV server...
start "Radicale" cmd /c "python -m radicale --config radicale-config"

:: Give Radicale a moment to bind its port
timeout /t 2 /nobreak >nul

echo Starting Aelora...
start "Aelora" cmd /c "npm run dev"

echo.
echo Both services launched. You can close this window.
echo   Radicale: http://127.0.0.1:5232
echo   Aelora:   http://localhost:3000
echo.
pause
