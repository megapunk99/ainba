/**
 * +EV CALCULATOR — Expected Value Engine
 * 
 * The core of what makes Action Network Pro valuable.
 * This module:
 * 1. Calculates no-vig probabilities from Pinnacle (the sharpest book)
 * 2. Compares your model's probability against the market consensus
 * 3. Identifies +EV bets where your model disagrees with the market
 * 4. Grades bets from A+ to D based on edge size and confidence
 * 5. Calculates optimal Kelly Criterion sizing
 * 
 * The key insight: Pinnacle's lines ARE the market. If your model says
 * 60% but Pinnacle says 55%, you have a 5% edge. That's +EV.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// ODDS CONVERSION UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Convert American odds to implied probability (includes vig).
 */
function americanToImplied(americanOdds) {
  if (americanOdds < 0) {
    return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
  } else {
    return 100 / (americanOdds + 100);
  }
}

/**
 * Convert American odds to decimal odds.
 */
function americanToDecimal(americanOdds) {
  if (americanOdds < 0) {
    return 1 + (100 / Math.abs(americanOdds));
  } else {
    return 1 + (americanOdds / 100);
  }
}

/**
 * Convert decimal odds to American odds.
 */
function decimalToAmerican(decimalOdds) {
  if (decimalOdds >= 2) {
    return Math.round((decimalOdds - 1) * 100);
  } else {
    return Math.round(-100 / (decimalOdds - 1));
  }
}

/**
 * Remove vig from two-way market to get true probabilities.
 * This is the KEY function — it turns sportsbook odds into "fair" probabilities.
 */
function removeVig(homeOdds, awayOdds) {
  const homeImplied = americanToImplied(homeOdds);
  const awayImplied = americanToImplied(awayOdds);
  const totalImplied = homeImplied + awayImplied;

  // True probabilities (vig removed)
  return {
    homeProb: homeImplied / totalImplied,
    awayProb: awayImplied / totalImplied,
    vig: totalImplied - 1,  // Overround (how much vig the book is taking)
    vigPct: ((totalImplied - 1) * 100).toFixed(1) + '%',
  };
}

/**
 * Remove vig from totals market.
 */
function removeVigTotals(overOdds, underOdds) {
  const overImplied = americanToImplied(overOdds);
  const underImplied = americanToImplied(underOdds);
  const totalImplied = overImplied + underImplied;

  return {
    overProb: overImplied / totalImplied,
    underProb: underImplied / totalImplied,
    vig: totalImplied - 1,
  };
}

// ═══════════════════════════════════════════════════════════════
// PINNACLE CONSENSUS — The Market Truth
// ═══════════════════════════════════════════════════════════════

/**
 * Get Pinnacle's no-vig probabilities for a game.
 * Pinnacle is the sharpest book — their lines ARE the market.
 * 
 * If no Pinnacle data available, fall back to multi-book consensus.
 */
function getPinnacleConsensus(gameOdds) {
  if (!gameOdds?.bookmakers) return null;

  // Try to find Pinnacle first
  const pinnacle = gameOdds.bookmakers.find(b =>
    b.key === 'pinnacle' || b.title?.toLowerCase().includes('pinnacle')
  );

  if (pinnacle) {
    const h2h = pinnacle.markets?.find(m => m.key === 'h2h');
    const spreads = pinnacle.markets?.find(m => m.key === 'spreads');
    const totals = pinnacle.markets?.find(m => m.key === 'totals');

    if (h2h) {
      const homeOutcome = h2h.outcomes?.find(o => o.name === gameOdds.home_team);
      const awayOutcome = h2h.outcomes?.find(o => o.name === gameOdds.away_team);

      if (homeOutcome && awayOutcome) {
        const noVig = removeVig(homeOutcome.price, awayOutcome.price);
        return {
          source: 'pinnacle',
          homeProb: noVig.homeProb,
          awayProb: noVig.awayProb,
          vig: noVig.vig,
          homeML: homeOutcome.price,
          awayML: awayOutcome.price,
          spread: spreads ? getSpreadForTeam(spreads, gameOdds.home_team) : null,
          total: totals ? getTotalForMarket(totals) : null,
        };
      }
    }
  }

  // Fallback: multi-book consensus (average of all books' no-vig probs)
  return getMultiBookConsensus(gameOdds);
}

/**
 * Get consensus from multiple books (fallback when no Pinnacle).
 * Averages the no-vig probabilities from all available books.
 */
