/**
 * SHARPEDGE Matchup Engine v2.0
 * 
 * Comprehensive matchup data for every scheduled game:
 * - Team records, standings, offensive/defensive efficiency
 * - Odds from all sportsbooks (FanDuel, DraftKings, BetMGM, Bovada, Stake)
 * - Injury report for both teams
 * - Key player matchups by position (PG vs PG, SG vs SG, etc.)
 * - Team aggregates from top players
 * - Head-to-head context
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

// ─── Team Map ────────────────────────────────────────────────────
let TEAM_MAP = null;
function getTeamMap() {
  if (TEAM_MAP) return TEAM_MAP;
  TEAM_MAP = {};
  const data = loadJson('teams.json');
  if (data?.sports?.[0]?.leagues?.[0]?.teams) {
    data.sports[0].leagues[0].teams.forEach(t => { if (t.team) TEAM_MAP[t.team.id] = t.team; });
  }
  return TEAM_MAP;
}

// ─── Standings Map ───────────────────────────────────────────────
let STANDINGS_MAP = null;
function getStandingsMap() {
  if (STANDINGS_MAP) return STANDINGS_MAP;
  STANDINGS_MAP = {};
  const standings = loadJson('standings.json');
  (standings?.children || []).forEach(c => {
    (c.standings?.entries || []).forEach(e => {
      const s = {};
      (e.stats || []).forEach(x => { s[x.name] = x.value; });
      STANDINGS_MAP[e.team.id] = {
        wins: s.wins || 0,
        losses: s.losses || 0,
        winPct: s.winPercent || 0,
        ppg: s.avgPointsFor || 0,
        oppg: s.avgPointsAgainst || 0,
        diff: s.differential || 0,
        streak: s.streak?.value || 0,
        streakDir: s.streak?.direction || '',
        gamesBehind: s.gamesBehind || 0,
        homeRecord: s.home || '',
        roadRecord: s.road || '',
        last10: s.record || '',
      };
    });
  });
  return STANDINGS_MAP;
}

// ─── Odds Map ────────────────────────────────────────────────────
let ODDS_MAP = null;
function getOddsMap() {
  if (ODDS_MAP) return ODDS_MAP;
  ODDS_MAP = {};
  const odds = loadJson('live-odds.json');
  if (Array.isArray(odds)) {
    odds.forEach(g => {
      const key = `${g.away_team}-${g.home_team}`;
      ODDS_MAP[key] = g;
    });
  }
  return ODDS_MAP;
}

// ─── Parse gamelog ───────────────────────────────────────────────
function parseGamelog(gamelog) {
  if (!gamelog?.labels || !gamelog?.seasonTypes) return [];
  const labels = gamelog.labels;
  const regSeason = gamelog.seasonTypes.find(s =>
    (s.displayName || s.name || '').includes('Regular')
  );
  if (!regSeason) return [];
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
      stats._date = ev.date || '';
      games.push(stats);
    });
  });
  return games;
}

// ─── Compute averages from games ─────────────────────────────────
function computeAverages(games) {
  if (!games.length) return null;
  const n = games.length;
  const avg = (key) => games.reduce((s, g) => s + (g[key] || 0), 0) / n;
  const fgMade = games.reduce((s, g) => s + (g.FG?.made || 0), 0);
  const fgAtt = games.reduce((s, g) => s + (g.FG?.attempted || 0), 0);
  const threeMade = games.reduce((s, g) => s + (g['3PT']?.made || 0), 0);
  const threeAtt = games.reduce((s, g) => s + (g['3PT']?.attempted || 0), 0);
  return {
    PPG: parseFloat(avg('PTS').toFixed(1)),
    RPG: parseFloat(avg('REB').toFixed(1)),
    APG: parseFloat(avg('AST').toFixed(1)),
    SPG: parseFloat(avg('STL').toFixed(1)),
    BPG: parseFloat(avg('BLK').toFixed(1)),
    TOPG: parseFloat(avg('TO').toFixed(1)),
    FG_PCT: fgAtt > 0 ? parseFloat(((fgMade / fgAtt) * 100).toFixed(1)) : 0,
    threePT_PCT: threeAtt > 0 ? parseFloat(((threeMade / threeAtt) * 100).toFixed(1)) : 0,
    MPG: parseFloat(avg('MIN').toFixed(1)),
    gamesPlayed: n,
  };
}

// ─── Compute trend (last N games) ───────────────────────────────
function computeTrend(games, n) {
  const recent = games.slice(-n);
  if (!recent.length) return null;
  const avg = (key) => recent.reduce((s, g) => s + (g[key] || 0), 0) / recent.length;
  const fgMade = recent.reduce((s, g) => s + (g.FG?.made || 0), 0);
  const fgAtt = recent.reduce((s, g) => s + (g.FG?.attempted || 0), 0);
  return {
    PPG: parseFloat(avg('PTS').toFixed(1)),
    RPG: parseFloat(avg('REB').toFixed(1)),
    APG: parseFloat(avg('AST').toFixed(1)),
    FG_PCT: fgAtt > 0 ? parseFloat(((fgMade / fgAtt) * 100).toFixed(1)) : 0,
    games: n,
  };
}

// ─── Get team roster with full player data ──────────────────────
function getTeamRoster(teamId) {
  const roster = loadJson(`roster-${teamId}.json`);
  if (!roster?.athletes) return [];

  return roster.athletes.map(a => {
    const gamelog = loadJson(`player-gamelog-${a.id}.json`);
    const games = parseGamelog(gamelog);
    const avgs = computeAverages(games);
    const trend5 = games.length >= 5 ? computeTrend(games, 5) : null;

    return {
      id: a.id,
      name: a.displayName || `${a.firstName} ${a.lastName}`,
      firstName: a.firstName,
      lastName: a.lastName,
      pos: a.position?.abbreviation || '',
      jersey: a.jersey || '',
      height: a.displayHeight || '',
      weight: a.displayWeight || '',
      age: a.age || '',
      headshot: a.headshot?.href || '',
      injuries: a.injuries || [],
      status: a.injuries?.length ? a.injuries[0].status : 'Active',
      avgs,
      trend5,
      gamesPlayed: games.length,
      gamelog: games,
    };
  });
}

// ─── Build odds for a specific matchup ──────────────────────────
function getMatchupOdds(homeTeamAbbr, awayTeamAbbr, homeTeamName, awayTeamName) {
  // Try abbreviation match first (both directions)
  const odds = loadJson('live-odds.json');
  if (!Array.isArray(odds)) return null;

  // Build name maps for matching
  const abbrToName = {};
  const nameToAbbr = {};
  const teamMap = getTeamMap();
  Object.values(teamMap).forEach(t => {
    if (t.abbreviation && t.displayName) {
      abbrToName[t.abbreviation] = t.displayName;
      nameToAbbr[t.displayName] = t.abbreviation;
    }
  });

  const gameOdds = odds.find(g => {
    // Get abbreviations for both sides of the odds
    const oddsHomeAbbr = nameToAbbr[g.home_team] || g.home_team;
    const oddsAwayAbbr = nameToAbbr[g.away_team] || g.away_team;
    
    // Match: our home = their home AND our away = their away
    // OR: our home = their away AND our away = their home (reversed)
    const forward = (oddsHomeAbbr === homeTeamAbbr && oddsAwayAbbr === awayTeamAbbr);
    const reverse = (oddsHomeAbbr === awayTeamAbbr && oddsAwayAbbr === homeTeamAbbr);
    return forward || reverse;
  });

  if (!gameOdds) return null;

  const gameBooks = [...(gameOdds.bookmakers || [])];

  const books = gameBooks.map(b => {
    const ml = b.markets?.find(m => m.key === 'h2h');
    const spread = b.markets?.find(m => m.key === 'spreads');
    const total = b.markets?.find(m => m.key === 'totals');
    const homeMl = ml?.outcomes?.find(o => o.name === gameOdds.home_team);
    const awayMl = ml?.outcomes?.find(o => o.name === gameOdds.away_team);
    const homeSpread = spread?.outcomes?.find(o => o.name === gameOdds.home_team);
    const awaySpread = spread?.outcomes?.find(o => o.name === gameOdds.away_team);
    const over = total?.outcomes?.find(o => o.name === 'Over');
    const under = total?.outcomes?.find(o => o.name === 'Under');

    return {
      book: b.title,
      homeML: homeMl?.price,
      awayML: awayMl?.price,
      homeSpread: homeSpread?.point,
      homeSpreadOdds: homeSpread?.price,
      awaySpread: awaySpread?.point,
      awaySpreadOdds: awaySpread?.price,
      total: over?.point,
      overOdds: over?.price,
      underOdds: under?.price,
    };
  });

  // Compute best odds
  // For favorites (negative ML), closer to 0 is better; for underdogs (positive ML), higher is better
  const bestHomeML = books.reduce((best, b) => {
    if (b.homeML == null) return best;
    if (!best) return b;
    if (b.homeML > 0 && best.homeML > 0) return b.homeML > best.homeML ? b : best;
    if (b.homeML < 0 && best.homeML < 0) return b.homeML > best.homeML ? b : best;
    return b.homeML > best.homeML ? b : best;
  }, null);
  const bestAwayML = books.reduce((best, b) => {
    if (b.awayML == null) return best;
    if (!best) return b;
    if (b.awayML > 0 && best.awayML > 0) return b.awayML > best.awayML ? b : best;
    if (b.awayML < 0 && best.awayML < 0) return b.awayML > best.awayML ? b : best;
    return b.awayML > best.awayML ? b : best;
  }, null);
  const bestHomeSpread = books.reduce((best, b) => {
    if (b.homeSpread == null) return best;
    if (!best) return b;
    // For favorites, lower spread is better; for underdogs, higher spread
    if (b.homeSpread < 0) return b.homeSpread > best.homeSpread ? b : best;
    return b.homeSpread < best.homeSpread ? b : best;
  }, null);
  const bestTotal = books.reduce((best, b) => {
    if (b.total == null) return best;
    if (!best) return b;
    // Lowest total (tightest line) is usually the best value
    return b.total < best.total ? b : best;
  }, null);

  return {
    books,
    bestHomeML: bestHomeML ? { book: bestHomeML.book, odds: bestHomeML.homeML } : null,
    bestAwayML: bestAwayML ? { book: bestAwayML.book, odds: bestAwayML.awayML } : null,
    bestHomeSpread: bestHomeSpread ? { book: bestHomeSpread.book, spread: bestHomeSpread.homeSpread, odds: bestHomeSpread.homeSpreadOdds } : null,
    bestTotal: bestTotal ? { book: bestTotal.book, total: bestTotal.total } : null,
  };
}

// ─── Aggregate team stats from top players ──────────────────────
function aggregateFromPlayers(players) {
  const top = players.filter(p => p.avgs).sort((a, b) => (b.avgs.MPG || 0) - (a.avgs.MPG || 0)).slice(0, 8);
  if (!top.length) return { PPG: 0, RPG: 0, APG: 0, SPG: 0, BPG: 0, TOPG: 0, FG_PCT: 0, threePT_PCT: 0, topPlayers: [] };

  return {
    PPG: parseFloat(top.reduce((s, p) => s + (p.avgs?.PPG || 0), 0).toFixed(1)),
    RPG: parseFloat(top.reduce((s, p) => s + (p.avgs?.RPG || 0), 0).toFixed(1)),
    APG: parseFloat(top.reduce((s, p) => s + (p.avgs?.APG || 0), 0).toFixed(1)),
    SPG: parseFloat(top.reduce((s, p) => s + (p.avgs?.SPG || 0), 0).toFixed(1)),
    BPG: parseFloat(top.reduce((s, p) => s + (p.avgs?.BPG || 0), 0).toFixed(1)),
    TOPG: parseFloat(top.reduce((s, p) => s + (p.avgs?.TOPG || 0), 0).toFixed(1)),
    FG_PCT: parseFloat(top.reduce((s, p) => s + (p.avgs?.FG_PCT || 0), 0 / top.length).toFixed(1)),
    threePT_PCT: parseFloat(top.reduce((s, p) => s + (p.avgs?.threePT_PCT || 0), 0 / top.length).toFixed(1)),
    topPlayers: top.map(p => ({
      name: p.name, pos: p.pos, jersey: p.jersey, headshot: p.headshot,
      PPG: p.avgs?.PPG, RPG: p.avgs?.RPG, APG: p.avgs?.APG,
      FG_PCT: p.avgs?.FG_PCT, threePT_PCT: p.avgs?.threePT_PCT,
      MPG: p.avgs?.MPG, gamesPlayed: p.avgs?.gamesPlayed,
      status: p.status,
      trend5: p.trend5,
    })),
  };
}

// ─── Build injury report ────────────────────────────────────────
function getInjuryReport(roster) {
  return roster
    .filter(p => p.injuries?.length > 0)
    .map(p => ({
      name: p.name,
      pos: p.pos,
      jersey: p.jersey,
      status: p.status,
      detail: p.injuries[0]?.details || p.injuries[0]?.detail || '',
      ppg: p.avgs?.PPG || 0,
    }));
}

// ─── Build key player matchups by position ──────────────────────
function buildKeyMatchups(awayRoster, homeRoster) {
  // ESPN uses generic positions: G, F, C
  // Map to specific if available, otherwise use generic
  const posGroups = ['G', 'F', 'C'];
  const matchups = [];
  const usedAway = new Set();
  const usedHome = new Set();

  posGroups.forEach(pos => {
    const awayCandidates = awayRoster
      .filter(p => p.pos === pos && p.avgs && p.status === 'Active' && !usedAway.has(p.id))
      .sort((a, b) => (b.avgs?.MPG || 0) - (a.avgs?.MPG || 0));
    const homeCandidates = homeRoster
      .filter(p => p.pos === pos && p.avgs && p.status === 'Active' && !usedHome.has(p.id))
      .sort((a, b) => (b.avgs?.MPG || 0) - (a.avgs?.MPG || 0));

    // Match top 2 at each position group
    const count = Math.min(2, awayCandidates.length, homeCandidates.length);
    for (let i = 0; i < count; i++) {
      const awayPlayer = awayCandidates[i];
      const homePlayer = homeCandidates[i];
      usedAway.add(awayPlayer.id);
      usedHome.add(homePlayer.id);

      const ppgDiff = (homePlayer.avgs?.PPG || 0) - (awayPlayer.avgs?.PPG || 0);
      const advantage = Math.abs(ppgDiff) > 2 ? (ppgDiff > 0 ? 'home' : 'away') : 'even';

      matchups.push({
        position: pos === 'G' ? (i === 0 ? 'Guard' : 'Guard 2') : pos === 'F' ? (i === 0 ? 'Forward' : 'Forward 2') : 'Center',
        away: {
          name: awayPlayer.name, jersey: awayPlayer.jersey, headshot: awayPlayer.headshot,
          PPG: awayPlayer.avgs?.PPG, RPG: awayPlayer.avgs?.RPG, APG: awayPlayer.avgs?.APG,
          FG_PCT: awayPlayer.avgs?.FG_PCT, status: awayPlayer.status,
          trend5: awayPlayer.trend5, MPG: awayPlayer.avgs?.MPG,
        },
        home: {
          name: homePlayer.name, jersey: homePlayer.jersey, headshot: homePlayer.headshot,
          PPG: homePlayer.avgs?.PPG, RPG: homePlayer.avgs?.RPG, APG: homePlayer.avgs?.APG,
          FG_PCT: homePlayer.avgs?.FG_PCT, status: homePlayer.status,
          trend5: homePlayer.trend5, MPG: homePlayer.avgs?.MPG,
        },
        advantage,
        ppgDiff: parseFloat(ppgDiff.toFixed(1)),
      });
    }
  });

  return matchups;
}

// ─── Compute matchup advantages ─────────────────────────────────
function computeAdvantages(awayAgg, homeAgg, awayStanding, homeStanding) {
  const advantages = [];
  const statKeys = [
    { key: 'PPG', label: 'Scoring', weight: 1.0 },
    { key: 'RPG', label: 'Rebounding', weight: 0.8 },
    { key: 'APG', label: 'Ball Movement', weight: 0.7 },
    { key: 'SPG', label: 'Defense (Steals)', weight: 0.6 },
    { key: 'BPG', label: 'Defense (Blocks)', weight: 0.5 },
    { key: 'TOPG', label: 'Ball Security', weight: -0.5 }, // lower is better
  ];

  let homeScore = 0;
  let awayScore = 0;

  statKeys.forEach(({ key, label, weight }) => {
    const awayVal = awayAgg[key] || 0;
    const homeVal = homeAgg[key] || 0;
    const diff = homeVal - awayVal;
    const effectiveWeight = key === 'TOPG' ? -weight : weight;

    if (diff > 0) homeScore += Math.abs(diff) * effectiveWeight;
    else awayScore += Math.abs(diff) * effectiveWeight;

    if (Math.abs(diff) > 0.5) {
      advantages.push({
        stat: key,
        label,
        away: awayVal,
        home: homeVal,
        diff: parseFloat(diff.toFixed(1)),
        advantage: diff > 0 ? 'home' : 'away',
      });
    }
  });

  // Home court advantage (+3.5 points historically)
  homeScore += 3.5;

  // Standing advantage
  if (awayStanding && homeStanding) {
    const winPctDiff = (homeStanding.winPct || 0) - (awayStanding.winPct || 0);
    homeScore += winPctDiff * 20;
    advantages.push({
      stat: 'Win%',
      label: 'Record',
      away: `${awayStanding.wins}-${awayStanding.losses}`,
      home: `${homeStanding.wins}-${homeStanding.losses}`,
      diff: parseFloat((winPctDiff * 100).toFixed(1)),
      advantage: winPctDiff > 0 ? 'home' : winPctDiff < 0 ? 'away' : 'even',
    });
  }

  return { advantages, homeScore: parseFloat(homeScore.toFixed(1)), awayScore: parseFloat(awayScore.toFixed(1)) };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: Build complete matchup for two teams
// ═══════════════════════════════════════════════════════════════════

function buildMatchup(awayTeamId, homeTeamId) {
  const teamMap = getTeamMap();
  const standingsMap = getStandingsMap();

  const awayTeam = teamMap[awayTeamId];
  const homeTeam = teamMap[homeTeamId];
  if (!awayTeam || !homeTeam) return null;

  // Rosters
  const awayRoster = getTeamRoster(awayTeamId);
  const homeRoster = getTeamRoster(homeTeamId);

  // Standings
  const awayStanding = standingsMap[awayTeamId] || null;
  const homeStanding = standingsMap[homeTeamId] || null;

  // Odds
  const odds = getMatchupOdds(homeTeam.abbreviation, awayTeam.abbreviation, homeTeam.displayName, awayTeam.displayName);

  // Aggregates
  const awayAggregate = aggregateFromPlayers(awayRoster);
  const homeAggregate = aggregateFromPlayers(homeRoster);

  // Injuries
  const awayInjuries = getInjuryReport(awayRoster);
  const homeInjuries = getInjuryReport(homeRoster);

  // Key matchups
  const keyMatchups = buildKeyMatchups(awayRoster, homeRoster);

  // Advantages
  const { advantages, homeScore, awayScore } = computeAdvantages(awayAggregate, homeAggregate, awayStanding, homeStanding);

  // Win probability from scoring model
  const totalScore = homeScore + awayScore;
  const homeWinProb = totalScore > 0 ? homeScore / totalScore : 0.5 + 0.035; // slight home edge

  return {
    away: {
      ...awayTeam,
      standing: awayStanding,
      aggregate: awayAggregate,
      injuries: awayInjuries,
      injuryCount: awayInjuries.length,
      activePlayers: awayRoster.filter(p => p.status === 'Active' && p.avgs).length,
      score: awayScore,
    },
    home: {
      ...homeTeam,
      standing: homeStanding,
      aggregate: homeAggregate,
      injuries: homeInjuries,
      injuryCount: homeInjuries.length,
      activePlayers: homeRoster.filter(p => p.status === 'Active' && p.avgs).length,
      score: homeScore,
    },
    odds,
    keyMatchups,
    advantages,
    homeWinProb: parseFloat(homeWinProb.toFixed(3)),
    awayWinProb: parseFloat((1 - homeWinProb).toFixed(3)),
    predictedMargin: parseFloat((homeScore - awayScore).toFixed(1)),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Get upcoming scheduled matchups with basic data
// ═══════════════════════════════════════════════════════════════════

function getUpcomingMatchups() {
  const teamMap = getTeamMap();

  // Collect from scoreboard (today's games)
  const scoreboard = loadJson('scoreboard.json');
  const scoreboardEvents = scoreboard?.events || [];

  // Collect from all 30 schedule files (upcoming season games)
  const scheduleGames = [];
  for (let t = 1; t <= 30; t++) {
    const sch = loadJson(`schedule-${t}.json`);
    if (!sch?.events) continue;
    sch.events.forEach(ev => {
      const comp = ev.competitions?.[0];
      if (!comp?.competitors) return;
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      if (home && away) {
        scheduleGames.push({
          eventId: ev.id,
          name: ev.name,
          date: ev.date,
          status: comp.status?.type?.description || 'Scheduled',
          away: {
            id: away.team?.id,
            abbr: away.team?.abbreviation,
            name: away.team?.displayName,
            logo: away.team?.logo,
            score: away.score,
          },
          home: {
            id: home.team?.id,
            abbr: home.team?.abbreviation,
            name: home.team?.displayName,
            logo: home.team?.logo,
            score: home.score,
          },
        });
      }
    });
  }

  // Merge and deduplicate
  const all = [...scoreboardEvents.map(ev => {
    const comp = ev.competitions?.[0];
    if (!comp?.competitors) return null;
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    if (!home || !away) return null;
    return {
      eventId: ev.id, name: ev.name, date: ev.date,
      status: comp.status?.type?.description || 'Scheduled',
      away: { id: away.team?.id, abbr: away.team?.abbreviation, name: away.team?.displayName, logo: away.team?.logo, score: away.score },
      home: { id: home.team?.id, abbr: home.team?.abbreviation, name: home.team?.displayName, logo: home.team?.logo, score: home.score },
    };
  }).filter(Boolean), ...scheduleGames];

  const unique = [...new Map(all.map(g => [g.eventId, g])).values()];
  unique.sort((a, b) => new Date(a.date) - new Date(b.date));
  return unique;
}

module.exports = { buildMatchup, getUpcomingMatchups, getTeamRoster, computeAverages };
