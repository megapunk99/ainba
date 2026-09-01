#!/bin/bash
# ══════════════════════════════════════════════════════════════════════
# NBA Betting Pipeline — Master Orchestration Script
#
# Runs the full pipeline:
#   1. Fetch ESPN data (scores, standings, teams)
#   2. Run Python betting agents (edge hunting, risk management)
#   3. Bridge data into the web frontend
#   4. Optionally restart the data server
#
# Usage:
#   ./run-pipeline.sh              # full pipeline
#   ./run-pipeline.sh --no-espn    # skip ESPN fetch
#   ./run-pipeline.sh --no-python  # skip Python pipeline (use existing JSON)
#   ./run-pipeline.sh --restart    # restart data server after
#   ./run-pipeline.sh --date 2026-11-15  # specific date
# ══════════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../nba-betting-agents"
FRONTEND_DIR="$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE} 🏀 NBA Betting Pipeline — $(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

SKIP_ESPN=false
SKIP_PYTHON=false
DO_RESTART=false
DATE_ARG=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-espn) SKIP_ESPN=true; shift ;;
    --no-python) SKIP_PYTHON=true; shift ;;
    --restart) DO_RESTART=true; shift ;;
    --date) DATE_ARG="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

START_TIME=$(date +%s)

# ─── Step 1: Fetch ESPN data ──────────────────────────────────────────
if [ "$SKIP_ESPN" = false ]; then
  echo -e "${YELLOW}[1/4] Fetching ESPN data (scores, standings, teams)...${NC}"
  cd "$FRONTEND_DIR"
  node server/fetch-data.cjs
  echo -e "${GREEN}  ✓ ESPN data fetched${NC}"
  echo ""
else
  echo -e "${YELLOW}[1/4] Skipping ESPN fetch (--no-espn)${NC}"
  echo ""
fi

# ─── Step 2: Run Python betting pipeline ──────────────────────────────
if [ "$SKIP_PYTHON" = false ]; then
  echo -e "${YELLOW}[2/4] Running Python betting agents pipeline...${NC}"
  cd "$AGENTS_DIR"

  DATE_FLAG=""
  if [ -n "$DATE_ARG" ]; then
    DATE_FLAG="--date $DATE_ARG"
  fi

  # Run the pipeline export
  python pipeline_export.py $DATE_FLAG --output "$FRONTEND_DIR/data/betting-pipeline.json"
  echo -e "${GREEN}  ✓ Python pipeline complete${NC}"
  echo ""
else
  echo -e "${YELLOW}[2/4] Skipping Python pipeline (--no-python)${NC}"
  echo ""
fi

# ─── Step 3: Bridge data into web frontend ────────────────────────────
echo -e "${YELLOW}[3/4] Bridging data into web frontend...${NC}"
cd "$FRONTEND_DIR"
node server/pipeline-bridge.cjs
echo -e "${GREEN}  ✓ Data bridged${NC}"
echo ""

# ─── Step 4: Restart data server (optional) ───────────────────────────
if [ "$DO_RESTART" = true ]; then
  echo -e "${YELLOW}[4/4] Restarting data server...${NC}"

  # Kill existing server if running
  pkill -f "node server/data-server.cjs" 2>/dev/null || true
  pkill -f "node server/index.cjs" 2>/dev/null || true
  sleep 1

  # Start in background
  nohup node server/data-server.cjs > /tmp/nba-server.log 2>&1 &
  sleep 2

  if pgrep -f "node server/data-server.cjs" > /dev/null; then
    echo -e "${GREEN}  ✓ Data server restarted (PID: $(pgrep -f 'node server/data-server.cjs'))${NC}"
  else
    echo -e "${RED}  ✗ Failed to restart data server${NC}"
    cat /tmp/nba-server.log
  fi
  echo ""
else
  echo -e "${YELLOW}[4/4] Skipping server restart (--restart to enable)${NC}"
  echo ""
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN} ✅ Pipeline complete in ${DURATION}s${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo "  Frontend: http://localhost:5173"
echo "  API:      http://localhost:3001"
echo "  Betting:  http://localhost:5173/betting"
echo "  Props:    http://localhost:5173/betting/props"
echo ""
echo "  Schedule daily (Windows):"
echo "    schtasks /create /tn \"NBA Pipeline\" /sc daily /st 09:00 \\"
echo "      /tr \"cd $FRONTEND_DIR && bash run-pipeline.sh --no-espn --restart\""
echo ""
echo "  Schedule daily (Linux/Mac - crontab):"
echo "    0 9 * * * cd $FRONTEND_DIR && bash run-pipeline.sh --no-espn --restart"
echo ""
