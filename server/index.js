// SHARPEDGE Data Server — ESM
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { collectAll } from './collector.cjs';
import { collectNews } from './news-collector.cjs';
import { generateAllProps, generateGameProps } from './props.cjs';
import { generateAllPropsEngine, generateGamePropsEngine } from './props-engine.cjs';
import { collectAllGames, collectMarketContext } from './data-collector.cjs';

import { recordPrediction, checkPredictions, discoverPatterns, getStatus } from './tracker.cjs';
import { buildMatchup, getUpcomingMatchups } from './matchup.cjs';
import { collect as collectOdds, getLineMovements } from './odds-collector.cjs';
import { fetchLiveOdds, detectLineMovements, getQuotaStatus } from './odds-fetcher.cjs';
import { generateAllPredictions, generateGamePrediction, getGameWithPredictions, getTopPropPicks } from './prediction-engine.cjs';
import { fetchAllProps as fetchRealProps, loadProps as loadRealProps, getPropsStatus as getRealPropsStatus, findPlayerPropLine } from './props-fetcher.cjs';
import { trainModel as trainML, predictGame as predictML, getModelInfo as getMLInfo } from './ml-model.cjs';
import core from './native/index.js';
import * as ws from './websocket.cjs';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file for API keys
try {
  const envPath = path.join(__dirname, '..', '.env');
  const envFile = readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    if (line.startsWith('#') || !line.includes('=')) return;
    const eqIdx = line.indexOf('=');
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    if (key) process.env[key] = val;
  });
  console.log('[env] Loaded', Object.keys(process.env).filter(k => k.startsWith('VITE_GROK')).length, 'Grok keys');
} catch (e) { console.log('[env] No .env file:', e.message); }
const app = express();
const PORT = 3001;
const DATA = path.join(__dirname, '..', 'data');

app.use(compression({ level: 6, threshold: 1024 }));
app.use(cors());
app.use(express.json());

// Cache headers
app.use((req, res, next) => {
  if (req.url.startsWith('/api/logo/')) {
    res.set('Cache-Control', 'public, max-age=604800, immutable');
  } else if (req.url.startsWith('/api/')) {
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
  }
  next();
});

// ─── Data Loading ────────────────────────────────────────────────
const cache = new Map();
function loadJson(file) {
  if (cache.has(file)) return cache.get(file);
  try {
    const raw = fs.readFileSync(path.join(DATA, file), 'utf8');
    const data = JSON.parse(raw);
    cache.set(file, data);
    return data;
  } catch { return null; }
}

function invalidateCache(pattern) {
  for (const key of cache.keys()) {
    if (key.includes(pattern)) cache.delete(key);
  }
}

// ─── Team Map ────────────────────────────────────────────────────
const TEAM_MAP = {};
function rebuildTeamMap() {
  const data = loadJson('teams.json');
  if (data?.sports?.[0]?.leagues?.[0]?.teams) {
    data.sports[0].leagues[0].teams.forEach(t => { if (t.team) TEAM_MAP[t.team.id] = t.team; });
  }
}
rebuildTeamMap();

// ─── Player Map (id -> {name, team, pos, headshot}) ──────────────
const PLAYER_MAP = {};
function rebuildPlayerMap() {
  Object.keys(PLAYER_MAP).length = 0;
  for (let t = 1; t <= 30; t++) {
    const roster = loadJson(`roster-${t}.json`);
    if (!roster?.athletes) continue;
    roster.athletes.forEach(a => {
      PLAYER_MAP[a.id] = {
        id: a.id,
        name: a.displayName || `${a.firstName} ${a.lastName}`,
        firstName: a.firstName,
        lastName: a.lastName,
        teamId: String(t),
        teamAbbr: TEAM_MAP[String(t)]?.abbreviation || '',
        teamName: TEAM_MAP[String(t)]?.displayName || '',
        pos: a.position?.abbreviation || '',
        jersey: a.jersey || '',
        height: a.displayHeight || '',
        weight: a.displayWeight || '',
        age: a.age || '',
        headshot: a.headshot?.href || '',
        injuries: a.injuries || [],
      };
    });
  }
}
rebuildPlayerMap();

// ─── Logo Proxy ──────────────────────────────────────────────────
app.get('/api/logo/:slug', async (req, res) => {
  const slug = req.params.slug;
  const ck = `logo:${slug}`;
  if (cache.has(ck)) { res.set('Content-Type', 'image/png'); return res.send(cache.get(ck)); }
  try {
    const r = await fetch(`https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/${slug}.png&h=80&w=80`);
    const buf = Buffer.from(await r.arrayBuffer());
    cache.set(ck, buf);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(buf);
  } catch { res.status(404).end(); }
});

