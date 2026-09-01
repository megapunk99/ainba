@echo off
title SHARPEDGE - NBA Betting Intelligence
color 0A

:: ── Navigate to project ──────────────────────────────────────────
cd /d "C:\Users\user\nba-ai-score"

:: ── ASCII Art Header ─────────────────────────────────────────────
echo.
echo   ███████╗██╗  ██╗██╗  ██╗ ██████╗ ██████╗  █████╗ ██████╗ ██████╗ ███████╗██████╗
echo   ██╔════╝██║  ██║██║  ██║██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗
echo   ███████╗███████║███████║██║   ██║██████╔╝███████║██████╔╝██████╔╝█████╗  ██████╔╝
echo   ╚════██║██╔══██║██╔══██║██║   ██║██╔══██╗██╔══██║██╔═══╝ ██╔═══╝ ██╔══╝  ██╔══██╗
echo   ███████║██║  ██║██║  ██║╚██████╔╝██║  ██║██║  ██║██║     ██║     ███████╗██║  ██║
echo   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝╚═╝  ╚═╝
echo.
echo           NBA BETTING INTELLIGENCE PLATFORM
echo           ─────────────────────────────────
echo.

:: ── Check Node.js ───────────────────────────────────────────────
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] Node.js not found! Please install from https://nodejs.org
    pause
    exit /b 1
)

:: ── Install dependencies if needed ──────────────────────────────
if not exist "node_modules" (
    echo   [SETUP] Installing dependencies...
    call npm install
    echo.
)

:: ── Refresh data from ESPN ──────────────────────────────────────
if not exist "data\metadata.json" (
    echo   [DATA] First run — fetching NBA data from ESPN...
    call node server\fetch-data.cjs
    echo.
) else (
    echo   [DATA] Refreshing NBA data from ESPN...
    call node server\fetch-data.cjs
    echo.
)

:: ── Start Backend (Port 3001) ───────────────────────────────────
echo   [STARTING] Backend server on port 3001...
start "SHARPEDGE Backend" cmd /c "cd /d C:\Users\user\nba-ai-score && node server\index.js"

:: Wait for backend
timeout /t 4 /nobreak >nul

:: ── Start Frontend (Port 5173) ──────────────────────────────────
echo   [STARTING] Frontend on port 5173...
start "SHARPEDGE Frontend" cmd /c "cd /d C:\Users\user\nba-ai-score && npm run dev"

:: Wait for frontend to compile
timeout /t 6 /nobreak >nul

:: ── Open Browser ────────────────────────────────────────────────
echo   [OPENING] Browser...
start http://localhost:5173/betting

echo.
echo   ┌─────────────────────────────────────────────┐
echo   │                                             │
echo   │   SHARPEDGE is running!                     │
echo   │                                             │
echo   │   Dashboard:  http://localhost:5173         │
echo   │   Betting:    http://localhost:5173/betting │
echo   │   API:        http://localhost:3001         │
echo   │                                             │
echo   │   Press any key to STOP all servers...      │
echo   │                                             │
echo   └─────────────────────────────────────────────┘
echo.

:: ── Keep alive until user presses a key ─────────────────────────
pause >nul

:: ── Cleanup ─────────────────────────────────────────────────────
echo.
echo   [STOPPING] Shutting down SHARPEDGE...
taskkill /fi "WINDOWTITLE eq SHARPEDGE Backend" /f >nul 2>nul
taskkill /fi "WINDOWTITLE eq SHARPEDGE Frontend" /f >nul 2>nul
taskkill /fi "WINDOWTITLE eq SHARPEDGE*" /f >nul 2>nul
echo   [DONE] SHARPEDGE stopped.
timeout /t 2 /nobreak >nul