function getMultiBookConsensus(gameOdds) {
  if (!gameOdds?.bookmakers?.length) return null;

  let totalHomeProb = 0;
  let totalAwayProb = 0;
  let bookCount = 0;

  for (const book of gameOdds.bookmakers) {
    const h2h = book.markets?.find(m => m.key === 'h2h');
    if (!h2h) continue;

    const homeOutcome = h2h.outcomes?.find(o => o.name === gameOdds.home_team);
    const awayOutcome = h2h.outcomes?.find(o => o.name === gameOdds.away_team);

    if (homeOutcome && awayOutcome) {
      const noVig = removeVig(homeOutcome.price, awayOutcome.price);
      totalHomeProb += noVig.homeProb;
      totalAwayProb += noVig.awayProb;
      bookCount++;
    }
  }

  if (bookCount === 0) return null;

  return {
    source: `consensus_${bookCount}_books`,
    homeProb: totalHomeProb / bookCount,
    awayProb: totalAwayProb / bookCount,
    vig: 0, // Already removed
    bookCount,
  };
}

/**
 * Get spread from a spreads market for a specific team.
 */
function getSpreadForTeam(spreadsMarket, teamName) {
  const outcome = spreadsMarket.outcomes?.find(o => o.name === teamName);
  return outcome ? { point: outcome.point, price: outcome.price } : null;
}

/**
 * Get total from a totals market.
 */
function getTotalForMarket(totalsMarket) {
  const over = totalsMarket.outcomes?.find(o => o.name === 'Over');
  return over ? { point: over.point, price: over.price } : null;
}

// ═══════════════════════════════════════════════════════════════
// +EV CALCULATION — The Core
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate if a bet is +EV.
 * 
 * @param {number} modelProb - Your model's probability of this outcome
 * @param {number} americanOdds - The odds you're getting
 * @param {object} marketConsensus - Pinnacle/market no-vig probabilities
 * @returns {object} EV analysis
 */
function calculateEV(modelProb, americanOdds, marketConsensus) {
  // Convert odds to decimal
  const decimalOdds = americanToDecimal(americanOdds);

  // Expected Value = (probability * payout) - 1
  // If EV > 0, the bet is +EV (profitable long-term)
  const ev = (modelProb * decimalOdds) - 1;
  const evPct = ev * 100;

  // Edge = your model vs the market
  const marketProb = marketConsensus?.homeProb || 0.5;
  const edge = modelProb - marketProb;
  const edgePct = edge * 100;

  // Grade the bet
  let grade = 'D';
  let gradeDescription = 'No value';
  if (evPct > 10) { grade = 'A+'; gradeDescription = 'Massive edge — rare'; }
  else if (evPct > 7) { grade = 'A'; gradeDescription = 'Strong edge'; }
  else if (evPct > 5) { grade = 'A-'; gradeDescription = 'Good edge'; }
  else if (evPct > 3) { grade = 'B+'; gradeDescription = 'Solid edge'; }
  else if (evPct > 2) { grade = 'B'; gradeDescription = 'Moderate edge'; }
  else if (evPct > 1) { grade = 'B-'; gradeDescription = 'Small edge'; }
  else if (evPct > 0.5) { grade = 'C+'; gradeDescription = 'Marginal edge'; }
  else if (evPct > 0) { grade = 'C'; gradeDescription = 'Tiny edge — exercise caution'; }
  else { grade = 'D'; gradeDescription = 'Negative EV — avoid'; }

  // Kelly Criterion sizing
  const kelly = calculateKelly(modelProb, americanOdds);

  // Is this a bet?
  const isBet = evPct > 1 && modelProb > 0.52; // Minimum 1% EV and 52% probability
  const isLean = evPct > 0.5 && !isBet;

  return {
    // Core metrics
    ev: parseFloat(evPct.toFixed(2)),
    edge: parseFloat(edgePct.toFixed(2)),
    modelProb: parseFloat((modelProb * 100).toFixed(1)),
    marketProb: parseFloat((marketProb * 100).toFixed(1)),
    americanOdds,
    decimalOdds: parseFloat(decimalOdds.toFixed(2)),

    // Grade
    grade,
    gradeDescription,

    // Recommendation
    isBet,
    isLean,
    recommendation: isBet ? 'BET' : isLean ? 'LEAN' : 'PASS',

    // Sizing
    kelly: kelly.fraction,
    kellyBetSize: kelly.recommendedBet,
    kellyRisk: kelly.riskLevel,

    // Market info
    marketSource: marketConsensus?.source || 'unknown',
    vig: marketConsensus?.vig ? (marketConsensus.vig * 100).toFixed(1) + '%' : 'N/A',
  };
}

