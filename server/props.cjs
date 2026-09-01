/**
 * SHARPEDGE Props Engine v2.0
 * 
 * NOT a spreadsheet. A matchup-aware prediction system.
 * 
 * For each scheduled game, it:
 * 1. Identifies the key players on both teams
 * 2. Computes their season averages and recent trends
 * 3. Analyzes the OPPONENT's defense (OPPG, pace, DRTG)
 * 4. Adjusts expectations based on matchup context
 * 5. Generates fair lines and detects value
 * 
 * Every prop is tied to a SPECIFIC GAME with a SPECIFIC OPPONENT.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

// ─── Team defensive data from standings ─────────────────────────
function getTeamDefense() {
  const standings = loadJson('standings.json');
  const defense = {};

  (standings?.children || []).forEach(c => {
    (c.standings?.entries || []).forEach(e => {
      const s = {};
      (e.stats || []).forEach(x => { s[x.name] = x.value; });
      defense[e.team.abbreviation || e.team.id] = {
        oppg: s.avgPointsAgainst || 110,        // Points allowed per game
        ppg: s.avgPointsFor || 110,              // Points scored per game
        pace: (s.avgPointsFor + s.avgPointsAgainst) / 2 / 50 * 50, // Estimated pace
        winPct: s.winPercent || 0.5,
        diff: s.differential || 0,
        // Lower OPPG = better defense
        defensiveRating: s.avgPointsAgainst < 105 ? 'elite' :
                        s.avgPointsAgainst < 108 ? 'good' :
                        s.avgPointsAgainst < 112 ? 'average' : 'poor',
      };
    });
  });

  return defense;
}

// ─── Parse player gamelog ───────────────────────────────────────
function parseGamelog(playerId) {
  const gamelog = loadJson(`player-gamelog-${playerId}.json`);
  if (!gamelog?.labels || !gamelog?.seasonTypes) return { labels: [], games: [], averages: null, last5: null, last10: null };

  const labels = gamelog.labels;
  const regSeason = gamelog.seasonTypes.find(s =>
    (s.displayName || s.name || '').includes('Regular')
  );
  if (!regSeason) return { labels, games: [], averages: null, last5: null, last10: null };

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
      stats._eventId = ev.eventId;
      stats._month = cat.displayName;
      games.push(stats);
    });
  });

  // Compute averages
  const computeAvg = (arr) => {
    if (!arr.length) return null;
    const n = arr.length;
    const avg = (key) => arr.reduce((s, g) => s + (g[key] || 0), 0) / n;
    const fgMade = arr.reduce((s, g) => s + (g.FG?.made || 0), 0);
    const fgAtt = arr.reduce((s, g) => s + (g.FG?.attempted || 0), 0);
    const threeMade = arr.reduce((s, g) => s + (g['3PT']?.made || 0), 0);
    const threeAtt = arr.reduce((s, g) => s + (g['3PT']?.attempted || 0), 0);
    return {
      PTS: parseFloat(avg('PTS').toFixed(1)),
      REB: parseFloat(avg('REB').toFixed(1)),
      AST: parseFloat(avg('AST').toFixed(1)),
      STL: parseFloat(avg('STL').toFixed(1)),
      BLK: parseFloat(avg('BLK').toFixed(1)),
      TO: parseFloat(avg('TO').toFixed(1)),
      MIN: parseFloat(avg('MIN').toFixed(1)),
      FG_PCT: fgAtt > 0 ? parseFloat(((fgMade / fgAtt) * 100).toFixed(1)) : 0,
      threePT_PCT: threeAtt > 0 ? parseFloat(((threeMade / threeAtt) * 100).toFixed(1)) : 0,
      games: n,
    };
  };

  return {
    labels,
    games,
    averages: computeAvg(games),
    last5: computeAvg(games.slice(-5)),
    last10: computeAvg(games.slice(-10)),
    last20: computeAvg(games.slice(-20)),
  };
}

// ─── Get team roster with player data ──────────────────────────
function getTeamPlayers(teamId) {
  const roster = loadJson(`roster-${teamId}.json`);
  if (!roster?.athletes) return [];

  return roster.athletes.map(a => {
    const gamelog = parseGamelog(a.id);
    return {
      id: a.id,
      name: a.displayName || `${a.firstName} ${a.lastName}`,
      pos: a.position?.abbreviation || '',
      jersey: a.jersey || '',
      headshot: a.headshot?.href || '',
      injuries: a.injuries || [],
      status: a.injuries?.length ? a.injuries[0].status : 'Active',
      gamelog,
    };
  }).filter(p => p.gamelog.averages && p.status === 'Active'); // Only active players with data
}

// ─── Matchup-adjusted prop prediction ──────────────────────────
function predictProp(player, opponentDef, stat, gameContext) {
  const avg = player.gamelog.averages;
  const last5 = player.gamelog.last5;
  const last10 = player.gamelog.last10;

  if (!avg || !avg[stat]) return null;

  const seasonAvg = avg[stat];

  // Weight recent form more heavily
  const recentAvg = last5 ? last5[stat] * 0.6 + (last10 ? last10[stat] * 0.4 : last5[stat] * 0.4) : seasonAvg;

  // Opponent defensive adjustment
  // Lower OPPG = tougher defense = fewer stats for opposing players
  const leagueAvgOPPG = 110;
  const oppgDiff = opponentDef.oppg - leagueAvgOPPG;
  // If opponent allows fewer points, reduce expected stats
  const defenseFactor = 1 + (oppgDiff / leagueAvgOPPG) * 0.5;

  // Pace adjustment
  // Higher pace = more possessions = more stats
  const leagueAvgPace = 100;
  const paceDiff = (opponentDef.pace || 100) - leagueAvgPace;
  const paceFactor = 1 + (paceDiff / leagueAvgPace) * 0.3;

  // Home/away adjustment (minor)
  const venueFactor = gameContext.isHome ? 1.02 : 0.98;

  // Back-to-back adjustment
  const b2bFactor = gameContext.isBackToBack ? 0.92 : 1.0;

  // Compute adjusted expectation
  const adjustedExpectation = recentAvg * defenseFactor * paceFactor * venueFactor * b2bFactor;

  // Generate fair line (round to nearest 0.5)
  const fairLine = Math.round(adjustedExpectation * 2) / 2;

  // Determine recommendation
  // We compare fairLine to what we'd expect a sportsbook to set
  // Sportsbooks typically set lines close to season average with slight adjustments
  const sportsbookLine = Math.round(seasonAvg * 2) / 2; // Approximate

  const edge = fairLine - sportsbookLine;
  const absEdge = Math.abs(edge);

  let recommendation = null;
  let confidence = 'LOW';

  if (absEdge >= 2) {
    recommendation = edge > 0 ? 'OVER' : 'UNDER';
    confidence = absEdge >= 4 ? 'HIGH' : 'MEDIUM';
  } else if (absEdge >= 1) {
    recommendation = edge > 0 ? 'OVER' : 'UNDER';
    confidence = 'LOW';
  }

  return {
    stat,
    seasonAvg,
    recentAvg: parseFloat(recentAvg.toFixed(1)),
    fairLine,
    sportsbookLine,
    edge: parseFloat(edge.toFixed(1)),
    recommendation,
    confidence,
    factors: {
      defense: opponentDef.defensiveRating,
      defenseAdj: parseFloat(((defenseFactor - 1) * 100).toFixed(1)) + '%',
      paceAdj: parseFloat(((paceFactor - 1) * 100).toFixed(1)) + '%',
      venue: gameContext.isHome ? 'Home' : 'Away',
      b2b: gameContext.isBackToBack ? 'Yes' : 'No',
    },
  };
}

// ─── Generate props for a specific game ────────────────────────
function generateGameProps(awayTeamId, homeTeamId) {
  const teamMap = {};
  const teamsData = loadJson('teams.json');
  if (teamsData?.sports?.[0]?.leagues?.[0]?.teams) {
    teamsData.sports[0].leagues[0].teams.forEach(t => { if (t.team) teamMap[t.team.id] = t.team; });
  }

  const awayTeam = teamMap[awayTeamId];
  const homeTeam = teamMap[homeTeamId];
  if (!awayTeam || !homeTeam) return null;

  const defense = getTeamDefense();
  const awayDefense = defense[awayTeam.abbreviation] || { oppg: 110, pace: 100 };
  const homeDefense = defense[homeTeam.abbreviation] || { oppg: 110, pace: 100 };

  const awayPlayers = getTeamPlayers(awayTeamId);
  const homePlayers = getTeamPlayers(homeTeamId);

  const stats = ['PTS', 'REB', 'AST', 'STL', 'BLK'];

  // Generate props for each player in each matchup
  const matchups = [];

  // Away team players playing against home team defense
  awayPlayers.forEach(player => {
    if (!player.gamelog.averages) return;
    const gameContext = { isHome: false, isBackToBack: false };
    const props = stats.map(stat => predictProp(player, homeDefense, stat, gameContext)).filter(Boolean);

    if (props.length > 0) {
      matchups.push({
        player: player.name,
        playerId: player.id,
        team: awayTeam.abbreviation,
        headshot: player.headshot,
        pos: player.pos,
        opponent: homeTeam.abbreviation,
        isHome: false,
        props,
      });
    }
  });

  // Home team players playing against away team defense
  homePlayers.forEach(player => {
    if (!player.gamelog.averages) return;
    const gameContext = { isHome: true, isBackToBack: false };
    const props = stats.map(stat => predictProp(player, awayDefense, stat, gameContext)).filter(Boolean);

    if (props.length > 0) {
      matchups.push({
        player: player.name,
        playerId: player.id,
        team: homeTeam.abbreviation,
        headshot: player.headshot,
        pos: player.pos,
        opponent: awayTeam.abbreviation,
        isHome: true,
        props,
      });
    }
  });

  // Sort by edge magnitude (biggest edges first)
  matchups.forEach(m => {
    m.topProps = m.props
      .filter(p => p.recommendation)
      .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
    m.bestProp = m.topProps[0] || null;
  });

  matchups.sort((a, b) => Math.abs(b.bestProp?.edge || 0) - Math.abs(a.bestProp?.edge || 0));

  return {
    away: { id: awayTeamId, abbr: awayTeam.abbreviation, name: awayTeam.displayName },
    home: { id: homeTeamId, abbr: homeTeam.abbreviation, name: homeTeam.displayName },
    awayDefense: { oppg: awayDefense.oppg, rating: awayDefense.defensiveRating },
    homeDefense: { oppg: homeDefense.oppg, rating: homeDefense.defensiveRating },
    matchups,
    totalProps: matchups.reduce((s, m) => s + m.topProps.length, 0),
    recommendations: matchups.filter(m => m.bestProp).length,
  };
}

// ─── Generate props for all scheduled games ────────────────────
function generateAllProps() {
  const scoreboard = loadJson('scoreboard.json');
  const events = scoreboard?.events || [];
  const games = [];

  events.forEach(ev => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    if (home?.team?.id && away?.team?.id) {
      const props = generateGameProps(away.team.id, home.team.id);
      if (props) games.push(props);
    }
  });

  // Also get upcoming scheduled games
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
          const props = generateGameProps(away.team.id, home.team.id);
          if (props) games.push(props);
        }
      }
    });
  }

  return {
    generated: new Date().toISOString(),
    totalGames: games.length,
    games: games.slice(0, 20), // Limit to 20 games
  };
}

module.exports = { generateGameProps, generateAllProps, getTeamDefense, parseGamelog, predictProp };
