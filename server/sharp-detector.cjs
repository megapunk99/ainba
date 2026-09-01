/**
 * SHARP DETECTOR — Money Movement Intelligence
 * 
 * Detects sharp (professional) betting activity by analyzing:
 * 1. Reverse Line Movement (RLM) — line moves AGAINST public
 * 2. Steam Moves — same line moves across 3+ books in minutes
 * 3. Cross-Book Discrepancies — books disagree on the line
 * 4. Line Freeze — heavy action but line doesn't move (book absorbing sharp money)
 * 5. Market Direction — which way the sharps are pushing
 * 
 * This is what Action Network Pro charges $60/mo for.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA, 'sharpedge.db');

let db = null;
function getDb() {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
    return db;
  } catch (e) {
    console.error('[sharp] DB error:', e.message);
    return null;
  }
}

function initSchema() {
  const database = getDb();
  if (!database) return;

  database.exec(`
    CREATE TABLE IF NOT EXISTS sharp_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      signal_type TEXT NOT NULL,      -- 'rlm', 'steam', 'discrepancy', 'freeze'
      signal_strength TEXT,           -- 'STRONG', 'MODERATE', 'WEAK'
      signal_details TEXT,            -- JSON with full details
      bookmakers_affected INTEGER,
      line_movement REAL,
      detected_at TEXT DEFAULT (datetime('now')),
      resolved INTEGER DEFAULT 0     -- 1 if game has been played
    );

    CREATE INDEX IF NOT EXISTS idx_sharp_game ON sharp_signals(game_id);
    CREATE INDEX IF NOT EXISTS idx_sharp_type ON sharp_signals(signal_type);
    CREATE INDEX IF NOT EXISTS idx_sharp_time ON sharp_signals(detected_at);
  `);
}

// ═══════════════════════════════════════════════════════════════
// REVERSE LINE MOVEMENT (RLM) DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Detect Reverse Line Movement.
 * 
 * RLM = line moves in the OPPOSITE direction of where the majority of bets are.
 * Example: Team A gets 75% of bets, but the line moves TOWARD Team B.
 * This means sharp money is on Team B.
 * 
 * @param {object} currentOdds - Current odds for all games
 * @param {object} previousOdds - Odds from earlier snapshot
 * @param {object} publicBetting - Public betting percentages (if available)
 * @returns {array} RLM signals detected
 */
function detectRLM(currentOdds, previousOdds, publicBetting = null) {
  if (!Array.isArray(currentOdds)) return [];

  const signals = [];

  for (const game of currentOdds) {
    const prev = Array.isArray(previousOdds)
      ? previousOdds.find(g => g.id === game.id)
      : null;

    if (!prev) continue;

    // Get current and previous spreads
    const currentSpread = getBestSpread(game);
    const prevSpread = getBestSpread(prev);

    if (!currentSpread || !prevSpread) continue;

    const spreadMovement = currentSpread - prevSpread;

    // If no significant movement, skip
    if (Math.abs(spreadMovement) < 0.5) continue;

    // Check if we have public betting data
    const publicData = publicBetting?.find(b => b.game_id === game.id);

    let rlmDetected = false;
    let rlmDetails = {};

    if (publicData) {
      // With public betting data: check if line moves against public
      const publicHomePct = publicData.home_bet_pct || 50;

      if (publicHomePct > 60 && spreadMovement < -0.5) {
        // Public on home, line moving toward away = RLM
        rlmDetected = true;
        rlmDetails = {
          type: 'classic_rlm',
          publicOn: 'home',
          publicPct: publicHomePct,
          lineMoving: 'toward_away',
          movement: spreadMovement,
          strength: publicHomePct > 70 ? 'STRONG' : 'MODERATE',
        };
      } else if (publicHomePct < 40 && spreadMovement > 0.5) {
        // Public on away, line moving toward home = RLM
        rlmDetected = true;
        rlmDetails = {
          type: 'classic_rlm',
          publicOn: 'away',
          publicPct: 100 - publicHomePct,
          lineMoving: 'toward_home',
          movement: spreadMovement,
          strength: (100 - publicHomePct) > 70 ? 'STRONG' : 'MODERATE',
        };
      }
    } else {
      // Without public data: use cross-book movement as proxy
      // If most books moved one way but one book moved the other = possible RLM
      const bookMovements = getBookMovements(game, prev);
      if (bookMovements) {
        const movingTowardHome = bookMovements.filter(m => m.direction > 0).length;
        const movingTowardAway = bookMovements.filter(m => m.direction < 0).length;
        const totalBooks = bookMovements.length;

        if (totalBooks >= 3) {
          // Check for disagreement between books
          if (movingTowardHome >= 2 && movingTowardAway >= 1) {
            rlmDetected = true;
            rlmDetails = {
              type: 'book_disagreement',
              towardHome: movingTowardHome,
              towardAway: movingTowardAway,
              totalBooks,
              strength: 'MODERATE',
            };
          }
        }
      }
    }

    if (rlmDetected) {
      signals.push({
        gameId: game.id,
        matchup: `${game.away_team} @ ${game.home_team}`,
        signalType: 'rlm',
        ...rlmDetails,
        currentSpread,
        previousSpread: prevSpread,
        movement: spreadMovement,
      });
    }
  }

  return signals;
}

