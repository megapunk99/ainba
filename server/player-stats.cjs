/**
 * PLAYER STATS — Aggregated Player Intelligence
 * 
 * This module:
 * 1. Parses gamelog data from ESPN
 * 2. Calculates season averages, last 5/10/20 games
 * 3. Provides home/away splits
 * 4. Calculates consistency metrics (CV)
 * 5. Generates player prop projections
 * 6. Finds value in player props
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// GAMELOG PARSER
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a player's gamelog and extract per-game stats.
 */
function parseGamelog(playerId) {
  const gamelog = loadJson(`player-gamelog-${playerId}.json`);
  if (!gamelog?.labels || !gamelog?.seasonTypes) return null;

  const labels = gamelog.labels;
  const games = [];

  for (const seasonType of (gamelog.seasonTypes || [])) {
    const isRegular = (seasonType.displayName || seasonType.name || '').includes('Regular');
    if (!isRegular) continue;

    for (const cat of (seasonType.categories || [])) {
      for (const ev of (cat.events || [])) {
        const stats = {};
        labels.forEach((label, i) => {
          const val = ev.stats?.[i] || '';
          if (label === 'FG' || label === '3PT' || label === 'FT') {
            const parts = String(val).split('-');
            stats[label] = { made: parseInt(parts[0]) || 0, attempted: parseInt(parts[1]) || 0 };
          } else {
            stats[label] = parseFloat(val) || 0;
          }
        });

        games.push({
          eventId: ev.eventId,
          stats,
          _pts: stats.PTS || 0,
          _reb: stats.REB || 0,
          _ast: stats.AST || 0,
          _stl: stats.STL || 0,
          _blk: stats.BLK || 0,
          _min: stats.MIN || 0,
        });
      }
    }
  }

  return { labels, games };
}

// ═══════════════════════════════════════════════════════════════
// STATISTICS UTILITIES
// ═══════════════════════════════════════════════════════════════

function calculateMean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calculateStdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = calculateMean(arr);
  const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function calculateCV(arr) {
  // Coefficient of Variation = stdDev / mean (measures consistency)
  const mean = calculateMean(arr);
  if (mean === 0) return 100;
  return (calculateStdDev(arr) / mean) * 100;
}

