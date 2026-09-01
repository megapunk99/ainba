# SHARPEDGE — System Architecture v2.0

## Design Philosophy
Desktop-first. Every pixel earns its space. Real data only.
Every bet has a reason. Every number is backed by data.

## Data Flow
```
[INTERNET] → [DATA PIPELINE] → [ENGINE] → [FRONTEND] → [YOU]
     ↓              ↓              ↓            ↓
 [ESPN API]    [DATA STORE]   [PREDICTIONS]  [DASHBOARD]
 [ODDS API]    (1800+ files)  [PROPS]        [LIVE ODDS]
 [NEWS FEEDS]  [SQLite DB]    [MATCHUPS]     [BET JOURNAL]
```

## Layer 1: DATA PIPELINE
- **ESPN API**: scores, standings, rosters, injuries, schedules
- **Odds API**: live odds from FanDuel, DraftKings, BetMGM, Bovada, Stake
- **News Feeds**: ESPN RSS, Yahoo Sports, Google News
- **Frequency**: every 5 seconds (live odds), every 15 minutes (scores), hourly (news)

## Layer 2: PREDICTION ENGINE
- **MatchupAnalyst**: deep team comparison for every game
- **PropsEngine**: generates player props from gamelogs, finds value
- **OddsScanner**: watches line movements, detects sharp money
- **InjuryIntel**: tracks injuries, projects point impact
- **NewsAnalyzer**: categorizes news, extracts betting signals
- **Native C Core**: performance-critical math (Kelly, vig removal, projections)

## Layer 3: DATABASE (SQLite + JSON)
- **SQLite** (`data/sharpedge.db`): structured queries, odds history, predictions
- **JSON files** (`data/`): raw API responses, player gamelogs, team data
- **Local storage**: bet journal, bankroll settings (browser-side)

## Layer 4: FRONTEND (React + Vite)
- **Dashboard**: today's best bets, live games, P/L summary
- **Live**: real-time odds streaming, <5s auto-refresh, line shopping
- **Pre-Match**: deep game analysis, model predictions, roster comparison
- **Matchups**: team search, head-to-head, stats comparison
- **Players**: search, profiles, gamelogs, season averages
- **Props**: value finder, edge detection, line comparison across books
- **Bet Journal**: log, auto-import, grade bets, track ROI/CLV
- **Bankroll**: Kelly sizing, unit tracking, P/L curves
- **Alerts**: sharp money signals, injury report, news feed

## Layer 5: REAL-TIME (WebSocket)
- Odds streaming with 5-second refresh
- Line movement detection and alerts
- Score updates during live games

## Key Principles
1. Real data only — no simulated responses
2. Desktop-first — dense information, trading terminal density
3. Light theme — zero dark mode, clean whites
4. Every pick has a WHY — reasoning, edge %, confidence tier
5. Auto-import bets — reduce manual entry
6. Kelly criterion sizing — proper bankroll management
7. CLV tracking — measure if you beat the closing line

## API Endpoints
| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server status |
| `GET /api/matches/upcoming` | Games with odds from all books |
| `GET /api/predictions` | Model predictions sorted by edge |
| `GET /api/odds` | Live odds from all sportsbooks |
| `GET /api/odds/sharp` | Sharp money / line movement signals |
| `GET /api/standings` | Conference standings |
| `GET /api/injuries` | Injury report |
| `GET /api/news` | News articles |
| `GET /api/props/top` | Top prop picks |
| `GET /api/props/v3/top` | Props engine v3 picks |
| `GET /api/teams/all` | All teams with rosters |
| `GET /api/players/:id` | Player profile + gamelog |
| `POST /api/refresh/odds` | Force odds refresh |
| `POST /api/predictions/generate` | Generate all predictions |
