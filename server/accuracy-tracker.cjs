/**
 * ACCURACY TRACKER — Model Performance Intelligence
 * 
 * The most important module in the entire system.
 * Without this, you don't know if your model is sharp or garbage.
 * 
 * This module:
 * 1. Checks pending predictions against actual game results
 * 2. Calculates win rate, ROI, CLV by bet type
 * 3. Tracks model version performance over time
 * 4. Generates performance reports for the dashboard
 * 5. Triggers retraining when accuracy drops
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
    console.error('[accuracy] DB error:', e.message);
    return null;
  }
}

function initSchema() {
  const database = getDb();
  if (!database) return;

  database.exec(`
    CREATE TABLE IF NOT EXISTS prediction_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prediction_id TEXT UNIQUE,
      game_id TEXT NOT NULL,
      prediction_type TEXT,          -- 'moneyline', 'spread', 'total', 'prop'
      predicted_side TEXT,           -- 'home', 'away', 'over', 'under'
      predicted_prob REAL,
      predicted_line REAL,
      predicted_odds INTEGER,
      actual_result TEXT,            -- 'win', 'loss', 'push'
      actual_home_score INTEGER,
      actual_away_score INTEGER,
      actual_total INTEGER,
      actual_margin REAL,
      clv_points REAL,
      was_positive_clv INTEGER,
      stake REAL,
      profit REAL,
      roi REAL,
      model_version TEXT,
      resolved_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS model_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_version TEXT,
      period TEXT,                   -- 'all', '30d', '7d', 'today'
      bet_type TEXT,                 -- 'all', 'moneyline', 'spread', 'total'
      total_predictions INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      pushes INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0,
      total_staked REAL DEFAULT 0,
      total_profit REAL DEFAULT 0,
      roi REAL DEFAULT 0,
      avg_odds REAL DEFAULT 0,
      avg_edge REAL DEFAULT 0,
      avg_clv REAL DEFAULT 0,
      clv_positive_rate REAL DEFAULT 0,
      last_updated TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_results_game ON prediction_results(game_id);
    CREATE INDEX IF NOT EXISTS idx_results_type ON prediction_results(prediction_type);
    CREATE INDEX IF NOT EXISTS idx_results_time ON prediction_results(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_results_model ON prediction_results(model_version);
  `);
}

// ═══════════════════════════════════════════════════════════════
// RESOLVE PREDICTIONS — Check if bets won or lost
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve a single prediction against actual game result.
 */
function resolvePrediction(prediction, gameResult) {
  if (!prediction || !gameResult) return null;

  const homeScore = gameResult.home_score || 0;
  const awayScore = gameResult.away_score || 0;
  const actualMargin = homeScore - awayScore;
  const actualTotal = homeScore + awayScore;

  let actualResult = 'loss';
  let profit = 0;

  if (prediction.prediction_type === 'moneyline') {
    if (prediction.predicted_side === 'home') {
      actualResult = homeScore > awayScore ? 'win' : awayScore > homeScore ? 'loss' : 'push';
    } else {
      actualResult = awayScore > homeScore ? 'win' : homeScore > awayScore ? 'loss' : 'push';
    }
  } else if (prediction.prediction_type === 'spread') {
    const adjustedMargin = actualMargin + (prediction.predicted_line || 0);
    if (prediction.predicted_side === 'home') {
      actualResult = adjustedMargin > 0 ? 'win' : adjustedMargin < 0 ? 'loss' : 'push';
    } else {
      actualResult = -adjustedMargin > 0 ? 'win' : -adjustedMargin < 0 ? 'loss' : 'push';
    }
  } else if (prediction.prediction_type === 'total') {
    if (prediction.predicted_side === 'over') {
      actualResult = actualTotal > (prediction.predicted_line || 0) ? 'win' :
                     actualTotal < (prediction.predicted_line || 0) ? 'loss' : 'push';
    } else {
      actualResult = actualTotal < (prediction.predicted_line || 0) ? 'win' :
                     actualTotal > (prediction.predicted_line || 0) ? 'loss' : 'push';
    }
  }

  // Calculate profit
  if (actualResult === 'win') {
    const decimalOdds = prediction.predicted_odds < 0
      ? 1 + (100 / Math.abs(prediction.predicted_odds))
      : 1 + (prediction.predicted_odds / 100);
    profit = (prediction.stake || 10) * (decimalOdds - 1);
  } else if (actualResult === 'loss') {
    profit = -(prediction.stake || 10);
  }

  const stake = prediction.stake || 10;
  const roi = stake > 0 ? (profit / stake * 100) : 0;

  return {
    predictionId: prediction.prediction_id || `pred-${Date.now()}`,
    gameId: prediction.game_id,
    predictionType: prediction.prediction_type,
    predictedSide: prediction.predicted_side,
    predictedProb: prediction.predicted_prob,
    predictedLine: prediction.predicted_line,
    predictedOdds: prediction.predicted_odds,
    actualResult,
    actualHomeScore: homeScore,
    actualAwayScore: awayScore,
    actualTotal,
    actualMargin,
    stake,
    profit: parseFloat(profit.toFixed(2)),
    roi: parseFloat(roi.toFixed(1)),
    modelVersion: prediction.model_version,
  };
}