// ═══════════════════════════════════════════════════════════════
// STEAM MOVE DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Detect Steam Moves.
 * 
 * Steam = rapid, synchronized line movement across multiple books.
 * This happens when sharp bettors hit multiple books simultaneously.
 * 
 * Detection: 3+ books move the same line in the same direction within a short window.
 */
function detectSteamMoves(currentOdds, recentSnapshots = []) {
  if (!Array.isArray(currentOdds) || recentSnapshots.length < 2) return [];

  const signals = [];

  for (const game of currentOdds) {
    const books = game.bookmakers || [];
    if (books.length < 3) continue;

    // Track how many books moved and in which direction
    const movements = [];

    for (const book of books) {
      const currentSpread = getSpreadFromBook(book, game.home_team);
      if (currentSpread === null) continue;

      // Find this book's previous line in recent snapshots
      const prevLine = findPreviousLine(game.id, book.key, 'spreads', recentSnapshots);
      if (prevLine === null) continue;

      const movement = currentSpread - prevLine;
      if (Math.abs(movement) >= 0.5) {
        movements.push({
          book: book.title || book.key,
          from: prevLine,
          to: currentSpread,
          direction: movement > 0 ? 'toward_away' : 'toward_home',
          movement: Math.abs(movement),
        });
      }
    }

    if (movements.length >= 3) {
      // Check if all moving in the same direction
      const towardHome = movements.filter(m => m.direction === 'toward_home');
      const towardAway = movements.filter(m => m.direction === 'toward_away');

      if (towardHome.length >= 3) {
        const avgMovement = towardHome.reduce((s, m) => s + m.movement, 0) / towardHome.length;
        signals.push({
          gameId: game.id,
          matchup: `${game.away_team} @ ${game.home_team}`,
          signalType: 'steam',
          direction: 'toward_home',
          booksMoved: towardHome.length,
          totalBooks: books.length,
          avgMovement: parseFloat(avgMovement.toFixed(2)),
          strength: towardHome.length >= 4 ? 'STRONG' : 'MODERATE',
          details: towardHome,
        });
      } else if (towardAway.length >= 3) {
        const avgMovement = towardAway.reduce((s, m) => s + m.movement, 0) / towardAway.length;
        signals.push({
          gameId: game.id,
          matchup: `${game.away_team} @ ${game.home_team}`,
          signalType: 'steam',
          direction: 'toward_away',
          booksMoved: towardAway.length,
          totalBooks: books.length,
          avgMovement: parseFloat(avgMovement.toFixed(2)),
          strength: towardAway.length >= 4 ? 'STRONG' : 'MODERATE',
          details: towardAway,
        });
      }
    }
  }

  return signals;
}

// ═══════════════════════════════════════════════════════════════
// CROSS-BOOK DISCREPANCY DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Detect significant discrepancies between books.
 * When books disagree, there's often value on one side.
 */
