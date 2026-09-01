/**
 * SHARPEDGE SQLite Database
 * 
 * Persistent storage for all NBA data collected from ESPN and odds APIs.
 * Replaces scattered JSON files with a single queryable database.
 * Data is collected once and reused until refreshed.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA, 'sharpedge.db');

let db = null;

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  // Add new columns for transparency (safe to run multiple times)
  try { db.exec(`ALTER TABLE match_player_props ADD COLUMN line_source TEXT DEFAULT 'estimated'`); } catch {}
  try { db.exec(`ALTER TABLE match_player_props ADD COLUMN hit_rate_at_fair_line REAL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE match_player_props ADD COLUMN real_hit_rate INTEGER DEFAULT 0`); } catch {}
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════

function initSchema() {
  db.exec(`
    -- Teams
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      abbreviation TEXT,
      short_name TEXT,
      logo TEXT,
      venue TEXT,
      conference TEXT,
      division TEXT,
      color TEXT,
      is_active INTEGER DEFAULT 1,
      raw_json TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Standings
    CREATE TABLE IF NOT EXISTS standings (
      team_id TEXT PRIMARY KEY,
      season INTEGER,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      win_pct REAL DEFAULT 0,
      ppg REAL DEFAULT 0,
      oppg REAL DEFAULT 0,
      differential REAL DEFAULT 0,
      streak INTEGER DEFAULT 0,
      streak_type TEXT,
      home_record TEXT,
      road_record TEXT,
      last_10 TEXT,
      conference_record TEXT,
      division_record TEXT,
      clincher TEXT,
      playoff_seed INTEGER,
      raw_stats TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    -- Players
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      full_name TEXT,
      team_id TEXT,
      position TEXT,
      jersey TEXT,
      height TEXT,
      weight TEXT,
      age INTEGER,
      experience TEXT,
      draft TEXT,
      headshot TEXT,
      status TEXT DEFAULT 'Active',
      raw_json TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    -- Player gamelogs (per-game stats)
    CREATE TABLE IF NOT EXISTS player_gamelogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      event_id TEXT,
      game_date TEXT,
      opponent TEXT,
      is_home INTEGER,
      result TEXT,
      score TEXT,
      minutes REAL,
      pts REAL,
      reb REAL,
      ast REAL,
      stl REAL,
      blk REAL,
      tov REAL,
      fg_made INTEGER,
      fg_att INTEGER,
      fg_pct REAL,
      three_made INTEGER,
      three_att INTEGER,
      three_pct REAL,
      ft_made INTEGER,
      ft_att INTEGER,
      ft_pct REAL,
      plus_minus REAL,
      raw_stats TEXT,
      UNIQUE(player_id, event_id),
      FOREIGN KEY (player_id) REFERENCES players(id)
    );

    -- Team schedules (upcoming and past games)
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      season INTEGER,
      week INTEGER,
      date TEXT,
      away_team_id TEXT,
      home_team_id TEXT,
      away_score INTEGER,
      home_score INTEGER,
      status TEXT,
      is_completed INTEGER DEFAULT 0,
      venue TEXT,
      raw_json TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Odds (current snapshot from sportsbooks)
    CREATE TABLE IF NOT EXISTS odds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT,
      sport_key TEXT,
      commence_time TEXT,
      home_team TEXT,
      away_team TEXT,
      bookmaker TEXT,
      market_key TEXT,
      outcome_name TEXT,
      outcome_price REAL,
      outcome_point REAL,
      last_update TEXT,
      UNIQUE(game_id, bookmaker, market_key, outcome_name)
    );

    -- Odds history (line movement tracking)
    CREATE TABLE IF NOT EXISTS odds_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT,
      snapshot_time TEXT,
      home_team TEXT,
      away_team TEXT,
      bookmaker TEXT,
      market_key TEXT,
      outcome_name TEXT,
      price REAL,
      point REAL
    );

    -- Collection metadata
    CREATE TABLE IF NOT EXISTS collection_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- News
    CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY,
      headline TEXT,
      description TEXT,
      published TEXT,
      category TEXT,
      teams TEXT,
      link TEXT,
      image TEXT,
      raw_json TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for fast queries
    CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
    CREATE INDEX IF NOT EXISTS idx_gamelogs_player ON player_gamelogs(player_id);
    CREATE INDEX IF NOT EXISTS idx_gamelogs_date ON player_gamelogs(game_date);
    CREATE INDEX IF NOT EXISTS idx_games_date ON games(date);
    CREATE INDEX IF NOT EXISTS idx_games_home ON games(home_team_id);
    CREATE INDEX IF NOT EXISTS idx_games_away ON games(away_team_id);
    CREATE INDEX IF NOT EXISTS idx_odds_game ON odds(game_id);
    CREATE INDEX IF NOT EXISTS idx_odds_history_game ON odds_history(game_id);
    CREATE INDEX IF NOT EXISTS idx_odds_history_time ON odds_history(snapshot_time);
    CREATE INDEX IF NOT EXISTS idx_news_published ON news(published);

    -- ═══════════════════════════════════════════════════════════
    -- LIVE PROPS & PREDICTIONS
    -- ═══════════════════════════════════════════════════════════

    -- Match predictions (one per game with overall score)
    CREATE TABLE IF NOT EXISTS match_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      away_team_id TEXT,
      home_team_id TEXT,
      home_win_prob REAL,
      predicted_margin REAL,
      home_score_pred REAL,
      away_score_pred REAL,
      sharp_signal TEXT,
      sharp_score REAL DEFAULT 0,
      confidence TEXT DEFAULT 'LOW',
      model_version TEXT DEFAULT 'v4',
      generated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(game_id)
    );

    -- Player props per match (assigned to specific games)
    CREATE TABLE IF NOT EXISTS match_player_props (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      player_name TEXT,
      team_abbr TEXT,
      opponent_abbr TEXT,
      is_home INTEGER DEFAULT 0,
      stat TEXT NOT NULL,
      season_avg REAL,
      last5_avg REAL,
      last10_avg REAL,
      projected_value REAL,
      fair_line REAL,
      sportsbook_line REAL,
      edge REAL,
      recommendation TEXT,
      confidence TEXT DEFAULT 'LOW',
      value_rating TEXT DEFAULT 'AVOID',
      prop_score REAL DEFAULT 0,
      kelly_pct REAL DEFAULT 0,
      hit_rate REAL DEFAULT 0,
      consistency_cv REAL DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      defense_rating TEXT,
      pace_factor REAL,
      injury_boost REAL DEFAULT 1.0,
      factors TEXT,
      model_version TEXT DEFAULT 'v4',
      generated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(game_id, player_id, stat)
    );

    -- Live betting snapshots (for real-time prop tracking)
    CREATE TABLE IF NOT EXISTS live_props (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      player_name TEXT,
      stat TEXT NOT NULL,
      current_line REAL,
      our_projection REAL,
      edge REAL,
      recommendation TEXT,
      confidence TEXT,
      book_line REAL,
      book_odds INTEGER,
      odds_changed_at TEXT,
      snapshot_time TEXT DEFAULT (datetime('now'))
    );

    -- Sharp money tracking per game
    CREATE TABLE IF NOT EXISTS sharp_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      signal_type TEXT,
      signal_strength REAL DEFAULT 0,
      ml_gap REAL DEFAULT 0,
      spread_gap REAL DEFAULT 0,
      total_gap REAL DEFAULT 0,
      bookmakers INTEGER DEFAULT 0,
      detected_at TEXT DEFAULT (datetime('now'))
    );

    -- Model accuracy tracking
    CREATE TABLE IF NOT EXISTS prediction_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT,
      player_id TEXT,
      stat TEXT,
      predicted_line REAL,
      actual_value REAL,
      recommendation TEXT,
      was_correct INTEGER DEFAULT 0,
      edge_at_prediction REAL,
      resolved_at TEXT
    );

    -- Indexes for fast props queries
    CREATE INDEX IF NOT EXISTS idx_props_game ON match_player_props(game_id);
    CREATE INDEX IF NOT EXISTS idx_props_player ON match_player_props(player_id);
    CREATE INDEX IF NOT EXISTS idx_props_stat ON match_player_props(stat);
    CREATE INDEX IF NOT EXISTS idx_props_score ON match_player_props(prop_score DESC);
    CREATE INDEX IF NOT EXISTS idx_live_props_game ON live_props(game_id);
    CREATE INDEX IF NOT EXISTS idx_predictions_game ON match_predictions(game_id);
    CREATE INDEX IF NOT EXISTS idx_sharp_game ON sharp_signals(game_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_game ON prediction_outcomes(game_id);
  `);

  console.log('[db] Schema initialized');
}

// ═══════════════════════════════════════════════════════════════════
// TEAM OPERATIONS
// ═══════════════════════════════════════════════════════════════════

function upsertTeam(team) {
  const db = getDb();
  db.prepare(`
    INSERT INTO teams (id, name, abbreviation, short_name, logo, venue, conference, division, color, raw_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, abbreviation=excluded.abbreviation, short_name=excluded.short_name,
      logo=excluded.logo, venue=excluded.venue, conference=excluded.conference,
      division=excluded.division, color=excluded.color, raw_json=excluded.raw_json,
      updated_at=datetime('now')
  `).run(
    String(team.id),
    team.displayName || team.name || '',
    team.abbreviation || '',
    team.shortDisplayName || '',
    team.logos?.[0]?.href || '',
    '',
    '',
    '',
    team.color || '',
    JSON.stringify(team)
  );
}

function upsertStanding(teamId, stats, season) {
  const db = getDb();
  const s = {};
  (stats || []).forEach(x => { s[x.name] = x.value; });

  db.prepare(`
    INSERT INTO standings (team_id, season, wins, losses, win_pct, ppg, oppg, differential,
      streak, streak_type, home_record, road_record, last_10, conference_record, division_record,
      clincher, playoff_seed, raw_stats, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(team_id) DO UPDATE SET
      season=excluded.season, wins=excluded.wins, losses=excluded.losses,
      win_pct=excluded.win_pct, ppg=excluded.ppg, oppg=excluded.oppg,
      differential=excluded.differential, streak=excluded.streak, streak_type=excluded.streak_type,
      home_record=excluded.home_record, road_record=excluded.road_record, last_10=excluded.last_10,
      conference_record=excluded.conference_record, division_record=excluded.division_record,
      clincher=excluded.clincher, playoff_seed=excluded.playoff_seed, raw_stats=excluded.raw_stats,
      updated_at=datetime('now')
  `).run(
    String(teamId),
    season || 2026,
    s.wins || 0,
    s.losses || 0,
    s.winPercent || 0,
    s.avgPointsFor || 0,
    s.avgPointsAgainst || 0,
    s.differential || 0,
    s.streak?.value || 0,
    s.streak?.abbreviation || '',
    s.home || '',
    s.road || '',
    s.record || '',
    s.conferenceRecord || '',
    s.divisionRecord || '',
    s.clincher?.abbreviation || '',
    s.playoffSeed || 0,
    JSON.stringify(stats)
  );
}

// ═══════════════════════════════════════════════════════════════════
// PLAYER OPERATIONS
// ═══════════════════════════════════════════════════════════════════

function upsertPlayer(player, teamId) {
  const db = getDb();
  const ath = player.athlete || player;
  db.prepare(`
    INSERT INTO players (id, first_name, last_name, full_name, team_id, position, jersey,
      height, weight, age, experience, draft, headshot, status, raw_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      first_name=excluded.first_name, last_name=excluded.last_name, full_name=excluded.full_name,
      team_id=excluded.team_id, position=excluded.position, jersey=excluded.jersey,
      height=excluded.height, weight=excluded.weight, age=excluded.age,
      experience=excluded.experience, draft=excluded.draft, headshot=excluded.headshot,
      status=excluded.status, raw_json=excluded.raw_json, updated_at=datetime('now')
  `).run(
    String(ath.id || player.id),
    ath.firstName || '',
    ath.lastName || '',
    ath.displayName || `${ath.firstName || ''} ${ath.lastName || ''}`.trim(),
    String(teamId),
    ath.position?.abbreviation || '',
    ath.jersey || '',
    ath.displayHeight || '',
    ath.displayWeight || '',
    ath.age || 0,
    ath.displayExperience || '',
    ath.displayDraft || '',
    ath.headshot?.href || '',
    ath.status?.abbreviation || 'Active',
    JSON.stringify(player)
  );
}

function upsertRosterPlayer(rosterPlayer, teamId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO players (id, first_name, last_name, full_name, team_id, position, jersey,
      height, weight, age, headshot, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      first_name=excluded.first_name, last_name=excluded.last_name, full_name=excluded.full_name,
      team_id=excluded.team_id, position=excluded.position, jersey=excluded.jersey,
      height=excluded.height, weight=excluded.weight, age=excluded.age,
      headshot=excluded.headshot, status=excluded.status, updated_at=datetime('now')
  `).run(
    String(rosterPlayer.id),
    rosterPlayer.firstName || '',
    rosterPlayer.lastName || '',
    rosterPlayer.displayName || `${rosterPlayer.firstName || ''} ${rosterPlayer.lastName || ''}`.trim(),
    String(teamId),
    rosterPlayer.position?.abbreviation || '',
    rosterPlayer.jersey || '',
    rosterPlayer.displayHeight || '',
    rosterPlayer.displayWeight || '',
    rosterPlayer.age || 0,
    rosterPlayer.headshot?.href || '',
    rosterPlayer.injuries?.length ? rosterPlayer.injuries[0].status : 'Active'
  );
}

// ═══════════════════════════════════════════════════════════════════
// GAMELOG OPERATIONS
// ═══════════════════════════════════════════════════════════════════

function upsertGamelog(playerId, gamelog) {
  const db = getDb();
  if (!gamelog?.labels || !gamelog?.seasonTypes) return 0;

  const labels = gamelog.labels;
  const reg = gamelog.seasonTypes.find(s => (s.displayName || s.name || '').includes('Regular'));
  if (!reg) return 0;

  const stmt = db.prepare(`
    INSERT INTO player_gamelogs (player_id, event_id, game_date, opponent, is_home, result, score,
      minutes, pts, reb, ast, stl, blk, tov, fg_made, fg_att, fg_pct,
      three_made, three_att, three_pct, ft_made, ft_att, ft_pct, plus_minus, raw_stats)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, event_id) DO UPDATE SET
      game_date=excluded.game_date, opponent=excluded.opponent, is_home=excluded.is_home,
      result=excluded.result, score=excluded.score, minutes=excluded.minutes,
      pts=excluded.pts, reb=excluded.reb, ast=excluded.ast, stl=excluded.stl,
      blk=excluded.blk, tov=excluded.tov, fg_made=excluded.fg_made, fg_att=excluded.fg_att,
      fg_pct=excluded.fg_pct, three_made=excluded.three_made, three_att=excluded.three_att,
      three_pct=excluded.three_pct, ft_made=excluded.ft_made, ft_att=excluded.ft_att,
      ft_pct=excluded.ft_pct, plus_minus=excluded.plus_minus, raw_stats=excluded.raw_stats
  `);

  let count = 0;
  const insertMany = db.transaction((events) => {
    for (const ev of events) {
      const stats = {};
      labels.forEach((l, i) => { stats[l] = ev.stats?.[i] || ''; });

      const parseFrac = (val) => {
        const parts = String(val || '0').split('-');
        return { made: parseInt(parts[0]) || 0, att: parseInt(parts[1]) || 0 };
      };
      const fg = parseFrac(stats.FG);
      const three = parseFrac(stats['3PT']);
      const ft = parseFrac(stats.FT);

      try {
        stmt.run(
          String(playerId),
          String(ev.eventId || ''),
          ev.gameDate || '',
          ev.opponent?.abbreviation || '',
          ev.atVs === 'vs' ? 1 : 0,
          ev.gameResult || '',
          ev.score || '',
          parseFloat(stats.MIN) || 0,
          parseFloat(stats.PTS) || 0,
          parseFloat(stats.REB) || 0,
          parseFloat(stats.AST) || 0,
          parseFloat(stats.STL) || 0,
          parseFloat(stats.BLK) || 0,
          parseFloat(stats.TO) || 0,
          fg.made, fg.att,
          fg.att > 0 ? (fg.made / fg.att) : 0,
          three.made, three.att,
          three.att > 0 ? (three.made / three.att) : 0,
          ft.made, ft.att,
          ft.att > 0 ? (ft.made / ft.att) : 0,
          parseFloat(stats['+/-']) || 0,
          JSON.stringify(stats)
        );
        count++;
      } catch {}
    }
  });

  const allEvents = [];
  (reg.categories || []).forEach(cat => {
    (cat.events || []).forEach(ev => allEvents.push(ev));
  });

  insertMany(allEvents);
  return count;
}

// ═══════════════════════════════════════════════════════════════════
// GAME / SCHEDULE OPERATIONS
// ═══════════════════════════════════════════════════════════════════

function upsertGame(game) {
  const db = getDb();
  db.prepare(`
    INSERT INTO games (id, season, week, date, away_team_id, home_team_id,
      away_score, home_score, status, is_completed, venue, raw_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      season=excluded.season, week=excluded.week, date=excluded.date,
      away_team_id=excluded.away_team_id, home_team_id=excluded.home_team_id,
      away_score=excluded.away_score, home_score=excluded.home_score,
      status=excluded.status, is_completed=excluded.is_completed,
      venue=excluded.venue, raw_json=excluded.raw_json, updated_at=datetime('now')
  `).run(
    String(game.id),
    game.season || 2027,
    game.week || 0,
    game.date || '',
    game.awayTeamId || '',
    game.homeTeamId || '',
    game.awayScore || 0,
    game.homeScore || 0,
    game.status || 'STATUS_SCHEDULED',
    game.isCompleted ? 1 : 0,
    game.venue || '',
    JSON.stringify(game)
  );
}

// ═══════════════════════════════════════════════════════════════════
// ODDS OPERATIONS
// ═══════════════════════════════════════════════════════════════════

function saveOddsBatch(oddsData) {
  const db = getDb();

  // Clear current odds (replace with latest snapshot)
  db.prepare('DELETE FROM odds').run();

  const stmt = db.prepare(`
    INSERT INTO odds (game_id, sport_key, commence_time, home_team, away_team,
      bookmaker, market_key, outcome_name, outcome_price, outcome_point, last_update)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction((games) => {
    for (const game of (Array.isArray(games) ? games : [])) {
      for (const book of (game.bookmakers || [])) {
        for (const market of (book.markets || [])) {
          for (const outcome of (market.outcomes || [])) {
            stmt.run(
              game.id || '',
              game.sport_key || '',
              game.commence_time || '',
              game.home_team || '',
              game.away_team || '',
              book.key || book.title || '',
              market.key || '',
              outcome.name || '',
              outcome.price || 0,
              outcome.point || 0,
              book.last_update || ''
            );
          }
        }
      }
    }
  });

  insertAll(oddsData);

  // Also append to history for line movement tracking
  const historyStmt = db.prepare(`
    INSERT INTO odds_history (game_id, snapshot_time, home_team, away_team,
      bookmaker, market_key, outcome_name, price, point)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertHistory = db.transaction((games) => {
    for (const game of (Array.isArray(games) ? games : [])) {
      for (const book of (game.bookmakers || [])) {
        for (const market of (book.markets || [])) {
          for (const outcome of (market.outcomes || [])) {
            historyStmt.run(
              game.id || '',
              game.home_team || '',
              game.away_team || '',
              book.key || book.title || '',
              market.key || '',
              outcome.name || '',
              outcome.price || 0,
              outcome.point || 0
            );
          }
        }
      }
    }
  });

  insertHistory(oddsData);

  // Prune history older than 30 days
  db.prepare(`DELETE FROM odds_history WHERE snapshot_time < datetime('now', '-30 days')`).run();

  console.log(`[db] Saved odds for ${(Array.isArray(oddsData) ? oddsData : []).length} games`);
}

// ═══════════════════════════════════════════════════════════════════
// NEWS OPERATIONS
// ═══════════════════════════════════════════════════════════════════

function saveNews(newsData) {
  const db = getDb();
  const articles = newsData?.articles || [];

  const stmt = db.prepare(`
    INSERT INTO news (id, headline, description, published, category, teams, link, image, raw_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      headline=excluded.headline, description=excluded.description, published=excluded.published,
      category=excluded.category, teams=excluded.teams, link=excluded.link, image=excluded.image,
      raw_json=excluded.raw_json, updated_at=datetime('now')
  `);

  for (const article of articles) {
    stmt.run(
      article.id || article.headline?.slice(0, 50) || String(Date.now()),
      article.headline || '',
      article.description || '',
      article.published || article.lastPublished || '',
      article.category || '',
      JSON.stringify(article.teams || []),
      article.links?.web?.href || article.links?.[0]?.href || '',
      article.images?.[0]?.url || article.thumbnail?.url || '',
      JSON.stringify(article)
    );
  }

  console.log(`[db] Saved ${articles.length} news articles`);
}

// ═══════════════════════════════════════════════════════════════════
// QUERY FUNCTIONS (read from DB instead of JSON files)
// ═══════════════════════════════════════════════════════════════════

function getAllTeams() {
  const db = getDb();
  return db.prepare('SELECT * FROM teams WHERE is_active = 1 ORDER BY name').all();
}

function getTeam(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(String(id));
}

function getTeamStanding(teamId) {
  const db = getDb();
  return db.prepare('SELECT * FROM standings WHERE team_id = ?').get(String(teamId));
}

function getAllStandings() {
  const db = getDb();
  return db.prepare(`
    SELECT t.id, t.name, t.abbreviation, t.logo,
      s.wins, s.losses, s.win_pct, s.ppg, s.oppg, s.differential,
      s.streak, s.streak_type, s.home_record, s.road_record, s.last_10,
      s.conference_record, s.clincher, s.playoff_seed
    FROM teams t
    LEFT JOIN standings s ON t.id = s.team_id
    WHERE t.is_active = 1
    ORDER BY s.wins DESC, s.losses ASC
  `).all();
}

function getTeamRoster(teamId) {
  const db = getDb();
  return db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY position, last_name').all(String(teamId));
}

function getPlayer(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM players WHERE id = ?').get(String(id));
}

function getPlayerGamelog(playerId) {
  const db = getDb();
  return db.prepare('SELECT * FROM player_gamelogs WHERE player_id = ? ORDER BY game_date DESC').all(String(playerId));
}

function getPlayerAverages(playerId) {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) as games,
      ROUND(AVG(pts), 1) as ppg,
      ROUND(AVG(reb), 1) as rpg,
      ROUND(AVG(ast), 1) as apg,
      ROUND(AVG(stl), 1) as spg,
      ROUND(AVG(blk), 1) as bpg,
      ROUND(AVG(tov), 1) as topg,
      ROUND(AVG(minutes), 1) as mpg,
      ROUND(SUM(fg_made) * 100.0 / NULLIF(SUM(fg_att), 0), 1) as fg_pct,
      ROUND(SUM(three_made) * 100.0 / NULLIF(SUM(three_att), 0), 1) as three_pct,
      ROUND(SUM(ft_made) * 100.0 / NULLIF(SUM(ft_att), 0), 1) as ft_pct
    FROM player_gamelogs
    WHERE player_id = ?
  `).get(String(playerId));
}

function getPlayerAveragesLastN(playerId, n) {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) as games,
      ROUND(AVG(pts), 1) as ppg,
      ROUND(AVG(reb), 1) as rpg,
      ROUND(AVG(ast), 1) as apg,
      ROUND(AVG(stl), 1) as spg,
      ROUND(AVG(blk), 1) as bpg,
      ROUND(AVG(tov), 1) as topg
    FROM (
      SELECT * FROM player_gamelogs
      WHERE player_id = ?
      ORDER BY game_date DESC
      LIMIT ?
    )
  `).get(String(playerId), n);
}

function getUpcomingGames() {
  const db = getDb();
  return db.prepare(`
    SELECT g.*,
      ht.name as home_team_name, ht.abbreviation as home_abbr, ht.logo as home_logo,
      at.name as away_team_name, at.abbreviation as away_abbr, at.logo as away_logo,
      hs.wins as home_wins, hs.losses as home_losses, hs.ppg as home_ppg, hs.oppg as home_oppg,
      aws.wins as away_wins, aws.losses as away_losses, aws.ppg as away_ppg, aws.oppg as away_oppg
    FROM games g
    LEFT JOIN teams ht ON g.home_team_id = ht.id
    LEFT JOIN teams at ON g.away_team_id = at.id
    LEFT JOIN standings hs ON g.home_team_id = hs.team_id
    LEFT JOIN standings aws ON g.away_team_id = aws.team_id
    WHERE g.is_completed = 0
    ORDER BY g.date ASC
    LIMIT 50
  `).all();
}

function getGameOdds(homeTeamName, awayTeamName) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM odds
    WHERE (home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?)
    ORDER BY bookmaker, market_key
  `).all(homeTeamName, awayTeamName, awayTeamName, homeTeamName);
}

function getOddsByGameId(gameId) {
  const db = getDb();
  return db.prepare('SELECT * FROM odds WHERE game_id = ? ORDER BY bookmaker, market_key').all(gameId);
}

function getOddsMovements(homeTeam, awayTeam) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM odds_history
    WHERE (home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?)
    ORDER BY snapshot_time DESC
    LIMIT 200
  `).all(homeTeam, awayTeam, awayTeam, homeTeam);
}

function getNews() {
  const db = getDb();
  return db.prepare('SELECT * FROM news ORDER BY published DESC LIMIT 100').all();
}

function searchTeams(query) {
  const db = getDb();
  const q = `%${query.toLowerCase()}%`;
  return db.prepare(`
    SELECT id, name, abbreviation, logo FROM teams
    WHERE LOWER(name) LIKE ? OR LOWER(abbreviation) LIKE ? OR LOWER(short_name) LIKE ?
    LIMIT 10
  `).all(q, q, q);
}

function searchPlayers(query) {
  const db = getDb();
  const q = `%${query.toLowerCase()}%`;
  return db.prepare(`
    SELECT p.id, p.full_name, p.position, p.jersey, p.team_id, p.headshot,
      t.name as team_name, t.abbreviation as team_abbr
    FROM players p
    LEFT JOIN teams t ON p.team_id = t.id
    WHERE LOWER(p.full_name) LIKE ? OR LOWER(p.last_name) LIKE ?
    LIMIT 15
  `).all(q, q);
}

function setMeta(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO collection_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(key, value);
}

function getMeta(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM collection_meta WHERE key = ?').get(key);
  return row?.value || null;
}

function getDbStats() {
  const db = getDb();
  return {
    teams: db.prepare('SELECT COUNT(*) as c FROM teams').get().c,
    players: db.prepare('SELECT COUNT(*) as c FROM players').get().c,
    gamelogs: db.prepare('SELECT COUNT(*) as c FROM player_gamelogs').get().c,
    games: db.prepare('SELECT COUNT(*) as c FROM games').get().c,
    odds: db.prepare('SELECT COUNT(*) as c FROM odds').get().c,
    oddsHistory: db.prepare('SELECT COUNT(*) as c FROM odds_history').get().c,
    news: db.prepare('SELECT COUNT(*) as c FROM news').get().c,
    lastCollection: getMeta('last_collection'),
  };
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// MATCH PREDICTIONS
// ═══════════════════════════════════════════════════════════════

function saveMatchPrediction(pred) {
  const db = getDb();
  db.prepare(`
    INSERT INTO match_predictions (game_id, away_team_id, home_team_id,
      home_win_prob, predicted_margin, home_score_pred, away_score_pred,
      sharp_signal, sharp_score, confidence, model_version, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(game_id) DO UPDATE SET
      home_win_prob=excluded.home_win_prob, predicted_margin=excluded.predicted_margin,
      home_score_pred=excluded.home_score_pred, away_score_pred=excluded.away_score_pred,
      sharp_signal=excluded.sharp_signal, sharp_score=excluded.sharp_score,
      confidence=excluded.confidence, model_version=excluded.model_version,
      generated_at=datetime('now')
  `).run(
    String(pred.gameId), String(pred.awayTeamId || ''), String(pred.homeTeamId || ''),
    pred.homeWinProb || 0.5, pred.predictedMargin || 0,
    pred.homeScorePred || 0, pred.awayScorePred || 0,
    pred.sharpSignal || 'NONE', pred.sharpScore || 0,
    pred.confidence || 'LOW', pred.modelVersion || 'v4'
  );
}

function getMatchPrediction(gameId) {
  const db = getDb();
  return db.prepare('SELECT * FROM match_predictions WHERE game_id = ?').get(String(gameId));
}

function getMatchPredictionsForGames(gameIds) {
  const db = getDb();
  if (!gameIds.length) return [];
  const placeholders = gameIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM match_predictions WHERE game_id IN (${placeholders})`).all(...gameIds.map(String));
}

// ═══════════════════════════════════════════════════════════════
// MATCH PLAYER PROPS
// ═══════════════════════════════════════════════════════════════

function saveMatchPlayerProps(gameId, props) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO match_player_props (game_id, player_id, player_name, team_abbr, opponent_abbr,
      is_home, stat, season_avg, last5_avg, last10_avg, projected_value, fair_line,
      sportsbook_line, edge, recommendation, confidence, value_rating, prop_score,
      kelly_pct, hit_rate, consistency_cv, games_played, defense_rating, pace_factor,
      injury_boost, factors, model_version, generated_at,
      line_source, hit_rate_at_fair_line, real_hit_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
    ON CONFLICT(game_id, player_id, stat) DO UPDATE SET
      player_name=excluded.player_name, team_abbr=excluded.team_abbr, opponent_abbr=excluded.opponent_abbr,
      is_home=excluded.is_home, season_avg=excluded.season_avg, last5_avg=excluded.last5_avg,
      last10_avg=excluded.last10_avg, projected_value=excluded.projected_value,
      fair_line=excluded.fair_line, sportsbook_line=excluded.sportsbook_line,
      edge=excluded.edge, recommendation=excluded.recommendation, confidence=excluded.confidence,
      value_rating=excluded.value_rating, prop_score=excluded.prop_score,
      kelly_pct=excluded.kelly_pct, hit_rate=excluded.hit_rate,
      consistency_cv=excluded.consistency_cv, games_played=excluded.games_played,
      defense_rating=excluded.defense_rating, pace_factor=excluded.pace_factor,
      injury_boost=excluded.injury_boost, factors=excluded.factors,
      model_version=excluded.model_version, generated_at=datetime('now'),
      line_source=excluded.line_source, hit_rate_at_fair_line=excluded.hit_rate_at_fair_line,
      real_hit_rate=excluded.real_hit_rate
  `);

  const insertMany = db.transaction((items) => {
    for (const p of items) {
      stmt.run(
        gameId, String(p.playerId || ''), p.playerName || '', p.teamAbbr || '',
        p.opponentAbbr || '', p.isHome ? 1 : 0, p.stat, p.seasonAvg || 0,
        p.last5Avg || 0, p.last10Avg || 0, p.projectedValue || 0,
        p.fairLine || 0, p.sportsbookLine || 0, p.edge || 0,
        p.recommendation || 'PASS', p.confidence || 'LOW', p.valueRating || 'AVOID',
        p.propScore || 0, p.kellyPct ?? null, p.hitRate || 0,
        p.consistencyCV || 0, p.gamesPlayed || 0, p.defenseRating || 'average',
        p.paceFactor || 1.0, p.injuryBoost || 1.0,
        JSON.stringify(p.factors || {}), p.modelVersion || 'v4',
        p.lineSource || 'estimated', p.hitRateAtFairLine || 0, p.realHitRate ? 1 : 0
      );
    }
  });
  insertMany(props);
}

function getMatchPlayerProps(gameId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM match_player_props
    WHERE game_id = ?
    ORDER BY prop_score DESC, ABS(edge) DESC
  `).all(String(gameId));
}

function getMatchPlayerPropsByPlayer(playerId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM match_player_props
    WHERE player_id = ?
    ORDER BY generated_at DESC
    LIMIT 20
  `).all(String(playerId));
}

function getTopProps(limit = 50, stat = null) {
  const db = getDb();
  let q = 'SELECT * FROM match_player_props WHERE recommendation != \'PASS\'';
  const params = [];
  if (stat) {
    q += ' AND stat = ?';
    params.push(stat);
  }
  q += ' ORDER BY prop_score DESC, ABS(edge) DESC LIMIT ?';
  params.push(limit);
  return db.prepare(q).all(...params);
}

function getPropsForGameWithPrediction(gameId) {
  const db = getDb();
  const prediction = db.prepare('SELECT * FROM match_predictions WHERE game_id = ?').get(String(gameId));
  const props = db.prepare('SELECT * FROM match_player_props WHERE game_id = ? ORDER BY prop_score DESC').all(String(gameId));
  const sharp = db.prepare('SELECT * FROM sharp_signals WHERE game_id = ? ORDER BY detected_at DESC LIMIT 1').get(String(gameId));
  return { prediction, props, sharp };
}

// ═══════════════════════════════════════════════════════════════
// LIVE PROPS
// ═══════════════════════════════════════════════════════════════

function saveLiveProps(gameId, liveProps) {
  const db = getDb();
  // Clear old snapshots for this game (keep latest)
  db.prepare('DELETE FROM live_props WHERE game_id = ? AND snapshot_time < datetime("now", "-1 hour")').run(String(gameId));

  const stmt = db.prepare(`
    INSERT INTO live_props (game_id, player_id, player_name, stat, current_line,
      our_projection, edge, recommendation, confidence, book_line, book_odds, snapshot_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertAll = db.transaction((items) => {
    for (const p of items) {
      stmt.run(gameId, String(p.playerId || ''), p.playerName || '', p.stat,
        p.currentLine || 0, p.ourProjection || 0, p.edge || 0,
        p.recommendation || 'PASS', p.confidence || 'LOW',
        p.bookLine || 0, p.bookOdds || -110);
    }
  });
  insertAll(liveProps);
}

function getLiveProps(gameId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM live_props WHERE game_id = ? ORDER BY ABS(edge) DESC
  `).all(String(gameId));
}

// ═══════════════════════════════════════════════════════════════
// SHARP SIGNALS
// ═══════════════════════════════════════════════════════════════

function saveSharpSignal(signal) {
  const db = getDb();
  db.prepare(`
    INSERT INTO sharp_signals (game_id, signal_type, signal_strength,
      ml_gap, spread_gap, total_gap, bookmakers, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    String(signal.gameId), signal.signalType || 'NONE', signal.signalStrength || 0,
    signal.mlGap || 0, signal.spreadGap || 0, signal.totalGap || 0,
    signal.bookmakers || 0
  );
}

function getSharpSignals(gameId) {
  const db = getDb();
  return db.prepare('SELECT * FROM sharp_signals WHERE game_id = ? ORDER BY detected_at DESC').all(String(gameId));
}

// ═══════════════════════════════════════════════════════════════
// PREDICTION OUTCOMES (for learning)
// ═══════════════════════════════════════════════════════════════

function recordPredictionOutcome(outcome) {
  const db = getDb();
  db.prepare(`
    INSERT INTO prediction_outcomes (game_id, player_id, stat, predicted_line,
      actual_value, recommendation, was_correct, edge_at_prediction, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    String(outcome.gameId || ''), String(outcome.playerId || ''), outcome.stat || '',
    outcome.predictedLine || 0, outcome.actualValue || 0, outcome.recommendation || '',
    outcome.wasCorrect ? 1 : 0, outcome.edgeAtPrediction || 0
  );
}

function getPredictionAccuracy() {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(was_correct) as correct,
      ROUND(SUM(was_correct) * 100.0 / COUNT(*), 1) as accuracy,
      ROUND(AVG(ABS(edge_at_prediction)), 1) as avg_edge
    FROM prediction_outcomes
    WHERE resolved_at IS NOT NULL
  `).get();
}

module.exports = {
  getDb,
  closeDb,
  upsertTeam,
  upsertStanding,
  upsertPlayer,
  upsertRosterPlayer,
  upsertGamelog,
  upsertGame,
  saveOddsBatch,
  saveNews,
  getAllTeams,
  getTeam,
  getTeamStanding,
  getAllStandings,
  getTeamRoster,
  getPlayer,
  getPlayerGamelog,
  getPlayerAverages,
  getPlayerAveragesLastN,
  getUpcomingGames,
  getGameOdds,
  getOddsByGameId,
  getOddsMovements,
  getNews,
  searchTeams,
  searchPlayers,
  setMeta,
  getMeta,
  getDbStats,
  // New prediction/props exports
  saveMatchPrediction,
  getMatchPrediction,
  getMatchPredictionsForGames,
  saveMatchPlayerProps,
  getMatchPlayerProps,
  getMatchPlayerPropsByPlayer,
  getTopProps,
  getPropsForGameWithPrediction,
  saveLiveProps,
  getLiveProps,
  saveSharpSignal,
  getSharpSignals,
  recordPredictionOutcome,
  getPredictionAccuracy,
};