/**
 * Batch resolve all pending predictions.
 */
function resolveAllPending() {
  const database = getDb();
  if (!database) return { resolved: 0, results: [] };

  // Get all pending predictions
  const pending = database.prepare(`
    SELECT * FROM match_player_props WHERE recommendation != 'PASS'
    UNION ALL
    SELECT * FROM prediction_outcomes WHERE actual_value IS NULL
  `).all();

  // Get completed games from scoreboard
  const scoreboard = loadJson('scoreboard.json');
  const completedGames = new Map();

  if (scoreboard?.events) {
    for (const event of scoreboard.events) {
      const comp = event.competitions?.[0];
      if (comp?.status?.type?.name === 'STATUS_FINAL') {
        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        if (home && away) {
          completedGames.set(event.id, {
            home_score: parseInt(home.score || 0),
            away_score: parseInt(away.score || 0),
          });
        }
      }
    }
  }

  const results = [];
  let resolved = 0;

  for (const pred of pending) {
    const gameResult = completedGames.get(pred.game_id);
    if (!gameResult) continue;

    const result = resolvePrediction(pred, gameResult);
    if (!result) continue;

    // Save result
    database.prepare(`
      INSERT OR REPLACE INTO prediction_results
        (prediction_id, game_id, prediction_type, predicted_side, predicted_prob,
         predicted_line, predicted_odds, actual_result, actual_home_score,
         actual_away_score, actual_total, actual_margin, stake, profit, roi,
         model_version, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      result.predictionId, result.gameId, result.predictionType, result.predictedSide,
      result.predictedProb, result.predictedLine, result.predictedOdds,
      result.actualResult, result.actualHomeScore, result.actualAwayScore,
      result.actualTotal, result.actualMargin, result.stake, result.profit,
      result.roi, result.modelVersion
    );

    resolved++;
    results.push(result);
  }

  console.log(`[accuracy] Resolved ${resolved} predictions`);
  return { resolved, results };
}

// ═══════════════════════════════════════════════════════════════
// PERFORMANCE STATISTICS
// ═══════════════════════════════════════════════════════════════

/**
 * Get overall performance stats.
 */
function getPerformanceStats(period = 'all', betType = 'all', modelVersion = null) {
  const database = getDb();
  if (!database) return null;

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (period !== 'all') {
    const days = period === 'today' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 999;
    whereClause += ` AND resolved_at >= datetime('now', '-${days} days')`;
  }

  if (betType !== 'all') {
    whereClause += ' AND prediction_type = ?';
    params.push(betType);
  }

  if (modelVersion) {
    whereClause += ' AND model_version = ?';
    params.push(modelVersion);
  }

  const stats = database.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN actual_result = 'loss' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN actual_result = 'push' THEN 1 ELSE 0 END) as pushes,
      ROUND(SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN actual_result != 'push' THEN 1 ELSE 0 END), 0), 1) as win_rate,
      ROUND(SUM(COALESCE(stake, 0)), 2) as total_staked,
      ROUND(SUM(COALESCE(profit, 0)), 2) as total_profit,
      ROUND(SUM(COALESCE(profit, 0)) * 100.0 / NULLIF(SUM(COALESCE(stake, 0)), 0), 1) as roi,
      ROUND(AVG(CASE WHEN predicted_odds IS NOT NULL THEN predicted_odds END), 0) as avg_odds,
      ROUND(AVG(CASE WHEN predicted_prob IS NOT NULL THEN predicted_prob END), 4) as avg_prob
    FROM prediction_results
    ${whereClause}
  `).get(...params);

  // Get performance by bet type
  const byType = database.prepare(`
    SELECT
      prediction_type,
      COUNT(*) as total,
      SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN actual_result = 'loss' THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN actual_result != 'push' THEN 1 ELSE 0 END), 0), 1) as win_rate,
      ROUND(SUM(COALESCE(profit, 0)), 2) as profit,
      ROUND(SUM(COALESCE(profit, 0)) * 100.0 / NULLIF(SUM(COALESCE(stake, 0)), 0), 1) as roi
    FROM prediction_results
    ${whereClause}
    GROUP BY prediction_type
    ORDER BY total DESC
  `).all(...params);

  // Get performance by model version
  const byVersion = database.prepare(`
    SELECT
      model_version,
      COUNT(*) as total,
      SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN actual_result != 'push' THEN 1 ELSE 0 END), 0), 1) as win_rate,
      ROUND(SUM(COALESCE(profit, 0)), 2) as profit
    FROM prediction_results
    ${whereClause}
    GROUP BY model_version
    ORDER BY model_version DESC
  `).all(...params);

  // Get recent results (last 20)
  const recent = database.prepare(`
    SELECT * FROM prediction_results
    ${whereClause}
    ORDER BY resolved_at DESC
    LIMIT 20
  `).all(...params);

  // Get streak info
  const streak = calculateStreak(database, whereClause, params);

  return {
    period,
    betType,
    overall: stats,
    byType,
    byVersion,
    recent,
    streak,
  };
}

/**
 * Calculate current win/loss streak.
 */
function calculateStreak(database, whereClause, params) {
  const results = database.prepare(`
    SELECT actual_result FROM prediction_results
    ${whereClause}
    ORDER BY resolved_at DESC
    LIMIT 50
  `).all(...params);

  if (results.length === 0) return { current: 0, type: 'none', longest: 0 };

  let currentStreak = 0;
  let currentType = results[0].actual_result;
  let longestStreak = 0;
  let longestType = 'none';

  for (const r of results) {
    if (r.actual_result === currentType) {
      currentStreak++;
    } else {
      if (currentStreak > longestStreak) {
        longestStreak = currentStreak;
        longestType = currentType;
      }
      currentType = r.actual_result;
      currentStreak = 1;
    }
  }

  if (currentStreak > longestStreak) {
    longestStreak = currentStreak;
    longestType = currentType;
  }

  return {
    current: currentStreak,
    type: currentType,
    longest: longestStreak,
    longestType,
  };
}

// ═══════════════════════════════════════════════════════════════
// MODEL COMPARISON
// ═══════════════════════════════════════════════════════════════

/**
 * Compare performance across model versions.
 */
function compareModelVersions() {
  const database = getDb();
  if (!database) return null;

  const versions = database.prepare(`
    SELECT
      model_version,
      COUNT(*) as total,
      SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN actual_result = 'loss' THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN actual_result != 'push' THEN 1 ELSE 0 END), 0), 1) as win_rate,
      ROUND(SUM(COALESCE(profit, 0)), 2) as profit,
      ROUND(SUM(COALESCE(profit, 0)) * 100.0 / NULLIF(SUM(COALESCE(stake, 0)), 0), 1) as roi,
      MIN(resolved_at) as first_bet,
      MAX(resolved_at) as last_bet
    FROM prediction_results
    GROUP BY model_version
    ORDER BY model_version
  `).all();

  return versions;
}

// ═══════════════════════════════════════════════════════════════
// RETRAINING TRIGGER
// ═══════════════════════════════════════════════════════════════

/**
 * Check if model needs retraining based on recent performance.
 */
function checkRetrainingNeeded() {
  const stats = getPerformanceStats('7d');
  if (!stats || !stats.overall || stats.overall.total < 10) {
    return { needed: false, reason: 'Insufficient recent data' };
  }

  const winRate = stats.overall.win_rate || 0;
  const roi = stats.overall.roi || 0;

  if (winRate < 45) {
    return {
      needed: true,
      reason: `Win rate ${winRate}% is below 45% threshold`,
      severity: 'HIGH',
      stats: stats.overall,
    };
  }

  if (roi < -10) {
    return {
      needed: true,
      reason: `ROI ${roi}% is below -10% threshold`,
      severity: 'MEDIUM',
      stats: stats.overall,
    };
  }

  return {
    needed: false,
    reason: 'Performance within acceptable range',
    stats: stats.overall,
  };
}

// ═══════════════════════════════════════════════════════════════
// HELPER
// ═══════════════════════════════════════════════════════════════

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  resolvePrediction,
  resolveAllPending,
  getPerformanceStats,
  compareModelVersions,
  checkRetrainingNeeded,
  initSchema,
};