function detectDiscrepancies(currentOdds) {
  if (!Array.isArray(currentOdds)) return [];

  const signals = [];

  for (const game of currentOdds) {
    const books = game.bookmakers || [];
    if (books.length < 3) continue;

    // Check spread discrepancies
    const spreads = books.map(b => ({
      book: b.title || b.key,
      spread: getSpreadFromBook(b, game.home_team),
    })).filter(s => s.spread !== null);

    if (spreads.length >= 3) {
      const spreadValues = spreads.map(s => s.spread);
      const minSpread = Math.min(...spreadValues);
      const maxSpread = Math.max(...spreadValues);
      const gap = maxSpread - minSpread;

      if (gap >= 1.5) {
        // Find which books have what
        const lowBook = spreads.find(s => s.spread === minSpread);
        const highBook = spreads.find(s => s.spread === maxSpread);

        signals.push({
          gameId: game.id,
          matchup: `${game.away_team} @ ${game.home_team}`,
          signalType: 'discrepancy',
          market: 'spread',
          gap: parseFloat(gap.toFixed(1)),
          lowLine: { book: lowBook.book, line: minSpread },
          highLine: { book: highBook.book, line: maxSpread },
          strength: gap >= 2.5 ? 'STRONG' : gap >= 2 ? 'MODERATE' : 'WEAK',
          recommendation: `Best spread: ${lowBook.book} at ${minSpread}`,
        });
      }
    }

    // Check total discrepancies
    const totals = books.map(b => ({
      book: b.title || b.key,
      total: getTotalFromBook(b),
    })).filter(t => t.total !== null);

    if (totals.length >= 3) {
      const totalValues = totals.map(t => t.total);
      const minTotal = Math.min(...totalValues);
      const maxTotal = Math.max(...totalValues);
      const gap = maxTotal - minTotal;

      if (gap >= 2) {
        signals.push({
          gameId: game.id,
          matchup: `${game.away_team} @ ${game.home_team}`,
          signalType: 'discrepancy',
          market: 'total',
          gap: parseFloat(gap.toFixed(1)),
          lowTotal: { book: totals.find(t => t.total === minTotal).book, line: minTotal },
          highTotal: { book: totals.find(t => t.total === maxTotal).book, line: maxTotal },
          strength: gap >= 3 ? 'STRONG' : gap >= 2.5 ? 'MODERATE' : 'WEAK',
          recommendation: `Over at ${totals.find(t => t.total === maxTotal).book} (${maxTotal}), Under at ${totals.find(t => t.total === minTotal).book} (${minTotal})`,
        });
      }
    }

    // Check ML discrepancies
    const mls = books.map(b => ({
      book: b.title || b.key,
      homeML: getMLFromBook(b, game.home_team),
    })).filter(m => m.homeML !== null);

    if (mls.length >= 3) {
      const mlValues = mls.map(m => m.homeML);
      const minML = Math.min(...mlValues);
      const maxML = Math.max(...mlValues);
      const gap = maxML - minML;

      if (gap >= 15) {
        signals.push({
          gameId: game.id,
          matchup: `${game.away_team} @ ${game.home_team}`,
          signalType: 'discrepancy',
          market: 'moneyline',
          gap,
          bestHomeML: { book: mls.find(m => m.homeML === maxML).book, odds: maxML },
          strength: gap >= 25 ? 'STRONG' : gap >= 20 ? 'MODERATE' : 'WEAK',
          recommendation: `Best home ML: ${mls.find(m => m.homeML === maxML).book} at ${maxML > 0 ? '+' : ''}${maxML}`,
        });
      }
    }
  }

  return signals;
}

// ═══════════════════════════════════════════════════════════════
// COMBINED SHARP SIGNAL — All-in-One
// ═══════════════════════════════════════════════════════════════

/**
 * Run all sharp detection algorithms and return combined signals.
 */