/**
 * Calculate Kelly Criterion optimal bet size.
 */
function calculateKelly(prob, americanOdds) {
  const decimalOdds = americanToDecimal(americanOdds);
  const b = decimalOdds - 1;  // Net odds (profit per $1 risked)
  const p = prob;              // Probability of winning
  const q = 1 - p;            // Probability of losing

  // Kelly fraction: (bp - q) / b
  const kellyFraction = (b * p - q) / b;

  // Apply fractional Kelly (25% for safety)
  const adjustedKelly = Math.max(0, kellyFraction * 0.25);

  // Recommended bet as % of bankroll
  const betPct = adjustedKelly * 100;

  // Risk level
  let riskLevel = 'LOW';
  if (betPct > 3) riskLevel = 'HIGH';
  else if (betPct > 1.5) riskLevel = 'MEDIUM';

  return {
    fraction: parseFloat(kellyFraction.toFixed(4)),
    adjustedFraction: parseFloat(adjustedKelly.toFixed(4)),
    recommendedBet: parseFloat(betPct.toFixed(2)) + '%',
    riskLevel,
    hasEdge: kellyFraction > 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// GAME-LEVEL +EV ANALYSIS
// ═══════════════════════════════════════════════════════════════

/**
 * Analyze all betting markets for a game and find +EV opportunities.
 * 
 * @param {object} gameOdds - Full odds data for a game
 * @param {object} modelPrediction - Your model's prediction for this game
 * @returns {object} Complete game analysis with all +EV bets
 */
function analyzeGameForEV(gameOdds, modelPrediction) {
  if (!gameOdds || !modelPrediction) return null;

  const marketConsensus = getPinnacleConsensus(gameOdds);
  if (!marketConsensus) return null;

  const results = {
    gameId: gameOdds.id,
    matchup: `${gameOdds.away_team} @ ${gameOdds.home_team}`,
    marketConsensus,
    bets: [],
    bestBet: null,
    hasValue: false,
  };

  // 1. Moneyline +EV
  const homeML = getOutcomeOdds(gameOdds, gameOdds.home_team, 'h2h');
  const awayML = getOutcomeOdds(gameOdds, gameOdds.away_team, 'h2h');

  if (homeML) {
    const homeEV = calculateEV(
      modelPrediction.homeWinProb || 0.5,
      homeML.odds,
      marketConsensus
    );
    results.bets.push({
      type: 'moneyline',
      side: 'home',
      team: gameOdds.home_team,
      odds: homeML.odds,
      book: homeML.book,
      ...homeEV,
    });
  }

  if (awayML) {
    const awayEV = calculateEV(
      1 - (modelPrediction.homeWinProb || 0.5),
      awayML.odds,
      { ...marketConsensus, homeProb: marketConsensus.awayProb, awayProb: marketConsensus.homeProb }
    );
    results.bets.push({
      type: 'moneyline',
      side: 'away',
      team: gameOdds.away_team,
      odds: awayML.odds,
      book: awayML.book,
      ...awayEV,
    });
  }

  // 2. Spread +EV
  const homeSpread = getOutcomeOdds(gameOdds, gameOdds.home_team, 'spreads');
  const awaySpread = getOutcomeOdds(gameOdds, gameOdds.away_team, 'spreads');

  if (homeSpread && modelPrediction.predictedMargin !== undefined) {
    // Convert predicted margin to spread probability
    const spreadProb = marginToSpreadProb(modelPrediction.predictedMargin, homeSpread.point || 0);
    const spreadEV = calculateEV(spreadProb, homeSpread.odds, marketConsensus);
    results.bets.push({
      type: 'spread',
      side: 'home',
      team: gameOdds.home_team,
      line: homeSpread.point,
      odds: homeSpread.odds,
      book: homeSpread.book,
      ...spreadEV,
    });
  }

  // 3. Total +EV
  const overOdds = getOutcomeOdds(gameOdds, 'Over', 'totals');
  const underOdds = getOutcomeOdds(gameOdds, 'Under', 'totals');

  if (overOdds && modelPrediction.projectedTotal) {
    const totalProb = totalToOverProb(modelPrediction.projectedTotal, overOdds.point || 0);
    const totalEV = calculateEV(totalProb, overOdds.odds, marketConsensus);
    results.bets.push({
      type: 'total',
      side: 'over',
      line: overOdds.point,
      odds: overOdds.odds,
      book: overOdds.book,
      ...totalEV,
    });
  }

  // Find best bet
  const valueBets = results.bets.filter(b => b.isBet || b.isLean);
  if (valueBets.length > 0) {
    results.bestBet = valueBets.reduce((best, b) => b.ev > best.ev ? b : best);
    results.hasValue = true;
  }

  // Sort by EV (best first)
  results.bets.sort((a, b) => b.ev - a.ev);

  return results;
}

/**
 * Get the best odds for a specific outcome across all books.
 */
function getOutcomeOdds(gameOdds, outcomeName, marketKey) {
  if (!gameOdds?.bookmakers) return null;

  let bestOdds = null;
  let bestBook = '';

  for (const book of gameOdds.bookmakers) {
    const market = book.markets?.find(m => m.key === marketKey);
    if (!market) continue;

    const outcome = market.outcomes?.find(o => o.name === outcomeName);
    if (!outcome) continue;

    // For odds: higher is better (less negative or more positive)
    if (!bestOdds || outcome.price > bestOdds.odds) {
      bestOdds = { odds: outcome.price, point: outcome.point, book: book.title || book.key };
      bestBook = book.title;
    }
  }

  return bestOdds;
}

/**
 * Convert predicted margin to spread win probability.
 * Uses a normal distribution approximation.
 */
function marginToSpreadProb(predictedMargin, spread) {
  // Standard deviation of NBA margins ~ 11 points
  const stdDev = 11;
  const z = (predictedMargin - spread) / stdDev;

  // Approximate CDF of normal distribution
  return normalCDF(z);
}

/**
 * Convert projected total to over probability.
 */
function totalToOverProb(projectedTotal, totalLine) {
  const stdDev = 12; // NBA total std dev
  const z = (projectedTotal - totalLine) / stdDev;
  return normalCDF(z);
}

/**
 * Approximate normal CDF (cumulative distribution function).
 */
function normalCDF(z) {
  // Abramowitz and Stegun approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

// ═══════════════════════════════════════════════════════════════
// BATCH ANALYSIS — All Games
// ═══════════════════════════════════════════════════════════════

/**
 * Analyze all upcoming games for +EV opportunities.
 */
function analyzeAllGamesForEV(predictions) {
  const liveOdds = loadJson('live-odds.json');
  if (!Array.isArray(liveOdds)) return [];

  const results = [];

  for (const game of liveOdds) {
    // Find matching prediction
    const prediction = predictions.find(p =>
      p.gameId === game.id ||
      p.home?.name === game.home_team ||
      p.away?.name === game.away_team
    );

    if (!prediction) continue;

    const analysis = analyzeGameForEV(game, prediction.prediction || prediction);
    if (analysis) results.push(analysis);
  }

  // Sort by best edge
  results.sort((a, b) => {
    const aEdge = a.bestBet?.ev || 0;
    const bEdge = b.bestBet?.ev || 0;
    return bEdge - aEdge;
  });

  return results;
}

// ═══════════════════════════════════════════════════════════════
// VALUE SUMMARY — Quick Dashboard Data
// ═══════════════════════════════════════════════════════════════

function getValueSummary(predictions) {
  const allAnalysis = analyzeAllGamesForEV(predictions);

  const valueBets = [];
  for (const game of allAnalysis) {
    for (const bet of game.bets) {
      if (bet.isBet || bet.isLean) {
        valueBets.push({
          matchup: game.matchup,
          ...bet,
        });
      }
    }
  }

  valueBets.sort((a, b) => b.ev - a.ev);

  return {
    totalGames: allAnalysis.length,
    gamesWithValue: allAnalysis.filter(g => g.hasValue).length,
    totalValueBets: valueBets.length,
    bets: valueBets,
    topPick: valueBets[0] || null,
    summary: valueBets.length > 0
      ? `Found ${valueBets.length} value bets across ${allAnalysis.length} games`
      : 'No +EV opportunities found right now',
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Core calculations
  americanToImplied,
  americanToDecimal,
  decimalToAmerican,
  removeVig,
  removeVigTotals,

  // Market analysis
  getPinnacleConsensus,
  getMultiBookConsensus,

  // +EV calculation
  calculateEV,
  calculateKelly,

  // Game analysis
  analyzeGameForEV,
  analyzeAllGamesForEV,
  getValueSummary,

  // Utilities
  marginToSpreadProb,
  totalToOverProb,
  normalCDF,
};
