/**
 * SHARPEDGE Prediction Engine v4.0 — Autonomous Prop Generator
 *
 * For each scheduled game:
 * 1. Computes win probability using team ratings + HCA
 * 2. Detects sharp money from cross-book odds discrepancies
 * 3. Projects every player's stats using weighted model (native C)
 * 4. Compares projections to sportsbook lines for value
 * 5. Scores and ranks all props (native C prop_score)
 * 6. Saves predictions + props to SQLite database
 *
 * Uses the C native core for all heavy math.
 */

const fs = require('fs');
const path = require('path');
const core = require('./native/index.js');
const db = require('./db.cjs');
let propsFetcher = null;
try { propsFetcher = require('./props-fetcher.cjs'); } catch {}
let mlModel = null;
try { mlModel = require('./ml-model.cjs'); } catch {}

const DATA = path.join(__dirname, '..', 'data');

// ═══════════════════════════════════════════════════════════════
// INJURY IMPACT PROJECTOR
// Projects point impact from injuries onto game outcomes
// ═══════════════════════════════════════════════════════════════

function getInjuryImpact(teamId, teamAbbr) {
  const roster = loadJson(`roster-${teamId}.json`);
  if (!roster?.athletes) return { injuries: [], totalImpact: 0, keyPlayersOut: [] };

  const injuries = [];
  const keyPlayersOut = [];
  let totalImpact = 0;

  for (const athlete of roster.athletes) {
    if (!athlete.injuries || athlete.injuries.length === 0) continue;

    for (const injury of athlete.injuries) {
      const status = (injury.status || injury.type || '').toLowerCase();
      const isOut = status.includes('out') || status.includes('suspended');
      const isDoubtful = status.includes('doubtful');
      const isQuestionable = status.includes('questionable') || status.includes('probable');

      // Get player's scoring impact from gamelog
      let avgPoints = 0;
      let avgMinutes = 0;
      const gamelog = loadJson(`player-gamelog-${athlete.id}.json`);
      if (gamelog?.labels && gamelog?.seasonTypes) {
        const reg = gamelog.seasonTypes.find(s => (s.displayName || '').includes('Regular'));
        if (reg) {
          const games = [];
          (reg.categories || []).forEach(c => (c.events || []).forEach(e => games.push(e)));
          if (games.length > 0) {
            const ptsIdx = gamelog.labels.indexOf('PTS');
            const minIdx = gamelog.labels.indexOf('MIN');
            if (ptsIdx >= 0) {
              const ptsVals = games.map(g => parseFloat(g.stats?.[ptsIdx]) || 0).filter(v => v > 0);
              avgPoints = ptsVals.length ? ptsVals.reduce((s, v) => s + v, 0) / ptsVals.length : 0;
            }
            if (minIdx >= 0) {
              const minVals = games.map(g => parseFloat(g.stats?.[minIdx]) || 0).filter(v => v > 0);
              avgMinutes = minVals.length ? minVals.reduce((s, v) => s + v, 0) / minVals.length : 0;
            }
          }
        }
      }

      // Calculate point swing based on status
      let pointSwing = 0;
      if (isOut) {
        // Player is out: lose their full scoring contribution
        pointSwing = -avgPoints;
        // Scale by minutes played (players who play more have bigger impact)
        const minuteFactor = Math.min(1, avgMinutes / 36);
        pointSwing = -avgPoints * minuteFactor;
      } else if (isDoubtful) {
        // 80% chance they don't play
        pointSwing = -avgPoints * 0.8 * (avgMinutes / 36);
      } else if (isQuestionable) {
        // 40% chance they don't play
        pointSwing = -avgPoints * 0.4 * (avgMinutes / 36);
      }

      const injuryInfo = {
        player: athlete.displayName || `${athlete.firstName} ${athlete.lastName}`,
        playerId: athlete.id,
        status: injury.status || injury.type || 'Unknown',
        detail: injury.details || injury.detail || '',
        avgPoints: parseFloat(avgPoints.toFixed(1)),
        avgMinutes: parseFloat(avgMinutes.toFixed(1)),
        pointSwing: parseFloat(pointSwing.toFixed(1)),
        isOut,
        isDoubtful,
        isQuestionable,
      };

      injuries.push(injuryInfo);
      totalImpact += pointSwing;

      if ((isOut || isDoubtful) && avgPoints > 10) {
        keyPlayersOut.push(injuryInfo);
      }
    }
  }

  return {
    teamAbbr,
    injuries,
    totalImpact: parseFloat(totalImpact.toFixed(1)),
    keyPlayersOut,
    criticalCount: injuries.filter(i => i.isOut || i.isDoubtful).length,
  };
}

