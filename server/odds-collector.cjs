/**
 * SHARPEDGE Real Odds Collector
 * 
 * Fetches live NBA odds from The Odds API.
 * Stores odds history for line movement tracking.
 * Replaces the old static live-odds.json with real data.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ODDS_FILE = path.join(DATA, 'live-odds.json');
const ODDS_HISTORY_FILE = path.join(DATA, 'odds-history.json');

function getApiKey() {
  // Try process.env first, then read .env file
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY;
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const match = envFile.match(/ODDS_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

function fetchOdds() {
  return new Promise((resolve, reject) => {
    const key = getApiKey();
    if (!key) return reject(new Error('No ODDS_API_KEY found'));

    const url = `/v4/sports/basketball_nba/odds/?apiKey=${key}&regions=us&markets=spreads,totals,h2h&bookmakers=fanduel,draftkings,betmgm,bovada&oddsFormat=american`;

    const req = https.request({
      hostname: 'api.the-odds-api.com',
      path: url,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 30000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const remaining = parseInt(res.headers['x-requests-remaining'] || '500');
          const used = parseInt(res.headers['x-requests-used'] || '0');
          const games = JSON.parse(data);

          if (!Array.isArray(games)) {
            return reject(new Error(`API error: ${games.message || 'Unknown'}`));
          }

          console.log(`[odds] Fetched ${games.length} games, ${remaining} requests remaining`);
          resolve({ games, remaining, used });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function saveOdds(games) {
  // Save current odds
  fs.writeFileSync(ODDS_FILE, JSON.stringify(games, null, 2));
  console.log(`[odds] Saved ${games.length} games to ${ODDS_FILE}`);

  // Append to history for line movement tracking
  let history = [];
  try { history = JSON.parse(fs.readFileSync(ODDS_HISTORY_FILE, 'utf8')); } catch {}

  const timestamp = Date.now();
  const snapshot = {
    timestamp,
    date: new Date().toISOString(),
    games: games.map(g => ({
      id: g.id,
      sport_key: g.sport_key,
      commence_time: g.commence_time,
      home_team: g.home_team,
      away_team: g.away_team,
      bookmakers: (g.bookmakers || []).map(b => ({
        key: b.key,
        title: b.title,
        last_update: b.last_update,
        markets: (b.markets || []).map(m => ({
          key: m.key,
          outcomes: (m.outcomes || []).map(o => ({
            name: o.name,
            price: o.price,
            point: o.point,
          })),
        })),
      })),
    })),
  };

  history.push(snapshot);

  // Keep last 500 snapshots (about 2 weeks of updates every 15 min)
  if (history.length > 500) history = history.slice(-500);

  fs.writeFileSync(ODDS_HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`[odds] History: ${history.length} snapshots`);
}

function getLineMovements(team1, team2) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(ODDS_HISTORY_FILE, 'utf8')); } catch {}

  // Find all snapshots for this matchup
  const relevant = history.filter(snap =>
    snap.games.some(g =>
      (g.home_team === team1 && g.away_team === team2) ||
      (g.home_team === team2 && g.away_team === team1)
    )
  );

  if (relevant.length < 2) return { movements: [], sufficient: false };

  // Track spread movements over time
  const movements = [];
  for (let i = 1; i < relevant.length; i++) {
    const prev = relevant[i - 1];
    const curr = relevant[i];

    const prevGame = prev.games.find(g =>
      (g.home_team === team1 && g.away_team === team2) ||
      (g.home_team === team2 && g.away_team === team1)
    );
    const currGame = curr.games.find(g =>
      (g.home_team === team1 && g.away_team === team2) ||
      (g.home_team === team2 && g.away_team === team1)
    );

    if (!prevGame || !currGame) continue;

    // Compare spreads from the first bookmaker
    const prevSpread = prevGame.bookmakers?.[0]?.markets?.find(m => m.key === 'spreads')?.outcomes?.find(o => o.name === team1)?.point;
    const currSpread = currGame.bookmakers?.[0]?.markets?.find(m => m.key === 'spreads')?.outcomes?.find(o => o.name === team1)?.point;

    if (prevSpread != null && currSpread != null && prevSpread !== currSpread) {
      movements.push({
        time: curr.date,
        spread: { from: prevSpread, to: currSpread, change: currSpread - prevSpread },
      });
    }
  }

  return { movements, sufficient: relevant.length >= 3 };
}

async function collect() {
  console.log('[odds] Fetching live NBA odds...');
  const { games, remaining } = await fetchOdds();
  saveOdds(games);
  return { games: games.length, remaining };
}

module.exports = { collect, fetchOdds, saveOdds, getLineMovements, getApiKey };

// Run if called directly
if (require.main === module) {
  collect().then(r => console.log(`[odds] Done: ${r.games} games, ${r.remaining} requests left`)).catch(e => console.error('[odds] Error:', e.message));
}
