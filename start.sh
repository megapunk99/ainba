#!/bin/bash
# ══════════════════════════════════════════════════════════════════════
# SHARPEDGE — NBA Betting Intelligence Platform
# Master startup script
# ══════════════════════════════════════════════════════════════════════

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║                                                   ║"
echo "  ║   ⚡ SHARPEDGE — NBA Betting Intelligence         ║"
echo "  ║   Multi-Agent AI • Real-Time Odds • EV Grading   ║"
echo "  ║                                                   ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "  [ERROR] Node.js not found. Install from https://nodejs.org"
  exit 1
fi

# Install dependencies if needed
if [ ! -d "$ROOT/node_modules" ]; then
  echo "  [1/4] Installing frontend dependencies..."
  cd "$ROOT" && npm install
  echo ""
fi

# Start backend
echo "  [2/4] Starting backend server (port 3001)..."
cd "$ROOT"
node server/index.js &
BACKEND_PID=$!
sleep 2

# Start frontend
echo "  [3/4] Starting frontend (port 5173)..."
cd "$ROOT"
npm run dev &
FRONTEND_PID=$!
sleep 3

# Open browser
echo "  [4/4] Opening browser..."
if command -v xdg-open &> /dev/null; then
  xdg-open http://localhost:5173/betting
elif command -v open &> /dev/null; then
  open http://localhost:5173/betting
fi

echo ""
echo "  ════════════════════════════════════════════════════"
echo "   ✅ SHARPEDGE is running!"
echo "  ════════════════════════════════════════════════════"
echo ""
echo "   Frontend:  http://localhost:5173"
echo "   Backend:   http://localhost:3001"
echo "   Betting:   http://localhost:5173/betting"
echo "   Props:     http://localhost:5173/betting/props"
echo "   Compare:   http://localhost:5173/betting/compare"
echo "   History:   http://localhost:5173/betting/props/history"
echo "   Track:     http://localhost:5173/betting/record"
echo ""
echo "   Press Ctrl+C to stop all servers..."
echo "  ════════════════════════════════════════════════════"
echo ""

# Cleanup on exit
cleanup() {
  echo ""
  echo "  Stopping servers..."
  kill $BACKEND_PID 2>/dev/null
  kill $FRONTEND_PID 2>/dev/null
  echo "  ✅ All servers stopped."
  exit 0
}

trap cleanup SIGINT SIGTERM

# Wait forever
wait
