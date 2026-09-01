/**
 * CLV TRACKER — Closing Line Value System
 * 
 * The single most important metric in sports betting.
 * CLV = did you beat the closing line?
 * 
 * If you bet -3 and it closes at -5, you captured +2 CLV (you're sharp).
 * If you bet -3 and it closes at -1, you lost -2 CLV (you're not).
 * 
 * This module:
 * 1. Captures opening lines when odds first appear
 * 2. Tracks every line movement throughout the day
 * 3. Captures closing lines (1 hour before tipoff)
 * 4. Calculates CLV for every bet placed
 * 5. Reports CLV stats by bet type, sport, confidence level
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA, 'sharpedge.db');

let db = null;
function getDb() {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
    return db;
  } catch (e) {
    console.error('[clv] DB connection error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// SCHEMA — CLV-specific tables
// ═══════════════════════════════════════════════════════════════

function initSchema() {
  const database = getDb();
  if (!database) return;

  database.exec(`
    -- Line snapshots: every time we capture odds for a game
    CREATE TABLE IF NOT EXISTS line_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,  -- 'opening', 'movement', 'closing'
      bookmaker TEXT NOT NULL,
      market_key TEXT NOT NULL,     -- 'h2h', 'spreads', 'totals'
      outcome_name TEXT,
      price REAL,
      point REAL,
      snapshot_time TEXT DEFAULT (datetime('now')),
      game_date TEXT,
      commence_time TEXT
    );

    -- Opening lines: captured once when odds first appear
    CREATE TABLE IF NOT EXISTS opening_lines (
      game_id TEXT NOT NULL,
      bookmaker TEXT NOT NULL,
      market_key TEXT NOT NULL,
      outcome_name TEXT,
      price REAL,
      point REAL,
      captured_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (game_id, bookmaker, market_key, outcome_name)
    );

    -- Closing lines: captured 1 hour before tipoff
    CREATE TABLE IF NOT EXISTS closing_lines (
      game_id TEXT NOT NULL,
      bookmaker TEXT NOT NULL,
      market_key TEXT NOT NULL,
      outcome_name TEXT,
      price REAL,
      point REAL,
      captured_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (game_id, bookmaker, market_key, outcome_name)
    );

    -- CLV tracker: every bet with its CLV measurement
    CREATE TABLE IF NOT EXISTS clv_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bet_id TEXT UNIQUE,
      game_id TEXT NOT NULL,
      bet_type TEXT,              -- 'spread', 'ml', 'total', 'prop'
      bet_side TEXT,              -- 'home', 'away', 'over', 'under'
      bet_line REAL,
      bet_odds INTEGER,
      bet_price REAL,
      closing_line REAL,
      closing_price REAL,
      clv_points REAL,            -- closing_line - bet_line (signed for spreads)
      clv_odds REAL,              -- closing_price - bet_price (signed)
      clv_direction TEXT,         -- 'positive', 'negative', 'push'
      was_positive INTEGER,       -- 1 if beat closing line
      stake REAL,
      result TEXT,                -- 'pending', 'win', 'loss', 'push'
      profit REAL,
      resolved_at TEXT,
      placed_at TEXT DEFAULT (datetime('now'))
    );

    -- CLV aggregates: pre-computed stats for fast dashboard queries
    CREATE TABLE IF NOT EXISTS clv_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT,                -- 'all', '30d', '7d', 'today'
      bet_type TEXT,              -- 'all', 'spread', 'ml', 'total', 'prop'
      total_bets INTEGER DEFAULT 0,
      positive_clv INTEGER DEFAULT 0,
      negative_clv INTEGER DEFAULT 0,
      push_clv INTEGER DEFAULT 0,
      avg_clv_points REAL DEFAULT 0,
      avg_clv_odds REAL DEFAULT 0,
      clv_win_rate REAL DEFAULT 0,
      total_profit REAL DEFAULT 0,
      roi REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_snapshots_game ON line_snapshots(game_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_time ON line_snapshots(snapshot_time);
    CREATE INDEX IF NOT EXISTS idx_snapshots_type ON line_snapshots(snapshot_type);
    CREATE INDEX IF NOT EXISTS idx_clv_bets_game ON clv_bets(game_id);
    CREATE INDEX IF NOT EXISTS idx_clv_bets_type ON clv_bets(bet_type);
    CREATE INDEX IF NOT EXISTS idx_clv_bets_time ON clv_bets(placed_at);
  `);

  console.log('[clv] Schema initialized');
}

// ═══════════════════════════════════════════════════════════════
// LINE SNAPSHOT CAPTURE
// ═══════════════════════════════════════════════════════════════

/**
 * Capture a snapshot of all current odds.
 * Called on every odds fetch to build line history.
 */