// ─── Merged Games Endpoint (real odds + team data) ─────────────
app.get('/api/games', (req, res) => {
  try {
    const rawOdds = loadJson('live-odds.json');
    const oddsGames = Array.isArray(rawOdds) ? rawOdds : [];
    const standings = loadJson('standings.json');
    const injuries = [];
    Object.values(PLAYER_MAP).forEach(p => {
      if (p.injuries?.length) {
        p.injuries.forEach(inj => {
          injuries.push({ player: p.name, team: p.teamAbbr, status: inj.status || inj.type || 'Unknown' });
        });
      }
    });
    const movements = detectLineMovements();

    // Build standings lookup
    const standingMap = {};
    (standings?.children || []).forEach(c => {
      (c.standings?.entries || []).forEach(e => {
        const s = {};
        (e.stats || []).forEach(x => { s[x.name] = x.value; });
        standingMap[e.team.displayName] = {
          id: e.team.id, abbr: e.team.abbreviation, name: e.team.displayName,
          logo: e.team.logos?.[0]?.href || '',
          wins: s.wins || 0, losses: s.losses || 0,
          ppg: s.avgPointsFor || 0, oppg: s.avgPointsAgainst || 0, diff: s.differential || 0,
          streak: s.streak || 0, last10: s.record || '',
        };
      });
    });

    // Enrich odds games with team data
    const games = oddsGames.map(g => {
      const homeInfo = standingMap[g.home_team] || { name: g.home_team, abbr: g.home_team.split(' ').pop()?.slice(0,3).toUpperCase(), wins: '?', losses: '?', ppg: 0, oppg: 0 };
      const awayInfo = standingMap[g.away_team] || { name: g.away_team, abbr: g.away_team.split(' ').pop()?.slice(0,3).toUpperCase(), wins: '?', losses: '?', ppg: 0, oppg: 0 };

      // Extract consensus odds from first bookmaker
      const firstBook = g.bookmakers?.[0];
      const h2h = firstBook?.markets?.find(m => m.key === 'h2h');
      const spr = firstBook?.markets?.find(m => m.key === 'spreads');
      const tot = firstBook?.markets?.find(m => m.key === 'totals');
      const homeML = h2h?.outcomes?.find(o => o.name === g.home_team)?.price;
      const awayML = h2h?.outcomes?.find(o => o.name === g.away_team)?.price;
      const spread = spr?.outcomes?.find(o => o.name === g.home_team)?.point;
      const total = tot?.outcomes?.find(o => o.name === 'Over')?.point;

      // Build per-book breakdown
      const bookLines = (g.bookmakers || []).map(b => {
        const bh = b.markets?.find(m => m.key === 'h2h');
        const bs = b.markets?.find(m => m.key === 'spreads');
        const bt = b.markets?.find(m => m.key === 'totals');
        return {
          book: b.title,
          homeML: bh?.outcomes?.find(o => o.name === g.home_team)?.price,
          awayML: bh?.outcomes?.find(o => o.name === g.away_team)?.price,
          spread: bs?.outcomes?.find(o => o.name === g.home_team)?.point,
          total: bt?.outcomes?.find(o => o.name === 'Over')?.point,
        };
      });

      // Check sharp signals
      const sharp = movements.find(mv =>
        mv.matchup.includes(homeInfo.abbr) && mv.matchup.includes(awayInfo.abbr)
      );

      return {
        id: g.id,
        time: g.commence_time,
        home: { ...homeInfo, logo: homeInfo.logo || `/api/logo/${homeInfo.abbr?.toLowerCase()}` },
        away: { ...awayInfo, logo: awayInfo.logo || `/api/logo/${awayInfo.abbr?.toLowerCase()}` },
        consensus: { spread, total, homeML, awayML },
        bookLines,
        bookCount: g.bookmakers?.length || 0,
        sharp: sharp || null,
      };
    });

    // Sort by time
    games.sort((a, b) => new Date(a.time) - new Date(b.time));

    const criticalInjuries = injuries.filter(i => i.status?.toLowerCase().includes('out') || i.status?.toLowerCase().includes('doubtful'));

    res.json({
      games,
      sharpSignals: movements,
      injuries: criticalInjuries,
      totalGames: games.length,
      gamesWithOdds: games.filter(g => g.bookCount > 0).length,
      lastUpdate: oddsGames[0]?.bookmakers?.[0]?.last_update || null,
    });
  } catch (err) {
    console.error('[api/games] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Core Endpoints ──────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  cached: cache.size,
  teams: Object.keys(TEAM_MAP).length,
  players: Object.keys(PLAYER_MAP).length,
}));

app.get('/api/scoreboard', (req, res) => res.json(loadJson('scoreboard.json') || { events: [] }));
app.get('/api/standings', (req, res) => res.json(loadJson('standings.json') || { children: [] }));
app.get('/api/teams', (req, res) => res.json(loadJson('teams.json') || { sports: [] }));
app.get('/api/news', (req, res) => {
  const data = loadJson('news.json');
  if (!data) return res.json({ articles: [], categories: {}, total: 0 });
  const category = req.query.category;
  let articles = data.articles || [];
  if (category && category !== 'all') {
    articles = articles.filter(a => (a.category || '').toLowerCase() === category.toLowerCase());
  }
  res.json({ ...data, articles, total: articles.length });
});
app.get('/api/news-intel', (req, res) => {
  const data = loadJson('news.json');
  res.json(data || { articles: [], categories: {} });
});
app.get('/api/news/refresh', (req, res) => {
  // Return immediately, run collection in background
  res.json({ success: true, message: 'News collection started' });
  collectNews().then(result => {
    console.log(`[news] Refresh complete: ${result.total} articles`);
    invalidateCache('news');
  }).catch(err => console.error('[news] Refresh error:', err.message));
});
app.get('/api/odds', (req, res) => {
  let d = loadJson('live-odds.json');
  const games = Array.isArray(d) ? d : [];
  res.json({ games, source: 'The Odds API', lastUpdate: games[0]?.bookmakers?.[0]?.last_update || null });
});

// Quota status — check without spending credits
app.get('/api/odds/quota', (req, res) => {
  res.json(getQuotaStatus());
});

// Legacy odds refresh (deprecated — use POST /api/odds/refresh)
app.get('/api/odds/refresh', async (req, res) => {
  try {
    const result = await collectOdds();
    cache.delete('live-odds.json');
    res.json({ success: true, games: result.games, remaining: result.remaining });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Line movement detection
app.get('/api/odds/movements', (req, res) => {
  const team1 = req.query.team1;
  const team2 = req.query.team2;
  if (!team1 || !team2) return res.json({ error: 'team1 and team2 required' });
  const movements = getLineMovements(team1, team2);
  res.json(movements);
});

// ─── Search ──────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const q = (req.query.query || '').toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = [];
  // Search teams
  Object.values(TEAM_MAP).forEach(t => {
    if (t.displayName?.toLowerCase().includes(q) || t.abbreviation?.toLowerCase().includes(q)) {
      results.push({ type: 'team', id: t.id, name: t.displayName, abbr: t.abbreviation });
    }
  });
  // Search players
  Object.values(PLAYER_MAP).forEach(p => {
    if (p.name.toLowerCase().includes(q) || p.lastName?.toLowerCase().includes(q)) {
      results.push({ type: 'player', id: p.id, name: p.name, team: p.teamAbbr, pos: p.pos });
    }
  });
  res.json({ results: results.slice(0, 15) });
});

// ─── Player Endpoints ────────────────────────────────────────────


app.get('/api/players/:id/stats', (req, res) => {
  const gamelog = loadJson(`player-gamelog-${req.params.id}.json`);
  if (!gamelog) return res.json({ labels: [], games: [], averages: {} });

  const labels = gamelog.labels || [];
  const names = gamelog.names || [];
  const seasonTypes = gamelog.seasonTypes || [];

  // Find regular season
  const regSeason = seasonTypes.find(s => (s.displayName || s.name || '').includes('Regular'));
  if (!regSeason) return res.json({ labels, games: [], averages: {} });

  // Flatten all games from all months
  const allGames = [];
  (regSeason.categories || []).forEach(cat => {
    (cat.events || []).forEach(ev => {
      const stats = {};
      labels.forEach((label, i) => { stats[label] = ev.stats?.[i] || ''; });
      stats._eventId = ev.eventId;
      stats._month = cat.displayName;
      allGames.push(stats);
    });
  });

  // Compute averages
  const averages = {};
  labels.forEach(label => {
    const vals = allGames.map(g => parseFloat(g[label])).filter(v => !isNaN(v));
    if (vals.length > 0) {
      if (label === 'FG' || label === '3PT' || label === 'FT') {
        // These are "made-attempted" format, compute percentage
        const made = vals.reduce((s, v) => s + (String(v).split('-')[0] || 0), 0);
        const attempted = vals.reduce((s, v) => s + (String(v).split('-')[1] || 0), 0);
        averages[label] = attempted > 0 ? `${made}/${attempted}` : '--';
      } else {
        averages[label] = (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1);
      }
    }
  });

  res.json({ labels, games: allGames, averages, totalGames: allGames.length });
});

// ─── Head-to-Head Stats ──────────────────────────────────────────
// Returns how a player performed against a specific opponent team
app.get('/api/players/:id/h2h/:teamId', (req, res) => {
  const gamelog = loadJson(`player-gamelog-${req.params.id}.json`);
  if (!gamelog) return res.json({ games: [], averages: {} });

  const labels = gamelog.labels || [];
  const seasonTypes = gamelog.seasonTypes || [];
  const targetTeamId = req.params.teamId;

  // Find opponent team abbreviation
  const oppTeam = TEAM_MAP[targetTeamId];
  const oppAbbr = oppTeam?.abbreviation || '';

  // Get all regular season games
  const regSeason = seasonTypes.find(s => (s.displayName || s.name || '').includes('Regular'));
  if (!regSeason) return res.json({ games: [], averages: {}, opponent: oppAbbr });

  // H2H data isn't directly in gamelog - we need to use the events to find
  // games against specific teams. The gamelog events don't include opponent info
  // directly, so we'll return all games and let the client filter.
  // However, we can also look at the event IDs to cross-reference.

  const allGames = [];
  (regSeason.categories || []).forEach(cat => {
    (cat.events || []).forEach(ev => {
      const stats = {};
      labels.forEach((label, i) => { stats[label] = ev.stats?.[i] || ''; });
      stats._eventId = ev.eventId;
      allGames.push(stats);
    });
  });

  // Compute season averages
  const averages = {};
  labels.forEach(label => {
    const vals = allGames.map(g => parseFloat(g[label])).filter(v => !isNaN(v));
    if (vals.length > 0) averages[label] = (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1);
  });

  res.json({ labels, games: allGames, averages, totalGames: allGames.length, opponent: oppAbbr });
});

// ─── Injuries ────────────────────────────────────────────────────
app.get('/api/injuries', (req, res) => {
  const injuries = [];
  Object.values(PLAYER_MAP).forEach(p => {
    if (p.injuries && p.injuries.length > 0) {
      p.injuries.forEach(inj => {
        injuries.push({
          player: p.name,
          playerId: p.id,
          team: p.teamAbbr,
          teamName: p.teamName,
          status: inj.status || inj.type || 'Unknown',
          detail: inj.details || inj.detail || '',
          type: inj.type || '',
        });
      });
    }
  });
  res.json({ injuries });
});

// ─── Schedule ────────────────────────────────────────────────────
app.get('/api/schedule', (req, res) => {
  const scoreboard = loadJson('scoreboard.json');
  res.json({ events: scoreboard?.events || [], games: scoreboard?.events || [] });
});

// ─── Predictions ─────────────────────────────────────────────────
app.get('/api/predictions', (req, res) => {
  const standings = loadJson('standings.json');
  const odds = loadJson('live-odds.json');
  const teams = [];
  (standings?.children || []).forEach(c => {
    (c.standings?.entries || []).forEach(e => {
      const s = {};
      (e.stats || []).forEach(x => { s[x.name] = x.value; });
      teams.push({
        id: e.team.id, abbr: e.team.abbreviation, name: e.team.displayName,
        wins: s.wins || 0, losses: s.losses || 0, winPct: s.winPercent || 0,
        ppg: s.avgPointsFor || 0, oppg: s.avgPointsAgainst || 0, diff: s.differential || 0,
      });
    });
  });
  const avgWinPct = teams.reduce((s, t) => s + t.winPct, 0) / (teams.length || 1);
  const avgDiff = teams.reduce((s, t) => s + t.diff, 0) / (teams.length || 1);
  teams.forEach(t => { t.rating = ((t.winPct - avgWinPct) * 10) + ((t.diff - avgDiff) * 0.5); });

  const games = Array.isArray(odds) ? odds : [];
  const predictions = [];
  games.forEach(g => {
    const homeTeam = g.home_team || g.homeTeam || '';
    const awayTeam = g.away_team || g.awayTeam || '';
    const home = teams.find(t => t.name === homeTeam || t.abbr === homeTeam);
    const away = teams.find(t => t.name === awayTeam || t.abbr === awayTeam);
    if (!home || !away) return;
    const homeWinProb = 0.5 + (home.rating - away.rating) * 0.03 + 0.035;
    const edge = Math.abs(homeWinProb - 0.5);
    const tier = edge > 0.12 ? 'ELITE' : edge > 0.06 ? 'STRONG' : 'MODERATE';
    const pick = homeWinProb > 0.5 ? home.abbr : away.abbr;
    predictions.push({
      matchup: `${away.abbr} @ ${home.abbr}`, home: home.abbr, away: away.abbr,
      homeTeam: homeTeam, awayTeam: awayTeam, pick,
      home_win_prob: parseFloat(homeWinProb.toFixed(3)),
      edge: parseFloat((edge * 100).toFixed(1)),
      tier, market: 'ML', confidence: tier,
      ev: edge,
      kellyPct: parseFloat(((edge / 0.1) * 25).toFixed(1)),
      reasoning: `${home.name} (${home.wins}-${home.losses}) vs ${away.name} (${away.wins}-${away.losses})`,
    });
  });
  res.json({ predictions });
});

// ─── Agents ──────────────────────────────────────────────────────
app.post('/api/agents/run', async (req, res) => {
  try {
    const standings = loadJson('standings.json');
    const odds = loadJson('live-odds.json');
    const news = loadJson('news.json');
    const scoreboard = loadJson('scoreboard.json');

    // Collect injuries from player data
    const injuries = [];
    Object.values(PLAYER_MAP).forEach(p => {
      if (p.injuries?.length) {
        p.injuries.forEach(inj => {
          injuries.push({
            player: p.name, playerId: p.id,
            team: p.teamAbbr, teamName: p.teamName,
            status: inj.status || 'Unknown',
            detail: inj.details || inj.detail || '',
          });
        });
      }
    });

    // Generate player props for the AI
    const now = Date.now();
    if (!propsCache || now - propsCacheTime > 300000) {
      propsCache = generateAllProps();
      propsCacheTime = now;
    }

    // Build matchup data for each scheduled game
    const { buildMatchup } = await import('./matchup.cjs');
    const events = scoreboard?.events || [];
    const matchups = [];
    for (const ev of events.slice(0, 10)) {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      if (home?.team?.id && away?.team?.id) {
        const m = buildMatchup(away.team.id, home.team.id);
        if (m) matchups.push(m);
      }
    }

    res.json({
      success: true,
      message: 'Agent analysis removed. Use /api/predictions/generate instead.',
    });
  } catch (err) {
    console.error('[agents] Error:', err.message);
    res.json({ error: err.message, agents: {}, intelBrief: null });
  }
});

// ─── Player Props (Matchup-Aware) ─────────────────────────────
let propsCache = null;
let propsCacheTime = 0;

app.get('/api/props', (req, res) => {
  const now = Date.now();
  if (!propsCache || now - propsCacheTime > 300000) {
    propsCache = generateAllProps();
    propsCacheTime = now;
  }
  res.json(propsCache);
});

app.get('/api/props/game/:awayId/:homeId', (req, res) => {
  const props = generateGameProps(req.params.awayId, req.params.homeId);
  if (!props) return res.status(404).json({ error: 'Game not found' });
  res.json(props);
});

// ─── Props Engine v3 (Professional-Grade) ────────────────────
let propsV3Cache = null;
let propsV3CacheTime = 0;

app.get('/api/props/v3', (req, res) => {
  const now = Date.now();
  if (!propsV3Cache || now - propsV3CacheTime > 300000) {
    try {
      propsV3Cache = generateAllPropsEngine();
      propsV3CacheTime = now;
    } catch (err) {
      console.error('[props-v3] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  res.json(propsV3Cache);
});

app.get('/api/props/v3/game/:awayId/:homeId', (req, res) => {
  try {
    const props = generateGamePropsEngine(req.params.awayId, req.params.homeId);
    if (!props) return res.status(404).json({ error: 'Game not found' });
    res.json(props);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/props/v3/top', (req, res) => {
  const now = Date.now();
  if (!propsV3Cache || now - propsV3CacheTime > 300000) {
    try {
      propsV3Cache = generateAllPropsEngine();
      propsV3CacheTime = now;
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  const limit = parseInt(req.query.limit) || 30;
  const stat = req.query.stat; // Filter by stat: PTS, REB, AST, etc.
  let picks = propsV3Cache.topPicks || [];
  if (stat) picks = picks.filter(p => p.stat === stat);
  res.json({
    picks: picks.slice(0, limit),
    total: picks.length,
    summary: propsV3Cache.summary,
  });
});

app.get('/api/props/top', (req, res) => {
  const now = Date.now();
  if (!propsCache || now - propsCacheTime > 300000) {
    propsCache = generateAllProps();
    propsCacheTime = now;
  }
  const limit = parseInt(req.query.limit) || 20;
  const topProps = [];
  (propsCache.games || []).forEach(g => {
    (g.matchups || []).forEach(m => {
      (m.topProps || []).forEach(p => {
        topProps.push({
          player: m.player, playerId: m.playerId, team: m.team,
          headshot: m.headshot, opponent: m.opponent, isHome: m.isHome,
          ...p,
        });
      });
    });
  });
  topProps.sort((a, b) => Math.abs(b.edge || 0) - Math.abs(a.edge || 0));
  res.json({ props: topProps.slice(0, limit), total: topProps.length });
});

// ─── Matchups ─────────────────────────────────────────────────
app.get('/api/matchups/upcoming', (req, res) => {
  const matchups = getUpcomingMatchups();
  res.json({ matchups });
});

app.get('/api/matchups/:awayId/:homeId', (req, res) => {
  const matchup = buildMatchup(req.params.awayId, req.params.homeId);
  if (!matchup) return res.status(404).json({ error: 'Teams not found' });
  res.json(matchup);
});

// ─── Meta ────────────────────────────────────────────────────────
app.get('/api/meta', (req, res) => {
  const f = fs.readdirSync(DATA).filter(x => x.endsWith('.json'));
  res.json({ totalFiles: f.length, cached: cache.size, teams: Object.keys(TEAM_MAP).length, players: Object.keys(PLAYER_MAP).length });
});

// ─── Start ───────────────────────────────────────────────────────
import http from 'http';
// ─── Dynamic Model API ──────────────────────────────────────
app.get('/api/model/data', (req, res) => {
  try {
    const data = collectAllGames();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/model/market', (req, res) => {
  try {
    const market = collectMarketContext();
    res.json(market);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Live Odds API ──────────────────────────────────────────
app.get('/api/odds/live', async (req, res) => {
  try {
    const data = await fetchLiveOdds();
    res.json({ games: Array.isArray(data) ? data.length : 0, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/odds/sharp', (req, res) => {
  const movements = detectLineMovements();
  res.json({ movements, count: movements.length });
});

app.post('/api/odds/refresh', async (req, res) => {
  try {
    const force = req.body?.force === true;
    const data = await fetchLiveOdds(force);
    const movements = detectLineMovements();
    res.json({
      games: Array.isArray(data) ? data.length : 0,
      sharpSignals: movements.length,
      movements,
      quota: getQuotaStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, quota: getQuotaStatus() });
  }
});

// All teams with standings from database
app.get('/api/teams/standings', (req, res) => {
  if (!db) return res.json({ teams: [] });
  try {
    const teams = db.getAllStandings();
    res.json({ teams, count: teams.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Team & Player Data API ────────────────────────────────
app.get('/api/teams/all', (req, res) => {
  const teams = [];
  for (let t = 1; t <= 30; t++) {
    const roster = loadJson(`roster-${t}.json`);
    const teamInfo = loadJson(`team-${t}.json`);
    const teamStats = loadJson(`stats-${t}.json`);
    teams.push({
      id: t,
      name: teamInfo?.team?.displayName || `Team ${t}`,
      abbreviation: teamInfo?.team?.abbreviation || '',
      logo: teamInfo?.team?.logos?.[0]?.href || '',
      roster: roster?.athletes || [],
      stats: teamStats,
    });
  }
  res.json({ teams, count: teams.length });
});

app.get('/api/teams/:id', (req, res) => {
  const t = req.params.id;
  const teamInfo = loadJson(`team-${t}.json`);
  const roster = loadJson(`roster-${t}.json`);
  const schedule = loadJson(`schedule-${t}.json`);
  const teamStats = loadJson(`stats-${t}.json`);
  if (!teamInfo) return res.status(404).json({ error: 'Team not found' });
  res.json({ team: teamInfo?.team, roster: roster?.athletes || [], schedule: schedule?.events || [], stats: teamStats });
});

app.get('/api/players/:id', (req, res) => {
  const profile = loadJson(`player-${req.params.id}.json`);
  const gamelog = loadJson(`player-gamelog-${req.params.id}.json`);
  const stats = loadJson(`player-stats-${req.params.id}.json`);
  if (!profile) return res.status(404).json({ error: 'Player not found' });
  res.json({ profile, gamelog, stats });
});

app.get('/api/matchup/:awayId/:homeId', (req, res) => {
  const awayTeam = loadJson(`team-${req.params.awayId}.json`);
  const homeTeam = loadJson(`team-${req.params.homeId}.json`);
  const awayRoster = loadJson(`roster-${req.params.awayId}.json`);
  const homeRoster = loadJson(`roster-${req.params.homeId}.json`);
  const standings = loadJson('standings.json');
  
  // Get standings for both teams
  let awayStanding = null, homeStanding = null;
  (standings?.children || []).forEach(c => {
    (c.standings?.entries || []).forEach(e => {
      if (String(e.team.id) === req.params.awayId) {
        const s = {};
        (e.stats || []).forEach(x => { s[x.name] = x.value; });
        awayStanding = { abbreviation: e.team.abbreviation, ...s };
      }
      if (String(e.team.id) === req.params.homeId) {
        const s = {};
        (e.stats || []).forEach(x => { s[x.name] = x.value; });
        homeStanding = { abbreviation: e.team.abbreviation, ...s };
      }
    });
  });
  
  // Get player stats for key players on both teams
  const getPlayersWithStats = (roster) => {
    return (roster?.athletes || []).map(a => {
      const gl = loadJson(`player-gamelog-${a.id}.json`);
      if (!gl?.labels || !gl?.seasonTypes) return null;
      const labels = gl.labels;
      const reg = gl.seasonTypes.find(s => (s.displayName || '').includes('Regular'));
      if (!reg) return null;
      const games = [];
      (reg.categories || []).forEach(c => (c.events || []).forEach(e => {
        const stats = {};
        labels.forEach((l, i) => {
          const val = e.stats?.[i] || '';
          stats[l] = (l === 'FG' || l === '3PT' || l === 'FT') ? val : parseFloat(val) || 0;
        });
        stats._opponent = e.opponent?.abbreviation || '';
        stats._isHome = e.atVs === 'vs';
        stats._date = e.gameDate || '';
        stats._result = e.gameResult || '';
        games.push(stats);
      }));
      const n = games.length || 1;
      const avg = (k) => games.reduce((s, g) => s + (g[k] || 0), 0) / n;
      return {
        id: a.id, name: a.displayName, position: a.position?.abbreviation || '',
        jersey: a.jersey || '',
        ppg: parseFloat(avg('PTS').toFixed(1)),
        rpg: parseFloat(avg('REB').toFixed(1)),
        apg: parseFloat(avg('AST').toFixed(1)),
        spg: parseFloat(avg('STL').toFixed(1)),
        bpg: parseFloat(avg('BLK').toFixed(1)),
        topg: parseFloat(avg('TO').toFixed(1)),
        fgPct: parseFloat(avg('FG%').toFixed(1)),
        games: n,
        recentGames: games.slice(-5).map(g => ({
          pts: g.PTS, reb: g.REB, ast: g.AST, stl: g.STL, blk: g.BLK,
          opponent: g._opponent, home: g._isHome, result: g._result,
          date: g._date?.slice(5, 10) || '',
        })),
      };
    }).filter(Boolean).sort((a, b) => b.ppg - a.ppg);
  };

  // Head-to-head history from match-data.json
  const matchData = loadJson('match-data.json') || [];
  const awayName = awayTeam?.displayName || '';
  const homeName = homeTeam?.displayName || '';
  const h2hGames = matchData.filter(g =>
    (g.home?.name === homeName && g.away?.name === awayName) ||
    (g.home?.name === awayName && g.away?.name === homeName)
  ).sort((a, b) => new Date(b.date) - new Date(a.date));

  const h2hRecord = { awayWins: 0, homeWins: 0, games: h2hGames.length };
  h2hGames.forEach(g => {
    if (g.home?.name === homeName && g.home?.winner) h2hRecord.homeWins++;
    else if (g.away?.name === homeName && g.away?.winner) h2hRecord.homeWins++;
    else h2hRecord.awayWins++;
  });

  res.json({
    away: { team: awayTeam?.team, roster: awayRoster?.athletes || [], standing: awayStanding, players: getPlayersWithStats(awayRoster) },
    home: { team: homeTeam?.team, roster: homeRoster?.athletes || [], standing: homeStanding, players: getPlayersWithStats(homeRoster) },
    h2h: { record: h2hRecord, recentGames: h2hGames.slice(0, 10).map(g => ({
      date: g.date,
      home: g.home?.name,
      away: g.away?.name,
      homeScore: g.home?.score,
      awayScore: g.away?.score,
      venue: g.venue,
    })) },
  });
});

// /api/news removed — duplicate of the handler defined above

app.get('/api/schedule/:teamId', (req, res) => {
  const schedule = loadJson(`schedule-${req.params.teamId}.json`);
  res.json({ events: schedule?.events || [] });
});

// ─── Tracker API ─────────────────────────────────────────────
app.get('/api/tracker/status', (req, res) => {
  res.json(getStatus());
});

app.post('/api/tracker/predict', (req, res) => {
  try {
    const id = recordPrediction(req.body);
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tracker/check', (req, res) => {
  // Check predictions against game results
  const scoreboard = loadJson('scoreboard.json');
  const events = scoreboard?.events || [];
  const gameResults = [];
  events.forEach(ev => {
    const comp = ev.competitions?.[0];
    (comp?.competitors || []).forEach(c => {
      // Extract player stats from box score if available
    });
  });
  const result = checkPredictions(gameResults);
  res.json(result);
});

app.post('/api/tracker/evolve', (req, res) => {
  const patterns = discoverPatterns();
  res.json({ patterns, count: patterns.length });
});

// ─── Database-backed API (new) ─────────────────────────────
let db = null;
try {
  const dbModule = require('./db.cjs');
  db = dbModule;
  console.log('[db] SQLite database loaded');
} catch (e) {
  console.error('[db] Failed to load:', e.message);
}

// Upcoming matches with odds from all sportsbooks
app.get('/api/matches/upcoming', (req, res) => {
  if (!db) return res.json({ matches: [], error: 'Database not available' });
  try {
    const games = db.getUpcomingGames();
    const matches = games.map(g => {
      const odds = db.getOddsByGameId(g.id);
      
      // Group odds by bookmaker
      const bookmakers = {};
      odds.forEach(o => {
        if (!bookmakers[o.bookmaker]) bookmakers[o.bookmaker] = { name: o.bookmaker, markets: {} };
        if (!bookmakers[o.bookmaker].markets[o.market_key]) bookmakers[o.bookmaker].markets[o.market_key] = [];
        bookmakers[o.bookmaker].markets[o.market_key].push({
          name: o.outcome_name,
          price: o.outcome_price,
          point: o.outcome_point,
        });
      });

      // Find consensus lines
      const spreads = odds.filter(o => o.market_key === 'spreads');
      const totals = odds.filter(o => o.market_key === 'totals');
      const mls = odds.filter(o => o.market_key === 'h2h');

      const homeSpread = spreads.filter(o => o.outcome_name === g.home_team);
      const homeML = mls.filter(o => o.outcome_name === g.home_team);
      const totalOver = totals.filter(o => o.outcome_name === 'Over');

      return {
        id: g.id,
        date: g.date,
        status: g.status,
        home: {
          id: g.home_team_id,
          name: g.home_team_name,
          abbreviation: g.home_abbr,
          logo: g.home_logo,
          wins: g.home_wins,
          losses: g.home_losses,
          ppg: g.home_ppg,
          oppg: g.home_oppg,
        },
        away: {
          id: g.away_team_id,
          name: g.away_team_name,
          abbreviation: g.away_abbr,
          logo: g.away_logo,
          wins: g.away_wins,
          losses: g.away_losses,
          ppg: g.away_ppg,
          oppg: g.away_oppg,
        },
        odds: {
          consensus: {
            spread: homeSpread.length ? (homeSpread.reduce((s, o) => s + o.outcome_point, 0) / homeSpread.length).toFixed(1) : null,
            total: totalOver.length ? (totalOver.reduce((s, o) => s + o.outcome_point, 0) / totalOver.length).toFixed(1) : null,
            homeML: homeML.length ? Math.round(homeML.reduce((s, o) => s + o.outcome_price, 0) / homeML.length) : null,
          },
          bookmakers: Object.values(bookmakers),
          sharpSignals: [],
        },
        bookCount: Object.keys(bookmakers).length,
      };
    });

    // Add sharp signals
    const movements = detectLineMovements();
    matches.forEach(m => {
      const movement = movements.find(mv => mv.matchup.includes(m.home.abbreviation) && mv.matchup.includes(m.away.abbreviation));
      if (movement) m.odds.sharpSignals = [movement];
    });

    res.json({ matches, count: matches.length, lastUpdate: db.getMeta('last_odds_fetch') });
  } catch (err) {
    console.error('[api] Upcoming matches error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// Team detail with roster and stats from database
app.get('/api/teams/:id/detail', (req, res) => {
  try {
    const teamId = req.params.id;
    const teamFile = loadJson(`team-${teamId}.json`);
    if (!teamFile?.team) return res.status(404).json({ error: 'Team not found' });

    const team = teamFile.team;

    // Get standings from standings.json
    const standings = loadJson('standings.json');
    let standing = null;
    (standings?.children || []).forEach(c => {
      (c.standings?.entries || []).forEach(e => {
        if (String(e.team.id) === String(teamId)) {
          const s = {};
          (e.stats || []).forEach(x => { s[x.name] = x.value; });
          standing = {
            wins: s.wins || 0, losses: s.losses || 0, winPercent: s.winPercent || 0,
            avgPointsFor: s.avgPointsFor || 0, avgPointsAgainst: s.avgPointsAgainst || 0,
            differential: s.differential || 0, avgRebounds: s.avgRebounds || 0,
            avgAssists: s.avgAssists || 0, avgSteals: s.avgSteals || 0,
            avgBlocks: s.avgBlocks || 0, avgTurnovers: s.avgTurnovers || 0,
            fieldGoalPct: s.fieldGoalPct || 0, threePointFieldGoalPct: s.threePointFieldGoalPct || 0,
            freeThrowPct: s.freeThrowPct || 0, streak: s.streak?.value || 0,
            record: s.record || '', home: s.home || '', road: s.road || '',
          };
        }
      });
    });

    // Get roster from JSON and compute player averages from gamelogs
    const roster = loadJson(`roster-${teamId}.json`);
    const playersWithStats = (roster?.athletes || []).map(a => {
      const gl = loadJson(`player-gamelog-${a.id}.json`);
      if (!gl?.labels || !gl?.seasonTypes) return null;
      const labels = gl.labels;
      const reg = gl.seasonTypes.find(s => (s.displayName || '').includes('Regular'));
      if (!reg) return null;
      const games = [];
      (reg.categories || []).forEach(c => (c.events || []).forEach(e => {
        const stats = {};
        labels.forEach((l, i) => {
          const val = e.stats?.[i] || '';
          stats[l] = (l === 'FG' || l === '3PT' || l === 'FT') ? val : parseFloat(val) || 0;
        });
        stats._opponent = e.opponent?.abbreviation || '';
        stats._isHome = e.atVs === 'vs';
        stats._date = e.gameDate || '';
        stats._result = e.gameResult || '';
        games.push(stats);
      }));
      const n = games.length || 1;
      const avg = (k) => games.reduce((s, g) => s + (g[k] || 0), 0) / n;
      return {
        id: a.id, displayName: a.displayName, position: a.position, jersey: a.jersey,
        displayHeight: a.displayHeight, displayWeight: a.displayWeight,
        headshot: a.headshot, injuries: a.injuries,
        averages: {
          games: games.length,
          ppg: parseFloat(avg('PTS').toFixed(1)),
          rpg: parseFloat(avg('REB').toFixed(1)),
          apg: parseFloat(avg('AST').toFixed(1)),
          spg: parseFloat(avg('STL').toFixed(1)),
          bpg: parseFloat(avg('BLK').toFixed(1)),
          topg: parseFloat(avg('TO').toFixed(1)),
        },
        recentGames: games.slice(-5).map(g => ({
          pts: g.PTS, reb: g.REB, ast: g.AST, stl: g.STL, blk: g.BLK,
          opponent: g._opponent, home: g._isHome, result: g._result, date: g._date?.slice(5, 10),
        })),
      };
    }).filter(Boolean).sort((a, b) => (b.averages?.ppg || 0) - (a.averages?.ppg || 0));

    res.json({ team, standing, roster: playersWithStats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Player detail with gamelog from database
app.get('/api/players/:id/gamelog', (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  try {
    const player = db.getPlayer(req.params.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    
    const gamelog = db.getPlayerGamelog(req.params.id);
    const averages = db.getPlayerAverages(req.params.id);
    const last5 = db.getPlayerAveragesLastN(req.params.id, 5);
    const last10 = db.getPlayerAveragesLastN(req.params.id, 10);

    res.json({ player, gamelog, averages, last5, last10 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search teams and players
app.get('/api/search/all', (req, res) => {
  if (!db) return res.json({ teams: [], players: [] });
  const q = req.query.q || '';
  if (!q) return res.json({ teams: [], players: [] });
  try {
    const teams = db.searchTeams(q);
    const players = db.searchPlayers(q);
    res.json({ teams, players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Database stats
app.get('/api/db/stats', (req, res) => {
  if (!db) return res.json({ error: 'Database not available' });
  try {
    res.json(db.getDbStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual data refresh
app.post('/api/refresh/all', async (req, res) => {
  try {
    console.log('[refresh] Starting full data refresh...');
    await collectAll();
    rebuildTeamMap();
    rebuildPlayerMap();
    res.json({ success: true, teams: Object.keys(TEAM_MAP).length, players: Object.keys(PLAYER_MAP).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh/odds', async (req, res) => {
  try {
    const force = req.body?.force === true;
    const data = await fetchLiveOdds(force);
    res.json({ success: true, games: Array.isArray(data) ? data.length : 0, quota: getQuotaStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message, quota: getQuotaStatus() });
  }
});

// ─── Prediction Engine v4 — Autonomous Props & Predictions ────

// Generate predictions for all scheduled games and save to DB
app.post('/api/predictions/generate', async (req, res) => {
  try {
    console.log('[predictions] Generating all predictions...');
    const result = generateAllPredictions();
    res.json({
      success: true,
      nativeMode: result.nativeMode,
      games: result.games,
      totalProps: result.totalProps,
      strongPlays: result.strongPlays,
      generated: result.generated,
    });
  } catch (err) {
    console.error('[predictions] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get predictions + props for a specific game (from DB — fast)
app.get('/api/predictions/game/:eventId', (req, res) => {
  try {
    const data = getGameWithPredictions(req.params.eventId);
    if (!data.prediction && (!data.props || data.props.length === 0)) {
      return res.json({ prediction: null, props: [], sharp: null, message: 'No predictions yet. POST /api/predictions/generate first.' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top prop picks across all games
app.get('/api/predictions/top-picks', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const stat = req.query.stat || null;
    const picks = getTopPropPicks(limit, stat);
    res.json({ picks, count: picks.length, stat: stat || 'ALL' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all match predictions (for dashboard)
app.get('/api/predictions/matches', (req, res) => {
  try {
    if (!db) return res.json({ matches: [] });
    const games = db.getUpcomingGames();
    const gameIds = games.map(g => g.id);
    const predictions = db.getMatchPredictionsForGames(gameIds);
    const matches = games.map(g => {
      const pred = predictions.find(p => String(p.game_id) === String(g.id));
      return {
        id: g.id,
        date: g.date,
        away: { id: g.away_team_id, abbr: g.away_abbr, name: g.away_team_name, logo: g.away_logo, wins: g.away_wins, losses: g.away_losses, ppg: g.away_ppg, oppg: g.away_oppg },
        home: { id: g.home_team_id, abbr: g.home_abbr, name: g.home_team_name, logo: g.home_logo, wins: g.home_wins, losses: g.home_losses, ppg: g.home_ppg, oppg: g.home_oppg },
        prediction: pred ? {
          homeWinProb: pred.home_win_prob,
          predictedMargin: pred.predicted_margin,
          homeScorePred: pred.home_score_pred,
          awayScorePred: pred.away_score_pred,
          sharpSignal: pred.sharp_signal,
          sharpScore: pred.sharp_score,
          confidence: pred.confidence,
        } : null,
      };
    });
    res.json({ matches, count: matches.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live props for a specific game (real-time projection vs book lines)
app.get('/api/predictions/live/:eventId', (req, res) => {
  try {
    const data = getGameWithPredictions(req.params.eventId);
    // Enrich props with live odds comparison
    const odds = loadJson('live-odds.json');
    const gameOdds = Array.isArray(odds) ? odds.find(g => {
      return data.props.length && (
        g.home_team?.includes(data.props[0]?.opponentAbbr) ||
        g.away_team?.includes(data.props[0]?.teamAbbr)
      );
    }) : null;

    res.json({
      prediction: data.prediction,
      props: data.props.map(p => ({
        player: p.player_name,
        team: p.team_abbr,
        stat: p.stat,
        recommendation: p.recommendation,
        edge: p.edge,
        score: p.prop_score,
        confidence: p.confidence,
        valueRating: p.value_rating,
        projected: p.projected_value,
        fairLine: p.fair_line,
        sportsbookLine: p.sportsbook_line,
        kellyPct: p.kelly_pct,
        hitRate: p.hit_rate,
      })),
      gameOdds: gameOdds ? {
        homeML: gameOdds.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h')?.outcomes?.find(o => o.name === gameOdds.home_team)?.price,
        awayML: gameOdds.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h')?.outcomes?.find(o => o.name === gameOdds.away_team)?.price,
        total: gameOdds.bookmakers?.[0]?.markets?.find(m => m.key === 'totals')?.outcomes?.find(o => o.name === 'Over')?.point,
      } : null,
      sharp: data.sharp,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Native module status
app.get('/api/native/status', (req, res) => {
  res.json({
    isNative: core.isNative,
    module: core.isNative ? 'C native core' : 'JavaScript fallback',
    functions: ['americanToDecimal', 'americanToImpliedProb', 'removeVig', 'kellyCriterion', 'statistics', 'weightedAverage', 'hitRate', 'winProbability', 'playerProjection', 'propScore', 'detectSharpMoney'],
  });
});

// ─── Historical Matchup Data API ─────────────────────────
app.get('/api/historical/seasons', (req, res) => {
  try {
    const histDir = path.join(__dirname, '..', 'data', 'historical', 'seasons');
    if (!fs.existsSync(histDir)) return res.json({ seasons: [] });
    const dirs = fs.readdirSync(histDir).filter(d => fs.statSync(path.join(histDir, d)).isDirectory());
    const seasons = dirs.map(d => {
      const seasonDir = path.join(histDir, d);
      const teamsFile = path.join(seasonDir, 'teams.json');
      const playersFile = path.join(seasonDir, 'players.json');
      const matchupsFile = path.join(seasonDir, 'matchups.json');
      return {
        year: parseInt(d),
        label: `${d}-${String((parseInt(d)+1)%100).padStart(2,'0')}`,
        teams: fs.existsSync(teamsFile) ? Object.keys(JSON.parse(fs.readFileSync(teamsFile, 'utf8'))).length : 0,
        players: fs.existsSync(playersFile) ? Object.keys(JSON.parse(fs.readFileSync(playersFile, 'utf8'))).length : 0,
        matchups: fs.existsSync(matchupsFile) ? JSON.parse(fs.readFileSync(matchupsFile, 'utf8')).length : 0,
      };
    });
    res.json({ seasons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/historical/game/:gameId', (req, res) => {
  try {
    const histDir = path.join(__dirname, '..', 'data', 'historical', 'seasons');
    // Search all seasons for this game
    const dirs = fs.readdirSync(histDir).filter(d => fs.statSync(path.join(histDir, d)).isDirectory());
    for (const d of dirs) {
      const gameFile = path.join(histDir, d, 'games', `${req.params.gameId}.json`);
      if (fs.existsSync(gameFile)) {
        return res.json(JSON.parse(fs.readFileSync(gameFile, 'utf8')));
      }
    }
    res.status(404).json({ error: 'Game not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/historical/matchups/:team1/:team2', (req, res) => {
  try {
    const histDir = path.join(__dirname, '..', 'data', 'historical', 'seasons');
    const dirs = fs.readdirSync(histDir).filter(d => fs.statSync(path.join(histDir, d)).isDirectory());
    const matchups = [];
    for (const d of dirs) {
      const matchupsFile = path.join(histDir, d, 'matchups.json');
      if (fs.existsSync(matchupsFile)) {
        const all = JSON.parse(fs.readFileSync(matchupsFile, 'utf8'));
        const filtered = all.filter(m =>
          (m.home?.team === req.params.team1.toUpperCase() && m.away?.team === req.params.team2.toUpperCase()) ||
          (m.home?.team === req.params.team2.toUpperCase() && m.away?.team === req.params.team1.toUpperCase())
        );
        matchups.push(...filtered);
      }
    }
    matchups.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ matchups, total: matchups.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/historical/team/:teamAbbr', (req, res) => {
  try {
    const histDir = path.join(__dirname, '..', 'data', 'historical', 'seasons');
    const dirs = fs.readdirSync(histDir).filter(d => fs.statSync(path.join(histDir, d)).isDirectory());
    const team = req.params.teamAbbr.toUpperCase();
    const seasons = [];
    for (const d of dirs) {
      const teamsFile = path.join(histDir, d, 'teams.json');
      if (fs.existsSync(teamsFile)) {
        const teams = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
        if (teams[team]) {
          seasons.push({ year: parseInt(d), ...teams[team] });
        }
      }
    }
    res.json({ team, seasons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/historical/player/:playerId', (req, res) => {
  try {
    const histDir = path.join(__dirname, '..', 'data', 'historical', 'seasons');
    const dirs = fs.readdirSync(histDir).filter(d => fs.statSync(path.join(histDir, d)).isDirectory());
    const seasons = [];
    for (const d of dirs) {
      const playersFile = path.join(histDir, d, 'players.json');
      if (fs.existsSync(playersFile)) {
        const players = JSON.parse(fs.readFileSync(playersFile, 'utf8'));
        if (players[req.params.playerId]) {
          seasons.push({ year: parseInt(d), ...players[req.params.playerId] });
        }
      }
    }
    res.json({ playerId: req.params.playerId, seasons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Historical Training Data API ─────────────────────────
app.get('/api/training/status', (req, res) => {
  try {
    const summaryPath = path.join(__dirname, '..', 'ml', 'training_data', 'training_summary.json');
    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      res.json(summary);
    } else {
      res.json({ total_games: 0, message: 'No training data collected yet. Run collection first.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/training/seasons', (req, res) => {
  try {
    const histDir = path.join(__dirname, '..', 'data', 'historical');
    if (!fs.existsSync(histDir)) return res.json({ seasons: [] });
    const files = fs.readdirSync(histDir).filter(f => f.startsWith('games-') && f.endsWith('.json'));
    const seasons = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
      return {
        season: f.replace('games-', '').replace('.json', ''),
        games: data.length,
        date: data[0]?.date || '',
      };
    });
    res.json({ seasons, total: seasons.reduce((s, x) => s + x.games, 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Real Player Props API ─────────────────────────────────
app.get('/api/props/real', (req, res) => {
  const props = loadRealProps();
  res.json({
    events: props.events || [],
    totalEvents: props.totalEvents || 0,
    totalProps: props.totalProps || 0,
    fetchedAt: props.fetchedAt || null,
  });
});

app.get('/api/props/real/status', (req, res) => {
  res.json(getRealPropsStatus());
});

app.post('/api/props/real/fetch', async (req, res) => {
  try {
    const force = req.body?.force === true;
    const result = await fetchRealProps(force);
    res.json({
      success: true,
      events: result.totalEvents || 0,
      props: result.totalProps || 0,
      fetchedAt: result.fetchedAt || new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/props/real/player/:name/:stat', (req, res) => {
  const line = findPlayerPropLine(req.params.name, req.params.stat.toUpperCase());
  if (!line) return res.json({ found: false, message: 'No line found' });
  res.json({ found: true, ...line });
});

// ─── ML Model API ──────────────────────────────────────────
app.get('/api/ml/status', (req, res) => {
  const info = getMLInfo();
  res.json(info || { status: 'No model trained' });
});

app.post('/api/ml/train', (req, res) => {
  try {
    const result = trainML();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ml/predict/:homeId/:awayId', (req, res) => {
  const pred = predictML(req.params.homeId, req.params.awayId);
  if (!pred) return res.json({ error: 'Could not predict — missing model or data' });
  res.json(pred);
});

// Train ML model + generate predictions on startup (non-blocking)
setTimeout(() => {
  try {
    // Train ML model first (so predictions use it)
    console.log('[ml] Training model on historical game data...');
    const mlResult = trainML();
    if (mlResult) {
      console.log(`[ml] Model trained: ${(mlResult.testAccuracy * 100).toFixed(1)}% accuracy on ${mlResult.samples} games`);
    }
  } catch (err) {
    console.error('[ml] Training error:', err.message);
  }

  try {
    console.log('[predictions] Auto-generating predictions on startup...');
    const result = generateAllPredictions();
    console.log(`[predictions] Startup generation complete: ${result.games} games, ${result.totalProps} props`);
  } catch (err) {
    console.error('[predictions] Startup generation error:', err.message);
  }
}, 10000); // Wait 10s for data to load

// ─── 404 (must be last) ─────────────────────────────────────────
app.use((req, res) => { res.status(404).json({ error: 'Not found' }); });

const server = http.createServer(app);

server.listen(PORT, () => {
  const f = fs.readdirSync(DATA).filter(x => x.endsWith('.json'));
  console.log(`[SHARPEDGE] Server on :${PORT} — ${f.length} data files, ${Object.keys(TEAM_MAP).length} teams, ${Object.keys(PLAYER_MAP).length} players`);

  // Start WebSocket server for live updates
  ws.start(server);

  // Collect fresh news on startup + auto-refresh every hour
  collectNews().then(() => {
    // Refresh news every 60 minutes
    setInterval(() => {
      collectNews().then(result => {
        console.log(`[news] Auto-refresh: ${result.total} articles`);
        invalidateCache('news');
      }).catch(err => console.error('[news] Auto-refresh error:', err.message));
    }, 60 * 60 * 1000);
  }).catch(err => console.error('[news] Error:', err.message));

  // Use cached odds on startup (don't waste API credits)
  const cachedOdds = loadJson('live-odds.json');
  if (cachedOdds && Array.isArray(cachedOdds) && cachedOdds.length > 0) {
    console.log(`[odds] Using cached odds: ${cachedOdds.length} games (startup fetch skipped to save credits)`);
  } else {
    // Only fetch if no cached data exists
    fetchLiveOdds().then(data => {
      console.log(`[odds] Initial fetch: ${Array.isArray(data) ? data.length : 0} games`);
    }).catch(err => console.error('[odds] Startup fetch error:', err.message));
  }

  // Fetch real player props (non-blocking, uses cached if available)
  setTimeout(() => {
    fetchRealProps().then(result => {
      console.log(`[props] Real props: ${result.totalEvents || 0} events, ${result.totalProps || 0} props`);
    }).catch(err => console.error('[props] Fetch error:', err.message));

    // Then refresh props every 6 hours
    setInterval(() => {
      fetchRealProps().then(result => {
        if (result.totalProps > 0) console.log(`[props] Refreshed: ${result.totalEvents} events, ${result.totalProps} props`);
      }).catch(err => console.error('[props] Refresh error:', err.message));
    }, 6 * 60 * 60 * 1000);
  }, 15000); // Wait 15s for odds to load first

  // Auto-refresh odds once per day at 8 AM — saves API credits
  // Free tier: 500/month. At 1/day = 30/month, leaves plenty of room.
  const now = new Date();
  const next8AM = new Date(now);
  next8AM.setHours(8, 0, 0, 0);
  if (next8AM <= now) next8AM.setDate(next8AM.getDate() + 1);
  const msUntil8AM = next8AM.getTime() - now.getTime();
  console.log(`[odds] Next auto-refresh in ${Math.round(msUntil8AM / 3600000)}h ${Math.round((msUntil8AM % 3600000) / 60000)}m`);
  setTimeout(() => {
    fetchLiveOdds().then(data => {
      console.log(`[odds] Daily refresh: ${Array.isArray(data) ? data.length : 0} games`);
    }).catch(err => console.error('[odds] Daily refresh error:', err.message));
    // Then every 24 hours
    setInterval(() => {
      fetchLiveOdds().then(data => {
        console.log(`[odds] Daily refresh: ${Array.isArray(data) ? data.length : 0} games`);
      }).catch(err => console.error('[odds] Daily refresh error:', err.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil8AM);

  // Legacy odds fetch (skip — already handled by fetchLiveOdds)
  // collectOdds().catch(err => console.error('[odds] Legacy error:', err.message));

  // Run data collector in background (non-blocking)
  collectAll().then(() => {
    rebuildTeamMap();
    rebuildPlayerMap();
    console.log(`[SHARPEDGE] Data refreshed — ${Object.keys(PLAYER_MAP).length} players`);
  }).catch(err => console.error('[collector] Error:', err.message));

  // Auto-evolve: check predictions + discover patterns every 30 minutes
  setInterval(() => {
    try {
      const result = checkPredictions([]);
      if (result.newChecked > 0) console.log(`[evolve] Checked ${result.newChecked} predictions, ${result.newCorrect} correct`);
      const patterns = discoverPatterns();
      if (patterns.length > 0) console.log(`[evolve] ${patterns.length} patterns discovered`);
    } catch (err) {
      console.error('[evolve] Error:', err.message);
    }
  }, 30 * 60 * 1000);
});

// ─── Enhanced Player Stats API ────────────────────────────────────
const ps = require('./player-stats.cjs');

// Player enhanced profile with averages, last 5/10, consistency, hit rates
app.get('/api/players/:id/profile', (req, res) => {
  try {
    const profile = ps.buildPlayerProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Player not found or insufficient data' });
    
    const playerInfo = PLAYER_MAP[req.params.id] || {};
    res.json({
      ...playerInfo,
      profile,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Player stat projection
app.get('/api/players/:id/projection/:stat', (req, res) => {
  try {
    const projection = ps.projectPlayerStat(req.params.id, req.params.stat.toUpperCase());
    if (!projection) return res.status(404).json({ error: 'Projection not available' });
    res.json(projection);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Player prop value finder
app.get('/api/players/:id/value/:stat/:line', (req, res) => {
  try {
    const value = ps.findPropValue(
      req.params.id,
      req.params.stat.toUpperCase(),
      parseFloat(req.params.line)
    );
    if (!value) return res.status(404).json({ error: 'Value calculation not available' });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All players on a team with profiles
app.get('/api/teams/:id/players', (req, res) => {
  try {
    const players = ps.getTeamPlayers(req.params.id);
    res.json({ players, count: players.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Game projections for both teams
app.get('/api/projections/game/:awayId/:homeId', (req, res) => {
  try {
    const projections = ps.generateGameProjections(req.params.homeId, req.params.awayId);
    res.json({ projections, count: projections.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search players by name
app.get('/api/players/search/:query', (req, res) => {
  try {
    const q = req.params.query.toLowerCase();
    const results = [];
    
    Object.values(PLAYER_MAP).forEach(p => {
      if (p.name.toLowerCase().includes(q) || p.lastName?.toLowerCase().includes(q)) {
        const profile = ps.buildPlayerProfile(p.id);
        results.push({
          ...p,
          hasProfile: !!profile,
          gamesPlayed: profile?.gamesPlayed || 0,
          ppg: profile?.seasonAvg?.PTS || 0,
        });
      }
    });
    
    results.sort((a, b) => b.ppg - a.ppg);
    res.json({ results: results.slice(0, 20), total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Injury Impact API ──────────────────────────────────────
const { getInjuryImpact, calculateInjuryAdjustment } = require('./prediction-engine.cjs');

app.get('/api/injuries/impact/:awayId/:homeId', (req, res) => {
  try {
    const homeInjuries = getInjuryImpact(req.params.homeId, '');
    const awayInjuries = getInjuryImpact(req.params.awayId, '');
    const adjustment = calculateInjuryAdjustment(homeInjuries, awayInjuries);
    res.json(adjustment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── News Betting Signal Extraction ──────────────────────────
app.get('/api/news/signals', (req, res) => {
  try {
    const data = loadJson('news.json');
    const articles = data?.articles || [];
    const signals = [];

    // Keyword-based signal extraction from headlines
    const INJURY_KEYWORDS = ['injury', 'hurt', 'out', 'doubtful', 'questionable', 'sprain', 'strain', 'surgery', 'sidelined', 'ruled out', 'game-time decision'];
    const TRADE_KEYWORDS = ['trade', 'traded', 'acquire', 'acquired', 'deal', 'sign', 'signed', 'waive', 'waived', 'release', 'released'];
    const SUSPENSION_KEYWORDS = ['suspension', 'suspended', 'ban', 'banned', 'fined'];
    const RUMOR_KEYWORDS = ['rumor', 'rumblings', 'reportedly', 'could', 'might', 'interest', 'pursuit', 'target'];
    const REST_KEYWORDS = ['rest', 'resting', 'load management', 'sits out'];

    for (const article of articles) {
      const text = `${article.title || ''} ${article.description || ''}`.toLowerCase();
      const teams = article.teams || [];
      const players = article.players || [];

      let signalType = null;
      let severity = 'LOW';
      let description = '';

      // Check for injury signals
      if (INJURY_KEYWORDS.some(kw => text.includes(kw))) {
        signalType = 'INJURY';
        severity = /out|ruled out|surgery|sidelined/.test(text) ? 'HIGH' : /doubtful|questionable/.test(text) ? 'MEDIUM' : 'LOW';
        description = `Injury report: ${article.title?.replace(/ - [^-]+$/, '').slice(0, 120)}`;
      }
      // Check for trade signals
      else if (TRADE_KEYWORDS.some(kw => text.includes(kw))) {
        signalType = 'TRADE';
        severity = /traded|acquired|deal/.test(text) ? 'HIGH' : 'MEDIUM';
        description = `Trade activity: ${article.title?.replace(/ - [^-]+$/, '').slice(0, 120)}`;
      }
      // Check for suspension signals
      else if (SUSPENSION_KEYWORDS.some(kw => text.includes(kw))) {
        signalType = 'SUSPENSION';
        severity = 'HIGH';
        description = `Suspension: ${article.title?.replace(/ - [^-]+$/, '').slice(0, 120)}`;
      }
      // Check for rest/load management
      else if (REST_KEYWORDS.some(kw => text.includes(kw))) {
        signalType = 'REST';
        severity = 'MEDIUM';
        description = `Rest/load management: ${article.title?.replace(/ - [^-]+$/, '').slice(0, 120)}`;
      }
      // Check for trade rumors
      else if (RUMOR_KEYWORDS.some(kw => text.includes(kw)) && TRADE_KEYWORDS.some(kw => text.includes(kw))) {
        signalType = 'RUMOR';
        severity = 'LOW';
        description = `Trade rumor: ${article.title?.replace(/ - [^-]+$/, '').slice(0, 120)}`;
      }

      if (signalType) {
        signals.push({
          type: signalType,
          severity,
          description,
          source: article.source,
          published: article.published,
          teams,
          players,
          headline: article.title?.replace(/ - [^-]+$/, ''),
          link: article.link,
        });
      }
    }

    // Sort by severity then date
    const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    signals.sort((a, b) => (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2));

    res.json({
      signals,
      count: signals.length,
      byType: {
        INJURY: signals.filter(s => s.type === 'INJURY').length,
        TRADE: signals.filter(s => s.type === 'TRADE').length,
        SUSPENSION: signals.filter(s => s.type === 'SUSPENSION').length,
        REST: signals.filter(s => s.type === 'REST').length,
        RUMOR: signals.filter(s => s.type === 'RUMOR').length,
      },
      highSeverity: signals.filter(s => s.severity === 'HIGH').length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


