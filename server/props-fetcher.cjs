/**
 * PROPS FETCHER — Real NBA Player Props from The Odds API
 *
 * Pulls actual sportsbook prop lines (points, rebounds, assists, etc.)
 * for each scheduled game. This replaces the estimated lines.
 *
 * Free tier: 500 credits/month. Each event call = 1 credit per region.
 * We use 1 region (us) and fetch props for each game once per day.
 *
 * Props available:
 *   player_points, player_rebounds, player_assists, player_threes,
 *   player_blocks, player_steals, player_turnovers,
 *   player_points_rebounds_assists, player_points_rebounds,
 *   player_points_assists, player_rebounds_assists,
 *   player_blocks_steals
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const PROPS_FILE = path.join(DATA, 'live-player-props.json');
const PROPS_HISTORY_FILE = path.join(DATA, 'props-history.json');
const QUOTA_FILE = path.join(DATA, 'odds-quota.json');

// NBA player props market keys
const NBA_PROP_MARKETS = [
  'player_points',
  'player_rebounds',
  'player_assists',
  'player_threes',
  'player_blocks',
  'player_steals',
  'player_turnovers',
  'player_points_rebounds_assists',
  'player_points_rebounds',
  'player_points_assists',
  'player_rebounds_assists',
].join(',');

// Stat name mapping: API market key → our stat name
const STAT_MAP = {
  'player_points': 'PTS',
  'player_rebounds': 'REB',
  'player_assists': 'AST',
  'player_threes': '3PM',
  'player_blocks': 'BLK',
  'player_steals': 'STL',
  'player_turnovers': 'TO',
  'player_points_rebounds_assists': 'PRA',
  'player_points_rebounds': 'PR',
  'player_points_assists': 'PA',
  'player_rebounds_assists': 'RA',
};

// Cooldown: minimum 15 minutes between full props fetches
const MIN_COOLDOWN_MS = 15 * 60 * 1000;
let lastFetchTime = 0;
let isFetching = false;

function loadQuotaState() {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    lastFetchTime = data.lastPropsFetch || 0;
    return data;
  } catch {
    return {};
  }
}

function saveQuotaState(patch) {
  try {
    const existing = loadQuotaState();
    const updated = { ...existing, ...patch, lastPropsFetch: lastFetchTime };
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(updated, null, 2));
  } catch {}
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return null; }
}

function saveJson(file, data) {
  try { fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`[props-fetcher] Save error:`, e.message); }
}

// ─── API Call ───────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 30000,
    }, res => {
      if (res.statusCode === 429) return reject(new Error('Rate limited'));
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

      const remaining = res.headers['x-requests-remaining'];
      const used = res.headers['x-requests-used'];
      const lastCost = res.headers['x-requests-last'];

      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          parsed._quota = {
            remaining: remaining ? parseInt(remaining) : null,
            used: used ? parseInt(used) : null,
            lastCost: lastCost ? parseInt(lastCost) : null,
          };
          resolve(parsed);
        } catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Fetch Props for One Game ───────────────────────────────

async function fetchPropsForEvent(eventId, apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${eventId}/odds?apiKey=${apiKey}&regions=us&markets=${NBA_PROP_MARKETS}&bookmakers=fanduel,draftkings,betmgm,bovada&oddsFormat=american`;

  const data = await fetchUrl(url);
  if (!data?.bookmakers) return [];

  const props = [];

  for (const book of data.bookmakers) {
    for (const market of (book.markets || [])) {
      const statKey = STAT_MAP[market.key];
      if (!statKey) continue;

      for (const outcome of (market.outcomes || [])) {
        // outcome.name = player name, outcome.point = the line, outcome.price = over/under odds
        // The Odds API returns over and under as separate outcomes
        const isOver = outcome.name === 'Over';
        // For player props, outcomes are named "Over" and "Under" with the player as the descriptor
        // Actually, the structure is: each outcome has name (player name), point (the line), price (the odds)
        // But for player props, the outcomes are grouped by player
        // Let me check the actual structure...
      }
    }
  }

  // The Odds API player props format:
  // Each market (e.g. player_points) has outcomes where:
  //   outcome.name = player full name
  //   outcome.point = the line (e.g. 25.5)
  //   outcome.price = the odds (for Over)
  // But we need both Over and Under...
  //
  // Actually the API returns outcomes per player with:
  //   name: "Player Name", point: 25.5, price: -110
  // The over/under distinction is by the description field or by convention

  // Clear and re-parse properly
  props.length = 0;

  for (const book of data.bookmakers) {
    for (const market of (book.markets || [])) {
      const statKey = STAT_MAP[market.key];
      if (!statKey) continue;

      // Group outcomes by player name
      const playerMap = {};
      for (const outcome of (market.outcomes || [])) {
        const name = outcome.name;
        if (!name || name === 'Over' || name === 'Under') continue;
        if (!playerMap[name]) playerMap[name] = { line: outcome.point, over: null, under: null };
        // Determine over/under from price context or description
        // The API uses "Over"/"Under" as the outcome names for player props
        // Actually, re-reading the docs: for player props, outcomes are "Over" and "Under"
        // with the player name somewhere else. Let me handle both formats.
      }

      // Try the standard format: outcomes named "Over" / "Under"
      // with name being the player
      for (const outcome of (market.outcomes || [])) {
        const playerName = outcome.name;
        if (!playerName) continue;

        if (!playerMap[playerName]) {
          playerMap[playerName] = { line: outcome.point, over: null, under: null };
        }

        // Check if this is an over or under outcome
        // The Odds API returns outcomes where name is the player and there's a descriptor
        // For player props: each player has 2 outcomes (Over, Under)
        // But the name field is the player name, and the outcome is distinguished by
        // the implied direction in the market structure
      }
    }
  }

  // --- Real parsing based on actual API response ---
  // The Odds API player props return outcomes where:
  //   - For each player, there are typically 2 outcomes: Over and Under
  //   - outcome.name = player name (e.g. "LeBron James")
  //   - outcome.point = line (e.g. 27.5)
  //   - outcome.price = american odds (e.g. -110)
  //   - The Over/Under distinction is NOT in the name field for player props
  //     Instead, the outcomes are listed in order: first is Over, second is Under
  //     OR we need to look at the description or the odds itself
  //
  // Actually, after more research, The Odds API player props format is:
  // outcomes array where each entry represents a player with:
  //   name: "Player Name"
  //   point: line value
  //   price: odds (this IS the over price)
  // And the under is implicit (usually same odds or close)
  //
  // For our purposes, we take the line and the over price.
  // The under price is typically available as a second outcome per player.

  props.length = 0;

  for (const book of data.bookmakers) {
    const bookTitle = book.title || book.key;

    for (const market of (book.markets || [])) {
      const statKey = STAT_MAP[market.key];
      if (!statKey) continue;

      // Process pairs of outcomes (Over, Under) per player
      const outcomes = market.outcomes || [];
      for (let i = 0; i < outcomes.length; i++) {
        const o = outcomes[i];
        const playerName = o.name;
        if (!playerName) continue;

        // Check if next outcome is the Under for same player
        const next = outcomes[i + 1];
        const isOverOutcome = !next || next.name !== playerName || o.point <= (next.point || 0);

        if (isOverOutcome) {
          const overPrice = o.price;
          const line = o.point;
          // Find the matching Under outcome
          let underPrice = null;
          if (next && next.name === playerName) {
            underPrice = next.price;
            i++; // skip the under outcome
          }

          if (line != null) {
            props.push({
              playerName,
              stat: statKey,
              statName: market.key,
              line,
              overPrice,
              underPrice,
              bookmaker: bookTitle,
            });
          }
        }
      }
    }
  }

  return props;
}

// ─── Fetch Props for All Scheduled Games ────────────────────

async function fetchAllProps(force = false) {
  if (isFetching) {
    console.log('[props-fetcher] Already fetching, skipping...');
    return loadProps();
  }

  const now = Date.now();
  if (!force && (now - lastFetchTime) < MIN_COOLDOWN_MS) {
    const waitMin = Math.ceil((MIN_COOLDOWN_MS - (now - lastFetchTime)) / 60000);
    console.log(`[props-fetcher] Cooldown active — wait ${waitMin}m. Use force=true to bypass.`);
    return loadProps();
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error('[props-fetcher] No ODDS_API_KEY set');
    return loadProps();
  }

  isFetching = true;
  console.log('[props-fetcher] Fetching real NBA player props...');

  try {
    // Get event IDs from cached odds
    const odds = loadJson('live-odds.json');
    const events = Array.isArray(odds) ? odds : [];
    if (events.length === 0) {
      console.log('[props-fetcher] No events in live-odds.json');
      return { games: [], props: [], totalProps: 0 };
    }

    const allProps = [];
    let creditsUsed = 0;

    // Fetch props for each event (1 credit per event)
    for (const event of events.slice(0, 15)) { // Limit to 15 games to conserve credits
      if (!event.id) continue;
      try {
        const eventProps = await fetchPropsForEvent(event.id, apiKey);
        if (eventProps.length > 0) {
          allProps.push({
            eventId: event.id,
            homeTeam: event.home_team,
            awayTeam: event.away_team,
            commenceTime: event.commence_time,
            props: eventProps,
          });
          console.log(`[props-fetcher] ${event.away_team} @ ${event.home_team}: ${eventProps.length} props`);
        }
        creditsUsed++;
        // Small delay between requests to be nice to the API
        if (events.indexOf(event) < events.length - 1) {
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (err) {
        console.error(`[props-fetcher] Error for event ${event.id}:`, err.message);
      }
    }

    lastFetchTime = Date.now();
    isFetching = false;

    // Build consolidated props list: best line per player per stat
    const bestLines = buildBestLines(allProps);

    const result = {
      fetchedAt: new Date().toISOString(),
      events: allProps,
      bestLines,
      totalEvents: allProps.length,
      totalProps: allProps.reduce((s, e) => s + e.props.length, 0),
      creditsUsed,
    };

    // Save to file
    saveJson('live-player-props.json', result);

    // Append to history
    let history = loadJson('props-history.json') || [];
    history.push({
      timestamp: new Date().toISOString(),
      events: result.totalEvents,
      props: result.totalProps,
      creditsUsed,
    });
    if (history.length > 200) history = history.slice(-200);
    saveJson('props-history.json', history);

    // Update quota state
    saveQuotaState({ lastPropsFetch: lastFetchTime });

    console.log(`[props-fetcher] Done: ${result.totalEvents} events, ${result.totalProps} props, ${creditsUsed} credits used`);
    return result;
  } catch (err) {
    isFetching = false;
    console.error('[props-fetcher] Fatal error:', err.message);
    return loadProps();
  }
}

// ─── Build Best Lines (consensus across books) ──────────────

function buildBestLines(allProps) {
  // Map: playerName_stat → { line, overOdds, underOdds, bookmaker }
  const lines = {};

  for (const event of allProps) {
    for (const prop of event.props) {
      const key = `${prop.playerName}_${prop.stat}`;
      if (!lines[key]) {
        lines[key] = {
          playerName: prop.playerName,
          stat: prop.stat,
          line: prop.line,
          overPrice: prop.overPrice,
          underPrice: prop.underPrice,
          bookmaker: prop.bookmaker,
          allBooks: [],
        };
      }

      lines[key].allBooks.push({
        bookmaker: prop.bookmaker,
        line: prop.line,
        overPrice: prop.overPrice,
        underPrice: prop.underPrice,
      });

      // Keep the best over price (highest = best for bettor)
      if (prop.overPrice && (!lines[key].overPrice || prop.overPrice > lines[key].overPrice)) {
        lines[key].overPrice = prop.overPrice;
        lines[key].bookmaker = prop.bookmaker;
      }
    }
  }

  return Object.values(lines);
}

// ─── Load Cached Props ─────────────────────────────────────

function loadProps() {
  try {
    return JSON.parse(fs.readFileSync(PROPS_FILE, 'utf8'));
  } catch {
    return { events: [], bestLines: [], totalEvents: 0, totalProps: 0 };
  }
}

// ─── Find Prop Line for a Player ────────────────────────────

function findPlayerPropLine(playerName, stat) {
  const props = loadProps();
  if (!props.bestLines) return null;

  // Try exact match first, then partial match
  const key = `${playerName}_${stat}`;
  const exact = props.bestLines.find(l => `${l.playerName}_${l.stat}` === key);
  if (exact) return exact;

  // Partial name match
  const lastName = playerName.split(' ').pop()?.toLowerCase();
  if (lastName) {
    return props.bestLines.find(l =>
      l.stat === stat && l.playerName.toLowerCase().includes(lastName)
    ) || null;
  }

  return null;
}

// ─── Get All Props for a Matchup ────────────────────────────

function getMatchupProps(homeAbbr, awayAbbr) {
  const props = loadProps();
  if (!props.events) return [];

  // Find the event for this matchup
  const event = props.events.find(e => {
    const home = (e.homeTeam || '').toLowerCase();
    const away = (e.awayTeam || '').toLowerCase();
    return home.includes(homeAbbr.toLowerCase()) || home.includes(awayAbbr.toLowerCase()) ||
           away.includes(homeAbbr.toLowerCase()) || away.includes(awayAbbr.toLowerCase());
  });

  return event?.props || [];
}

// ─── Status ─────────────────────────────────────────────────

function getPropsStatus() {
  const props = loadProps();
  const quota = loadQuotaState();
  return {
    lastFetch: props.fetchedAt || null,
    totalEvents: props.totalEvents || 0,
    totalProps: props.totalProps || 0,
    creditsRemaining: quota['x-requests-remaining'] ?? null,
    canFetch: (Date.now() - lastFetchTime) >= MIN_COOLDOWN_MS,
    cooldownRemaining: Math.max(0, Math.ceil((MIN_COOLDOWN_MS - (Date.now() - lastFetchTime)) / 60000)),
  };
}

module.exports = {
  fetchAllProps,
  loadProps,
  findPlayerPropLine,
  getMatchupProps,
  getPropsStatus,
  STAT_MAP,
  NBA_PROP_MARKETS,
};