function captureLineSnapshot(oddsData, snapshotType = 'movement') {
  const database = getDb();
  if (!database || !Array.isArray(oddsData)) return 0;

  const stmt = database.prepare(`
    INSERT INTO line_snapshots (game_id, snapshot_type, bookmaker, market_key,
      outcome_name, price, point, snapshot_time, game_date, commence_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `);

  let count = 0;
  const insertAll = database.transaction((games) => {
    for (const game of games) {
      const gameId = game.id || '';
      const gameDate = game.commence_time ? game.commence_time.slice(0, 10) : '';
      const commenceTime = game.commence_time || '';

      for (const book of (game.bookmakers || [])) {
        for (const market of (book.markets || [])) {
          for (const outcome of (market.outcomes || [])) {
            try {
              stmt.run(
                gameId,
                snapshotType,
                book.key || book.title || '',
                market.key || '',
                outcome.name || '',
                outcome.price || 0,
                outcome.point || 0,
                gameDate,
                commenceTime
              );
              count++;
            } catch {}
          }
        }
      }
    }
  });

  insertAll(oddsData);
  console.log(`[clv] Captured ${count} line snapshots (${snapshotType})`);
  return count;
}

/**
 * Capture opening lines — only saves if no opening line exists yet for this game/book/market/outcome.
 */
