/**
 * ODDS FETCHER v3.0 — Quota-Aware
 * 
 * Pulls real NBA odds from The Odds API
 * Free tier: 500 credits/month (~16 requests/day)
 * Each request = 1 credit per sport (NBA = 1 credit)
 * 
 * v3.0 adds:
 *  - Server-side cooldown (min 30 min between fetches)
 *  - Quota tracking (remaining/used credits)
 *  - Daily usage counter
 *  - One-fetch-per-day mode for extreme conservation
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ODDS_FILE = path.join(DATA, 'live-odds.json');
const ODDS_HISTORY_FILE = path.join(DATA, 'odds-history.json');
const QUOTA_FILE = path.join(DATA, 'odds-quota.json');

// ─── Rate Limiting State ─────────────────────────────────────
let lastFetchTime = 0;
let lastRemaining = null;
let lastUsed = null;
let dailyCount = 0;
let dailyDate = '';
let isFetching = false;

// Minimum gap between API calls (30 minutes default)
const MIN_COOLDOWN_MS = 30 * 60 * 1000;

function loadQuotaState() {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    lastFetchTime = data.lastFetchTime || 0;
    lastRemaining = data.lastRemaining;
    lastUsed = data.lastUsed;
    dailyCount = data.dailyCount || 0;
    dailyDate = data.dailyDate || '';
    // Reset daily counter if it's a new day
    const today = new Date().toISOString().slice(0, 10);
    if (dailyDate !== today) {
      dailyCount = 0;
      dailyDate = today;
    }
  } catch {}
}

function saveQuotaState() {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({
      lastFetchTime,
      lastRemaining,
      lastUsed,
      dailyCount,
      dailyDate,
      lastUpdated: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

// Load on module init
loadQuotaState();

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 30000,
    }, res => {
      if (res.statusCode === 429) {
        return reject(new Error('Rate limited — wait before retrying'));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      // Extract quota headers from The Odds API
      const remaining = res.headers['x-requests-remaining'];
      const used = res.headers['x-requests-used'];

      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Attach quota info to the response
          parsed._quota = {
            remaining: remaining ? parseInt(remaining) : null,
            used: used ? parseInt(used) : null,
          };
          resolve(parsed);
        } catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`[odds] Save error:`, e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// QUOTA STATUS — Check current usage without making an API call
// ═══════════════════════════════════════════════════════════════════

function getQuotaStatus() {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  
  // Reset daily count if new day
  if (dailyDate !== today) {
    dailyCount = 0;
    dailyDate = today;
  }

  const timeSinceLastFetch = now - lastFetchTime;
  const cooldownRemaining = Math.max(0, MIN_COOLDOWN_MS - timeSinceLastFetch);
  const canFetch = cooldownRemaining === 0 && !isFetching;
  
  // Estimate remaining monthly credits
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth = new Date().getDate();
  const estimatedMonthlyRemaining = lastRemaining != null 
    ? lastRemaining 
    : Math.max(0, 500 - (dailyCount * dayOfMonth)); // rough estimate

  return {
    lastFetchTime: lastFetchTime ? new Date(lastFetchTime).toISOString() : null,
    lastRemaining: lastRemaining,
    lastUsed: lastUsed,
    dailyCount,
    dailyDate,
    cooldownMs: MIN_COOLDOWN_MS,
    cooldownRemaining,
    canFetch,
    isFetching,
    estimatedMonthlyRemaining,
    minutesUntilNextFetch: Math.ceil(cooldownRemaining / 60000),
    monthlyBudget: 500,
    dailyBudget: 16,
    recommendation: getRecommendation(estimatedMonthlyRemaining, dailyCount),
  };
}

function getRecommendation(remaining, dailyCount) {
  if (remaining != null && remaining < 20) return 'CRITICAL — Only fetch once per game day';
  if (remaining != null && remaining < 50) return 'LOW — Fetch only before tipoff';
  if (dailyCount >= 10) return 'HIGH USAGE — Consider reducing frequency';
  if (dailyCount >= 5) return 'MODERATE — OK for game days';
  return 'HEALTHY — Plenty of credits remaining';
}

// ═══════════════════════════════════════════════════════════════════
// FETCH LIVE ODDS — with cooldown protection
// ═══════════════════════════════════════════════════════════════════

async function fetchLiveOdds(force = false) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error('ODDS_API_KEY not set in .env');

  // ─── Cooldown check ─────────────────────────────────────
  const now = Date.now();
  const timeSinceLastFetch = now - lastFetchTime;
  
  if (!force && timeSinceLastFetch < MIN_COOLDOWN_MS) {
    const waitMinutes = Math.ceil((MIN_COOLDOWN_MS - timeSinceLastFetch) / 60000);
    throw new Error(`Cooldown active — wait ${waitMinutes} more minutes. Use force=true to bypass.`);
  }

  if (isFetching) {
    throw new Error('Fetch already in progress — please wait');
  }

  isFetching = true;

  try {
    // Fetch NBA odds from US books, all markets
    const url = `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=fanduel,draftkings,betmgm,bovada,caesars`;

    console.log('[odds] Fetching live NBA odds from The Odds API...');
    const data = await fetchUrl(url);

    // Update quota tracking
    lastFetchTime = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    if (dailyDate !== today) {
      dailyCount = 0;
      dailyDate = today;
    }
    dailyCount++;

    if (data._quota) {
      lastRemaining = data._quota.remaining;
      lastUsed = data._quota.used;
    }

    saveQuotaState();

    const gameCount = Array.isArray(data) ? data.length : 0;
    const quotaInfo = data._quota ? ` [${data._quota.remaining} credits remaining]` : '';
    console.log(`[odds] Received ${gameCount} games${quotaInfo}`);

    // Save to JSON file (backward compat)
    saveJson(ODDS_FILE, data);

    // Append to JSON history
    const history = loadJson(ODDS_HISTORY_FILE) || [];
    history.push({
      timestamp: new Date().toISOString(),
      gameCount,
      games: Array.isArray(data) ? data.map(g => ({
        matchup: `${g.away_team} @ ${g.home_team}`,
        commence: g.commence_time,
        books: g.bookmakers?.length || 0,
      })) : [],
    });
    saveJson(ODDS_HISTORY_FILE, history.slice(-100));

    // Save to SQLite database
    try {
      const db = require('./db.cjs');
      db.saveOddsBatch(data);
      db.setMeta('last_odds_fetch', new Date().toISOString());
      console.log(`[odds] Saved to database`);
    } catch (e) {
      console.error(`[odds] DB save error:`, e.message);
    }

    return data;
  } finally {
    isFetching = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// CHECK CREDITS — See remaining API quota
// ═══════════════════════════════════════════════════════════════════

async function checkCredits() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error('ODDS_API_KEY not set');

  const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`;
  const data = await fetchUrl(url);
  return { sports: Array.isArray(data) ? data.length : 0 };
}

// ═══════════════════════════════════════════════════════════════════
// LINE MOVEMENT — Detect sharp activity
// ═══════════════════════════════════════════════════════════════════

function detectLineMovements() {
  const current = loadJson(ODDS_FILE);
  const history = loadJson(ODDS_HISTORY_FILE) || [];
  
  if (!Array.isArray(current) || history.length < 2) return [];

  const movements = [];
  current.forEach(game => {
    const books = game.bookmakers || [];
    if (books.length < 2) return;

    // Get current best lines
    const spreads = books.map(b => ({
      book: b.title,
      home: b.markets?.find(m => m.key === 'spreads')?.outcomes?.find(o => o.name === game.home_team)?.point,
      away: b.markets?.find(m => m.key === 'spreads')?.outcomes?.find(o => o.name === game.away_team)?.point,
    })).filter(s => s.home != null);

    const totals = books.map(b => ({
      book: b.title,
      over: b.markets?.find(m => m.key === 'totals')?.outcomes?.find(o => o.name === 'Over')?.point,
    })).filter(t => t.over != null);

    const mls = books.map(b => ({
      book: b.title,
      home: b.markets?.find(m => m.key === 'h2h')?.outcomes?.find(o => o.name === game.home_team)?.price,
    })).filter(m => m.home != null);

    // Cross-book discrepancies
    const spreadValues = spreads.map(s => s.home).filter(v => v != null);
    const totalValues = totals.map(t => t.over).filter(v => v != null);
    const mlValues = mls.map(m => m.home).filter(v => v != null);

    const spreadGap = spreadValues.length >= 2 ? Math.max(...spreadValues) - Math.min(...spreadValues) : 0;
    const totalGap = totalValues.length >= 2 ? Math.max(...totalValues) - Math.min(...totalValues) : 0;
    const mlGap = mlValues.length >= 2 ? Math.max(...mlValues) - Math.min(...mlValues) : 0;

    if (spreadGap >= 1 || totalGap >= 2 || mlGap >= 10) {
      movements.push({
        matchup: `${game.away_team} @ ${game.home_team}`,
        spreadGap: spreadGap.toFixed(1),
        totalGap: totalGap.toFixed(1),
        mlGap,
        bestSpread: spreads.reduce((best, s) => s.home < best.home ? s : best, spreads[0]),
        bestTotal: totals.reduce((best, t) => t.over > best.over ? t : best, totals[0]),
        bestML: mls.reduce((best, m) => m.home > best.home ? m : best, mls[0]),
        sharpSignal: spreadGap >= 2 || mlGap >= 15 ? 'STRONG' : spreadGap >= 1 || mlGap >= 10 ? 'MODERATE' : 'WEAK',
      });
    }
  });

  return movements;
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// ODDSPAPI INTEGRATION — Sharp books (Pinnacle, etc.)
// ═══════════════════════════════════════════════════════════════════

const ODDSPAPI_KEY = process.env.ODDSPAPI_KEY || '';
const ODDSPAPI_BASE = 'https://api.oddspapi.io/v4';
let oddspapiQuota = { remaining: 250, used: 0, lastFetch: 0 };
const ODDSPAPI_COOLDOWN = 5 * 60 * 1000; // 5 minutes between OddsPapi calls

/**
 * Fetch odds from OddsPapi (includes Pinnacle + 350 books).
 * Free tier: 250 requests/month.
 */
