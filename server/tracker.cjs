/**
 * TRACKER v1.0 — Records predictions, checks results, computes accuracy
 *
 * Every prediction is stored. After games complete, we check who was right.
 * This feeds back into the model so it gets smarter over time.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const TRACKER_FILE = path.join(DATA, 'model-tracker.json');

function loadTracker() {
  try { return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8')); }
  catch {
    return {
      predictions: [],
      results: [],
      patterns: [],
      overallAccuracy: {},
      recentAccuracy: {},
      bestPerforming: [],
      worstPerforming: [],
      totalPredictions: 0,
      totalCorrect: 0,
      lastUpdated: null,
    };
  }
}

function saveTracker(tracker) {
  // Keep only last 500 predictions
  tracker.predictions = (tracker.predictions || []).slice(-500);
  tracker.results = (tracker.results || []).slice(-200);
  tracker.lastUpdated = new Date().toISOString();
  try { fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2)); }
  catch (e) { console.error('[tracker] Save error:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// RECORD — Store a prediction
// ═══════════════════════════════════════════════════════════════════

function recordPrediction(prediction) {
  const tracker = loadTracker();
  
  const record = {
    id: `pred-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    player: prediction.player,
    team: prediction.team,
    stat: prediction.stat,
    recommendation: prediction.recommendation,
    estimatedLine: prediction.estimatedLine,
    projection: prediction.yourProjection,
    edge: prediction.edge,
    confidence: prediction.confidence,
    matchup: prediction.matchup,
    reasoning: prediction.reasoning,
    // Will be filled in after game
    actualResult: null,
    correct: null,
    checked: false,
  };

  tracker.predictions.push(record);
  tracker.totalPredictions++;
  saveTracker(tracker);

  return record.id;
}

// ═══════════════════════════════════════════════════════════════════
// CHECK — Verify predictions against actual results
// ═══════════════════════════════════════════════════════════════════

function checkPredictions(gameResults) {
  const tracker = loadTracker();
  let newCorrect = 0;
  let newChecked = 0;

  tracker.predictions.forEach(pred => {
    if (pred.checked) return;

    // Find the actual result for this player
    const result = gameResults.find(r =>
      r.player === pred.player && r.stat === pred.stat
    );

    if (result && result.actualValue != null) {
      pred.actualResult = result.actualValue;
      
      // Did the pick hit?
      if (pred.recommendation === 'OVER') {
        pred.correct = result.actualValue > pred.estimatedLine;
      } else {
        pred.correct = result.actualValue < pred.estimatedLine;
      }
      
      pred.checked = true;
      pred.actualValue = result.actualValue;
      newChecked++;
      if (pred.correct) newCorrect++;

      tracker.results.push({
        player: pred.player,
        stat: pred.stat,
        recommendation: pred.recommendation,
        estimatedLine: pred.estimatedLine,
        actualValue: result.actualValue,
        projection: pred.projection,
        correct: pred.correct,
        edge: pred.edge,
        confidence: pred.confidence,
        timestamp: pred.timestamp,
      });
    }
  });

  // Update accuracy stats
  if (newChecked > 0) {
    const checkedPreds = tracker.predictions.filter(p => p.checked);
    const correct = checkedPreds.filter(p => p.correct).length;
    tracker.totalCorrect = correct;

    tracker.overallAccuracy = {
      overall: `${(correct / checkedPreds.length * 100).toFixed(1)}%`,
      total: checkedPreds.length,
      correct,
      incorrect: checkedPreds.length - correct,
    };

    // Accuracy by stat
    const byStat = {};
    checkedPreds.forEach(p => {
      if (!byStat[p.stat]) byStat[p.stat] = { correct: 0, total: 0 };
      byStat[p.stat].total++;
      if (p.correct) byStat[p.stat].correct++;
    });
    tracker.overallAccuracy.byStat = {};
    Object.entries(byStat).forEach(([stat, data]) => {
      tracker.overallAccuracy.byStat[stat] = `${(data.correct / data.total * 100).toFixed(1)}% (${data.correct}/${data.total})`;
    });

    // Accuracy by confidence
    const byConf = {};
    checkedPreds.forEach(p => {
      if (!byConf[p.confidence]) byConf[p.confidence] = { correct: 0, total: 0 };
      byConf[p.confidence].total++;
      if (p.correct) byConf[p.confidence].correct++;
    });
    tracker.overallAccuracy.byConfidence = {};
    Object.entries(byConf).forEach(([conf, data]) => {
      tracker.overallAccuracy.byConfidence[conf] = `${(data.correct / data.total * 100).toFixed(1)}% (${data.correct}/${data.total})`;
    });

    // Accuracy by recommendation
    const byRec = {};
    checkedPreds.forEach(p => {
      if (!byRec[p.recommendation]) byRec[p.recommendation] = { correct: 0, total: 0 };
      byRec[p.recommendation].total++;
      if (p.correct) byRec[p.recommendation].correct++;
    });
    tracker.overallAccuracy.byRecommendation = {};
    Object.entries(byRec).forEach(([rec, data]) => {
      tracker.overallAccuracy.byRecommendation[rec] = `${(data.correct / data.total * 100).toFixed(1)}% (${data.correct}/${data.total})`;
    });

    // Recent accuracy (last 50)
    const recent = checkedPreds.slice(-50);
    const recentCorrect = recent.filter(p => p.correct).length;
    tracker.recentAccuracy = {
      overall: `${(recentCorrect / recent.length * 100).toFixed(1)}%`,
      sample: recent.length,
    };

    // Best/Worst performing players
    const byPlayer = {};
    checkedPreds.forEach(p => {
      if (!byPlayer[p.player]) byPlayer[p.player] = { correct: 0, total: 0 };
      byPlayer[p.player].total++;
      if (p.correct) byPlayer[p.player].correct++;
    });
    const playerAcc = Object.entries(byPlayer)
      .map(([name, data]) => ({ name, accuracy: data.correct / data.total, correct: data.correct, total: data.total }))
      .filter(p => p.total >= 3); // Need at least 3 predictions

    tracker.bestPerforming = playerAcc
      .sort((a, b) => b.accuracy - a.accuracy)
      .slice(0, 10)
      .map(p => `${p.name} (${(p.accuracy * 100).toFixed(0)}% - ${p.correct}/${p.total})`);

    tracker.worstPerforming = playerAcc
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 10)
      .map(p => `${p.name} (${(p.accuracy * 100).toFixed(0)}% - ${p.correct}/${p.total})`);
  }

  saveTracker(tracker);
  return { newChecked, newCorrect, total: tracker.predictions.length };
}

// ═══════════════════════════════════════════════════════════════════
// EVOLVE — Discover patterns from results
// ═══════════════════════════════════════════════════════════════════

function discoverPatterns() {
  const tracker = loadTracker();
  const results = tracker.results || [];
  if (results.length < 20) return []; // Need enough data

  const patterns = [];

  // Pattern: Which stats are most predictable?
  const statAccuracy = {};
  results.forEach(r => {
    if (!statAccuracy[r.stat]) statAccuracy[r.stat] = { correct: 0, total: 0 };
    statAccuracy[r.stat].total++;
    if (r.correct) statAccuracy[r.stat].correct++;
  });
  Object.entries(statAccuracy).forEach(([stat, data]) => {
    if (data.total >= 5) {
      const acc = data.correct / data.total;
      patterns.push({
        type: 'stat_accuracy',
        stat,
        accuracy: acc,
        sample: data.total,
        description: `${stat} predictions are ${(acc * 100).toFixed(0)}% accurate (${data.total} samples)`,
        recommendation: acc > 0.55 ? 'TRUST' : acc < 0.45 ? 'DISTRUST' : 'NEUTRAL',
      });
    }
  });

  // Pattern: Are OVER or UNDER picks better?
  const recAccuracy = {};
  results.forEach(r => {
    if (!recAccuracy[r.recommendation]) recAccuracy[r.recommendation] = { correct: 0, total: 0 };
    recAccuracy[r.recommendation].total++;
    if (r.correct) recAccuracy[r.recommendation].correct++;
  });
  Object.entries(recAccuracy).forEach(([rec, data]) => {
    if (data.total >= 5) {
      const acc = data.correct / data.total;
      patterns.push({
        type: 'recommendation_accuracy',
        recommendation: rec,
        accuracy: acc,
        sample: data.total,
        description: `${rec} picks are ${(acc * 100).toFixed(0)}% accurate (${data.total} samples)`,
      });
    }
  });

  // Pattern: Does higher confidence = higher accuracy?
  const confAccuracy = {};
  results.forEach(r => {
    if (!confAccuracy[r.confidence]) confAccuracy[r.confidence] = { correct: 0, total: 0 };
    confAccuracy[r.confidence].total++;
    if (r.correct) confAccuracy[r.confidence].correct++;
  });
  Object.entries(confAccuracy).forEach(([conf, data]) => {
    if (data.total >= 5) {
      const acc = data.correct / data.total;
      patterns.push({
        type: 'confidence_calibration',
        confidence: conf,
        accuracy: acc,
        sample: data.total,
        description: `${conf} confidence picks are ${(acc * 100).toFixed(0)}% accurate`,
      });
    }
  });

  // Pattern: Is there an optimal edge range?
  const edgeRanges = { '0-1': [], '1-2': [], '2-3': [], '3-5': [], '5+': [] };
  results.forEach(r => {
    const edge = Math.abs(r.edge || 0);
    const range = edge < 1 ? '0-1' : edge < 2 ? '1-2' : edge < 3 ? '2-3' : edge < 5 ? '3-5' : '5+';
    edgeRanges[range].push(r.correct ? 1 : 0);
  });
  Object.entries(edgeRanges).forEach(([range, outcomes]) => {
    if (outcomes.length >= 5) {
      const acc = outcomes.reduce((s, v) => s + v, 0) / outcomes.length;
      patterns.push({
        type: 'edge_range',
        range,
        accuracy: acc,
        sample: outcomes.length,
        description: `Edge ${range} pts: ${(acc * 100).toFixed(0)}% accurate (${outcomes.length} picks)`,
      });
    }
  });

  tracker.patterns = patterns;
  saveTracker(tracker);
  return patterns;
}

// ═══════════════════════════════════════════════════════════════════
// STATUS — Current tracker status
// ═══════════════════════════════════════════════════════════════════

function getStatus() {
  const tracker = loadTracker();
  const pending = tracker.predictions.filter(p => !p.checked).length;
  return {
    totalPredictions: tracker.totalPredictions,
    checked: tracker.predictions.filter(p => p.checked).length,
    pending,
    accuracy: tracker.overallAccuracy,
    recentAccuracy: tracker.recentAccuracy,
    patterns: tracker.patterns || [],
    bestPerforming: tracker.bestPerforming || [],
    worstPerforming: tracker.worstPerforming || [],
    lastUpdated: tracker.lastUpdated,
  };
}

module.exports = {
  recordPrediction,
  checkPredictions,
  discoverPatterns,
  getStatus,
  loadTracker,
};
