@echo off
title NBA Betting Platform
color 0A

echo.
echo  ╔═══════════════════════════════════════════════════╗
echo  ║                                                   ║
echo  ║   ⚡ SHARPEDGE — NBA Betting Intelligence         ║
echo  ║   Multi-Agent AI • Real-Time Odds • EV Grading   ║
echo  ║                                                   ║
echo  ╚═══════════════════════════════════════════════════╝
echo.

set ROOT=%~dp0

:: ─── Check Node.js ────────────────────────────────────────
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

:: ─── Install dependencies if needed ───────────────────────
if not exist "%ROOT%node_modules" (
    echo  [1/4] Installing frontend dependencies...
    cd /d "%ROOT%"
    call npm install
    echo.
)

:: ─── Start backend server ─────────────────────────────────
echo  [2/4] Starting backend server (port 3001)...
cd /d "%ROOT%"
start "NBA Backend" /min cmd /c "node server/index.js"
timeout /t 2 /nobreak >nul

:: ─── Start frontend dev server ────────────────────────────
echo  [3/4] Starting frontend (port 5173)...
cd /d "%ROOT%"
start "NBA Frontend" cmd /c "npm run dev"
timeout /t 3 /nobreak >nul

:: ─── Open browser ─────────────────────────────────────────
echo  [4/4] Opening browser...
start http://localhost:5173/betting

echo.
echo  ════════════════════════════════════════════════════
echo   ✅ SHARPEDGE is running!
echo  ════════════════════════════════════════════════════
echo.
echo   Frontend:  http://localhost:5173
echo   Backend:   http://localhost:3001
echo   Betting:   http://localhost:5173/betting
echo   Props:     http://localhost:5173/betting/props
echo   Compare:   http://localhost:5173/betting/compare
echo   History:   http://localhost:5173/betting/props/history
echo   Track:     http://localhost:5173/betting/record
echo.
echo   Press any key to stop all servers...
echo  ════════════════════════════════════════════════════
echo.

:: Wait for user to press a key, then kill everything
pause >nul

echo.
echo  Stopping servers...
taskkill /f /fi "WINDOWTITLE eq NBA Backend*" >nul 2>nul
taskkill /f /fi "WINDOWTITLE eq NBA Frontend*" >nul 2>nul
echo  ✅ All servers stopped.
timeout /t 2 /nobreak >nul