async function fetchOddsPapi(force = false) {
  if (!ODDSPAPI_KEY) {
    console.log('[odds] ODDSPAPI_KEY not set — skipping sharp book data');
    return null;
  }

  const now = Date.now();
  if (!force && (now - oddspapiQuota.lastFetch) < ODDSPAPI_COOLDOWN) {
    console.log('[odds] OddsPapi cooldown active');
    return null;
  }

  try {
    // Get upcoming NBA fixtures with odds
    const url = `${ODDSPAPI_BASE}/odds?sportId=4&hasOdds=true&apiKey=${ODDSPAPI_KEY}`;
    console.log('[odds] Fetching sharp book odds from OddsPapi (Pinnacle included)...');
    
    const data = await fetchUrl(url);
    oddspapiQuota.lastFetch = now;
    
    if (Array.isArray(data)) {
      console.log(`[odds] OddsPapi: received ${data.length} fixtures with sharp book odds`);
      return data;
    }
    
    return data;
  } catch (e) {
    console.error('[odds] OddsPapi error:', e.message);
    return null;
  }
}

/**
 * Merge sharp book data (OddsPapi/Pinnacle) with existing odds.
 * This gives you the best of both worlds: US books + sharp books.
 */
function mergeOddsData(softBooksData, sharpBooksData) {
  if (!sharpBooksData) return softBooksData;
  if (!Array.isArray(softBooksData)) return sharpBooksData;
  if (!Array.isArray(sharpBooksData)) return softBooksData;
  
  // TODO: merge logic based on game IDs and bookmaker keys
  // For now, return combined
  return softBooksData;
}

