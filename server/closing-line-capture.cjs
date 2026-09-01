/**
 * CLOSING LINE CAPTURE — Automated Snapshot Service
 * 
 * Captures odds at strategic times:
 * 1. Opening: When odds first appear (usually 1-2 days before)
 * 2. Movement: Every 30 minutes during the day
 * 3. Pre-close: 2 hours before tipoff (increased frequency)
 * 4. Closing: 1 hour before tipoff (FINAL line)
 * 
 * The closing line is the most accurate reflection of true probability.
 * If you can consistently beat it, you're sharp.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ODDS_FILE = path.join(DATA, 'live-odds.json');
const CAPTURE_LOG = path.join(DATA, 'capture-log.json');

let clvTracker = null;
function getCLVTracker() {
  if (clvTracker) return clvTracker;
  try {
    clvTracker = require('./clv-tracker.cjs');
    return clvTracker;
  } catch (e) {
    console.error('[capture] CLV tracker not available:', e.message);
    return null;
  }
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[capture] Save error:', e.message); }
}

// ═══════════════════════════════════════════════════════════════
// CAPTURE SCHEDULER
// ═══════════════════════════════════════════════════════════════

/**
 * Determine what type of snapshot to take based on current time vs game time.
 */
function getCaptureType(gameCommenceTime) {
  if (!gameCommenceTime) return null;

  const now = new Date();
  const tipoff = new Date(gameCommenceTime);
  const hoursUntilTipoff = (tipoff - now) / (1000 * 60 * 60);

  if (hoursUntilTipoff > 24) return null; // Too early
  if (hoursUntilTipoff > 2) return 'movement'; // Regular movement tracking
  if (hoursUntilTipoff > 1) return 'pre_close'; // Getting close
  if (hoursUntilTipoff > 0) return 'closing'; // FINAL LINE
  return null; // Game started
}

/**
 * Run the capture cycle — check all games and capture appropriate snapshots.
 */
function runCaptureCycle(oddsData) {
  if (!Array.isArray(oddsData)) return { captured: 0, types: {} };

  const clvTracker = getCLVTracker();
  if (!clvTracker) return { captured: 0, error: 'CLV tracker not available' };

  const results = { captured: 0, types: {}, games: [] };

  for (const game of oddsData) {
    const captureType = getCaptureType(game.commence_time);
    if (!captureType) continue;

    // Always capture movement snapshots
    clvTracker.captureLineSnapshot([game], captureType);
    results.captured++;
    results.types[captureType] = (results.types[captureType] || 0) + 1;

    // Capture opening lines (only saves if not already captured)
    clvTracker.captureOpeningLines([game]);

    // Capture closing lines (overwrites with final line)
    if (captureType === 'closing') {
      clvTracker.captureClosingLines([game]);
    }

    results.games.push({
      matchup: `${game.away_team} @ ${game.home_team}`,
      captureType,
      timeUntilTipoff: getTimeUntilTipoff(game.commence_time),
    });
  }

  // Log capture cycle
  logCaptureCycle(results);

  return results;
}

/**
 * Force capture closing lines for all games (manual trigger).
 */
function forceClosingCapture(oddsData) {
  const clvTracker = getCLVTracker();
  if (!clvTracker) return { captured: 0, error: 'CLV tracker not available' };

  let captured = 0;
  for (const game of (Array.isArray(oddsData) ? oddsData : [])) {
    clvTracker.captureClosingLines([game]);
    captured++;
  }

  console.log(`[capture] Force-captured ${captured} closing lines`);
  return { captured };
}

// ═══════════════════════════════════════════════════════════════
// CAPTURE LOG
// ═══════════════════════════════════════════════════════════════

function logCaptureCycle(results) {
  const log = loadJson(CAPTURE_LOG) || { cycles: [], totalCaptures: 0 };

  log.cycles.push({
    timestamp: new Date().toISOString(),
    captured: results.captured,
    types: results.types,
    games: results.games?.length || 0,
  });

  // Keep last 500 cycles
  if (log.cycles.length > 500) {
    log.cycles = log.cycles.slice(-500);
  }

  log.totalCaptures += results.captured;
  log.lastCapture = new Date().toISOString();

  saveJson(CAPTURE_LOG, log);
}

/**
 * Get capture status and statistics.
 */
function getCaptureStatus() {
  const log = loadJson(CAPTURE_LOG) || { cycles: [], totalCaptures: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const todayCycles = log.cycles.filter(c => c.timestamp?.startsWith(today));
  const todayCaptures = todayCycles.reduce((sum, c) => sum + (c.captured || 0), 0);

  // Count games with opening/closing lines
  let gamesWithOpening = 0;
  let gamesWithClosing = 0;

  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA, 'sharpedge.db'));
    db.pragma('journal_mode = WAL');

    gamesWithOpening = db.prepare('SELECT COUNT(DISTINCT game_id) as c FROM opening_lines').get().c;
    gamesWithClosing = db.prepare('SELECT COUNT(DISTINCT game_id) as c FROM closing_lines').get().c;
    db.close();
  } catch {}

  return {
    totalCaptures: log.totalCaptures,
    todayCycles: todayCycles.length,
    todayCaptures,
    gamesWithOpeningLines: gamesWithOpening,
    gamesWithClosingLines: gamesWithClosing,
    lastCapture: log.lastCapture,
    recentCycles: log.cycles.slice(-5),
  };
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

function getTimeUntilTipoff(commenceTime) {
  if (!commenceTime) return null;
  const now = new Date();
  const tipoff = new Date(commenceTime);
  const diffMs = tipoff - now;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  runCaptureCycle,
  forceClosingCapture,
  getCaptureStatus,
  getCaptureType,
};