function captureOpeningLines(oddsData) {
  const database = getDb();
  if (!database || !Array.isArray(oddsData)) return 0;

  const stmt = database.prepare(`
    INSERT OR IGNORE INTO opening_lines (game_id, bookmaker, market_key,
      outcome_name, price, point, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let count = 0;
  const insertAll = database.transaction((games) => {
    for (const game of games) {
      const gameId = game.id || '';
      for (const book of (game.bookmakers || [])) {
        for (const market of (book.markets || [])) {
          for (const outcome of (market.outcomes || [])) {
            try {
              const result = stmt.run(
                gameId,
                book.key || book.title || '',
                market.key || '',
                outcome.name || '',
                outcome.price || 0,
                outcome.point || 0
              );
              if (result.changes > 0) count++;
            } catch {}
          }
        }
      }
    }
  });

  insertAll(oddsData);
  console.log(`[clv] Captured ${count} new opening lines`);
  return count;
}

/**
 * Capture closing lines — overwrites with the final line before tipoff.
 */
function captureClosingLines(oddsData) {
  const database = getDb();
  if (!database || !Array.isArray(oddsData)) return 0;

  // Delete existing closing lines for these games
  const gameIds = oddsData.map(g => g.id).filter(Boolean);
  if (gameIds.length === 0) return 0;

  const placeholders = gameIds.map(() => '?').join(',');
  database.prepare(`DELETE FROM closing_lines WHERE game_id IN (${placeholders})`).run(...gameIds);

  const stmt = database.prepare(`
    INSERT INTO closing_lines (game_id, bookmaker, market_key,
      outcome_name, price, point, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let count = 0;
  const insertAll = database.transaction((games) => {
    for (const game of games) {
      const gameId = game.id || '';
      for (const book of (game.bookmakers || [])) {
        for (const market of (book.markets || [])) {
          for (const outcome of (market.outcomes || [])) {
            try {
              stmt.run(
                gameId,
                book.key || book.title || '',
                market.key || '',
                outcome.name || '',
                outcome.price || 0,
                outcome.point || 0
              );
              count++;
            } catch {}
          }
        }
      }
    }
  });

  insertAll(oddsData);
  console.log(`[clv] Captured ${count} closing lines`);
  return count;
}

// ═══════════════════════════════════════════════════════════════
// CLV CALCULATION
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate CLV for a specific bet.
 * 
 * @param {string} gameId - The game ID
 * @param {string} betType - 'spread', 'ml', 'total'
 * @param {string} betSide - 'home', 'away', 'over', 'under'
 * @param {number} betLine - The line you bet at (e.g., -3 for spread)
 * @param {number} betOdds - The odds you got (e.g., -110)
 * @returns {object} CLV calculation results
 */
function calculateCLV(gameId, betType, betSide, betLine, betOdds) {
  const database = getDb();
  if (!database) return null;

  // Get closing line for this game/book/market
  let marketKey = betType;
  if (betType === 'ml') marketKey = 'h2h';

  let outcomeName = '';
  if (betSide === 'home') outcomeName = '%'; // We'll match by game context
  if (betSide === 'away') outcomeName = '%';
  if (betSide === 'over') outcomeName = 'Over';
  if (betSide === 'under') outcomeName = 'Under';

  // Get closing lines from all books
  const closingLines = database.prepare(`
    SELECT * FROM closing_lines
    WHERE game_id = ? AND market_key = ?
    ORDER BY bookmaker
  `).all(gameId, marketKey);

  if (!closingLines.length) {
    return {
      clvPoints: null,
      clvOdds: null,
      clvDirection: 'unknown',
      wasPositive: null,
      closingLine: null,
      closingPrice: null,
      message: 'No closing line data available',
    };
  }

  // Get average closing line (market consensus)
  const avgClosingLine = closingLines.reduce((sum, l) => sum + (l.point || 0), 0) / closingLines.length;
  const avgClosingPrice = closingLines.reduce((sum, l) => sum + (l.price || 0), 0) / closingLines.length;

  // Calculate CLV
  let clvPoints = 0;
  let clvOdds = 0;

  if (betType === 'spread') {
    // For spreads: if you bet home -3 and closing is home -5, you got 2 points of CLV
    // CLV = closing_line - bet_line (both negative for favorites)
    clvPoints = avgClosingLine - betLine;
  } else if (betType === 'total') {
    // For totals: if you bet Over 220 and closing is 222, you got 2 points of CLV
    clvPoints = avgClosingLine - betLine;
  } else {
    // For ML: CLV is in the odds price
    clvPoints = 0;
  }

  // CLV in odds terms
  clvOdds = avgClosingPrice - betOdds;

  // Determine direction
  let clvDirection = 'push';
  let wasPositive = 0;
  if (Math.abs(clvPoints) > 0.01 || Math.abs(clvOdds) > 0.01) {
    // For favorites (negative spread), more negative = better
    // For underdogs (positive spread), more positive = better
    if (betType === 'spread') {
      if (betLine < 0) {
        // Betting favorite: more negative closing = positive CLV
        wasPositive = clvPoints < 0 ? 1 : 0;
      } else {
        // Betting underdog: more positive closing = positive CLV
        wasPositive = clvPoints > 0 ? 1 : 0;
      }
    } else if (betType === 'total') {
      // For overs: higher closing = positive CLV
      // For unders: lower closing = positive CLV
      wasPositive = betSide === 'over' ? (clvPoints > 0 ? 1 : 0) : (clvPoints < 0 ? 1 : 0);
    } else {
      // ML: lower odds (more favorite) at close = positive CLV
      wasPositive = clvOdds < 0 ? 1 : 0;
    }
    clvDirection = wasPositive ? 'positive' : 'negative';
  }

  return {
    clvPoints: parseFloat(clvPoints.toFixed(2)),
    clvOdds: parseFloat(clvOdds.toFixed(0)),
    clvDirection,
    wasPositive,
    closingLine: parseFloat(avgClosingLine.toFixed(1)),
    closingPrice: parseFloat(avgClosingPrice.toFixed(0)),
    bookCount: closingLines.length,
    closingLines: closingLines.map(l => ({
      book: l.bookmaker,
      line: l.point,
      price: l.price,
    })),
  };
}

/**
 * Record a bet and calculate its CLV.
 */
function recordBet(bet) {
  const database = getDb();
  if (!database) return null;

  const clv = calculateCLV(bet.gameId, bet.betType, bet.betSide, bet.betLine, bet.betOdds);

  const stmt = database.prepare(`
    INSERT OR REPLACE INTO clv_bets (bet_id, game_id, bet_type, bet_side,
      bet_line, bet_odds, bet_price, closing_line, closing_price,
      clv_points, clv_odds, clv_direction, was_positive,
      stake, result, profit, placed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const result = stmt.run(
    bet.betId || `bet-${Date.now()}`,
    bet.gameId,
    bet.betType,
    bet.betSide,
    bet.betLine,
    bet.betOdds,
    bet.betPrice || bet.betOdds,
    clv?.closingLine || null,
    clv?.closingPrice || null,
    clv?.clvPoints || 0,
    clv?.clvOdds || 0,
    clv?.clvDirection || 'unknown',
    clv?.wasPositive || 0,
    bet.stake || 0,
    bet.result || 'pending',
    bet.profit || 0
  );

  return { betId: bet.betId, clv, dbResult: result };
}

// ═══════════════════════════════════════════════════════════════
// CLV STATISTICS
// ═══════════════════════════════════════════════════════════════

/**
 * Get CLV stats for a time period and bet type.
 */
function getCLVStats(period = 'all', betType = 'all') {
  const database = getDb();
  if (!database) return null;

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (period !== 'all') {
    const days = period === 'today' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 999;
    whereClause += ` AND placed_at >= datetime('now', '-${days} days')`;
  }

  if (betType !== 'all') {
    whereClause += ' AND bet_type = ?';
    params.push(betType);
  }

  const stats = database.prepare(`
    SELECT
      COUNT(*) as total_bets,
      SUM(CASE WHEN clv_direction = 'positive' THEN 1 ELSE 0 END) as positive_clv,
      SUM(CASE WHEN clv_direction = 'negative' THEN 1 ELSE 0 END) as negative_clv,
      SUM(CASE WHEN clv_direction = 'push' THEN 1 ELSE 0 END) as push_clv,
      ROUND(AVG(CASE WHEN clv_points != 0 THEN clv_points END), 2) as avg_clv_points,
      ROUND(AVG(CASE WHEN clv_odds != 0 THEN clv_odds END), 0) as avg_clv_odds,
      ROUND(SUM(CASE WHEN clv_direction = 'positive' THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN clv_direction != 'push' THEN 1 ELSE 0 END), 0), 1) as clv_win_rate,
      ROUND(SUM(COALESCE(profit, 0)), 2) as total_profit,
      ROUND(SUM(COALESCE(profit, 0)) * 100.0 / NULLIF(SUM(COALESCE(stake, 0)), 0), 1) as roi
    FROM clv_bets
    ${whereClause}
  `).get(...params);

  // Get CLV by bet type breakdown
  const byType = database.prepare(`
    SELECT
      bet_type,
      COUNT(*) as total,
      SUM(CASE WHEN clv_direction = 'positive' THEN 1 ELSE 0 END) as positive,
      ROUND(AVG(CASE WHEN clv_points != 0 THEN clv_points END), 2) as avg_clv
    FROM clv_bets
    ${whereClause}
    GROUP BY bet_type
    ORDER BY total DESC
  `).all(...params);

  // Get recent CLV trend (last 20 bets)
  const recent = database.prepare(`
    SELECT bet_id, game_id, bet_type, bet_side, bet_line, bet_odds,
      clv_points, clv_direction, was_positive, result, profit, placed_at
    FROM clv_bets
    ${whereClause}
    ORDER BY placed_at DESC
    LIMIT 20
  `).all(...params);

  return {
    period,
    betType,
    overall: stats,
    byType,
    recent,
  };
}

/**
 * Get line movement history for a specific game.
 */
function getLineMovement(gameId) {
  const database = getDb();
  if (!database) return null;

  const snapshots = database.prepare(`
    SELECT * FROM line_snapshots
    WHERE game_id = ?
    ORDER BY snapshot_time ASC, bookmaker, market_key
  `).all(gameId);

  const opening = database.prepare(`
    SELECT * FROM opening_lines WHERE game_id = ?
  `).all(gameId);

  const closing = database.prepare(`
    SELECT * FROM closing_lines WHERE game_id = ?
  `).all(gameId);

  // Group snapshots by time to show movement
  const timeline = {};
  for (const snap of snapshots) {
    const time = snap.snapshot_time;
    if (!timeline[time]) timeline[time] = [];
    timeline[time].push(snap);
  }

  return {
    gameId,
    opening,
    closing,
    timeline,
    totalSnapshots: snapshots.length,
    firstCapture: snapshots[0]?.snapshot_time || null,
    lastCapture: snapshots[snapshots.length - 1]?.snapshot_time || null,
  };
}

// ═══════════════════════════════════════════════════════════════
// AUTO-CAPTURE: Check if it's time to capture closing lines
// ═══════════════════════════════════════════════════════════════

/**
 * Check which games are within 1 hour of tipoff and need closing line capture.
 */
function getGamesNeedingClosingCapture(oddsData) {
  if (!Array.isArray(oddsData)) return [];

  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

  return oddsData.filter(game => {
    if (!game.commence_time) return false;
    const tipoff = new Date(game.commence_time);
    return tipoff <= oneHourFromNow && tipoff > now;
  });
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  captureLineSnapshot,
  captureOpeningLines,
  captureClosingLines,
  calculateCLV,
  recordBet,
  getCLVStats,
  getLineMovement,
  getGamesNeedingClosingCapture,
  initSchema,
};
