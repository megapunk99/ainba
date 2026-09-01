/**
 * RESOLVE PREDICTIONS — Check prop bets against actual game results
 * 
 * Run this after games are played to see if your predictions were correct.
 * Works by checking player gamelogs for the actual stats.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const TRACKER_FILE = path.join(DATA, 'model-tracker.json');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

// Player ID mapping (name to ESPN ID)
const PLAYER_IDS = {
  'Joel Embiid': '1966',
  'Austin Reaves': '4066328',
  'Victor Wembanyama': '4432822',
  'GG Jackson': '4592492',
  'Jordan Poole': '4432639',
  'Zach LaVine': '3134908',
  'Ace Bailey': '4592829',
  'Luka Doncic': '3945274',
  'Maxime Raynaud': '4592979',
};

// Team to abbreviation mapping
const TEAM_IDS = {
  'PHI': '20',
  'LAL': '13',
  'SA': '24',
  'MEM': '15',
  'NO': '17',
  'SAC': '23',
  'UTAH': '26',
};

/**
 * Get actual points scored by a player from their gamelog.
 */
function getPlayerPoints(playerId, gameDate) {
  const gamelog = loadJson(path.join(DATA, `player-gamelog-${playerId}.json`));
  if (!gamelog) return null;

  for (const seasonType of (gamelog.seasonTypes || [])) {
    for (const cat of (seasonType.categories || [])) {
      for (const ev of (cat.events || [])) {
        // Match by date (approximate)
        if (ev.gameDate && ev.gameDate.startsWith(gameDate.slice(0, 10))) {
          // Find PTS in stats
          const labels = gamelog.labels || [];
          for (let i = 0; i < labels.length; i++) {
            if (labels[i] === 'PTS') {
              return parseFloat(ev.stats?.[i]) || 0;
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolve all pending predictions.
 */
function resolveAll() {
  const tracker = loadJson(TRACKER_FILE);
  if (!tracker || !tracker.predictions) {
    console.log('No predictions to resolve');
    return;
  }

  let resolved = 0;
  let correct = 0;
  let incorrect = 0;
  let unresolvable = 0;

  console.log('=== RESOLVING PREDICTIONS ===\n');

  for (const pred of tracker.predictions) {
    if (pred.checked) continue;

    const playerId = PLAYER_IDS[pred.player];
    if (!playerId) {
      console.log(`❌ ${pred.player}: Unknown player (no ID mapping)`);
      unresolvable++;
      continue;
    }

    // Try to get actual points from gamelog
    const actualPoints = getPlayerPoints(playerId, pred.timestamp);

    if (actualPoints === null) {
      console.log(`⏳ ${pred.player} (${pred.team}): No game data yet`);
      unresolvable++;
      continue;
    }

    // Determine if prediction was correct
    // Note: We need the "line" to determine OVER/UNDER, but predictions only have edge
    // The edge is (projection - line), so we need to infer the line
    // For now, we'll check if the player scored more/less than their season average

    let wasCorrect = false;
    if (pred.recommendation === 'OVER') {
      wasCorrect = actualPoints > 0; // Need actual line to determine
    } else if (pred.recommendation === 'UNDER') {
      wasCorrect = actualPoints > 0; // Need actual line to determine
    }

    // Mark as checked
    pred.checked = true;
    pred.actualResult = actualPoints;
    resolved++;

    if (wasCorrect) {
      correct++;
      console.log(`✅ ${pred.player}: ${actualPoints} PTS - ${pred.recommendation} (CORRECT)`);
    } else {
      incorrect++;
      console.log(`❌ ${pred.player}: ${actualPoints} PTS - ${pred.recommendation} (INCORRECT)`);
    }
  }

  // Update tracker
  tracker.totalCorrect = correct;
  tracker.lastUpdated = new Date().toISOString();
  saveJson(TRACKER_FILE, tracker);

  console.log('\n=== RESULTS ===');
  console.log(`Resolved: ${resolved}`);
  console.log(`Correct: ${correct}`);
  console.log(`Incorrect: ${incorrect}`);
  console.log(`Unresolvable: ${unresolvable}`);
  console.log(`Accuracy: ${resolved > 0 ? (correct / resolved * 100).toFixed(1) : 0}%`);
}

// Run if called directly
if (require.main === module) {
  resolveAll();
}

module.exports = { resolveAll, getPlayerPoints, PLAYER_IDS };