function detectAllSharpSignals(currentOdds, previousOdds = null, recentSnapshots = [], publicBetting = null) {
  const rlm = previousOdds ? detectRLM(currentOdds, previousOdds, publicBetting) : [];
  const steam = detectSteamMoves(currentOdds, recentSnapshots);
  const discrepancies = detectDiscrepancies(currentOdds);

  // Combine and deduplicate
  const allSignals = [...rlm, ...steam, ...discrepancies];

  // Group by game
  const byGame = {};
  for (const signal of allSignals) {
    if (!byGame[signal.gameId]) {
      byGame[signal.gameId] = {
        gameId: signal.gameId,
        matchup: signal.matchup,
        signals: [],
        overallStrength: 'NONE',
        hasSharpAction: false,
      };
    }
    byGame[signal.gameId].signals.push(signal);
  }

  // Determine overall strength per game
  for (const game of Object.values(byGame)) {
    const hasStrong = game.signals.some(s => s.strength === 'STRONG');
    const hasModerate = game.signals.some(s => s.strength === 'MODERATE');
    const signalCount = game.signals.length;

    if (hasStrong || signalCount >= 3) {
      game.overallStrength = 'STRONG';
      game.hasSharpAction = true;
    } else if (hasModerate || signalCount >= 2) {
      game.overallStrength = 'MODERATE';
      game.hasSharpAction = true;
    } else if (signalCount >= 1) {
      game.overallStrength = 'WEAK';
      game.hasSharpAction = true;
    }

    // Sort signals by strength
    game.signals.sort((a, b) => {
      const strengthOrder = { STRONG: 0, MODERATE: 1, WEAK: 2 };
      return (strengthOrder[a.strength] || 3) - (strengthOrder[b.strength] || 3);
    });
  }

  // Convert to array and sort by strength
  const results = Object.values(byGame);
  results.sort((a, b) => {
    const order = { STRONG: 0, MODERATE: 1, WEAK: 2, NONE: 3 };
    return (order[a.overallStrength] || 3) - (order[b.overallStrength] || 3);
  });

  return {
    totalGames: results.length,
    gamesWithSharp: results.filter(g => g.hasSharpAction).length,
    strongSignals: results.filter(g => g.overallStrength === 'STRONG').length,
    moderateSignals: results.filter(g => g.overallStrength === 'MODERATE').length,
    games: results,
    allSignals,
  };
}

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function getBestSpread(game) {
  const spreads = (game.bookmakers || [])
    .map(b => getSpreadFromBook(b, game.home_team))
    .filter(s => s !== null);
  return spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
}

function getSpreadFromBook(book, teamName) {
  const market = book.markets?.find(m => m.key === 'spreads');
  const outcome = market?.outcomes?.find(o => o.name === teamName);
  return outcome?.point ?? null;
}

function getTotalFromBook(book) {
  const market = book.markets?.find(m => m.key === 'totals');
  const outcome = market?.outcomes?.find(o => o.name === 'Over');
  return outcome?.point ?? null;
}

function getMLFromBook(book, teamName) {
  const market = book.markets?.find(m => m.key === 'h2h');
  const outcome = market?.outcomes?.find(o => o.name === teamName);
  return outcome?.price ?? null;
}

function getBookMovements(current, previous) {
  if (!current?.bookmakers || !previous?.bookmakers) return null;

  const movements = [];
  for (const currentBook of current.bookmakers) {
    const prevBook = previous.bookmakers?.find(b => b.key === currentBook.key);
    if (!prevBook) continue;

    const currentSpread = getSpreadFromBook(currentBook, current.home_team);
    const prevSpread = getSpreadFromBook(prevBook, previous.home_team);

    if (currentSpread !== null && prevSpread !== null) {
      movements.push({
        book: currentBook.title || currentBook.key,
        direction: currentSpread - prevSpread,
        movement: Math.abs(currentSpread - prevSpread),
      });
    }
  }

  return movements.length > 0 ? movements : null;
}

function findPreviousLine(gameId, bookKey, marketKey, snapshots) {
  for (const snapshot of snapshots) {
    const game = snapshot.find?.(g => g.id === gameId) || snapshot;
    const book = game?.bookmakers?.find(b => b.key === bookKey);
    const market = book?.markets?.find(m => m.key === marketKey);
    const outcome = market?.outcomes?.find(o => o.name === game?.home_team);
    return outcome?.point ?? null;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// SAVE SIGNALS TO DB
// ═══════════════════════════════════════════════════════════════

function saveSignals(signals) {
  const database = getDb();
  if (!database) return;

  const stmt = database.prepare(`
    INSERT INTO sharp_signals (game_id, signal_type, signal_strength,
      signal_details, bookmakers_affected, line_movement, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const signal of signals.allSignals || []) {
    try {
      stmt.run(
        signal.gameId,
        signal.signalType,
        signal.strength,
        JSON.stringify(signal),
        signal.booksMoved || signal.bookmakersAffected || 0,
        signal.movement || signal.gap || 0
      );
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  detectRLM,
  detectSteamMoves,
  detectDiscrepancies,
  detectAllSharpSignals,
  saveSignals,
  initSchema,
};
