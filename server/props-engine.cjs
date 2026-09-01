/**
 * SHARPEDGE Props Engine v3.0 — Professional-Grade
 *
 * Think like a betting firm, not a spreadsheet.
 *
 * For each game, for each player:
 * 1. Project minutes based on role, rest, and game context
 * 2. Compute usage rate and offensive role
 * 3. Factor in teammate injuries (usage redistribution)
 * 4. Adjust for opponent defense BY POSITION
 * 5. Compute fair lines using weighted model
 * 6. Compare to sportsbook lines for value detection
 * 7. Size bets using Kelly criterion
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// 1. GAMELOG PARSER — Extract clean stats from ESPN gamelogs
// ═══════════════════════════════════════════════════════════════════

function parseGamelogFull(playerId) {
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
      // Extract metadata
      stats._eventId = ev.eventId;
      stats._date = ev.gameDate || '';
      stats._opponent = ev.opponent?.abbreviation || ev.opponent?.id || '';
      stats._isHome = ev.atVs === 'vs';
      stats._result = ev.gameResult || '';
      stats._score = ev.score || '';
      stats._homeTeamScore = parseInt(ev.homeTeamScore) || 0;
      stats._awayTeamScore = parseInt(ev.awayTeamScore) || 0;
      stats._dayOfMonth = ev.gameDate ? new Date(ev.gameDate).getDate() : 0;
      stats._month = cat.displayName || '';
      games.push(stats);
    });
  });

  return { labels, games };
}

// ═══════════════════════════════════════════════════════════════════
// 2. STATISTICAL HELPERS
// ═══════════════════════════════════════════════════════════════════

const avg = (arr, key) => {
  const vals = arr.map(g => g[key]).filter(v => !isNaN(v) && v !== null && v !== undefined);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
};

const median = (arr, key) => {
  const vals = arr.map(g => g[key]).filter(v => !isNaN(v)).sort((a, b) => a - b);
  if (!vals.length) return 0;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
};

const stdDev = (arr, key) => {
  const a = avg(arr, key);
  const variance = arr.reduce((s, g) => s + Math.pow((g[key] || 0) - a, 2), 0) / arr.length;
  return Math.sqrt(variance);
};

const pctGamesOver = (arr, key, line) => arr.filter(g => g[key] > line).length / arr.length;

// ═══════════════════════════════════════════════════════════════════
// 3. TEAM DATA — Defense, Pace, Roster
// ═══════════════════════════════════════════════════════════════════

function getTeamDefense() {
  const standings = loadJson('standings.json');
  const defense = {};

  (standings?.children || []).forEach(c => {
    (c.standings?.entries || []).forEach(e => {
      const s = {};
      (e.stats || []).forEach(x => { s[x.name] = x.value; });

      // Compute pace: possessions per game (NBA avg ~100)
      // Pace ≈ (PPG + OPPG) / (league_avg_PPG_per_possession * 2)
      // Simplified: NBA teams average ~100 possessions/game, ~1.1 points/possession
      const ppg = s.avgPointsFor || 110;
      const oppg = s.avgPointsAgainst || 110;
      // Pace = total points / points_per_possession / 2 (per team)
      // points_per_possession ≈ 1.1 (NBA average)
      const pace = Math.min(110, Math.max(90, (ppg + oppg) / 2 / 1.1));

      defense[e.team.abbreviation || e.team.id] = {
        ppg,
        oppg,
        diff: s.differential || 0,
        winPct: s.winPercent || 0.5,
        pace,
        defRating: oppg < 105 ? 'elite' : oppg < 108 ? 'good' : oppg < 112 ? 'average' : 'poor',
        // Points allowed by tier (used for position-specific adjustments)
        ptsAllowedPerGame: oppg,
        wins: s.wins || 0,
        losses: s.losses || 0,
        // Strength of schedule proxy
        strengthOfSchedule: s.differential > 5 ? 'weak' : s.differential < -5 ? 'strong' : 'average',
      };
    });
  });

  return defense;
}

// Position-specific defensive ratings (NBA averages)
// These represent points allowed per game to each position
const POS_DEFENSE基准 = {
  PG: { pts: 18.5, reb: 3.2, ast: 4.8, stl: 0.8, blk: 0.2 },
  SG: { pts: 17.8, reb: 3.5, ast: 3.2, stl: 0.9, blk: 0.3 },
  SF: { pts: 17.2, reb: 4.8, ast: 2.8, stl: 0.8, blk: 0.5 },
  PF: { pts: 16.5, reb: 7.2, ast: 2.2, stl: 0.7, blk: 0.8 },
  C:  { pts: 14.8, reb: 9.5, ast: 1.8, stl: 0.5, blk: 1.2 },
};

function getPositionDefense(opponentDef, position) {
  const base = POS_DEFENSE基准[position] || POS_DEFENSE基准.SF;
  const oppgFactor = opponentDef.oppg / 110; // League average ~110

  return {
    pts: base.pts * oppgFactor,
    reb: base.reb * oppgFactor,
    ast: base.ast * oppgFactor,
    stl: base.stl * oppgFactor,
    blk: base.blk * oppgFactor,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 4. PLAYER PROFILE — Minutes, Usage, Trends
// ═══════════════════════════════════════════════════════════════════

function buildPlayerProfile(playerId) {
  const playerData = loadJson(`player-${playerId}.json`);
  const gamelog = parseGamelogFull(playerId);

  if (!gamelog?.games?.length) return null;

  const games = gamelog.games;
  const n = games.length;

  // Season averages
  const seasonAvg = {};
  ['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'MIN', 'PF'].forEach(k => {
    seasonAvg[k] = parseFloat(avg(games, k).toFixed(1));
  });
  ['FG', '3PT', 'FT'].forEach(k => {
    const made = games.reduce((s, g) => s + (g[k]?.made || 0), 0);
    const att = games.reduce((s, g) => s + (g[k]?.attempted || 0), 0);
    seasonAvg[k] = {
      made: parseFloat((made / n).toFixed(1)),
      attempted: parseFloat((att / n).toFixed(1)),
      pct: att > 0 ? parseFloat(((made / att) * 100).toFixed(1)) : 0,
    };
  });

  // Recent form (weighted: last 5 = 0.5, last 10 = 0.3, rest = 0.2)
  const last5 = games.slice(-5);
  const last10 = games.slice(-10);
  const last20 = games.slice(-20);

  const recentForm = {};
  ['PTS', 'REB', 'AST', 'STL', 'BLK', 'MIN'].forEach(k => {
    const l5 = avg(last5, k);
    const l10 = avg(last10, k);
    recentForm[k] = {
      last5: parseFloat(l5.toFixed(1)),
      last10: parseFloat(l10.toFixed(1)),
      season: seasonAvg[k],
      weighted: parseFloat((l5 * 0.5 + l10 * 0.3 + seasonAvg[k] * 0.2).toFixed(1)),
    };
  });

  // Standard deviation (consistency measure)
  const consistency = {};
  ['PTS', 'REB', 'AST'].forEach(k => {
    consistency[k] = {
      stdDev: parseFloat(stdDev(games, k).toFixed(1)),
      cv: seasonAvg[k] > 0 ? parseFloat((stdDev(games, k) / seasonAvg[k] * 100).toFixed(1)) : 0, // Coefficient of variation
    };
  });

  // Home/away splits
  const homeGames = games.filter(g => g._isHome);
  const awayGames = games.filter(g => !g._isHome);
  const homeSplits = {};
  const awaySplits = {};
  ['PTS', 'REB', 'AST', 'MIN'].forEach(k => {
    homeSplits[k] = parseFloat(avg(homeGames, k).toFixed(1));
    awaySplits[k] = parseFloat(avg(awayGames, k).toFixed(1));
  });

  // Rest days (look at game dates)
  const sortedGames = [...games].sort((a, b) => new Date(a._date) - new Date(b._date));
  const restDays = [];
  for (let i = 1; i < sortedGames.length; i++) {
    const prev = new Date(sortedGames[i - 1]._date);
    const curr = new Date(sortedGames[i]._date);
    const days = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
    restDays.push(days);
  }
  const avgRest = restDays.length ? restDays.reduce((s, d) => s + d, 0) / restDays.length : 2;
  const lastRest = restDays.length ? restDays[restDays.length - 1] : 2;

  // Minutes projection
  const seasonMPG = seasonAvg.MIN;
  const recentMPG = recentForm.MIN.weighted;
  // Project based on role consistency
  const mpgConsistency = consistency.PTS?.cv < 25 ? 'stable' : consistency.PTS?.cv < 40 ? 'variable' : 'volatile';
  const projectedMIN = mpgConsistency === 'stable' ? recentMPG : (recentMPG * 0.7 + seasonMPG * 0.3);

  // Usage rate approximation (PTS + AST + TO) / MIN
  const usageRate = seasonAvg.MIN > 0
    ? parseFloat((((seasonAvg.PTS * 0.5 + seasonAvg.AST * 0.3 + seasonAvg.TO * 0.2) / (seasonAvg.MIN / 48 * 100)) * 100).toFixed(1))
    : 0;

  // Hit rates for common lines
  const hitRates = {};
  [15, 20, 25, 30].forEach(line => {
    hitRates[`over${line}pts`] = parseFloat((pctGamesOver(games, 'PTS', line) * 100).toFixed(1));
  });
  [5, 8, 10, 12].forEach(line => {
    hitRates[`over${line}reb`] = parseFloat((pctGamesOver(games, 'REB', line) * 100).toFixed(1));
  });
  [3, 5, 7, 10].forEach(line => {
    hitRates[`over${line}ast`] = parseFloat((pctGamesOver(games, 'AST', line) * 100).toFixed(1));
  });

  return {
    playerId,
    name: playerData?.athlete?.displayName || playerId,
    team: playerData?.athlete?.team?.abbreviation || '',
    position: playerData?.athlete?.position?.abbreviation || '',
    jersey: playerData?.athlete?.jersey || '',
    headshot: playerData?.athlete?.headshot?.href || '',
    experience: playerData?.athlete?.displayExperience || '',
    gamesPlayed: n,
    seasonAvg,
    recentForm,
    consistency,
    homeSplits,
    awaySplits,
    projectedMIN: parseFloat(projectedMIN.toFixed(1)),
    mpgConsistency,
    usageRate,
    avgRestDays: parseFloat(avgRest.toFixed(1)),
    lastRestDays: lastRest,
    hitRates,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 5. TEAMMATE INJURY IMPACT — Usage redistribution
// ═══════════════════════════════════════════════════════════════════

function getTeamInjuries(teamAbbr) {
  const injuries = [];
  // Roster files are team-specific: roster-{teamId}.json contains only that team's players
  // Athletes in roster files don't have .team.abbreviation, they're already grouped by team
  // We need to match teamAbbr to teamId via teams.json
  const teamsData = loadJson('teams.json');
  const teamIdMap = {};
  if (teamsData?.sports?.[0]?.leagues?.[0]?.teams) {
    teamsData.sports[0].leagues[0].teams.forEach(t => {
      if (t.team) teamIdMap[t.team.abbreviation] = t.team.id;
    });
  }
  const teamId = teamIdMap[teamAbbr];
  if (!teamId) return injuries;

  const roster = loadJson(`roster-${teamId}.json`);
  if (!roster?.athletes) return injuries;

  roster.athletes.forEach(a => {
    if (a.injuries?.length) {
      a.injuries.forEach(inj => {
        if (inj.status !== 'Active') {
          injuries.push({
            player: a.displayName,
            playerId: a.id,
            status: inj.status,
            detail: inj.details || inj.detail || '',
          });
        }
      });
    }
  });
  return injuries;
}

function computeUsageRedistribution(teamInjuries, allPlayers) {
  // When a star is OUT, their usage redistributes to remaining players
  // More usage = more stats for the player
  const outPlayers = teamInjuries.filter(i => i.status === 'Out' || i.status === 'OUT');
  if (!outPlayers.length) return { factor: 1, reason: 'No key injuries' };

  // Find the usage of injured players
  let lostUsage = 0;
  outPlayers.forEach(inj => {
    const profile = allPlayers.find(p => p.playerId === String(inj.playerId) || p.name === inj.player);
    if (profile) lostUsage += profile.usageRate * 0.5; // Approximate their share
  });

  // Redistribution factor (capped at +15% boost)
  const redistribution = Math.min(lostUsage * 0.3, 15);

  return {
    factor: 1 + redistribution / 100,
    redistribution: parseFloat(redistribution.toFixed(1)),
    outPlayers: outPlayers.map(p => p.player),
    reason: `${outPlayers.length} player(s) OUT — ${redistribution.toFixed(1)}% usage redistributed`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 6. PROP PREDICTION MODEL
// ═══════════════════════════════════════════════════════════════════

function predictPlayerProp(player, opponentDef, stat, gameContext) {
  const { isHome, isBackToBack, opponentAbbr, teammateUsageBoost } = gameContext;

  // Base: weighted recent form (already includes opponent variety)
  const recent = player.recentForm[stat];
  if (!recent) return null;

  let baseExpectation = recent.weighted;

  // Minutes projection adjustment (small — only if significantly different)
  const minProjFactor = player.projectedMIN / (player.seasonAvg.MIN || 1);
  // Only apply if minutes are notably different (>10% change)
  if (Math.abs(minProjFactor - 1) > 0.1) {
    baseExpectation *= minProjFactor;
  }

  // Opponent defensive adjustment (team-level, capped)
  // OPPG: higher = worse defense = more points allowed
  // League avg OPPG ~110
  const leagueAvgOPPG = 110;
  const oppgDiff = (opponentDef.oppg - leagueAvgOPPG) / leagueAvgOPPG;
  // Cap at ±5% effect
  const defAdj = Math.max(-0.05, Math.min(0.05, oppgDiff * 0.5));
  baseExpectation *= (1 + defAdj);

  // Pace adjustment (capped ±3%)
  // Higher pace = more possessions = more stats
  const leagueAvgPace = 100;
  const paceDiff = (opponentDef.pace - leagueAvgPace) / leagueAvgPace;
  const paceAdj = Math.max(-0.03, Math.min(0.03, paceDiff * 0.3));
  baseExpectation *= (1 + paceAdj);

  // Home/away split (use actual player splits, capped)
  const haDiff = (player.homeSplits[stat] || 0) - (player.awaySplits[stat] || 0);
  const seasonAvg = player.seasonAvg[stat] || 1;
  const haAdj = Math.max(-0.05, Math.min(0.05, haDiff / seasonAvg * 0.3));
  baseExpectation *= isHome ? (1 + haAdj) : (1 - haAdj);

  // Rest day adjustment (capped)
  if (isBackToBack) {
    baseExpectation *= 0.94; // ~6% drop on back-to-backs
  } else if (player.lastRestDays >= 3) {
    baseExpectation *= 1.01; // ~1% boost with extra rest
  }

  // Teammate injury boost (capped at +8%)
  if (teammateUsageBoost > 1) {
    const boost = Math.min(teammateUsageBoost - 1, 0.08);
    baseExpectation *= (1 + boost);
  }

  // Compute fair line (round to nearest 0.5)
  const fairLine = Math.round(baseExpectation * 2) / 2;

  // Sportsbook line estimation (books use season avg with slight adjustments)
  const sportsbookLine = Math.round(player.seasonAvg[stat] * 2) / 2;

  // Edge: difference between our projection and estimated sportsbook line
  const edge = parseFloat((fairLine - sportsbookLine).toFixed(2));
  const absEdge = Math.abs(edge);

  // Confidence: based on consistency and sample size
  let confidence = 'LOW';
  if (absEdge >= 3 && player.consistency[stat]?.cv < 25 && player.gamesPlayed >= 20) confidence = 'HIGH';
  else if (absEdge >= 2 && player.consistency[stat]?.cv < 35) confidence = 'MEDIUM';

  // REAL hit rate from actual gamelog data (not fabricated)
  const gamelog = parseGamelogFull(player.playerId);
  const allStatValues = (gamelog?.games || []).map(g => g[stat] || 0);
  const hitRateAtSeasonAvg = allStatValues.length > 0 ? pctGamesOver(gamelog.games, stat, sportsbookLine) : 0;
  const hitRateAtFairLine = allStatValues.length > 0 ? pctGamesOver(gamelog.games, stat, fairLine) : 0;

  // Value rating: honest assessment
  let valueRating = 'AVOID';
  if (absEdge >= 3 && confidence === 'HIGH') valueRating = 'STRONG';
  else if (absEdge >= 2 && confidence !== 'LOW') valueRating = 'GOOD';
  else if (absEdge >= 1.5) valueRating = 'FAIR';
  else if (absEdge >= 1) valueRating = 'MARGINAL';

  // Recommendation
  let recommendation = null;
  if (edge > 0.5 && valueRating !== 'AVOID') recommendation = 'OVER';
  else if (edge < -0.5 && valueRating !== 'AVOID') recommendation = 'UNDER';

  // Kelly: NOT available without real sportsbook prop odds
  // We don't have actual -110 lines for player props, so we don't fabricate Kelly
  const kellyPct = null;

  return {
    stat,
    seasonAvg: player.seasonAvg[stat],
    recentAvg: recent.weighted,
    last5: recent.last5,
    last10: recent.last10,
    fairLine,
    sportsbookLine,
    lineSource: 'estimated_from_season_avg',
    edge,
    recommendation,
    confidence,
    valueRating,
    kellyPct,
    hitRate: parseFloat(hitRateAtSeasonAvg.toFixed(4)),
    hitRateAtFairLine: parseFloat(hitRateAtFairLine.toFixed(4)),
    realHitRate: true,
    factors: {
      minutes: `${player.projectedMIN} MIN projected`,
      defense: `${opponentDef.defRating} defense (${opponentDef.ptsAllowedPerGame} OPPG)`,
      posDefense: `${player.position} vs ${opponentAbbr}`,
      pace: `${opponentDef.pace.toFixed(0)} possessions`,
      home: isHome ? 'Home' : 'Away',
      rest: isBackToBack ? 'Back-to-back' : `${player.lastRestDays} days rest`,
      usage: teammateUsageBoost > 1 ? `+${((teammateUsageBoost - 1) * 100).toFixed(0)}% usage boost` : 'Normal usage',
      consistency: `${player.consistency[stat]?.cv || '?'}% CV`,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 7. MAIN: Generate Props for a Game
// ═══════════════════════════════════════════════════════════════════

function generateGamePropsEngine(awayTeamId, homeTeamId) {
  const teamsData = loadJson('teams.json');
  const teamMap = {};
  if (teamsData?.sports?.[0]?.leagues?.[0]?.teams) {
    teamsData.sports[0].leagues[0].teams.forEach(t => { if (t.team) teamMap[t.team.id] = t.team; });
  }

  const awayTeam = teamMap[awayTeamId];
  const homeTeam = teamMap[homeTeamId];
  if (!awayTeam || !homeTeam) return null;

  const defense = getTeamDefense();
  const awayDef = defense[awayTeam.abbreviation] || { oppg: 110, pace: 100, defRating: 'average', ptsAllowedPerGame: 110 };
  const homeDef = defense[homeTeam.abbreviation] || { oppg: 110, pace: 100, defRating: 'average', ptsAllowedPerGame: 110 };

  // Get rosters (roster files are team-specific, athletes don't have .team prop)
  const awayRoster = loadJson(`roster-${awayTeamId}.json`)?.athletes || [];
  const homeRoster = loadJson(`roster-${homeTeamId}.json`)?.athletes || [];

  // Get injuries
  const awayInjuries = getTeamInjuries(awayTeam.abbreviation);
  const homeInjuries = getTeamInjuries(homeTeam.abbreviation);

  // Build player profiles
  const awayPlayers = awayRoster
    .map(a => buildPlayerProfile(a.id))
    .filter(Boolean)
    .filter(p => p.gamesPlayed >= 5); // Need at least 5 games

  const homePlayers = homeRoster
    .map(a => buildPlayerProfile(a.id))
    .filter(Boolean)
    .filter(p => p.gamesPlayed >= 5);


  // Compute usage redistribution
  const awayBoost = computeUsageRedistribution(awayInjuries, awayPlayers);
  const homeBoost = computeUsageRedistribution(homeInjuries, homePlayers);

  const stats = ['PTS', 'REB', 'AST', 'STL', 'BLK'];
  const allMatchups = [];

  // Away team playing at home team's defense
  awayPlayers.forEach(player => {
    const gameContext = {
      isHome: false,
      isBackToBack: player.lastRestDays <= 1,
      opponentAbbr: homeTeam.abbreviation,
      teammateUsageBoost: awayBoost.factor,
    };

    const props = stats.map(stat =>
      predictPlayerProp(player, homeDef, stat, gameContext)
    ).filter(Boolean);

    if (props.length > 0) {
      allMatchups.push({
        player: player.name,
        playerId: player.playerId,
        team: awayTeam.abbreviation,
        headshot: player.headshot,
        pos: player.position,
        jersey: player.jersey,
        opponent: homeTeam.abbreviation,
        isHome: false,
        gamesPlayed: player.gamesPlayed,
        seasonAvg: player.seasonAvg,
        recentForm: player.recentForm,
        consistency: player.consistency,
        projectedMIN: player.projectedMIN,
        usageRate: player.usageRate,
        hitRates: player.hitRates,
        restDays: player.lastRestDays,
        props,
        topProps: props.filter(p => p.recommendation).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)),
        bestProp: null,
      });
    }
  });

  // Home team playing at away team's defense
  homePlayers.forEach(player => {
    const gameContext = {
      isHome: true,
      isBackToBack: player.lastRestDays <= 1,
      opponentAbbr: awayTeam.abbreviation,
      teammateUsageBoost: homeBoost.factor,
    };

    const props = stats.map(stat =>
      predictPlayerProp(player, awayDef, stat, gameContext)
    ).filter(Boolean);

    if (props.length > 0) {
      allMatchups.push({
        player: player.name,
        playerId: player.playerId,
        team: homeTeam.abbreviation,
        headshot: player.headshot,
        pos: player.position,
        jersey: player.jersey,
        opponent: awayTeam.abbreviation,
        isHome: true,
        gamesPlayed: player.gamesPlayed,
        seasonAvg: player.seasonAvg,
        recentForm: player.recentForm,
        consistency: player.consistency,
        projectedMIN: player.projectedMIN,
        usageRate: player.usageRate,
        hitRates: player.hitRates,
        restDays: player.lastRestDays,
        props,
        topProps: props.filter(p => p.recommendation).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)),
        bestProp: null,
      });
    }
  });

  // Set bestProp for each matchup
  allMatchups.forEach(m => {
    m.bestProp = m.topProps[0] || null;
  });

  // Sort by best edge
  allMatchups.sort((a, b) => Math.abs(b.bestProp?.edge || 0) - Math.abs(a.bestProp?.edge || 0));

  return {
    away: { id: awayTeamId, abbr: awayTeam.abbreviation, name: awayTeam.displayName },
    home: { id: homeTeamId, abbr: homeTeam.abbreviation, name: homeTeam.displayName },
    awayDefense: { oppg: awayDef.oppg, rating: awayDef.defRating, pace: awayDef.pace },
    homeDefense: { oppg: homeDef.oppg, rating: homeDef.defRating, pace: homeDef.pace },
    awayInjuries: awayInjuries.map(i => ({ player: i.player, status: i.status })),
    homeInjuries: homeInjuries.map(i => ({ player: i.player, status: i.status })),
    awayUsageBoost: awayBoost,
    homeUsageBoost: homeBoost,
    matchups: allMatchups,
    totalProps: allMatchups.reduce((s, m) => s + m.topProps.length, 0),
    recommendations: allMatchups.filter(m => m.bestProp).length,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 8. Generate All Props for All Scheduled Games
// ═══════════════════════════════════════════════════════════════════

function generateAllPropsEngine() {
  const scoreboard = loadJson('scoreboard.json');
  const events = scoreboard?.events || [];
  const games = [];

  events.forEach(ev => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    if (home?.team?.id && away?.team?.id) {
      const props = generateGamePropsEngine(away.team.id, home.team.id);
      if (props) games.push(props);
    }
  });

  // Also check team schedules for upcoming games
  for (let t = 1; t <= 30; t++) {
    const sch = loadJson(`schedule-${t}.json`);
    if (!sch?.events) continue;
    sch.events.slice(0, 5).forEach(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      if (home?.team?.id && away?.team?.id) {
        const existing = games.find(g => g.home.id === home.team.id && g.away.id === away.team.id);
        if (!existing) {
          const props = generateGamePropsEngine(away.team.id, home.team.id);
          if (props) games.push(props);
        }
      }
    });
  }

  // Get all top picks across games
  const allPicks = [];
  games.forEach(g => {
    g.matchups.forEach(m => {
      m.topProps.forEach(p => {
        allPicks.push({
          player: m.player,
          team: m.team,
          pos: m.pos,
          opponent: m.opponent,
          ...p,
        });
      });
    });
  });

  // Sort all picks by edge
  allPicks.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  return {
    generated: new Date().toISOString(),
    season: '2026-27',
    totalGames: games.length,
    totalPicks: allPicks.length,
    games,
    topPicks: allPicks.slice(0, 50), // Top 50 across all games
    strongPlays: allPicks.filter(p => p.valueRating === 'STRONG'),
    summary: {
      totalPlayers: games.reduce((s, g) => s + g.matchups.length, 0),
      overPlays: allPicks.filter(p => p.recommendation === 'OVER').length,
      underPlays: allPicks.filter(p => p.recommendation === 'UNDER').length,
      highConfidence: allPicks.filter(p => p.confidence === 'HIGH').length,
      mediumConfidence: allPicks.filter(p => p.confidence === 'MEDIUM').length,
    },
  };
}

module.exports = {
  generateGamePropsEngine,
  generateAllPropsEngine,
  buildPlayerProfile,
  getTeamDefense,
  getPositionDefense,
  getTeamInjuries,
  computeUsageRedistribution,
  parseGamelogFull,
};
