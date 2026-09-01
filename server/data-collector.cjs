/**
 * DATA COLLECTOR v1.0
 * 
 * Gathers EVERYTHING available into one unified structure per game.
 * No rules, no weights, no assumptions. Just data.
 * 
 * The LLM (the brain) decides what matters.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

function saveJson(file, data) {
  try { fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`[collector] Save ${file} error:`, e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// PLAYER — Full profile from all available data sources
// ═══════════════════════════════════════════════════════════════════

function collectPlayer(playerId) {
  const profile = loadJson(`player-${playerId}.json`);
  const gamelog = loadJson(`player-gamelog-${playerId}.json`);
  const stats = loadJson(`player-stats-${playerId}.json`);

  if (!profile && !gamelog) return null;

  const athlete = profile?.athlete || {};
  
  // Parse gamelog into game-by-game data
  const games = [];
  if (gamelog?.labels && gamelog?.seasonTypes) {
    const labels = gamelog.labels;
    const regSeason = gamelog.seasonTypes.find(s =>
      (s.displayName || s.name || '').includes('Regular')
    );
    if (regSeason) {
      (regSeason.categories || []).forEach(cat => {
        (cat.events || []).forEach(ev => {
          const game = {};
          labels.forEach((label, i) => {
            const val = ev.stats?.[i] || '';
            if (label === 'FG' || label === '3PT' || label === 'FT') {
              const parts = String(val).split('-');
              game[label] = { made: parseInt(parts[0]) || 0, attempted: parseInt(parts[1]) || 0 };
            } else {
              game[label] = parseFloat(val) || 0;
            }
          });
          game._eventId = ev.eventId;
          game._date = ev.gameDate || '';
          game._opponent = ev.opponent?.abbreviation || '';
          game._opponentFull = ev.opponent?.displayName || '';
          game._isHome = ev.atVs === 'vs';
          game._result = ev.gameResult || '';
          game._score = ev.score || '';
          games.push(game);
        });
      });
    }
  }

  // Sort games by date
  games.sort((a, b) => new Date(a._date) - new Date(b._date));

  return {
    playerId,
    name: athlete.displayName || `${athlete.firstName} ${athlete.lastName}` || playerId,
    firstName: athlete.firstName || '',
    lastName: athlete.lastName || '',
    team: athlete.team?.abbreviation || '',
    teamId: athlete.team?.id || '',
    position: athlete.position?.abbreviation || '',
    jersey: athlete.jersey || '',
    height: athlete.displayHeight || '',
    weight: athlete.displayWeight || '',
    age: athlete.age || 0,
    experience: athlete.displayExperience || '',
    draft: athlete.displayDraft || '',
    headshot: athlete.headshot?.href || '',
    status: athlete.status?.abbreviation || 'Active',
    
    // Current season stats summary (from ESPN)
    seasonSummary: athlete.statsSummary?.statistics?.map(s => ({
      name: s.name,
      value: s.value,
      display: s.displayValue,
      rank: s.rank,
    })) || [],
    
    // Full gamelog (all games this season)
    games,
    totalGames: games.length,
    
    // Advanced stats if available
    advancedStats: stats || null,
    
    // Injuries
    injuries: athlete.injuries || [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// TEAM — Full profile from standings, roster, schedules
// ═══════════════════════════════════════════════════════════════════

function collectTeam(teamId) {
  const teamData = loadJson(`team-${teamId}.json`);
  const roster = loadJson(`roster-${teamId}.json`);
  const schedule = loadJson(`schedule-${teamId}.json`);
  const teamStats = loadJson(`stats-${teamId}.json`);

  // Get standings data
  const standings = loadJson('standings.json');
  let standingsEntry = null;
  (standings?.children || []).forEach(c => {
    (c.standings?.entries || []).forEach(e => {
      if (String(e.team.id) === String(teamId)) {
        const s = {};
        (e.stats || []).forEach(x => { s[x.name] = x.value; });
        standingsEntry = s;
      }
    });
  });

  // Collect injured players
  const injuries = [];
  (roster?.athletes || []).forEach(a => {
    if (a.injuries?.length) {
      a.injuries.forEach(inj => {
        injuries.push({
          player: a.displayName,
          playerId: a.id,
          status: inj.status || 'Unknown',
          detail: inj.details || inj.detail || '',
          position: a.position?.abbreviation || '',
        });
      });
    }
  });

  // Get all players with gamelogs
  const players = [];
  (roster?.athletes || []).forEach(a => {
    const playerData = collectPlayer(a.id);
    if (playerData && playerData.games.length > 0) {
      players.push(playerData);
    }
  });

  // Schedule — past results and upcoming games
  const pastGames = [];
  const upcomingGames = [];
  (schedule?.events || []).forEach(ev => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    const gameData = {
      id: ev.id,
      date: ev.date || '',
      homeTeam: home?.team?.abbreviation || '',
      awayTeam: away?.team?.abbreviation || '',
      homeScore: parseInt(home?.score) || 0,
      awayScore: parseInt(away?.score) || 0,
      status: comp?.status?.type?.name || 'STATUS_SCHEDULED',
      isCompleted: comp?.status?.type?.completed || false,
    };
    if (gameData.isCompleted) pastGames.push(gameData);
    else upcomingGames.push(gameData);
  });

  return {
    teamId,
    name: teamData?.team?.displayName || teamData?.team?.name || `Team ${teamId}`,
    abbreviation: teamData?.team?.abbreviation || '',
    logo: teamData?.team?.logos?.[0]?.href || '',
    venue: teamData?.venue?.fullName || '',
    conference: teamData?.groups?.abbreviation || '',
    division: teamData?.groups?.name || '',
    
    // Standings
    standings: standingsEntry ? {
      wins: standingsEntry.wins || 0,
      losses: standingsEntry.losses || 0,
      winPct: standingsEntry.winPercent || 0,
      ppg: standingsEntry.avgPointsFor || 0,
      oppg: standingsEntry.avgPointsAgainst || 0,
      diff: standingsEntry.differential || 0,
      streak: standingsEntry.streak?.value || 0,
      streakType: standingsEntry.streak?.abbreviation || '',
      home: standingsEntry.home || '',
      road: standingsEntry.road || '',
      last10: standingsEntry.record || '',
      conferenceRecord: standingsEntry.conferenceRecord || '',
      divisionRecord: standingsEntry.divisionRecord || '',
    } : null,
    
    // Roster
    roster: (roster?.athletes || []).map(a => ({
      id: a.id,
      name: a.displayName,
      position: a.position?.abbreviation || '',
      jersey: a.jersey || '',
      status: a.injuries?.length ? a.injuries[0].status : 'Active',
    })),
    
    // Injuries
    injuries,
    
    // Schedule
    pastGames: pastGames.slice(-20), // Last 20 games
    upcomingGames: upcomingGames.slice(0, 5), // Next 5 games
    
    // Team stats
    teamStats: teamStats || null,
    
    // All player data
    players,
  };
}

// ═══════════════════════════════════════════════════════════════════
// GAME — Complete picture of a single matchup
// ═══════════════════════════════════════════════════════════════════

function collectGame(awayTeamId, homeTeamId) {
  const away = collectTeam(awayTeamId);
  const home = collectTeam(homeTeamId);

  if (!away || !home) return null;

  // Get odds for this game
  const odds = loadJson('live-odds.json');
  const gameOdds = (Array.isArray(odds) ? odds : []).find(o => {
    const matchHome = o.home_team === home.abbreviation || o.home_team === home.name;
    const matchAway = o.away_team === away.abbreviation || o.away_team === away.name;
    return matchHome && matchAway;
  });

  // Get matchup data if available
  const matchup = loadJson('match-data.json');
  const matchupDetail = matchup?.matchups?.find(m =>
    (m.home?.abbr === home.abbreviation && m.away?.abbr === away.abbreviation) ||
    (m.home?.abbr === away.abbreviation && m.away?.abbr === home.abbreviation)
  );

  // Get news
  const news = loadJson('news.json');
  const relevantNews = (news?.articles || []).filter(a => {
    const teams = (a.teams || []).map(t => t.toLowerCase());
    return teams.includes(home.abbreviation.toLowerCase()) ||
           teams.includes(away.abbreviation.toLowerCase()) ||
           teams.includes(home.name?.toLowerCase()) ||
           teams.includes(away.name?.toLowerCase());
  }).slice(0, 10);

  // Head-to-head from past games
  const h2h = [];
  (away.pastGames || []).forEach(g => {
    if (g.homeTeam === home.abbreviation || g.awayTeam === home.abbreviation) {
      h2h.push(g);
    }
  });

  return {
    away,
    home,
    odds: gameOdds || null,
    matchupDetail: matchupDetail || null,
    relevantNews,
    headToHead: h2h,
    timestamp: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════
// ALL GAMES — Collect data for every scheduled game
// ═══════════════════════════════════════════════════════════════════

function collectAllGames() {
  const scoreboard = loadJson('scoreboard.json');
  const events = scoreboard?.events || [];
  const allOdds = loadJson('live-odds.json');
  const news = loadJson('news.json');
  const oddsHistory = loadJson('odds-history.json');

  // Build team lookup
  const teamsData = loadJson('teams.json');
  const teamMap = {};
  if (teamsData?.sports?.[0]?.leagues?.[0]?.teams) {
    teamsData.sports[0].leagues[0].teams.forEach(t => {
      if (t.team) teamMap[t.team.id] = t.team;
    });
  }

  // Collect all games from scoreboard
  const games = [];
  events.forEach(ev => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    if (home?.team?.id && away?.team?.id) {
      const gameData = collectGame(away.team.id, home.team.id);
      if (gameData) {
        gameData.eventId = ev.id;
        gameData.date = ev.date || '';
        games.push(gameData);
      }
    }
  });

  // Also check team schedules for upcoming games not on scoreboard
  for (let t = 1; t <= 30; t++) {
    const sch = loadJson(`schedule-${t}.json`);
    if (!sch?.events) continue;
    sch.events.slice(0, 5).forEach(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      if (home?.team?.id && away?.team?.id) {
        const existing = games.find(g =>
          g.home.abbreviation === home.team.abbreviation &&
          g.away.abbreviation === away.team.abbreviation
        );
        if (!existing) {
          const gameData = collectGame(away.team.id, home.team.id);
          if (gameData) {
            gameData.eventId = ev.id;
            gameData.date = ev.date || '';
            games.push(gameData);
          }
        }
      }
    });
  }

  return {
    timestamp: new Date().toISOString(),
    totalGames: games.length,
    games,
    allOdds: allOdds || [],
    oddsHistory: oddsHistory || [],
    news: news || { articles: [] },
    totalPlayers: games.reduce((s, g) => s + (g.away?.players?.length || 0) + (g.home?.players?.length || 0), 0),
  };
}

// ═══════════════════════════════════════════════════════════════════
// MARKET CONTEXT — What the market is telling us
// ═══════════════════════════════════════════════════════════════════

function collectMarketContext() {
  const odds = loadJson('live-odds.json');
  const history = loadJson('odds-history.json');

  // Analyze line movements
  const movements = [];
  if (Array.isArray(odds)) {
    odds.forEach(g => {
      const books = g.bookmakers || [];
      if (books.length >= 2) {
        const spreads = books.map(b =>
          b.markets?.find(m => m.key === 'spreads')?.outcomes?.find(o => o.name === g.home_team)?.point
        ).filter(s => s != null);
        const totals = books.map(b =>
          b.markets?.find(m => m.key === 'totals')?.outcomes?.find(o => o.name === 'Over')?.point
        ).filter(t => t != null);
        const mls = books.map(b =>
          b.markets?.find(m => m.key === 'h2h')?.outcomes?.find(o => o.name === g.home_team)?.price
        ).filter(m => m != null);

        movements.push({
          matchup: `${g.away_team} @ ${g.home_team}`,
          spreadRange: spreads.length >= 2 ? Math.max(...spreads) - Math.min(...spreads) : 0,
          totalRange: totals.length >= 2 ? Math.max(...totals) - Math.min(...totals) : 0,
          mlRange: mls.length >= 2 ? Math.max(...mls) - Math.min(...mls) : 0,
          bestSpread: spreads.length ? Math.min(...spreads) : null,
          bestTotal: totals.length ? Math.max(...totals) : null,
          bookCount: books.length,
        });
      }
    });
  }

  return {
    movements,
    oddsHistory: history || [],
  };
}

module.exports = {
  collectPlayer,
  collectTeam,
  collectGame,
  collectAllGames,
  collectMarketContext,
  loadJson,
  saveJson,
};
