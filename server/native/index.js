/**
 * SHARPEDGE Native Core — JS Wrapper
 * 
 * Tries to load the C native module for speed.
 * Falls back to pure JS implementations if native is unavailable.
 */

let native;
try {
  native = require('./build/Release/sharpedge_core');
  console.log('[native] Loaded C core module — FAST mode enabled');
} catch (e) {
  console.log('[native] C module not available, using JS fallbacks:', e.message);
  native = null;
}

// ═══════════════════════════════════════════════════════════════
// ODDS CONVERSION
// ═══════════════════════════════════════════════════════════════

function americanToDecimal(american) {
  if (native) return native.americanToDecimal(american);
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function americanToImpliedProb(american) {
  if (native) return native.americanToImpliedProb(american);
  return american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100);
}

function removeVig(homeAmerican, awayAmerican) {
  if (native) return native.removeVig(homeAmerican, awayAmerican);
  const homeImp = americanToImpliedProb(homeAmerican);
  const awayImp = americanToImpliedProb(awayAmerican);
  const total = homeImp + awayImp;
  return {
    homeProb: homeImp / total,
    awayProb: awayImp / total,
    vig: total - 1,
  };
}

// ═══════════════════════════════════════════════════════════════
// KELLY CRITERION
// ═══════════════════════════════════════════════════════════════

function kellyCriterion(trueProb, decimalOdds, fraction = 0.25) {
  if (native) return native.kellyCriterion(trueProb, decimalOdds, fraction);
  const b = decimalOdds - 1;
  const q = 1 - trueProb;
  let fullKelly = (b * trueProb - q) / b;
  if (fullKelly < 0) fullKelly = 0;
  if (fullKelly > 0.25) fullKelly = 0.25;
  const fractionalKelly = fullKelly * fraction;
  const ev = (trueProb * (decimalOdds - 1)) - (1 - trueProb);
  return {
    fullKelly,
    fractionalKelly,
    recommendedPct: fractionalKelly * 100,
    expectedValue: ev,
    isPositiveEV: ev > 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════

function statistics(values) {
  if (native && values.length > 0) return native.statistics(values);
  if (!values.length) return { mean: 0, stddev: 0, variance: 0, median: 0, min: 0, max: 0, cv: 0, count: 0 };
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    mean,
    stddev,
    variance,
    median,
    min: sorted[0],
    max: sorted[n - 1],
    cv: mean > 0 ? (stddev / mean) * 100 : 0,
    count: n,
  };
}

function weightedAverage(values, weights) {
  if (native) return native.weightedAverage(values, weights);
  let sumV = 0, sumW = 0;
  for (let i = 0; i < values.length; i++) {
    sumV += values[i] * weights[i];
    sumW += weights[i];
  }
  return sumW > 0 ? sumV / sumW : 0;
}

function hitRate(values, line) {
  if (native) return native.hitRate(values, line);
  const hits = values.filter(v => v > line).length;
  return { hits, total: values.length, rate: values.length > 0 ? hits / values.length : 0 };
}

// ═══════════════════════════════════════════════════════════════
// PROBABILITY
// ═══════════════════════════════════════════════════════════════

function winProbability(homeRating, awayRating, hca = 3.5) {
  if (native) return native.winProbability(homeRating, awayRating, hca);
  const diff = (homeRating + hca) - awayRating;
  const homeProb = 1 / (1 + Math.exp(-diff * 0.1));
  return {
    homeProb,
    awayProb: 1 - homeProb,
    predictedMargin: diff * 0.4,
  };
}

function playerProjection(seasonAvg, last5, last10, w5 = 0.5, w10 = 0.3, wSeason = 0.2) {
  if (native) return native.playerProjection(seasonAvg, last5, last10, w5, w10, wSeason);
  return (last5 * w5 + last10 * w10 + seasonAvg * wSeason) / (w5 + w10 + wSeason);
}

function propScore(fairLine, sportsbookLine, consistencyCV, gamesPlayed) {
  if (native) return native.propScore(fairLine, sportsbookLine, consistencyCV, gamesPlayed);
  const edge = fairLine - sportsbookLine;
  const absEdge = Math.abs(edge);
  const edgeScore = Math.min(50, absEdge * 8);
  const consScore = Math.max(0, 25 - consistencyCV * 0.5);
  const sampleScore = Math.min(25, gamesPlayed * 1.5);
  let score = Math.min(100, Math.max(0, edgeScore + consScore + sampleScore));
  const confidence = score >= 70 ? 'HIGH' : score >= 45 ? 'MEDIUM' : 'LOW';
  const valueRating = score >= 80 && absEdge >= 3 ? 'STRONG'
    : score >= 60 && absEdge >= 2 ? 'GOOD'
    : score >= 40 && absEdge >= 1.5 ? 'FAIR'
    : score >= 25 ? 'MARGINAL' : 'AVOID';
  const recommendation = edge > 0.5 ? 'OVER' : edge < -0.5 ? 'UNDER' : 'PASS';
  return { edge, absEdge, score, confidence, valueRating, recommendation };
}

// ═══════════════════════════════════════════════════════════════
// SHARP DETECTION
// ═══════════════════════════════════════════════════════════════

function detectSharpMoney(bookOdds) {
  if (native) return native.detectSharpMoney(bookOdds);
  if (!bookOdds || bookOdds.length < 2) {
    return { isSharp: false, signal: 'INSUFFICIENT_DATA', sharpScore: 0 };
  }
  const homeMLs = bookOdds.map(b => b.homeML).filter(v => v != null);
  const spreads = bookOdds.map(b => b.homeSpread).filter(v => v != null);
  const totals = bookOdds.map(b => b.total).filter(v => v != null);

  const mlGap = homeMLs.length >= 2 ? Math.max(...homeMLs) - Math.min(...homeMLs) : 0;
  const spreadGap = spreads.length >= 2 ? Math.max(...spreads) - Math.min(...spreads) : 0;
  const totalGap = totals.length >= 2 ? Math.max(...totals) - Math.min(...totals) : 0;

  let sharpScore = 0;
  if (mlGap >= 15) sharpScore += 40;
  else if (mlGap >= 10) sharpScore += 25;
  else if (mlGap >= 5) sharpScore += 10;
  if (spreadGap >= 2) sharpScore += 40;
  else if (spreadGap >= 1) sharpScore += 20;
  else if (spreadGap >= 0.5) sharpScore += 10;
  if (totalGap >= 3) sharpScore += 30;
  else if (totalGap >= 2) sharpScore += 15;
  else if (totalGap >= 1) sharpScore += 8;

  const isSharp = sharpScore >= 30;
  const signal = sharpScore >= 50 ? 'STRONG' : sharpScore >= 30 ? 'MODERATE' : sharpScore >= 15 ? 'WEAK' : 'NONE';

  return { isSharp, signal, sharpScore, mlGap, spreadGap, totalGap };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  isNative: !!native,
  americanToDecimal,
  americanToImpliedProb,
  removeVig,
  kellyCriterion,
  statistics,
  weightedAverage,
  hitRate,
  winProbability,
  playerProjection,
  propScore,
  detectSharpMoney,
};