// ═══════════════════════════════════════════════════════════════════
// INTEGRATED FETCH — All systems
// ═══════════════════════════════════════════════════════════════════

/**
 * Enhanced fetch that integrates CLV tracking, sharp detection, and +EV.
 */
async function fetchAndAnalyze(force = false) {
  // 1. Fetch current odds (existing system)
  const oddsData = await fetchLiveOdds(force);
  if (!oddsData) return null;
  
  // 2. Fetch sharp book data (OddsPapi)
  const sharpData = await fetchOddsPapi(force);
  
  // 3. Capture line snapshots for CLV tracking
  try {
    const clvTracker = require('./clv-tracker.cjs');
    clvTracker.captureLineSnapshot(oddsData, 'movement');
    clvTracker.captureOpeningLines(oddsData);
  } catch (e) {
    console.error('[odds] CLV tracking error:', e.message);
  }
  
  // 4. Check for closing line capture
  try {
    const closingCapture = require('./closing-line-capture.cjs');
    closingCapture.runCaptureCycle(oddsData);
  } catch (e) {
    console.error('[odds] Closing capture error:', e.message);
  }
  
  // 5. Detect sharp signals
  let sharpSignals = null;
  try {
    const sharpDetector = require('./sharp-detector.cjs');
    const previousOdds = loadJson(path.join(DATA, 'live-odds-previous.json'));
    sharpSignals = sharpDetector.detectAllSharpSignals(oddsData, previousOdds);
    if (sharpSignals.gamesWithSharp > 0) {
      console.log(`[odds] Detected ${sharpSignals.gamesWithSharp} games with sharp action`);
      sharpDetector.saveSignals(sharpSignals);
    }
  } catch (e) {
    console.error('[odds] Sharp detection error:', e.message);
  }
  
  // 6. Save current as previous for next comparison
  try {
    saveJson(path.join(DATA, 'live-odds-previous.json'), oddsData);
  } catch {}
  
  // 7. Resolve any pending predictions
  try {
    const accuracyTracker = require('./accuracy-tracker.cjs');
    const resolved = accuracyTracker.resolveAllPending();
    if (resolved.resolved > 0) {
      console.log(`[odds] Resolved ${resolved.resolved} predictions`);
    }
  } catch (e) {
    console.error('[odds] Accuracy tracking error:', e.message);
  }
  
  return {
    odds: oddsData,
    sharpData,
    sharpSignals,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  fetchLiveOdds,
  fetchOddsPapi,
  fetchAndAnalyze,
  checkCredits,
  detectLineMovements,
  getQuotaStatus,
  MIN_COOLDOWN_MS,
};