function calculateInjuryAdjustment(homeInjuryData, awayInjuryData) {
  // Net injury impact: negative means home team is more hurt
  const netImpact = homeInjuryData.totalImpact - awayInjuryData.totalImpact;

  // Convert to win probability adjustment
  // ~1 point of scoring = ~1.5% win probability shift
  const probAdjustment = netImpact * 0.015;

  // Score prediction adjustment
  const homeScoreAdj = homeInjuryData.totalImpact * 0.5; // Home loses points from injuries
  const awayScoreAdj = awayInjuryData.totalImpact * 0.5; // Away loses points from injuries

  return {
    netImpact: parseFloat(netImpact.toFixed(1)),
    probAdjustment: parseFloat(Math.max(-0.15, Math.min(0.15, probAdjustment)).toFixed(4)),
    homeScoreAdj: parseFloat(homeScoreAdj.toFixed(1)),
    awayScoreAdj: parseFloat(awayScoreAdj.toFixed(1)),
    homeInjuries: homeInjuryData,
    awayInjuries: awayInjuryData,
  };
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// INJURY MAP BUILDER — quick lookup: playerId -> injury status
// ═══════════════════════════════════════════════════════════════

function buildInjuryMap(teamId) {
  const roster = loadJson(`roster-${teamId}.json`);
  const map = {};
  if (!roster?.athletes) return map;
  for (const athlete of roster.athletes) {
    if (athlete.injuries && athlete.injuries.length > 0) {
      map[String(athlete.id)] = {
        status: athlete.injuries[0].status || athlete.injuries[0].type || 'Unknown',
        detail: athlete.injuries[0].details || athlete.injuries[0].detail || '',
      };
    }
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════
// LAST GAME DATE — uses scoreboard event dates to find recency
// ═══════════════════════════════════════════════════════════════

// Cache: eventId -> date (built from scoreboard + schedules)
let _eventDateCache = null;
function getEventDateMap() {
  if (_eventDateCache) return _eventDateCache;
  _eventDateCache = {};
  // From scoreboard
  const sb = loadJson('scoreboard.json');
  (sb?.events || []).forEach(ev => {
    if (ev.date) _eventDateCache[ev.id] = ev.date;
  });
  // From team schedules (covers completed games with dates)
  for (let t = 1; t <= 30; t++) {
    const sch = loadJson(`schedule-${t}.json`);
    (sch?.events || []).forEach(ev => {
      if (ev.date && ev.id) _eventDateCache[ev.id] = ev.date;
      // Competitors don't have dates, the event itself does — already captured above
    });
  }
  return _eventDateCache;
}

function getLastGameDate(playerId) {
  const eventDates = getEventDateMap();
  const gamelog = loadJson(`player-gamelog-${playerId}.json`);
  if (!gamelog?.labels || !gamelog?.seasonTypes) return null;
  const reg = gamelog.seasonTypes.find(s => (s.displayName || '').includes('Regular'));
  if (!reg) return null;
  let latestDate = null;
  for (const cat of (reg.categories || [])) {
    for (const ev of (cat.events || [])) {
      const gameDate = eventDates[ev.eventId];
      if (gameDate) {
        const d = new Date(gameDate);
        if (!isNaN(d.getTime()) && (!latestDate || d > latestDate)) {
          latestDate = d;
        }
      }
    }
  }
  return latestDate;
}

// ═══════════════════════════════════════════════════════════════
// REST DAYS / BACK-TO-BACK DETECTION
// Calculates rest advantage between two teams
// ═══════════════════════════════════════════════════════════════

function getTeamRestDays(teamId, gameDate) {
  const eventDates = getEventDateMap();
  const sch = loadJson(`schedule-${teamId}.json`);
  if (!sch?.events) return { restDays: 2, isBackToBack: false, gamesInLast7: 0 };

  const gameDt = new Date(gameDate);
  if (isNaN(gameDt.getTime())) return { restDays: 2, isBackToBack: false, gamesInLast7: 0 };

  // Find completed games before this game
  const pastGames = [];
  for (const ev of (sch.events || [])) {
    const comp = ev.competitions?.[0];
    const status = comp?.status?.type?.name || '';
    if (status !== 'STATUS_FINAL') continue;
    const evDate = eventDates[ev.id] || ev.date;
    if (!evDate) continue;
    const d = new Date(evDate);
    if (isNaN(d.getTime()) || d >= gameDt) continue;
    pastGames.push(d);
  }

  pastGames.sort((a, b) => b - a); // Most recent first

  let restDays = 2; // Default: 2 days rest
  let isBackToBack = false;
  let gamesInLast7 = 0;

  if (pastGames.length > 0) {
    const lastGame = pastGames[0];
    restDays = Math.round((gameDt - lastGame) / (1000 * 60 * 60 * 24));
    isBackToBack = restDays <= 1;
  }

  // Count games in last 7 days
  const sevenDaysAgo = new Date(gameDt.getTime() - 7 * 24 * 60 * 60 * 1000);
  gamesInLast7 = pastGames.filter(d => d >= sevenDaysAgo).length;

  return { restDays, isBackToBack, gamesInLast7 };
}

function calculateRestAdjustment(homeRest, awayRest) {
  // NBA research: each day of extra rest is worth ~0.3-0.5 points
  // Back-to-back: lose ~1.5-2 points on average
  // 3-in-4: lose ~1 point
  // 4-in-5: lose ~1.5 points
  
  let homeAdj = 0;
  let awayAdj = 0;

  // Back-to-back penalty
  if (homeRest.isBackToBack) homeAdj -= 1.8;
  if (awayRest.isBackToBack) awayAdj -= 1.8;

  // Games in last 7 days fatigue
  if (homeRest.gamesInLast7 >= 5) homeAdj -= 1.5; // 5+ in 7 = very tired
  else if (homeRest.gamesInLast7 >= 4) homeAdj -= 0.8; // 4 in 7 = somewhat tired
  if (awayRest.gamesInLast7 >= 5) awayAdj -= 1.5;
  else if (awayRest.gamesInLast7 >= 4) awayAdj -= 0.8;

  // Rest advantage (more rest = small advantage)
  const restDiff = homeRest.restDays - awayRest.restDays;
  if (restDiff >= 2) homeAdj += 0.5; // Home has 2+ more days rest
  else if (restDiff <= -2) awayAdj += 0.5; // Away has 2+ more days rest

  // Extra rest boost (3+ days off)
  if (homeRest.restDays >= 3 && !homeRest.isBackToBack) homeAdj += 0.3;
  if (awayRest.restDays >= 3 && !awayRest.isBackToBack) awayAdj += 0.3;

  return {
    homeAdj: parseFloat(homeAdj.toFixed(2)),
    awayAdj: parseFloat(awayAdj.toFixed(2)),
    netAdvantage: parseFloat((homeAdj - awayAdj).toFixed(2)),
    homeB2B: homeRest.isBackToBack,
    awayB2B: awayRest.isBackToBack,
    homeRestDays: homeRest.restDays,
    awayRestDays: awayRest.restDays,
    homeGamesIn7: homeRest.gamesInLast7,
    awayGamesIn7: awayRest.gamesInLast7,
  };
}

// ═══════════════════════════════════════════════════════════════
// OPPONENT MATCHUP SCORING
// How well does a team's offense match up against opponent defense
// ═══════════════════════════════════════════════════════════════

function calculateMatchupScore(offenseTeamId, defenseTeamId) {
  const standings = getStandingsMap();
  const off = standings[offenseTeamId];
  const def = standings[defenseTeamId];
  if (!off || !def) return { score: 0, factors: {} };

  // PPG vs Opponent OPPG (does our offense beat their defense?)
  const ppgvsDef = off.ppg - def.oppg; // Positive = offense outscores their defense

  // Pace impact (fast pace benefits high-scoring teams)
  const paceDiff = off.pace - 100; // Above league average pace
  const paceBoost = paceDiff * 0.1;

  // Turnover battle (low TO + high steal = transition points)
  // We approximate from PPG differential
  const netRating = off.ppg - off.oppg; // Team's net rating

  // Home/Away adjustment already handled by rest/homeAdvantage

  // Overall matchup score (how many extra points above expectation)
  const matchupScore = (ppgvsDef * 0.3) + (netRating * 0.2) + (paceBoost * 0.5);

  return {
    score: parseFloat(matchupScore.toFixed(2)),
    factors: {
      ppgvsDef: parseFloat(ppgvsDef.toFixed(1)),
      netRating: parseFloat(netRating.toFixed(1)),
      paceDiff: parseFloat(paceDiff.toFixed(1)),
      paceBoost: parseFloat(paceBoost.toFixed(2)),
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// RECENT FORM MOMENTUM
// Weight last 5 games more heavily than season average
// ═══════════════════════════════════════════════════════════════

function getRecentForm(teamId) {
  const standings = getStandingsMap();
  const team = standings[teamId];
  if (!team) return { form: 'UNKNOWN', ppg: 110, oppg: 110, momentum: 0 };

  // Get recent schedule results
  const sch = loadJson(`schedule-${teamId}.json`);
  if (!sch?.events) return { form: 'UNKNOWN', ppg: team.ppg, oppg: team.oppg, momentum: 0 };

  const recentResults = [];
  for (const ev of (sch.events || []).slice(0, 10)) {
    const comp = ev.competitions?.[0];
    const status = comp?.status?.type?.name || '';
    if (status !== 'STATUS_FINAL') continue;
    const competitors = comp?.competitors || [];
    const teamComp = competitors.find(c => String(c.team?.id) === String(teamId));
    const oppComp = competitors.find(c => String(c.team?.id) !== String(teamId));
    if (!teamComp || !oppComp) continue;

    const teamScore = parseInt(teamComp.score || 0);
    const oppScore = parseInt(oppComp.score || 0);
    const won = teamScore > oppScore;
    recentResults.push({ won, margin: teamScore - oppScore, scored: teamScore, allowed: oppScore });
  }

  if (recentResults.length === 0) return { form: 'UNKNOWN', ppg: team.ppg, oppg: team.oppg, momentum: 0 };

  // Calculate recent stats (last 5 completed games)
  const last5 = recentResults.slice(0, 5);
  const recentPPG = last5.reduce((s, g) => s + g.scored, 0) / last5.length;
  const recentOPPG = last5.reduce((s, g) => s + g.allowed, 0) / last5.length;
  const recentWinPct = last5.filter(g => g.won).length / last5.length;

  // Momentum: positive = improving, negative = declining
  // Compare last 5 to season average
  const ppgMomentum = recentPPG - team.ppg;
  const defMomentum = team.oppg - recentOPPG; // Positive = defense improving
  const momentum = (ppgMomentum * 0.6) + (defMomentum * 0.4);

  // Form string (e.g., "W3", "L2", "W1L1")
  let form = '';
  let streak = 0;
  let streakType = '';
  for (const g of last5) {
    const type = g.won ? 'W' : 'L';
    if (type === streakType) {
      streak++;
    } else {
      if (streakType) form += streakType + streak + (last5.length > 3 ? ' ' : '');
      streakType = type;
      streak = 1;
    }
  }
  if (streakType) form += streakType + streak;

  return {
    form,
    ppg: parseFloat(recentPPG.toFixed(1)),
    oppg: parseFloat(recentOPPG.toFixed(1)),
    winPct: parseFloat(recentWinPct.toFixed(3)),
    momentum: parseFloat(momentum.toFixed(2)),
    gamesAnalyzed: last5.length,
    last5Results: last5.map(g => g.won ? 'W' : 'L'),
  };
}

// ═══════════════════════════════════════════════════════════════
// PREDICTION ACCURACY TRACKER
// Logs predictions, checks results, tracks calibration
// ═══════════════════════════════════════════════════════════════

const ACCURACY_FILE = path.join(DATA, 'autonomous-state', 'prediction-accuracy.json');

function loadAccuracy() {
  try { return JSON.parse(fs.readFileSync(ACCURACY_FILE, 'utf8')); }
  catch { return { predictions: [], summary: { total: 0, correct: 0, accuracy: 0 } };
  }
}

function saveAccuracy(data) {
  try {
    fs.mkdirSync(path.dirname(ACCURACY_FILE), { recursive: true });
    fs.writeFileSync(ACCURACY_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function logPrediction(pred) {
  const acc = loadAccuracy();
  acc.predictions.push({
    id: pred.gameId || `${pred.awayTeamId}-${pred.homeTeamId}`,
    timestamp: new Date().toISOString(),
    homeWinProb: pred.prediction?.homeWinProb,
    homeScorePred: pred.prediction?.homeScorePred,
    awayScorePred: pred.prediction?.awayScorePred,
    confidence: pred.prediction?.confidence,
    result: null, // Filled in when game is resolved
    actualHomeScore: null,
    actualAwayScore: null,
    wasCorrect: null,
    calibratedProb: null,
  });
  // Keep last 500 predictions
  acc.predictions = acc.predictions.slice(-500);
  saveAccuracy(acc);
}

function checkPredictionResults() {
  const acc = loadAccuracy();
  const eventDates = getEventDateMap();
  const sb = loadJson('scoreboard.json');
  let updated = 0;

  for (const pred of acc.predictions) {
    if (pred.result !== null) continue; // Already checked

    // Find the game in scoreboard
    const eventId = pred.id;
    const event = (sb?.events || []).find(e => e.id === eventId);
    if (!event) continue;

    const comp = event.competitions?.[0];
    const status = comp?.status?.type?.name || '';
    if (status !== 'STATUS_FINAL') continue;

    const competitors = comp.competitors || [];
    const homeComp = competitors.find(c => c.homeAway === 'home');
    const awayComp = competitors.find(c => c.homeAway === 'away');
    if (!homeComp || !awayComp) continue;

    const homeScore = parseInt(homeComp.score || 0);
    const awayScore = parseInt(awayComp.score || 0);
    const homeWon = homeScore > awayScore;
    const predictedHomeWin = pred.homeWinProb > 0.5;

    pred.result = homeWon ? 'HOME_WIN' : 'AWAY_WIN';
    pred.actualHomeScore = homeScore;
    pred.actualAwayScore = awayScore;
    pred.wasCorrect = predictedHomeWin === homeWon;

    // Calibration: was the probability accurate?
    if (pred.homeWinProb != null) {
      const actualProb = homeWon ? 1 : 0;
      pred.calibratedProb = Math.abs(pred.homeWinProb - actualProb);
    }

    updated++;
  }

  // Update summary
  const checked = acc.predictions.filter(p => p.result !== null);
  const correct = checked.filter(p => p.wasCorrect);
  acc.summary = {
    total: checked.length,
    correct: correct.length,
    accuracy: checked.length > 0 ? parseFloat((correct.length / checked.length * 100).toFixed(1)) : 0,
    avgCalibration: checked.length > 0
      ? parseFloat((checked.reduce((s, p) => s + (p.calibratedProb || 0), 0) / checked.length).toFixed(3))
      : 0,
    lastUpdated: new Date().toISOString(),
  };

  saveAccuracy(acc);
  return { updated, summary: acc.summary };
}

// ═══════════════════════════════════════════════════════════════
// CLOSING LINE VALUE TRACKER
// Compares our prediction to market odds at open and close
// ═══════════════════════════════════════════════════════════════

const CLV_FILE = path.join(DATA, 'autonomous-state', 'clv-tracker.json');

function loadCLV() {
  try { return JSON.parse(fs.readFileSync(CLV_FILE, 'utf8')); }
  catch { return { entries: [], summary: { total: 0, beatClosing: 0, clvRate: 0 } };
  }
}

function saveCLV(data) {
  try {
    fs.mkdirSync(path.dirname(CLV_FILE), { recursive: true });
    fs.writeFileSync(CLV_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function logCLV(pred, gameOdds) {
  const clv = loadCLV();
  const oddsMap = getOddsMap();
  const gameData = oddsMap[pred.home?.name] || oddsMap[pred.away?.name] || null;

  if (!gameData?.bookmakers?.length) return;

  // Get consensus odds from first book
  const firstBook = gameData.bookmakers[0];
  const h2h = firstBook?.markets?.find(m => m.key === 'h2h');
  const homeLine = h2h?.outcomes?.find(o => o.name === gameData.home_team)?.price;
  const awayLine = h2h?.outcomes?.find(o => o.name === gameData.away_team)?.price;

  if (homeLine == null) return;

  // Convert market line to probability
  const marketProb = homeLine > 0 ? 100 / (homeLine + 100) : Math.abs(homeLine) / (Math.abs(homeLine) + 100);

  // Our edge: model probability - market probability
  const edge = pred.prediction?.homeWinProb - marketProb;

  clv.entries.push({
    id: pred.gameId,
    timestamp: new Date().toISOString(),
    ourProb: pred.prediction?.homeWinProb,
    marketProb: parseFloat(marketProb.toFixed(4)),
    edge: parseFloat(edge.toFixed(4)),
    confidence: pred.prediction?.confidence,
    homeTeam: pred.home?.name,
    awayTeam: pred.away?.name,
    homeLine,
    awayLine,
    result: null, // Filled when game resolves
  });

  clv.entries = clv.entries.slice(-500);
  saveCLV(clv);
}

function updateCLVResults() {
  const clv = loadCLV();
  const sb = loadJson('scoreboard.json');
  let updated = 0;

  for (const entry of clv.entries) {
    if (entry.result !== null) continue;

    const event = (sb?.events || []).find(e => e.id === entry.id);
    if (!event) continue;
    const comp = event.competitions?.[0];
    if (comp?.status?.type?.name !== 'STATUS_FINAL') continue;

    const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
    const homeWon = parseInt(homeComp?.score || 0) > parseInt(comp.competitors?.find(c => c.homeAway === 'away')?.score || 0);
    const predictedHomeWin = entry.ourProb > 0.5;

    entry.result = homeWon ? 'HOME_WIN' : 'AWAY_WIN';
    entry.wasCorrect = predictedHomeWin === homeWon;
    // Did we beat the market?
    entry.beatMarket = entry.wasCorrect && Math.abs(entry.edge) > 0.02;
    updated++;
  }

  const checked = clv.entries.filter(e => e.result !== null);
  clv.summary = {
    total: checked.length,
    beatClosing: checked.filter(e => e.beatMarket).length,
    clvRate: checked.length > 0 ? parseFloat((checked.filter(e => e.beatMarket).length / checked.length * 100).toFixed(1)) : 0,
    accuracy: checked.length > 0 ? parseFloat((checked.filter(e => e.wasCorrect).length / checked.length * 100).toFixed(1)) : 0,
    lastUpdated: new Date().toISOString(),
  };

  saveCLV(clv);
  return { updated, summary: clv.summary };
}

// ═══════════════════════════════════════════════════════════════
// TEAM DATA CACHE (loaded once per generation run)
// ═══════════════════════════════════════════════════════════════

let _teamMap = null;
let _standingsMap = null;
let _oddsMap = null;

function getTeamMap() {
  if (_teamMap) return _teamMap;
  _teamMap = {};
  const data = loadJson('teams.json');
  if (data?.sports?.[0]?.leagues?.[0]?.teams) {
    data.sports[0].leagues[0].teams.forEach(t => { if (t.team) _teamMap[t.team.id] = t.team; });
  }
  return _teamMap;
}

function getStandingsMap() {
  if (_standingsMap) return _standingsMap;
  _standingsMap = {};
  const standings = loadJson('standings.json');
  (standings?.children || []).forEach(c => {
    (c.standings?.entries || []).forEach(e => {
      const s = {};
      (e.stats || []).forEach(x => { s[x.name] = x.value; });
      _standingsMap[e.team.id] = {
        wins: s.wins || 0, losses: s.losses || 0,
        winPct: s.winPercent || 0.5,
        ppg: s.avgPointsFor || 110, oppg: s.avgPointsAgainst || 110,
        diff: s.differential || 0, pace: (s.avgPointsFor + s.avgPointsAgainst) / 2.2,
      };
    });
  });
  return _standingsMap;
}

function getOddsMap() {
  if (_oddsMap) return _oddsMap;
  _oddsMap = {};
  const odds = loadJson('live-odds.json');
  if (Array.isArray(odds)) {
    odds.forEach(g => {
      // Key by both team full names
      _oddsMap[g.home_team] = g;
      _oddsMap[g.away_team] = g;
    });
  }
  return _oddsMap;
}

// ═══════════════════════════════════════════════════════════════
// PLAYER GAMELOG PARSER
// ═══════════════════════════════════════════════════════════════

function parseGamelog(playerId) {
  const gamelog = loadJson(`player-gamelog-${playerId}.json`);
  if (!gamelog?.labels || !gamelog?.seasonTypes) return null;

  const labels = gamelog.labels;
  const regSeason = gamelog.seasonTypes.find(s =>
    (s.displayName || s.name || '').includes('Regular')
  );
  if (!regSeason) return null;

  const games = [];
  (regSeason.categories || []).forEach(cat => {
    (cat.events || []).forEach(ev => {
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
      stats._opponent = ev.opponent?.abbreviation || '';
      stats._isHome = ev.atVs === 'vs';
      stats._date = ev.gameDate || '';
      // Ensure MIN is parsed as a number
      if (stats.MIN === undefined) {
        const minIdx = labels.indexOf('MIN');
        if (minIdx >= 0) stats.MIN = parseFloat(ev.stats?.[minIdx]) || 0;
      }
      games.push(stats);
    });
  });

  return { labels, games };
}

// ═══════════════════════════════════════════════════════════════
// PLAYER PROFILE BUILDER (uses native C for stats)
// ═══════════════════════════════════════════════════════════════

function buildPlayerProfile(playerId) {
  const gamelog = parseGamelog(playerId);
  if (!gamelog?.games?.length || gamelog.games.length < 3) return null;

  const games = gamelog.games;
  const n = games.length;
  const last5 = games.slice(-5);
  const last10 = games.slice(-10);

  // Season averages using native stats
  const profile = {
    playerId,
    gamesPlayed: n,
    seasonAvg: {},
    last5Avg: {},
    last10Avg: {},
    consistency: {},
  };

  for (const stat of ['PTS', 'REB', 'AST', 'STL', 'BLK']) {
    const seasonVals = games.map(g => g[stat] || 0);
    const l5Vals = last5.map(g => g[stat] || 0);
    const l10Vals = last10.map(g => g[stat] || 0);

    const sStat = core.statistics(seasonVals);
    const sL5 = core.statistics(l5Vals);
    const sL10 = core.statistics(l10Vals);

    profile.seasonAvg[stat] = sStat.mean;
    profile.last5Avg[stat] = sL5.mean;
    profile.last10Avg[stat] = sL10.mean;
    profile.consistency[stat] = sStat.cv; // Coefficient of variation
  }

  // Home/away splits
  const homeGames = games.filter(g => g._isHome);
  const awayGames = games.filter(g => !g._isHome);
  profile.homeSplit = {};
  profile.awaySplit = {};
  for (const stat of ['PTS', 'REB', 'AST']) {
    const hVals = homeGames.map(g => g[stat] || 0);
    const aVals = awayGames.map(g => g[stat] || 0);
    profile.homeSplit[stat] = hVals.length ? core.statistics(hVals).mean : profile.seasonAvg[stat];
    profile.awaySplit[stat] = aVals.length ? core.statistics(aVals).mean : profile.seasonAvg[stat];
  }

  // Hit rates for common lines
  const allPTS = games.map(g => g.PTS || 0);
  profile.hitRates = {};
  for (const line of [15, 20, 25, 30]) {
    profile.hitRates[`over${line}pts`] = core.hitRate(allPTS, line).rate;
  }
  const allREB = games.map(g => g.REB || 0);
  for (const line of [5, 8, 10, 12]) {
    profile.hitRates[`over${line}reb`] = core.hitRate(allREB, line).rate;
  }
  const allAST = games.map(g => g.AST || 0);
  for (const line of [3, 5, 7, 10]) {
    profile.hitRates[`over${line}ast`] = core.hitRate(allAST, line).rate;
  }

  return profile;
}

// ═══════════════════════════════════════════════════════════════
// PROP PREDICTOR (one player, one stat, one game)
// ═══════════════════════════════════════════════════════════════

function predictProp(player, opponentDef, stat, gameContext) {
  const { isHome } = gameContext;

  const seasonAvg = player.seasonAvg[stat];
  const last5 = player.last5Avg[stat];
  const last10 = player.last10Avg[stat];
  const cv = player.consistency[stat] || 30;

  if (seasonAvg === 0 && last5 === 0) return null;

  // Project using native C weighted average (50% L5, 30% L10, 20% season)
  const projected = core.playerProjection(seasonAvg, last5, last10, 0.5, 0.3, 0.2);

  // Defensive adjustment (opponent OPPG vs league avg 110)
  const defFactor = 1 + ((opponentDef.oppg - 110) / 110) * 0.5;

  // Pace adjustment
  const paceFactor = 1 + ((opponentDef.pace - 100) / 100) * 0.3;

  // Home/away split adjustment
  const haDiff = (player.homeSplit[stat] || seasonAvg) - (player.awaySplit[stat] || seasonAvg);
  const haAdj = Math.max(-0.05, Math.min(0.05, haDiff / (seasonAvg || 1) * 0.3));
  const homeAdj = isHome ? (1 + haAdj) : (1 - haAdj);

  // Final projection
  const adjustedProjection = projected * defFactor * paceFactor * homeAdj;

  // Fair line (round to nearest 0.5)
  const fairLine = Math.round(adjustedProjection * 2) / 2;

  // Real sportsbook line from props fetcher (or fallback to estimated)
  let sportsbookLine = null;
  let lineSource = 'estimated';
  let sportsbookOverPrice = null;
  let sportsbookUnderPrice = null;
  let bestBook = null;

  // Try to find real sportsbook line from fetched props data
  if (propsFetcher) {
    try {
      const realLine = propsFetcher.findPlayerPropLine(player.playerName || '', stat);
      if (realLine && realLine.line != null) {
        sportsbookLine = realLine.line;
        sportsbookOverPrice = realLine.overPrice;
        sportsbookUnderPrice = realLine.underPrice;
        bestBook = realLine.bookmaker;
        lineSource = 'sportsbook';
      }
    } catch {}
  }

  // Fallback: estimate from season average if no real line found
  if (sportsbookLine == null) {
    sportsbookLine = Math.round(seasonAvg * 2) / 2;
    lineSource = 'estimated_from_season_avg';
  }

  // Edge: difference between our projection and the sportsbook line
  const edge = fairLine - sportsbookLine;
  const absEdge = Math.abs(edge);

  // REAL hit rate from actual gamelog data
  const statValues = parseGamelog(player.playerId)?.games.map(g => g[stat] || 0) || [];
  const hitRateAtFairLine = core.hitRate(statValues, fairLine);
  const hitRateAtSportsbook = core.hitRate(statValues, sportsbookLine);

  // Kelly Criterion: only calculate when we have real odds
  let kellyPct = null;
  if (lineSource === 'sportsbook' && sportsbookOverPrice && absEdge >= 1) {
    try {
      const overDecimal = sportsbookOverPrice > 0
        ? 1 + sportsbookOverPrice / 100
        : 1 + 100 / Math.abs(sportsbookOverPrice);
      const overProb = hitRateAtFairLine.rate;
      if (overProb > 0 && overDecimal > 1) {
        const kelly = core.kellyCriterion(overProb, overDecimal, 0.25);
        kellyPct = kelly.recommendedPct;
      }
    } catch {}
  }

  // Confidence: based on consistency, sample size, and whether we have real lines
  let confidence = 'LOW';
  const hasRealLine = lineSource === 'sportsbook';
  if (absEdge >= 3 && cv < 25 && player.gamesPlayed >= 20 && hasRealLine) confidence = 'HIGH';
  else if (absEdge >= 2 && cv < 35 && hasRealLine) confidence = 'MEDIUM';
  else if (absEdge >= 3 && cv < 25 && player.gamesPlayed >= 20) confidence = 'MEDIUM';
  else if (absEdge >= 2 && cv < 35) confidence = 'LOW';

  // Value rating: honest assessment
  let valueRating = 'AVOID';
  if (absEdge >= 3 && confidence === 'HIGH') valueRating = 'STRONG';
  else if (absEdge >= 2 && confidence !== 'LOW') valueRating = 'GOOD';
  else if (absEdge >= 1.5) valueRating = 'FAIR';
  else if (absEdge >= 1) valueRating = 'MARGINAL';

  // Recommendation
  let recommendation = 'PASS';
  if (edge > 0.5 && valueRating !== 'AVOID') recommendation = 'OVER';
  else if (edge < -0.5 && valueRating !== 'AVOID') recommendation = 'UNDER';

  return {
    playerId: player.playerId,
    playerName: '', // Filled in by caller
    stat,
    seasonAvg: seasonAvg,
    last5Avg: last5,
    last10Avg: last10,
    projectedValue: parseFloat(adjustedProjection.toFixed(1)),
    fairLine,
    sportsbookLine,
    lineSource,
    sportsbookOverPrice,
    sportsbookUnderPrice,
    bestBook,
    edge: parseFloat(edge.toFixed(1)),
    recommendation,
    confidence,
    valueRating,
    propScore: parseFloat(Math.min(100, Math.max(0, absEdge * 15 + (25 - cv * 0.4) + player.gamesPlayed * 0.5)).toFixed(1)),
    kellyPct,
    hitRateAtFairLine: parseFloat(hitRateAtFairLine.rate.toFixed(4)),
    hitRateAtSportsbook: parseFloat(hitRateAtSportsbook.rate.toFixed(4)),
    hitRate: parseFloat(hitRateAtSportsbook.rate.toFixed(4)), // DB compat
    realHitRate: lineSource === 'sportsbook',
    consistencyCV: cv,
    gamesPlayed: player.gamesPlayed,
    defenseRating: opponentDef.oppg < 105 ? 'elite' : opponentDef.oppg < 108 ? 'good' : opponentDef.oppg < 112 ? 'average' : 'poor',
    paceFactor: parseFloat(paceFactor.toFixed(3)),
    factors: {
      defAdj: `${((defFactor - 1) * 100).toFixed(1)}%`,
      paceAdj: `${((paceFactor - 1) * 100).toFixed(1)}%`,
      homeAdj: isHome ? 'Home' : 'Away',
      consistency: `${cv.toFixed(1)}% CV`,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// MAIN: Generate predictions for one game
// ═══════════════════════════════════════════════════════════════

function generateGamePrediction(awayTeamId, homeTeamId, eventId) {
  const teamMap = getTeamMap();
  const standingsMap = getStandingsMap();
  const oddsMap = getOddsMap();
  const eventDates = getEventDateMap();

  const awayTeam = teamMap[awayTeamId];
  const homeTeam = teamMap[homeTeamId];
  if (!awayTeam || !homeTeam) return null;

  const awayStanding = standingsMap[awayTeamId] || { ppg: 110, oppg: 110, pace: 100, winPct: 0.5 };
  const homeStanding = standingsMap[homeTeamId] || { ppg: 110, oppg: 110, pace: 100, winPct: 0.5 };

  // 1a. Win probability — ML model (trained) or native C fallback
  let winProb;
  if (mlModel) {
    try {
      const mlPred = mlModel.predictGame(homeTeamId, awayTeamId);
      if (mlPred) {
        winProb = {
          homeProb: mlPred.homeProb,
          awayProb: mlPred.awayProb,
          predictedMargin: mlPred.predictedMargin,
        };
      }
    } catch {}
  }
  if (!winProb) {
    // Fallback: native C sigmoid
    const homeRating = homeStanding.ppg * homeStanding.winPct;
    const awayRating = awayStanding.ppg * awayStanding.winPct;
    winProb = core.winProbability(homeRating, awayRating, 3.5);
  }

  // 1b. Rest days / back-to-back adjustment
  let restAdj = { homeAdj: 0, awayAdj: 0, netAdvantage: 0 };
  try {
    const gameDate = eventDates[eventId] || null;
    if (gameDate) {
      const homeRest = getTeamRestDays(homeTeamId, gameDate);
      const awayRest = getTeamRestDays(awayTeamId, gameDate);
      restAdj = calculateRestAdjustment(homeRest, awayRest);
      // Apply rest to win probability (~0.5% per point of rest advantage)
      const restProbShift = restAdj.netAdvantage * 0.005;
      winProb = {
        homeProb: Math.max(0.05, Math.min(0.95, winProb.homeProb + restProbShift)),
        awayProb: Math.max(0.05, Math.min(0.95, winProb.awayProb - restProbShift)),
        predictedMargin: winProb.predictedMargin + restAdj.netAdvantage * 0.3,
      };
    }
  } catch (e) {}

  // 1c. Recent form momentum
  let homeForm = null, awayForm = null;
  try {
    homeForm = getRecentForm(homeTeamId);
    awayForm = getRecentForm(awayTeamId);
    // Blend recent form into ratings (30% form, 70% season)
    if (homeForm.ppg && homeForm.ppg !== team.ppg) {
      homeStanding.ppg = homeStanding.ppg * 0.7 + homeForm.ppg * 0.3;
      homeStanding.oppg = homeStanding.oppg * 0.7 + homeForm.oppg * 0.3;
    }
    if (awayForm.ppg && awayForm.ppg !== team?.ppg) {
      awayStanding.ppg = awayStanding.ppg * 0.7 + awayForm.ppg * 0.3;
      awayStanding.oppg = awayStanding.oppg * 0.7 + awayForm.oppg * 0.3;
    }
  } catch (e) {}

  // 1d. Matchup-specific scoring
  let homeMatchup = null, awayMatchup = null;
  try {
    homeMatchup = calculateMatchupScore(homeTeamId, awayTeamId);
    awayMatchup = calculateMatchupScore(awayTeamId, homeTeamId);
  } catch (e) {}

  // 1b. Injury impact adjustment
  let injuryAdj = null;
  try {
    const homeInjuries = getInjuryImpact(homeTeamId, homeTeam.abbreviation);
    const awayInjuries = getInjuryImpact(awayTeamId, awayTeam.abbreviation);
    injuryAdj = calculateInjuryAdjustment(homeInjuries, awayInjuries);
    winProb = {
      homeProb: Math.max(0.05, Math.min(0.95, winProb.homeProb + injuryAdj.probAdjustment)),
      awayProb: Math.max(0.05, Math.min(0.95, winProb.awayProb - injuryAdj.probAdjustment)),
      predictedMargin: winProb.predictedMargin + injuryAdj.netImpact * 0.4,
    };
  } catch (e) {}

  // 1c. News signal impact
  let newsAdjustments = {};
  try {
    const newsData = loadJson('news.json');
    if (newsData?.articles) {
      const OUT_KW = /\b(out|ruled out|done for|season.?ending|surgery|torn|fracture|broken)\b/i;
      const REST_KW = /\b(rest|resting|load management|sits? out|scratch)\b/i;
      const QUESTIONABLE_KW = /\b(questionable|doubtful|game.?time|gt|DTD|day.?to.?day)\b/i;
      const BOOST_KW = /\b(returns?|back|healthy|cleared|active|playing)\b/i;

      for (const article of newsData.articles) {
        const text = `${article.title || ''} ${article.description || ''}`;
        const articleTeams = article.teams || [];
        const articlePlayers = article.players || [];

        // Only process articles mentioning teams in this game
        const relevantTeam = articleTeams.find(t =>
          t === awayTeam.abbreviation || t === homeTeam.abbreviation
        );
        if (!relevantTeam) continue;

        const isHome = relevantTeam === homeTeam.abbreviation;

        if (OUT_KW.test(text)) {
          // Team has a player out — reduce their effective PPG
          newsAdjustments[relevantTeam] = (newsAdjustments[relevantTeam] || 0) - 2;
        } else if (REST_KW.test(text)) {
          newsAdjustments[relevantTeam] = (newsAdjustments[relevantTeam] || 0) - 1;
        } else if (BOOST_KW.test(text)) {
          newsAdjustments[relevantTeam] = (newsAdjustments[relevantTeam] || 0) + 1;
        }
      }
    }
  } catch (e) {}

  // Apply news adjustments to standings
  if (newsAdjustments[awayTeam.abbreviation]) {
    awayStanding.ppg += newsAdjustments[awayTeam.abbreviation];
  }
  if (newsAdjustments[homeTeam.abbreviation]) {
    homeStanding.ppg += newsAdjustments[homeTeam.abbreviation];
  }

  // 2. Sharp money detection
  let sharpSignal = { isSharp: false, signal: 'NONE', sharpScore: 0, mlGap: 0, spreadGap: 0, totalGap: 0 };
  const gameOdds = oddsMap[homeTeam.displayName] || oddsMap[awayTeam.displayName] || null;
  if (gameOdds?.bookmakers?.length >= 2) {
    const bookOdds = gameOdds.bookmakers.map(b => ({
      homeML: b.markets?.find(m => m.key === 'h2h')?.outcomes?.find(o => o.name === gameOdds.home_team)?.price,
      awayML: b.markets?.find(m => m.key === 'h2h')?.outcomes?.find(o => o.name === gameOdds.away_team)?.price,
      homeSpread: b.markets?.find(m => m.key === 'spreads')?.outcomes?.find(o => o.name === gameOdds.home_team)?.point,
      total: b.markets?.find(m => m.key === 'totals')?.outcomes?.find(o => o.name === 'Over')?.point,
    }));
    sharpSignal = core.detectSharpMoney(bookOdds);
  }

  // 3. Build injury maps for both teams (before iterating rosters)
  const homeInjuryMap = buildInjuryMap(homeTeamId);
  const awayInjuryMap = buildInjuryMap(awayTeamId);

  // 4. Project player props — ONLY for active, recently-playing players
  const STATS = ['PTS', 'REB', 'AST', 'STL', 'BLK'];
  const allProps = [];
  const skippedPlayers = [];

  for (const { teamId, teamAbbr, isHome, opponentDef, injuryMap } of [
    { teamId: awayTeamId, teamAbbr: awayTeam.abbreviation, isHome: false, opponentDef: homeStanding, injuryMap: awayInjuryMap },
    { teamId: homeTeamId, teamAbbr: homeTeam.abbreviation, isHome: true, opponentDef: awayStanding, injuryMap: homeInjuryMap },
  ]) {
    const roster = loadJson(`roster-${teamId}.json`);
    if (!roster?.athletes) continue;

    for (const athlete of roster.athletes) {
      const playerName = athlete.displayName || `${athlete.firstName} ${athlete.lastName}`;
      const athleteId = String(athlete.id);

      // ── FILTER 1: Injury status check ──
      const injuryStatus = injuryMap[athleteId];
      if (injuryStatus) {
        const statusLower = (injuryStatus.status || '').toLowerCase();
        // OUT / SUSPENDED / SEASON-ENDING = skip entirely
        if (statusLower.includes('out') || statusLower.includes('suspended') ||
            statusLower.includes('season') || statusLower.includes('surgery')) {
          skippedPlayers.push({ name: playerName, reason: `OUT: ${injuryStatus.status}`, team: teamAbbr });
          continue;
        }
      }

      // ── FILTER 2: Recency check — skip players who haven't played recently ──
      const lastGameDate = getLastGameDate(athleteId);
      if (lastGameDate) {
        const daysSince = (Date.now() - new Date(lastGameDate).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > 21) {
          skippedPlayers.push({ name: playerName, reason: `Last game ${Math.round(daysSince)}d ago`, team: teamAbbr });
          continue;
        }
      }

      // ── FILTER 3: Minimum games played ──
      const profile = buildPlayerProfile(athleteId);
      if (!profile || profile.gamesPlayed < 5) {
        skippedPlayers.push({ name: playerName, reason: `Only ${profile?.gamesPlayed || 0} games`, team: teamAbbr });
        continue;
      }

      // ── FILTER 4: Check if player actually plays significant minutes ──
      // Get average minutes from gamelog
      const gamelog = parseGamelog(athleteId);
      let avgMinutes = 0;
      if (gamelog?.games?.length) {
        const minVals = gamelog.games.map(g => g.MIN || 0).filter(v => v > 0);
        avgMinutes = minVals.length ? minVals.reduce((s, v) => s + v, 0) / minVals.length : 0;
      }
      // Skip players who average < 10 minutes (benchwarmers, two-way players)
      if (avgMinutes < 10) {
        skippedPlayers.push({ name: playerName, reason: `${avgMinutes.toFixed(0)} MPG (too low)`, team: teamAbbr });
        continue;
      }

      // ── FILTER 5: Questionable/Doubtful = reduce projection ──
      let minuteMultiplier = 1.0;
      if (injuryStatus) {
        const s = (injuryStatus.status || '').toLowerCase();
        if (s.includes('doubtful')) minuteMultiplier = 0.3; // 70% reduction
        else if (s.includes('questionable') || s.includes('probable')) minuteMultiplier = 0.7; // 30% reduction
        else if (s.includes('day-to-day') || s.includes('gte')) minuteMultiplier = 0.85; // 15% reduction
      }

      // ── Generate props ──
      for (const stat of STATS) {
        const prediction = predictProp(profile, opponentDef, stat, { isHome });
        if (!prediction || prediction.recommendation === 'PASS') continue;

        // Apply minute/injury multiplier to projection
        if (minuteMultiplier < 1.0) {
          prediction.projectedValue = parseFloat((prediction.projectedValue * minuteMultiplier).toFixed(1));
          prediction.fairLine = Math.round(prediction.projectedValue * 2) / 2;
          prediction.edge = parseFloat((prediction.projectedValue - prediction.sportsbookLine).toFixed(1));
          // Recalculate confidence after adjustment
          const adjAbsEdge = Math.abs(prediction.edge);
          if (adjAbsEdge < 1) prediction.confidence = 'LOW';
          else if (adjAbsEdge < 2) prediction.confidence = prediction.confidence === 'HIGH' ? 'MEDIUM' : prediction.confidence;
          // Recalculate score
          prediction.propScore = parseFloat(Math.min(100, Math.max(0, adjAbsEdge * 15 + (25 - prediction.consistencyCV * 0.4) + prediction.gamesPlayed * 0.5)).toFixed(1));
          // Downgrade value rating
          if (prediction.valueRating === 'STRONG') prediction.valueRating = 'GOOD';
          if (prediction.valueRating === 'GOOD' && adjAbsEdge < 2) prediction.valueRating = 'FAIR';
        }

        prediction.playerName = playerName;
        prediction.teamAbbr = teamAbbr;
        prediction.opponentAbbr = isHome ? awayTeam.abbreviation : homeTeam.abbreviation;
        prediction.isHome = isHome;
        prediction.avgMinutes = parseFloat(avgMinutes.toFixed(1));
        prediction.injuryStatus = injuryStatus ? injuryStatus.status : null;
        prediction.injuryAdjusted = minuteMultiplier < 1.0;
        allProps.push(prediction);
      }
    }
  }

  // Sort by score (best props first)
  allProps.sort((a, b) => b.propScore - a.propScore);

  // 5. Determine overall confidence
  const topProps = allProps.filter(p => p.confidence !== 'LOW');
  const confidence = topProps.length >= 5 ? 'HIGH' : topProps.length >= 2 ? 'MEDIUM' : 'LOW';

  // 6. Predict scores (with ALL adjustments)
  const totalPace = (awayStanding.pace + homeStanding.pace) / 2;
  const homeScoreAdj = (injuryAdj ? injuryAdj.homeScoreAdj : 0) + restAdj.homeAdj + (homeMatchup?.score || 0);
  const awayScoreAdj = (injuryAdj ? injuryAdj.awayScoreAdj : 0) + restAdj.awayAdj + (awayMatchup?.score || 0);
  const homeScorePred = homeStanding.ppg * (1 + (awayStanding.oppg - 110) / 200) * (totalPace / 100) + homeScoreAdj - awayScoreAdj;
  const awayScorePred = awayStanding.ppg * (1 + (homeStanding.oppg - 110) / 200) * (totalPace / 100) + awayScoreAdj - homeScoreAdj;

  const result = {
    gameId: eventId || `${awayTeamId}-${homeTeamId}`,
    awayTeamId,
    homeTeamId,
    away: { id: awayTeamId, abbr: awayTeam.abbreviation, name: awayTeam.displayName },
    home: { id: homeTeamId, abbr: homeTeam.abbreviation, name: homeTeam.displayName },
    prediction: {
      homeWinProb: winProb.homeProb,
      predictedMargin: winProb.predictedMargin,
      homeScorePred: parseFloat(homeScorePred.toFixed(1)),
      awayScorePred: parseFloat(awayScorePred.toFixed(1)),
      sharpSignal: sharpSignal.signal,
      sharpScore: sharpSignal.sharpScore,
      confidence,
      injuryAdjustment: injuryAdj ? {
        netImpact: injuryAdj.netImpact,
        probShift: injuryAdj.probAdjustment,
        homeOut: injuryAdj.homeInjuries.criticalCount,
        awayOut: injuryAdj.awayInjuries.criticalCount,
        homeKeyOut: injuryAdj.homeInjuries.keyPlayersOut.map(p => p.player),
        awayKeyOut: injuryAdj.awayInjuries.keyPlayersOut.map(p => p.player),
      } : null,
      newsAdjustments: Object.keys(newsAdjustments).length > 0 ? newsAdjustments : null,
      restAdvantage: restAdj.netAdvantage !== 0 ? {
        net: restAdj.netAdvantage,
        homeB2B: restAdj.homeB2B,
        awayB2B: restAdj.awayB2B,
        homeRestDays: restAdj.homeRestDays,
        awayRestDays: restAdj.awayRestDays,
      } : null,
      recentForm: homeForm && awayForm ? {
        home: { form: homeForm.form, ppg: homeForm.ppg, oppg: homeForm.oppg, momentum: homeForm.momentum },
        away: { form: awayForm.form, ppg: awayForm.ppg, oppg: awayForm.oppg, momentum: awayForm.momentum },
      } : null,
      matchupScore: homeMatchup && awayMatchup ? {
        homeEdge: homeMatchup.score,
        awayEdge: awayMatchup.score,
        factors: { home: homeMatchup.factors, away: awayMatchup.factors },
      } : null,
    },
    props: allProps,
    topPicks: allProps.filter(p => p.valueRating === 'STRONG' || p.valueRating === 'GOOD').slice(0, 10),
    totalProps: allProps.length,
    strongPlays: allProps.filter(p => p.valueRating === 'STRONG').length,
    skippedPlayers,
  };

  // Log prediction for accuracy tracking
  try { logPrediction(result); } catch {}
  try { logCLV(result); } catch {}

  return result;
}

// ═══════════════════════════════════════════════════════════════
// BATCH: Generate predictions for ALL scheduled games
// ═══════════════════════════════════════════════════════════════

function generateAllPredictions() {
  console.log('[prediction-engine] Starting full prediction generation...');
  const start = Date.now();

  const teamMap = getTeamMap();
  const games = [];
  const seen = new Set();

  // Collect games from scoreboard
  const scoreboard = loadJson('scoreboard.json');
  (scoreboard?.events || []).forEach(ev => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    if (home?.team?.id && away?.team?.id) {
      const key = `${away.team.id}-${home.team.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        games.push({ awayId: away.team.id, homeId: home.team.id, eventId: ev.id });
      }
    }
  });

  // Collect from team schedules (upcoming 5 games per team)
  for (let t = 1; t <= 30; t++) {
    const sch = loadJson(`schedule-${t}.json`);
    if (!sch?.events) continue;
    sch.events.slice(0, 5).forEach(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.away_team || c.homeAway === 'away');
      if (home?.team?.id && away?.team?.id) {
        const key = `${away.team.id}-${home.team.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          games.push({ awayId: away.team.id, homeId: home.team.id, eventId: ev.id });
        }
      }
    });
  }

  console.log(`[prediction-engine] Processing ${games.length} games...`);

  let totalProps = 0;
  let totalStrong = 0;
  const results = [];

  for (const game of games) {
    try {
      const prediction = generateGamePrediction(game.awayId, game.homeId, game.eventId);
      if (!prediction) continue;

      // Save to DB
      db.saveMatchPrediction({
        gameId: prediction.gameId,
        awayTeamId: game.awayId,
        homeTeamId: game.homeId,
        homeWinProb: prediction.prediction.homeWinProb,
        predictedMargin: prediction.prediction.predictedMargin,
        homeScorePred: prediction.prediction.homeScorePred,
        awayScorePred: prediction.prediction.awayScorePred,
        sharpSignal: prediction.prediction.sharpSignal,
        sharpScore: prediction.prediction.sharpScore,
        confidence: prediction.prediction.confidence,
      });

      // Save props to DB
      if (prediction.props.length > 0) {
        db.saveMatchPlayerProps(prediction.gameId, prediction.props);
      }

      // Save sharp signal if detected
      if (prediction.prediction.sharpScore > 0) {
        db.saveSharpSignal({
          gameId: prediction.gameId,
          signalType: prediction.prediction.sharpSignal,
          signalStrength: prediction.prediction.sharpScore,
        });
      }

      totalProps += prediction.totalProps;
      totalStrong += prediction.strongPlays;
      results.push(prediction);
    } catch (err) {
      console.error(`[prediction-engine] Error for ${game.awayId}@${game.homeId}:`, err.message);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[prediction-engine] Done in ${elapsed}s: ${results.length} games, ${totalProps} props, ${totalStrong} strong plays`);

  // Record generation time
  db.setMeta('last_prediction_run', new Date().toISOString());
  db.setMeta('prediction_stats', JSON.stringify({
    games: results.length,
    totalProps,
    strongPlays: totalStrong,
    elapsed: `${elapsed}s`,
  }));

  // Check accuracy of previous predictions
  let accuracy = null;
  let clv = null;
  try { accuracy = checkPredictionResults(); } catch {}
  try { clv = updateCLVResults(); } catch {}

  // Reset caches
  _teamMap = null;
  _standingsMap = null;
  _oddsMap = null;
  _eventDateCache = null;

  return {
    generated: new Date().toISOString(),
    nativeMode: core.isNative,
    games: results.length,
    totalProps,
    strongPlays: totalStrong,
    accuracy: accuracy?.summary || null,
    clv: clv?.summary || null,
    results,
  };
}

// ═══════════════════════════════════════════════════════════════
// GET: Retrieve predictions from DB (fast, no recomputation)
// ═══════════════════════════════════════════════════════════════

function getGameWithPredictions(gameId) {
  return db.getPropsForGameWithPrediction(gameId);
}

function getTopPropPicks(limit = 30, stat = null) {
  return db.getTopProps(limit, stat);
}

function getPlayerPropsAcrossGames(playerId) {
  return db.getMatchPlayerPropsByPlayer(playerId);
}

module.exports = {
  generateGamePrediction,
  generateAllPredictions,
  getGameWithPredictions,
  getTopPropPicks,
  getPlayerPropsAcrossGames,
  buildPlayerProfile,
  predictProp,
  checkPredictionResults,
  updateCLVResults,
  loadAccuracy,
  loadCLV,
  getTeamRestDays,
  calculateRestAdjustment,
  getRecentForm,
  calculateMatchupScore,
};
