/**
 * SHARPEDGE Data Collector v2.0
 * 
 * Fetches real NBA data from ESPN APIs on server start.
 * Saves to both JSON files (for backward compat) AND SQLite database.
 * Runs in background, writes to data/ directory.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DATA = path.join(__dirname, '..', 'data');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function save(file, data) {
  if (data) {
    try { fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2)); }
    catch (e) { console.error(`[collector] Save ${file} error:`, e.message); }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Scoreboard (live scores + today's games)
// ═══════════════════════════════════════════════════════════════════
async function collectScoreboard() {
  const data = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard');
  if (data?.events) {
    save('scoreboard.json', data);
    console.log(`[collector] Scoreboard: ${data.events.length} games`);
    return data;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Standings
// ═══════════════════════════════════════════════════════════════════
async function collectStandings() {
  const data = await fetch('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings');
  if (data?.children) {
    save('standings.json', data);
    console.log(`[collector] Standings: ${data.children.length} conferences`);

    // Save to database
    try {
      const db = require('./db.cjs');
      const season = data.children?.[0]?.standings?.season || 2026;
      data.children.forEach(conference => {
        (conference.standings?.entries || []).forEach(entry => {
          db.upsertTeam(entry.team);
          db.upsertStanding(entry.team.id, entry.stats, season);
        });
      });
      console.log(`[collector] Standings saved to database`);
    } catch (e) {
      console.error(`[collector] DB standings error:`, e.message);
    }
  }
  return data;
}

// ═══════════════════════════════════════════════════════════════════
// Teams list
// ═══════════════════════════════════════════════════════════════════
async function collectTeams() {
  const data = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams');
  if (data?.sports) {
    save('teams.json', data);
    const teams = data.sports?.[0]?.leagues?.[0]?.teams || [];
    console.log(`[collector] Teams: ${teams.length} teams`);

    // Save to database
    try {
      const db = require('./db.cjs');
      teams.forEach(t => {
        if (t.team) {
          db.upsertTeam({
            ...t.team,
            venue: t.team.venue?.fullName || '',
            conference: t.team.groups?.abbreviation || '',
            division: t.team.groups?.name || '',
          });
        }
      });
      console.log(`[collector] Teams saved to database`);
    } catch (e) {
      console.error(`[collector] DB teams error:`, e.message);
    }

    return teams.map(t => t.team);
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════
// Roster for each team
// ═══════════════════════════════════════════════════════════════════
async function collectRosters(teams) {
  let count = 0;
  const db = require('./db.cjs');

  for (const team of teams) {
    const data = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team.id}/roster`);
    if (data?.athletes) {
      save(`roster-${team.id}.json`, data);
      count++;

      // Save roster players to database
      data.athletes.forEach(athlete => {
        db.upsertRosterPlayer(athlete, team.id);
      });
    }
  }
  console.log(`[collector] Rosters: ${count} teams`);
}

// ═══════════════════════════════════════════════════════════════════
// Team stats for each team
// ═══════════════════════════════════════════════════════════════════
async function collectTeamStats(teams) {
  let count = 0;
  for (const team of teams) {
    const data = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team.id}/statistics`);
    if (data) {
      save(`stats-${team.id}.json`, data);
      count++;
    }
  }
  console.log(`[collector] Team stats: ${count} teams`);
}

// ═══════════════════════════════════════════════════════════════════
// Team schedules (upcoming + past games)
// ═══════════════════════════════════════════════════════════════════
async function collectSchedules(teams) {
  let count = 0;
  const db = require('./db.cjs');

  for (const team of teams) {
    const data = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team.id}/schedule`);
    if (data?.events) {
      save(`schedule-${team.id}.json`, data);
      count++;

      // Save games to database
      data.events.forEach(ev => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === 'home');
        const away = comp?.competitors?.find(c => c.homeAway === 'away');
        if (home?.team?.id && away?.team?.id) {
          db.upsertGame({
            id: ev.id,
            season: ev.season?.year || 2027,
            week: ev.week?.number || 0,
            date: ev.date || '',
            awayTeamId: away.team.id,
            homeTeamId: home.team.id,
            awayScore: parseInt(away.score) || 0,
            homeScore: parseInt(home.score) || 0,
            status: comp.status?.type?.name || 'STATUS_SCHEDULED',
            isCompleted: comp.status?.type?.completed || false,
            venue: comp.venue?.fullName || '',
          });
        }
      });
    }
  }
  console.log(`[collector] Schedules: ${count} teams`);
}

// ═══════════════════════════════════════════════════════════════════
// Player gamelog for each player on each team
// ═══════════════════════════════════════════════════════════════════
async function collectPlayerData(teams) {
  let playerCount = 0;
  let gamelogCount = 0;
  const playerIds = new Set();
  const db = require('./db.cjs');

  for (const team of teams) {
    // Read roster
    let roster;
    try {
      roster = JSON.parse(fs.readFileSync(path.join(DATA, `roster-${team.id}.json`), 'utf8'));
    } catch { continue; }

    const athletes = roster.athletes || [];
    for (const athlete of athletes) {
      if (playerIds.has(athlete.id)) continue;
      playerIds.add(athlete.id);

      // Player info
      const playerData = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/athletes/${athlete.id}`);
      if (playerData?.id) {
        save(`player-${athlete.id}.json`, playerData);
        db.upsertPlayer(playerData, team.id);
        playerCount++;
      }

      // Player gamelog
      const gamelog = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/athletes/${athlete.id}/gamelog`);
      if (gamelog?.events || gamelog?.seasonTypes) {
        save(`player-gamelog-${athlete.id}.json`, gamelog);
        const inserted = db.upsertGamelog(athlete.id, gamelog);
        if (inserted > 0) gamelogCount++;
      }
    }
  }

  console.log(`[collector] Players: ${playerCount} profiles, ${gamelogCount} gamelogs`);
}

// ═══════════════════════════════════════════════════════════════════
// News
// ═══════════════════════════════════════════════════════════════════
async function collectNews() {
  const data = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news');
  if (data) {
    save('news.json', data);
    const count = data.articles?.length || 0;
    console.log(`[collector] News: ${count} articles`);

    // Save to database
    try {
      const db = require('./db.cjs');
      db.saveNews(data);
    } catch (e) {
      console.error(`[collector] DB news error:`, e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main Collection Pipeline
// ═══════════════════════════════════════════════════════════════════
async function collectAll() {
  console.log('[collector] Starting data collection...');
  const start = Date.now();

  // Core data first (fast)
  await Promise.all([
    collectScoreboard(),
    collectStandings(),
    collectNews()
  ]);

  // Teams (needed for rosters/players)
  const teams = await collectTeams();
  if (!teams.length) {
    console.log('[collector] No teams found, aborting');
    return;
  }

  // Rosters (needed for player IDs)
  await collectRosters(teams);

  // Team stats
  await collectTeamStats(teams);

  // Schedules (upcoming + past games)
  await collectSchedules(teams);

  // Player data (slowest - many API calls)
  await collectPlayerData(teams);

  // Record collection time
  try {
    const db = require('./db.cjs');
    db.setMeta('last_collection', new Date().toISOString());
    const stats = db.getDbStats();
    console.log(`[collector] DB stats: ${stats.teams} teams, ${stats.players} players, ${stats.gamelogs} gamelogs, ${stats.games} games`);
  } catch {}

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[collector] Done in ${elapsed}s`);
}

module.exports = { collectAll };

// Run if called directly
if (require.main === module) {
  collectAll().catch(console.error);
}
