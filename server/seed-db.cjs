/**
 * SEED DATABASE from existing JSON files
 * 
 * Reads all the JSON data files in data/ and populates the SQLite database.
 * Run this once after creating a fresh database: node server/seed-db.cjs
 */
const fs = require('fs');
const path = require('path');
const db = require('./db.cjs');

const DATA = path.join(__dirname, '..', 'data');

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// SEED TEAMS
// ═══════════════════════════════════════════════════════════════════
function seedTeams() {
  console.log('[seed] Seeding teams...');
  
  // From teams.json
  const data = loadJson('teams.json');
  if (!data?.sports?.[0]?.leagues?.[0]?.teams) {
    console.log('[seed] No teams.json found');
    return;
  }
  
  const teams = data.sports[0].leagues[0].teams;
  let count = 0;
  
  for (const t of teams) {
    if (!t.team) continue;
    db.upsertTeam({
      ...t.team,
      venue: t.team.venue?.fullName || '',
      conference: t.team.groups?.abbreviation || '',
      division: t.team.groups?.name || '',
    });
    count++;
  }
  
  console.log(`[seed] Seeded ${count} teams`);
  
  // Also load team-specific files
  for (let i = 1; i <= 30; i++) {
    const teamFile = loadJson(`team-${i}.json`);
    if (teamFile?.team) {
      db.upsertTeam({
        ...teamFile.team,
        venue: teamFile.team.venue?.fullName || '',
        conference: teamFile.team.groups?.abbreviation || '',
        division: teamFile.team.groups?.name || '',
      });
    }
  }
  
  console.log(`[seed] Updated teams from individual team files`);
}

// ═══════════════════════════════════════════════════════════════════
// SEED STANDINGS
// ═══════════════════════════════════════════════════════════════════
function seedStandings() {
  console.log('[seed] Seeding standings...');
  const data = loadJson('standings.json');
  if (!data?.children) {
    console.log('[seed] No standings.json found');
    return;
  }
  
  let count = 0;
  for (const conference of data.children) {
    for (const entry of (conference.standings?.entries || [])) {
      db.upsertTeam(entry.team);
      db.upsertStanding(entry.team.id, entry.stats, data.children[0]?.standings?.season || 2026);
      count++;
    }
  }
  
  console.log(`[seed] Seeded ${count} standings`);
}

// ═══════════════════════════════════════════════════════════════════
// SEED ROSTERS
// ═══════════════════════════════════════════════════════════════════
function seedRosters() {
  console.log('[seed] Seeding rosters...');
  let totalPlayers = 0;
  
  for (let i = 1; i <= 30; i++) {
    const roster = loadJson(`roster-${i}.json`);
    if (!roster?.athletes) continue;
    
    for (const athlete of roster.athletes) {
      db.upsertRosterPlayer(athlete, String(i));
      totalPlayers++;
    }
  }
  
  console.log(`[seed] Seeded ${totalPlayers} roster players`);
}

// ═══════════════════════════════════════════════════════════════════
// SEED PLAYER PROFILES
// ═══════════════════════════════════════════════════════════════════
function seedPlayerProfiles() {
  console.log('[seed] Seeding player profiles...');
  let count = 0;
  const files = fs.readdirSync(DATA).filter(f => f.startsWith('player-') && f.endsWith('.json') && !f.includes('gamelog') && !f.includes('stats'));
  
  for (const file of files) {
    const data = loadJson(file);
    if (data?.id) {
      // Find team ID from the player data
      const teamId = data.team?.id || data.teamId || '';
      db.upsertPlayer(data, teamId);
      count++;
    }
  }
  
  console.log(`[seed] Seeded ${count} player profiles`);
}

// ═══════════════════════════════════════════════════════════════════
// SEED GAMELOGS
// ═══════════════════════════════════════════════════════════════════
function seedGamelogs() {
  console.log('[seed] Seeding player gamelogs...');
  let count = 0;
  const files = fs.readdirSync(DATA).filter(f => f.startsWith('player-gamelog-') && f.endsWith('.json'));
  
  for (const file of files) {
    const data = loadJson(file);
    if (!data) continue;
    
    const playerId = file.replace('player-gamelog-', '').replace('.json', '');
    const inserted = db.upsertGamelog(playerId, data);
    if (inserted > 0) count++;
  }
  
  console.log(`[seed] Seeded gamelogs for ${count} players`);
}

// ═══════════════════════════════════════════════════════════════════
// SEED GAMES (SCHEDULES)
// ═══════════════════════════════════════════════════════════════════
function seedGames() {
  console.log('[seed] Seeding games from schedules...');
  let count = 0;
  const seen = new Set();
  
  for (let i = 1; i <= 30; i++) {
    const schedule = loadJson(`schedule-${i}.json`);
    if (!schedule?.events) continue;
    
    for (const ev of schedule.events) {
      // Deduplicate games (same game appears in both team schedules)
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      
      if (home?.team?.id && away?.team?.id) {
        db.upsertGame({
          id: ev.id,
          season: ev.season?.year || 2026,
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
        count++;
      }
    }
  }
  
  console.log(`[seed] Seeded ${count} games`);
}

// ═══════════════════════════════════════════════════════════════════
// SEED ODDS
// ═══════════════════════════════════════════════════════════════════
function seedOdds() {
  console.log('[seed] Seeding odds...');
  const data = loadJson('live-odds.json');
  const games = Array.isArray(data) ? data : [];
  
  if (games.length === 0) {
    console.log('[seed] No odds data found');
    return;
  }
  
  db.saveOddsBatch(games);
  db.setMeta('last_odds_fetch', new Date().toISOString());
  console.log(`[seed] Seeded odds for ${games.length} games`);
}

// ═══════════════════════════════════════════════════════════════════
// SEED NEWS
// ═══════════════════════════════════════════════════════════════════
function seedNews() {
  console.log('[seed] Seeding news...');
  const data = loadJson('news.json');
  if (!data) {
    console.log('[seed] No news.json found');
    return;
  }
  
  db.saveNews(data);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SEED
// ═══════════════════════════════════════════════════════════════════
function seedAll() {
  console.log('═══════════════════════════════════════════════');
  console.log('  SHARPEDGE Database Seeder');
  console.log('═══════════════════════════════════════════════');
  
  const start = Date.now();
  
  seedTeams();
  seedStandings();
  seedRosters();
  seedPlayerProfiles();
  seedGamelogs();
  seedGames();
  seedOdds();
  seedNews();
  
  // Record completion
  db.setMeta('last_collection', new Date().toISOString());
  
  // Print stats
  const stats = db.getDbStats();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  
  console.log('═══════════════════════════════════════════════');
  console.log(`  Database seeded in ${elapsed}s`);
  console.log(`  Teams:     ${stats.teams}`);
  console.log(`  Players:   ${stats.players}`);
  console.log(`  Gamelogs:  ${stats.gamelogs}`);
  console.log(`  Games:     ${stats.games}`);
  console.log(`  Odds:      ${stats.odds}`);
  console.log(`  News:      ${stats.news}`);
  console.log('═══════════════════════════════════════════════');
  
  db.closeDb();
}

seedAll();
