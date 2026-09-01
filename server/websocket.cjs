/**
 * SHARPEDGE WebSocket Server
 * 
 * Pushes live updates to connected clients:
 * - Odds changes (line movements)
 * - Score updates (live games)
 * - News alerts (breaking stories)
 * - Injury updates
 * 
 * Clients connect once and receive all updates automatically.
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ODDS_FILE = path.join(DATA, 'live-odds.json');

let wss = null;
let clients = new Set();
let previousOdds = null;
let pollInterval = null;

// ─── Load API key ──────────────────────────────────────────────
function getApiKey() {
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY;
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const match = envFile.match(/ODDS_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

// ─── Fetch odds from The Odds API ─────────────────────────────
function fetchOdds() {
  return new Promise((resolve, reject) => {
    const key = getApiKey();
    if (!key) return reject(new Error('No API key'));

    const req = https.request({
      hostname: 'api.the-odds-api.com',
      path: `/v4/sports/basketball_nba/odds/?apiKey=${key}&regions=us&markets=spreads,totals,h2h&bookmakers=fanduel,draftkings,betmgm,bovada&oddsFormat=american`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 30000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const games = JSON.parse(data);
          if (!Array.isArray(games)) return reject(new Error(games.message || 'API error'));
          resolve({
            games,
            remaining: parseInt(res.headers['x-requests-remaining'] || '0'),
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── Detect line changes between two snapshots ────────────────
function detectChanges(prev, curr) {
  if (!prev || !curr) return [];

  const changes = [];
  const prevMap = new Map(prev.map(g => [`${g.away_team}-${g.home_team}`, g]));
  const currMap = new Map(curr.map(g => [`${g.away_team}-${g.home_team}`, g]));

  for (const [key, currGame] of currMap) {
    const prevGame = prevMap.get(key);
    if (!prevGame) {
      changes.push({ type: 'new_game', game: currGame });
      continue;
    }

    const currBooks = currGame.bookmakers || [];
    const prevBooks = prevGame.bookmakers || [];

    for (const cb of currBooks) {
      const pb = prevBooks.find(b => b.key === cb.key);
      if (!pb) continue;

      const cbMarkets = cb.markets || [];
      const pbMarkets = pb.markets || [];

      for (const cm of cbMarkets) {
        const pm = pbMarkets.find(m => m.key === cm.key);
        if (!pm) continue;

        for (const co of cm.outcomes || []) {
          const po = pm.outcomes?.find(o => o.name === co.name && o.point === co.point);
          if (!po) continue;

          // Detect price change
          if (co.price !== po.price) {
            const spreadChange = cm.key === 'spreads' ? (co.point !== po.point) : false;
            changes.push({
              type: spreadChange ? 'spread_move' : 'price_change',
              game: `${currGame.away_team} @ ${currGame.home_team}`,
              book: cb.title,
              market: cm.key,
              team: co.name,
              from: po.price,
              to: co.price,
              point: co.point,
              pointFrom: po.point,
              direction: co.price > po.price ? 'up' : 'down',
            });
          }
        }
      }
    }
  }

  return changes;
}

// ─── Broadcast to all connected clients ───────────────────────
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  }
}

// ─── Odds polling cycle ───────────────────────────────────────
let isPolling = false;
let lastPollTime = 0;

async function pollOdds() {
  if (isPolling) return;
  isPolling = true;

  try {
    const { games, remaining } = await fetchOdds();
    const now = Date.now();

    // Save to file
    fs.writeFileSync(ODDS_FILE, JSON.stringify(games, null, 2));

    // Detect changes
    const changes = detectChanges(previousOdds, games);

    // Broadcast updates
    broadcast({
      type: 'odds_update',
      timestamp: now,
      gameCount: games.length,
      requestsRemaining: remaining,
      changes,
    });

    // Broadcast specific line movements
    if (changes.length > 0) {
      console.log(`[ws] ${changes.length} line movements detected`);
      broadcast({
        type: 'line_movements',
        timestamp: now,
        movements: changes,
      });
    }

    previousOdds = games;
    lastPollTime = now;

    // Log usage
    if (remaining <= 10) {
      console.log(`[ws] WARNING: Only ${remaining} API requests remaining`);
    }
  } catch (err) {
    console.error('[ws] Odds poll error:', err.message);
  } finally {
    isPolling = false;
  }
}

// ─── Start the WebSocket server ───────────────────────────────
function start(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[ws] Client connected (${clients.size} total)`);

    // Send current odds immediately
    try {
      const current = JSON.parse(fs.readFileSync(ODDS_FILE, 'utf8'));
      ws.send(JSON.stringify({
        type: 'initial',
        timestamp: Date.now(),
        games: current,
      }));
    } catch {}

    // Send connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to SHARPEDGE live feed',
      pollInterval: '60 seconds during game hours',
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        // Client can request specific updates
        if (msg.type === 'refresh_odds') {
          pollOdds();
        }
      } catch {}
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] Client disconnected (${clients.size} total)`);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  // Start polling — every 60 seconds
  // During game hours (roughly 7 PM - 1 AM ET), poll more frequently
  pollInterval = setInterval(() => {
    const hour = new Date().getUTCHours() - 5; // ET offset (rough)
    const isGameHours = hour >= 18 || hour <= 1; // 6 PM - 1 AM ET
    const interval = isGameHours ? 60000 : 300000; // 1 min vs 5 min

    if (Date.now() - lastPollTime >= interval) {
      pollOdds();
    }
  }, 30000); // Check every 30 seconds if we should poll

  // Initial poll
  pollOdds();

  console.log('[ws] WebSocket server started on /ws');
}

function stop() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (wss) { wss.close(); wss = null; }
}

module.exports = { start, stop, broadcast, pollOdds, detectChanges, getClientCount: () => clients.size };