function calculateMedian(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calculatePercentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

// ═══════════════════════════════════════════════════════════════
// PLAYER PROFILE
// ═══════════════════════════════════════════════════════════════

/**
 * Build a comprehensive player profile with all stats.
 */
function buildPlayerProfile(playerId) {
  const gamelog = parseGamelog(playerId);
  if (!gamelog || gamelog.games.length < 3) return null;

  const games = gamelog.games;
  const n = games.length;
  const last5 = games.slice(-5);
  const last10 = games.slice(-10);
  const last20 = games.slice(-20);

  const profile = {
    playerId,
    gamesPlayed: n,
    seasonAvg: {},
    last5Avg: {},
    last10Avg: {},
    last20Avg: {},
    consistency: {},
    hitRates: {},
    percentiles: {},
  };

  for (const stat of ['PTS', 'REB', 'AST', 'STL', 'BLK', 'MIN']) {
    const seasonVals = games.map(g => g.stats[stat] || 0);
    const l5Vals = last5.map(g => g.stats[stat] || 0);
    const l10Vals = last10.map(g => g.stats[stat] || 0);
    const l20Vals = last20.map(g => g.stats[stat] || 0);

    profile.seasonAvg[stat] = parseFloat(calculateMean(seasonVals).toFixed(1));
    profile.last5Avg[stat] = parseFloat(calculateMean(l5Vals).toFixed(1));
    profile.last10Avg[stat] = parseFloat(calculateMean(l10Vals).toFixed(1));
    profile.last20Avg[stat] = parseFloat(calculateMean(l20Vals).toFixed(1));
    profile.consistency[stat] = parseFloat(calculateCV(seasonVals).toFixed(1));
    profile.percentiles[stat] = {
      p25: calculatePercentile(seasonVals, 25),
      p50: calculateMedian(seasonVals),
      p75: calculatePercentile(seasonVals, 75),
    };
  }

  // Hit rates for common prop lines
  profile.hitRates = calculateHitRates(games);

  return profile;
}

/**
 * Calculate hit rates at common prop lines.
 */
function calculateHitRates(games) {
  const hitRates = {};

  // Points hit rates
  const ptsValues = games.map(g => g.stats.PTS || 0);
  for (const line of [10, 15, 20, 25, 30, 35]) {
    const hits = ptsValues.filter(v => v > line).length;
    hitRates[`over${line}pts`] = parseFloat((hits / ptsValues.length * 100).toFixed(1));
  }

  // Rebounds hit rates
  const rebValues = games.map(g => g.stats.REB || 0);
  for (const line of [5, 8, 10, 12, 15]) {
    const hits = rebValues.filter(v => v > line).length;
    hitRates[`over${line}reb`] = parseFloat((hits / rebValues.length * 100).toFixed(1));
  }

  // Assists hit rates
  const astValues = games.map(g => g.stats.AST || 0);
  for (const line of [3, 5, 7, 10]) {
    const hits = astValues.filter(v => v > line).length;
    hitRates[`over${line}ast`] = parseFloat((hits / astValues.length * 100).toFixed(1));
  }

  // PRA (Points + Rebounds + Assists) hit rates
  const praValues = games.map(g => (g.stats.PTS || 0) + (g.stats.REB || 0) + (g.stats.AST || 0));
  for (const line of [25, 30, 35, 40, 45]) {
    const hits = praValues.filter(v => v > line).length;
    hitRates[`over${line}pra`] = parseFloat((hits / praValues.length * 100).toFixed(1));
  }

  return hitRates;
}

// ═══════════════════════════════════════════════════════════════
// PLAYER PROP PROJECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Project a player's stat for a specific game.
 */
function projectPlayerStat(playerId, stat, options = {}) {
  const profile = buildPlayerProfile(playerId);
  if (!profile) return null;

  const {
    weightL5 = 0.5,   // Weight for last 5 games
    weightL10 = 0.3,  // Weight for last 10 games
    weightSeason = 0.2, // Weight for season average
    adjustForOpponent = 0, // Defensive adjustment
    isHome = false,
  } = options;

  const seasonAvg = profile.seasonAvg[stat] || 0;
  const l5Avg = profile.last5Avg[stat] || 0;
  const l10Avg = profile.last10Avg[stat] || 0;
  const cv = profile.consistency[stat] || 50;

  // Weighted projection
  const rawProjection = (l5Avg * weightL5) + (l10Avg * weightL10) + (seasonAvg * weightSeason);

  // Apply opponent adjustment
  const adjustedProjection = rawProjection * (1 + adjustForOpponent);

  // Home/away adjustment (if available)
  // For now, just use raw projection

  // Calculate confidence based on consistency
  let confidence = 'LOW';
  if (cv < 20 && profile.gamesPlayed >= 20) confidence = 'HIGH';
  else if (cv < 30 && profile.gamesPlayed >= 10) confidence = 'MEDIUM';

  // Calculate expected line (round to nearest 0.5)
  const expectedLine = Math.round(adjustedProjection * 2) / 2;

  return {
    playerId,
    stat,
    projection: parseFloat(adjustedProjection.toFixed(1)),
    expectedLine,
    confidence,
    consistency: cv,
    gamesPlayed: profile.gamesPlayed,
    breakdown: {
      seasonAvg,
      last5Avg: l5Avg,
      last10Avg: l10Avg,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// VALUE FINDER
// ═══════════════════════════════════════════════════════════════

/**
 * Find value in player props by comparing projections to lines.
 */
function findPropValue(playerId, stat, sportsbookLine) {
  const projection = projectPlayerStat(playerId, stat);
  if (!projection) return null;

  const edge = projection.projection - sportsbookLine;
  const edgePct = (edge / sportsbookLine) * 100;

  // Determine if there's value
  let recommendation = 'PASS';
  let valueRating = 'AVOID';

  if (edge > 2 && projection.confidence === 'HIGH') {
    recommendation = 'OVER';
    valueRating = 'STRONG';
  } else if (edge > 1.5 && projection.confidence !== 'LOW') {
    recommendation = 'OVER';
    valueRating = 'GOOD';
  } else if (edge > 1) {
    recommendation = 'OVER';
    valueRating = 'FAIR';
  } else if (edge < -2 && projection.confidence === 'HIGH') {
    recommendation = 'UNDER';
    valueRating = 'STRONG';
  } else if (edge < -1.5 && projection.confidence !== 'LOW') {
    recommendation = 'UNDER';
    valueRating = 'GOOD';
  } else if (edge < -1) {
    recommendation = 'UNDER';
    valueRating = 'FAIR';
  }

  // Get hit rate at the line
  const profile = buildPlayerProfile(playerId);
  const hitRate = profile?.hitRates?.[`over${Math.floor(sportsbookLine)}${stat.toLowerCase()}`] || null;

  return {
    playerId,
    stat,
    sportsbookLine,
    projection: projection.projection,
    expectedLine: projection.expectedLine,
    edge: parseFloat(edge.toFixed(1)),
    edgePct: parseFloat(edgePct.toFixed(1)),
    recommendation,
    valueRating,
    confidence: projection.confidence,
    hitRate,
    breakdown: projection.breakdown,
  };
}

// ═══════════════════════════════════════════════════════════════
// TEAM PLAYER SEARCH
// ═══════════════════════════════════════════════════════════════

/**
 * Get all players on a team with their profiles.
 */
function getTeamPlayers(teamId) {
  const roster = loadJson(`roster-${teamId}.json`);
  if (!roster?.athletes) return [];

  const players = [];
  for (const athlete of roster.athletes) {
    const profile = buildPlayerProfile(athlete.id);
    if (profile) {
      players.push({
        id: athlete.id,
        name: athlete.displayName || `${athlete.firstName} ${athlete.lastName}`,
        position: athlete.position?.abbreviation,
        profile,
      });
    }
  }

  return players.sort((a, b) => (b.profile.seasonAvg.PTS || 0) - (a.profile.seasonAvg.PTS || 0));
}

// ═══════════════════════════════════════════════════════════════
// BATCH PROJECTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Generate projections for all players in a game.
 */
function generateGameProjections(homeTeamId, awayTeamId) {
  const homePlayers = getTeamPlayers(homeTeamId);
  const awayPlayers = getTeamPlayers(awayTeamId);

  const projections = [];

  for (const player of [...homePlayers, ...awayPlayers]) {
    for (const stat of ['PTS', 'REB', 'AST']) {
      const proj = projectPlayerStat(player.id, stat);
      if (proj) {
        projections.push({
          ...proj,
          playerName: player.name,
          teamId: player.id === homeTeamId ? homeTeamId : awayTeamId,
          isHome: player.id === homeTeamId,
        });
      }
    }
  }

  return projections.sort((a, b) => b.projection - a.projection);
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  parseGamelog,
  buildPlayerProfile,
  projectPlayerStat,
  findPropValue,
  getTeamPlayers,
  generateGameProjections,
  calculateHitRates,
  // Utilities
  calculateMean,
  calculateStdDev,
  calculateCV,
  calculateMedian,
  calculatePercentile,
};
